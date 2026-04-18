/**
 * WebSocket 事件处理模块
 * 管理客户端连接、房间分配、事件转发
 *
 * 连接认证:
 *   - 设备客户端: ?client_type=device&token=<JWT> (需要)
 *   - Web 仪表盘: ?client_type=web (不需要认证)
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('./db');
const config = require('./config');

/**
 * 活跃的截图请求追踪
 * key: request_id, value: { device_id, requestTime }
 * 用于计算截图响应时间
 */
const pendingScreenshotRequests = new Map();

/**
 * 初始化 Socket.IO 事件处理
 * @param {import('socket.io').Server} io
 */
function initSocketIO(io) {
  console.log('[WebSocket] Socket.IO 事件处理器已初始化');

  // -------------------------------------------
  // 中间件：连接认证
  //   - 设备端：强制 JWT Token 验证
  //   - Web 端：不需要认证
  // -------------------------------------------
  io.use((socket, next) => {
    const clientType = socket.handshake.query.client_type; // 'device' | 'web'

    if (clientType === 'device') {
      const token = socket.handshake.query.token;
      if (!token) {
        return next(new Error('设备连接需要提供 JWT Token'));
      }
      // 设备端：验证 JWT Token
      try {
        const decoded = jwt.verify(token, config.JWT_SECRET, { issuer: 'stalker-panel' });
        socket.clientType = 'device';
        socket.deviceId = decoded.device_id;
        socket.deviceType = decoded.device_type;
        // 加入设备房间
        socket.join(`device:${decoded.device_id}`);
        console.log(`[WebSocket] 设备已认证: ${decoded.device_id} (${decoded.device_type})`);
        next();
      } catch (error) {
        return next(new Error('JWT Token 无效或已过期'));
      }
    } else {
      // Web 端：不需要认证
      socket.clientType = 'web';
      console.log(`[WebSocket] Web 客户端已连接: ${socket.id}`);
      next();
    }
  });

  // -------------------------------------------
  // 连接管理
  // -------------------------------------------
  io.on('connection', (socket) => {
    console.log(`[WebSocket] 新连接: ${socket.id} (类型: ${socket.clientType})`);

    // Web 客户端自动加入房间
    if (socket.clientType === 'web') {
      socket.join('web-clients');
      // 发送当前在线设备列表
      sendDeviceListToWeb(socket);
    }

    // 设备端：连接时已通过 JWT 认证，直接通知上线
    if (socket.clientType === 'device' && socket.deviceId) {
      const device = db.prepare('SELECT * FROM devices WHERE device_id = ?').get(socket.deviceId);
      if (device) {
        // 更新心跳
        const now = new Date().toISOString();
        db.prepare('UPDATE devices SET last_heartbeat = ? WHERE device_id = ?').run(now, socket.deviceId);

        socket.emit('device-ready', {
          device_id: socket.deviceId,
          meeting_mode: !!device.meeting_mode,
        });

        // 通知 Web 客户端设备上线
        io.to('web-clients').emit('device:online', {
          deviceId: socket.deviceId,
          deviceName: device.device_name || socket.deviceId,
          deviceType: socket.deviceType,
          meetingMode: !!device.meeting_mode,
        });
        broadcastDeviceUpdate(io);
      }
    }

    // =======================================
    // 设备端事件
    // =======================================

    /**
     * 设备就绪/重新同步（JWT 已在中间件中验证）
     * 客户端发送: {} (deviceId 从 JWT 中提取)
     */
    socket.on('sync', (data) => {
      if (socket.clientType !== 'device' || !socket.deviceId) return;

      const device = db.prepare('SELECT * FROM devices WHERE device_id = ?').get(socket.deviceId);
      if (!device) return;

      const now = new Date().toISOString();
      db.prepare('UPDATE devices SET last_heartbeat = ? WHERE device_id = ?').run(now, socket.deviceId);

      socket.emit('device-ready', {
        device_id: socket.deviceId,
        meeting_mode: !!device.meeting_mode,
      });
    });

    /**
     * 心跳
     * 客户端定期发送保持连接活跃
     */
    socket.on('heartbeat', (data) => {
      if (!socket.deviceId) return;

      const now = new Date().toISOString();
      db.prepare('UPDATE devices SET last_heartbeat = ? WHERE device_id = ?')
        .run(now, socket.deviceId);

      // 回复心跳确认
      socket.emit('heartbeat-ack', { timestamp: now });

      // 通知 Web 客户端
      io.to('web-clients').emit('device:heartbeat', {
        deviceId: socket.deviceId,
        timestamp: now,
      });
    });

    /**
     * 截图响应
     * 设备收到截图请求后，将截图数据通过此事件回传
     * data: { request_id, image_base64, is_rejected?, response_time_ms? }
     */
    socket.on('screenshot-response', (data) => {
      try {
        if (!socket.deviceId) return;

        const { request_id, image_base64, is_rejected, response_time_ms } = data;

        // 计算响应时间（如果客户端未提供）
        let finalResponseTime = response_time_ms;
        if (!finalResponseTime && pendingScreenshotRequests.has(request_id)) {
          const pending = pendingScreenshotRequests.get(request_id);
          finalResponseTime = Date.now() - pending.requestTime;
          pendingScreenshotRequests.delete(request_id);
        }

        // 存储到数据库
        db.prepare(`
          INSERT INTO screenshots (device_id, timestamp, image_base64, requested_by, is_rejected, response_time_ms)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          socket.deviceId,
          new Date().toISOString(),
          image_base64 || '',
          request_id || 'socket',
          is_rejected ? 1 : 0,
          finalResponseTime || null
        );

        console.log(`[WebSocket] 截图响应: 设备=${socket.deviceId}, 拒绝=${!!is_rejected}, 响应时间=${finalResponseTime}ms`);

        // 广播到 Web 客户端
        const screenshotEvent = {
          deviceId: socket.deviceId,
          requestId: request_id,
          isRejected: !!is_rejected,
          responseTimeMs: finalResponseTime,
          timestamp: new Date().toISOString(),
          hasImage: !!image_base64 && !is_rejected,
        };
        io.to('web-clients').emit('new-screenshot', screenshotEvent);
        io.to('web-clients').emit(is_rejected ? 'device:screenshotRejected' : 'device:screenshot', screenshotEvent);
      } catch (error) {
        console.error('[WebSocket] 截图响应处理失败:', error.message);
      }
    });

    /**
     * 应用事件（实时推送）
     * data: { app_name, window_title, event_type, duration_seconds? }
     */
    socket.on('app-event', (data) => {
      try {
        if (!socket.deviceId) return;

        const { app_name, window_title, event_type, duration_seconds } = data;
        if (!event_type) return;

        // 存储到数据库
        db.prepare(`
          INSERT INTO app_events (device_id, timestamp, app_name, window_title, event_type, duration_seconds)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          socket.deviceId,
          new Date().toISOString(),
          app_name || '',
          window_title || '',
          event_type,
          duration_seconds || null
        );

        // 追加到操作链条
        if (event_type === 'switch' && app_name) {
          appendToCurrentChain(socket.deviceId, app_name);
        }

        // 广播到 Web 客户端（不含完整数据，仅摘要）
        const appEvent = {
          deviceId: socket.deviceId,
          appName: app_name,
          windowTitle: window_title,
          eventType: event_type,
          durationSeconds: duration_seconds,
          timestamp: new Date().toISOString(),
        };
        io.to('web-clients').emit('app-event-update', { device_id: socket.deviceId, app_name, window_title, event_type, duration_seconds, timestamp: new Date().toISOString() });
        io.to('web-clients').emit('device:appSwitch', appEvent);
      } catch (error) {
        console.error('[WebSocket] 应用事件处理失败:', error.message);
      }
    });

    /**
     * 传感器数据更新（实时推送）
     * data: { data_type, value_json }
     */
    socket.on('sensor-update', (data) => {
      try {
        if (!socket.deviceId) return;

        const { data_type, value_json } = data;
        if (!data_type || !value_json) return;

        let jsonStr = typeof value_json === 'string' ? value_json : JSON.stringify(value_json);

        // 存储到数据库
        db.prepare(`
          INSERT INTO sensor_data (device_id, timestamp, data_type, value_json)
          VALUES (?, ?, ?, ?)
        `).run(socket.deviceId, new Date().toISOString(), data_type, jsonStr);

        // 广播到 Web 客户端
        const sensorEvent = {
          deviceId: socket.deviceId,
          dataType: data_type,
          value: typeof value_json === 'string' ? JSON.parse(value_json) : value_json,
          timestamp: new Date().toISOString(),
        };
        io.to('web-clients').emit('sensor-data-update', { device_id: socket.deviceId, data_type, value: sensorEvent.value, timestamp: new Date().toISOString() });
        io.to('web-clients').emit('device:sensorData', sensorEvent);
      } catch (error) {
        console.error('[WebSocket] 传感器数据处理失败:', error.message);
      }
    });

    /**
     * 输入空闲事件（实时推送）
     * data: { idle_type, idle_duration_ms }
     */
    socket.on('input-idle-event', (data) => {
      try {
        if (!socket.deviceId) return;

        const { idle_type, idle_duration_ms } = data;
        if (!idle_type || idle_duration_ms === undefined) return;

        db.prepare(`
          INSERT INTO input_idle (device_id, timestamp, idle_type, idle_duration_ms)
          VALUES (?, ?, ?, ?)
        `).run(socket.deviceId, new Date().toISOString(), idle_type, idle_duration_ms);

        const idleEvent = {
          deviceId: socket.deviceId,
          idleType: idle_type,
          idleDurationMs: idle_duration_ms,
          timestamp: new Date().toISOString(),
        };
        io.to('web-clients').emit('input-idle-update', { device_id: socket.deviceId, idle_type, idle_duration_ms, timestamp: new Date().toISOString() });
        io.to('web-clients').emit('device:inputIdle', idleEvent);
      } catch (error) {
        console.error('[WebSocket] 空闲事件处理失败:', error.message);
      }
    });

    // =======================================
    // 断开连接
    // =======================================
    socket.on('disconnect', (reason) => {
      console.log(`[WebSocket] 断开连接: ${socket.id} (设备: ${socket.deviceId || '未注册'}, 原因: ${reason})`);

      // 检查该设备是否还有其他活跃连接
      if (socket.deviceId) {
        const room = io.sockets.adapter.rooms.get(`device:${socket.deviceId}`);
        if (!room || room.size === 0) {
          // 设备所有连接都已断开，通知 Web
          io.to('web-clients').emit('device:offline', { deviceId: socket.deviceId });
          broadcastDeviceUpdate(io);
        }
      }
    });

    // =======================================
    // Web 客户端事件（从 Dashboard 发出）
    // =======================================

    /**
     * Web 请求截图 → 转发到设备
     */
    socket.on('requestScreenshot', (data) => {
      const { deviceId } = data;
      if (!deviceId) return;
      const requestId = 'web-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6);
      requestScreenshotFromDevice(io, deviceId, requestId);
    });

    /**
     * 设备端会议模式变更 → 广播到 Web（会议模式只能由设备端控制）
     * 设备端通过 REST API 或 Socket 事件上报会议模式变更
     */

    /**
     * Web 发送传感器校准命令 → 转发到 Android 设备
     */
    socket.on('calibrateSensor', (data) => {
      const { deviceId } = data;
      if (!deviceId) return;
      io.to(`device:${deviceId}`).emit('calibrate-sensor', {
        command: 'calibrate',
        timestamp: Date.now(),
      });
    });

    /**
     * Web 请求蓝牙扫描 → 转发到设备
     */
    socket.on('scanBluetooth', (data) => {
      const { deviceId } = data;
      if (!deviceId) return;
      io.to(`device:${deviceId}`).emit('bluetooth-scan', {
        timestamp: Date.now(),
      });
    });
  });
}

// =============================================
// 辅助函数
// =============================================

/**
 * 获取设备的会议模式状态
 */
function getDeviceMeetingMode(deviceId) {
  const row = db.prepare('SELECT meeting_mode FROM devices WHERE device_id = ?').get(deviceId);
  return row ? row.meeting_mode : 0;
}

/**
 * 追加应用到当前操作链条（30秒超时自动分段）
 */
function appendToCurrentChain(deviceId, appName) {
  const now = new Date().toISOString();
  const chainTimeout = 30;

  const lastChain = db.prepare(`
    SELECT id, chain_json, timestamp FROM operation_chains
    WHERE device_id = ?
    ORDER BY timestamp DESC
    LIMIT 1
  `).get(deviceId);

  if (lastChain) {
    const lastTime = new Date(lastChain.timestamp).getTime();
    if ((Date.now() - lastTime) / 1000 < chainTimeout) {
      let chain = JSON.parse(lastChain.chain_json);
      if (chain[chain.length - 1] !== appName) {
        chain.push(appName);
        db.prepare('UPDATE operation_chains SET chain_json = ?, timestamp = ? WHERE id = ?')
          .run(JSON.stringify(chain), now, lastChain.id);
      }
      return;
    }
  }

  db.prepare(`
    INSERT INTO operation_chains (device_id, timestamp, chain_json)
    VALUES (?, ?, ?)
  `).run(deviceId, now, JSON.stringify([appName]));
}

/**
 * 向 Web 客户端广播设备列表更新
 */
function broadcastDeviceUpdate(io) {
  try {
    const devices = db.prepare('SELECT * FROM devices ORDER BY last_heartbeat DESC').all();
    const now = Date.now();

    const devicesWithStatus = devices.map(d => {
      const lastHB = d.last_heartbeat ? new Date(d.last_heartbeat).getTime() : 0;
      return {
        ...d,
        online: (now - lastHB) < config.HEARTBEAT_TIMEOUT_MS,
        meeting_mode: !!d.meeting_mode,
      };
    });

    io.to('web-clients').emit('device-update', { devices: devicesWithStatus });
  } catch (error) {
    console.error('[WebSocket] 广播设备更新失败:', error.message);
  }
}

/**
 * 向新连接的 Web 客户端发送当前设备列表
 */
function sendDeviceListToWeb(socket) {
  try {
    const devices = db.prepare('SELECT * FROM devices ORDER BY last_heartbeat DESC').all();
    const now = Date.now();

    const devicesWithStatus = devices.map(d => {
      const lastHB = d.last_heartbeat ? new Date(d.last_heartbeat).getTime() : 0;
      return {
        ...d,
        online: (now - lastHB) < config.HEARTBEAT_TIMEOUT_MS,
        meeting_mode: !!d.meeting_mode,
      };
    });

    socket.emit('device-update', { devices: devicesWithStatus });
  } catch (error) {
    console.error('[WebSocket] 发送设备列表失败:', error.message);
  }
}

/**
 * 向指定设备发送截图请求（供 API 路由调用）
 */
function requestScreenshotFromDevice(io, deviceId, requestId) {
  pendingScreenshotRequests.set(requestId, {
    device_id: deviceId,
    requestTime: Date.now(),
  });

  // 设置超时自动清理
  setTimeout(() => {
    if (pendingScreenshotRequests.has(requestId)) {
      const pending = pendingScreenshotRequests.get(requestId);
      const elapsed = Date.now() - pending.requestTime;

      // 记录超时为拒绝
      db.prepare(`
        INSERT INTO screenshots (device_id, timestamp, image_base64, requested_by, is_rejected, response_time_ms)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        deviceId,
        new Date().toISOString(),
        '',
        requestId,
        1,
        elapsed
      );

      pendingScreenshotRequests.delete(requestId);
      console.log(`[截图请求] 超时: 设备=${deviceId}, requestId=${requestId}, 耗时=${elapsed}ms`);
    }
  }, config.SCREENSHOT_REQUEST_TIMEOUT_MS);

  io.to(`device:${deviceId}`).emit('screenshot-request', {
    request_id: requestId,
    requested_by: 'web',
    timestamp: Date.now(),
  });
}

module.exports = { initSocketIO, requestScreenshotFromDevice };
