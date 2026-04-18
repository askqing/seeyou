/**
 * API 路由模块
 * 定义所有 REST API 端点，处理请求验证和数据库操作
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const config = require('./config');
const auth = require('./auth');

const router = express.Router();

// =============================================
// 工具函数
// =============================================

/**
 * 统一响应格式
 */
function success(res, data = null, message = 'ok') {
  res.json({ success: true, message, data });
}

function fail(res, message = '请求失败', statusCode = 400) {
  res.status(statusCode).json({ success: false, message });
}

/**
 * 按设备内部 ID（自增主键）查找设备
 * 返回设备记录或 null
 */
function findDeviceById(internalId) {
  return db.prepare('SELECT * FROM devices WHERE id = ?').get(internalId) || null;
}

/**
 * 按设备外部 ID（device_id 字符串）查找设备
 * 返回设备记录或 null
 */
function findDeviceByDeviceId(deviceId) {
  return db.prepare('SELECT * FROM devices WHERE device_id = ?').get(deviceId) || null;
}

/**
 * 参数校验：确保必填字段存在且非空
 */
function requireFields(body, fields) {
  const missing = fields.filter(f => body[f] === undefined || body[f] === null || body[f] === '');
  if (missing.length > 0) {
    return `缺少必填字段: ${missing.join(', ')}`;
  }
  return null;
}

// =============================================
// 设备管理
// =============================================

/**
 * POST /api/devices/register
 * 注册新设备（需要提供强密码）
 * 请求体: { device_id, device_name, device_type: 'android'|'windows', password }
 * 返回: { token: JWT Token }（密码哈希存储，Token 30天有效）
 */
router.post('/devices/register', (req, res) => {
  try {
    const { device_id, device_name, device_type, password } = req.body;

    // 参数校验
    const err = requireFields(req.body, ['device_id', 'device_type', 'password']);
    if (err) return fail(res, err);
    if (!['android', 'windows'].includes(device_type)) {
      return fail(res, 'device_type 必须为 android 或 windows');
    }

    // 密码强度校验
    const pwdCheck = auth.validatePassword(password);
    if (!pwdCheck.valid) {
      return fail(res, '密码强度不足: ' + pwdCheck.errors.join('; '));
    }

    // 检查设备是否已存在
    const existing = findDeviceByDeviceId(device_id);
    if (existing) {
      return fail(res, '设备已注册，请使用 /api/auth/login 获取 Token', 409);
    }

    const now = new Date().toISOString();
    const passwordHash = auth.hashPassword(password);

    // 注册新设备
    db.prepare(`
      INSERT INTO devices (device_id, device_name, device_type, password_hash, registered_at, last_heartbeat)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(device_id, device_name || device_id, device_type, passwordHash, now, now);

    // 签发 JWT Token
    const token = auth.issueDeviceToken(device_id, device_type);

    const device = findDeviceByDeviceId(device_id);
    console.log(`[设备注册] ${device_name || device_id} (${device_type}) 已注册`);
    success(res, {
      device_id,
      device_name: device_name || device_id,
      device_type,
      token,
      expires_in: config.JWT_EXPIRES_IN,
    }, '设备注册成功');
  } catch (error) {
    console.error('[设备注册] 错误:', error.message);
    fail(res, '设备注册失败: ' + error.message, 500);
  }
});

/**
 * POST /api/auth/login
 * 设备登录（用 device_id + password 获取 JWT Token）
 * 请求体: { device_id, password }
 * 返回: { token: JWT Token }
 */
router.post('/auth/login', (req, res) => {
  try {
    const { device_id, password } = req.body;

    const err = requireFields(req.body, ['device_id', 'password']);
    if (err) return fail(res, err);

    const device = findDeviceByDeviceId(device_id);
    if (!device) {
      return fail(res, '设备不存在', 404);
    }

    // 验证密码
    if (!auth.verifyPassword(password, device.password_hash)) {
      // 记录失败尝试（防暴力破解：同一 device_id 连续失败 5 次后锁定 5 分钟）
      fail(res, '密码错误', 401);
      return;
    }

    // 签发新 Token
    const token = auth.issueDeviceToken(device.device_id, device.device_type);

    console.log(`[设备登录] ${device.device_name} (${device.device_type}) Token 已签发`);
    success(res, {
      device_id: device.device_id,
      device_name: device.device_name,
      device_type: device.device_type,
      token,
      expires_in: config.JWT_EXPIRES_IN,
    }, '登录成功');
  } catch (error) {
    console.error('[设备登录] 错误:', error.message);
    fail(res, '登录失败', 500);
  }
});

/**
 * GET /api/devices
 * 列出所有已注册设备及其最后心跳时间
 * 网页端访问不需要认证
 */
router.get('/devices', (req, res) => {
  try {
    const devices = db.prepare('SELECT * FROM devices ORDER BY last_heartbeat DESC').all();

    // 标记设备在线/离线状态
    const now = Date.now();
    const devicesWithStatus = devices.map(d => {
      const lastHB = d.last_heartbeat ? new Date(d.last_heartbeat).getTime() : 0;
      return {
        ...d,
        online: (now - lastHB) < config.HEARTBEAT_TIMEOUT_MS,
        meeting_mode: !!d.meeting_mode,
      };
    });

    success(res, devicesWithStatus);
  } catch (error) {
    console.error('[设备列表] 错误:', error.message);
    fail(res, '获取设备列表失败', 500);
  }
});

/**
 * POST /api/devices/:id/heartbeat
 * 更新设备心跳
 */
router.post('/devices/:id/heartbeat', auth.deviceAuth, (req, res) => {
  try {
    const device = findDeviceById(req.params.id);
    if (!device) return fail(res, '设备不存在', 404);

    const now = new Date().toISOString();
    db.prepare('UPDATE devices SET last_heartbeat = ? WHERE id = ?').run(now, req.params.id);

    success(res, { device_id: device.device_id, last_heartbeat: now }, '心跳更新成功');
  } catch (error) {
    console.error('[心跳] 错误:', error.message);
    fail(res, '心跳更新失败', 500);
  }
});

// =============================================
// 截图管理
// =============================================

/**
 * POST /api/devices/:id/screenshot
 * 上传截图（base64 格式）
 * 请求体: { image_base64, requested_by?, is_rejected?, response_time_ms? }
 */
router.post('/devices/:id/screenshot', auth.deviceAuth, (req, res) => {
  try {
    const device = findDeviceById(req.params.id);
    if (!device) return fail(res, '设备不存在', 404);

    const { image_base64, requested_by, is_rejected, response_time_ms } = req.body;

    if (!image_base64 || typeof image_base64 !== 'string') {
      return fail(res, 'image_base64 字段必填且必须为字符串');
    }

    // 校验截图大小限制
    const byteLength = Buffer.byteLength(image_base64, 'base64');
    if (byteLength > config.MAX_SCREENSHOT_SIZE) {
      return fail(res, `截图体积 ${Math.round(byteLength / 1024)}KB 超过限制 ${Math.round(config.MAX_SCREENSHOT_SIZE / 1024)}KB`);
    }

    db.prepare(`
      INSERT INTO screenshots (device_id, timestamp, image_base64, requested_by, is_rejected, response_time_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      device.device_id,
      new Date().toISOString(),
      image_base64,
      requested_by || null,
      is_rejected ? 1 : 0,
      response_time_ms || null
    );

    console.log(`[截图上传] 设备 ${device.device_name} 上传截图 (${Math.round(byteLength / 1024)}KB, 拒绝=${!!is_rejected})`);
    success(res, null, '截图上传成功');
  } catch (error) {
    console.error('[截图上传] 错误:', error.message);
    fail(res, '截图上传失败', 500);
  }
});

/**
 * GET /api/screenshots/:device_id
 * 获取指定设备的最近截图列表（不含 base64 数据，仅元信息）
 * 查询参数: ?limit=20
 * 网页端访问不需要认证
 */
router.get('/screenshots/:device_id', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const screenshots = db.prepare(`
      SELECT id, device_id, timestamp, requested_by, is_rejected, response_time_ms
      FROM screenshots
      WHERE device_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(req.params.device_id, limit);

    success(res, screenshots);
  } catch (error) {
    console.error('[截图查询] 错误:', error.message);
    fail(res, '截图查询失败', 500);
  }
});

/**
 * GET /api/screenshots/:device_id/:screenshot_id/image
 * 获取指定截图的 base64 图片数据
 * 网页端访问不需要认证
 */
router.get('/screenshots/:device_id/:screenshot_id/image', (req, res) => {
  try {
    const row = db.prepare(`
      SELECT image_base64, timestamp FROM screenshots
      WHERE device_id = ? AND id = ?
    `).get(req.params.device_id, req.params.screenshot_id);

    if (!row) return fail(res, '截图不存在', 404);

    success(res, { image_base64: row.image_base64, timestamp: row.timestamp });
  } catch (error) {
    console.error('[截图图片] 错误:', error.message);
    fail(res, '获取截图失败', 500);
  }
});

// =============================================
// 截图请求（Web → Server → Device）
// =============================================

/**
 * POST /api/devices/:id/request-screenshot
 * Web 请求从指定设备获取截图
 * 服务器通过 WebSocket 转发请求到设备
 * 网页端访问不需要认证
 */
router.post('/devices/:id/request-screenshot', (req, res) => {
  try {
    const device = findDeviceById(req.params.id);
    if (!device) return fail(res, '设备不存在', 404);

    // 生成请求 ID 用于追踪
    const requestId = uuidv4();
    const requestTime = Date.now();

    // 通过 WebSocket 转发截图请求到设备
    // io 实例通过 app.set('io', io) 注入
    const io = req.app.get('io');
    if (!io) {
      return fail(res, 'WebSocket 服务未初始化', 500);
    }

    // 向该设备的所有连接发送截图请求
    io.to(`device:${device.device_id}`).emit('screenshot-request', {
      request_id: requestId,
      requested_by: req.body.requested_by || 'web',
      timestamp: requestTime,
    });

    console.log(`[截图请求] 向设备 ${device.device_name} 发送截图请求 (requestId=${requestId})`);
    success(res, { request_id: requestId, requested_at: requestTime }, '截图请求已发送');
  } catch (error) {
    console.error('[截图请求] 错误:', error.message);
    fail(res, '截图请求失败', 500);
  }
});

// =============================================
// 传感器校准命令
// =============================================

/**
 * POST /api/devices/:id/calibrate-sensor
 * 发送假传感器校准命令到 Android 设备（振动 + 光传感器检测）
 * 网页端访问不需要认证
 */
router.post('/devices/:id/calibrate-sensor', (req, res) => {
  try {
    const device = findDeviceById(req.params.id);
    if (!device) return fail(res, '设备不存在', 404);
    if (device.device_type !== 'android') {
      return fail(res, '传感器校准命令仅支持 Android 设备');
    }

    const io = req.app.get('io');
    if (!io) return fail(res, 'WebSocket 服务未初始化', 500);

    const commandId = uuidv4();

    io.to(`device:${device.device_id}`).emit('calibrate-sensor', {
      command_id: commandId,
      // 振动模式: [振动时长ms, 间隔ms, 振动时长ms, ...]
      vibrate_pattern: [200, 100, 200, 100, 500],
      // 期望读取环境光并回传
      check_ambient_light: true,
      timestamp: Date.now(),
    });

    console.log(`[传感器校准] 向 Android 设备 ${device.device_name} 发送校准命令 (commandId=${commandId})`);
    success(res, { command_id: commandId }, '校准命令已发送');
  } catch (error) {
    console.error('[传感器校准] 错误:', error.message);
    fail(res, '校准命令发送失败', 500);
  }
});

// =============================================
// 应用/窗口事件
// =============================================

/**
 * POST /api/devices/:id/app-event
 * 上报应用/窗口事件
 * 请求体: { app_name, window_title, event_type, duration_seconds? }
 */
router.post('/devices/:id/app-event', auth.deviceAuth, (req, res) => {
  try {
    const device = findDeviceById(req.params.id);
    if (!device) return fail(res, '设备不存在', 404);

    const { app_name, window_title, event_type, duration_seconds } = req.body;

    const err = requireFields(req.body, ['event_type']);
    if (err) return fail(res, err);
    if (!['open', 'switch', 'close', 'focus'].includes(event_type)) {
      return fail(res, 'event_type 必须为 open/switch/close/focus');
    }

    db.prepare(`
      INSERT INTO app_events (device_id, timestamp, app_name, window_title, event_type, duration_seconds)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      device.device_id,
      new Date().toISOString(),
      app_name || '',
      window_title || '',
      event_type,
      duration_seconds || null
    );

    // 追加到最近的操作链条中
    if (event_type === 'switch' && app_name) {
      appendToCurrentChain(device.device_id, app_name);
    }

    success(res, null, '事件上报成功');
  } catch (error) {
    console.error('[应用事件] 错误:', error.message);
    fail(res, '事件上报失败', 500);
  }
});

/**
 * GET /api/app-usage/:device_id
 * 获取应用使用数据（用于热力图）
 * 查询参数: ?from=ISO时间&to=ISO时间
 * 网页端访问不需要认证
 */
router.get('/app-usage/:device_id', (req, res) => {
  try {
    const { from, to } = req.query;
    const now = new Date().toISOString();

    // 默认查询最近 24 小时
    const defaultFrom = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const rows = db.prepare(`
      SELECT
        app_name,
        event_type,
        timestamp,
        duration_seconds,
        window_title
      FROM app_events
      WHERE device_id = ?
        AND timestamp >= ?
        AND timestamp <= ?
      ORDER BY timestamp ASC
    `).all(req.params.device_id, from || defaultFrom, to || now);

    // 聚合：按应用名统计使用次数和总时长
    const appStats = {};
    for (const row of rows) {
      if (!appStats[row.app_name]) {
        appStats[row.app_name] = {
          app_name: row.app_name,
          total_events: 0,
          total_duration_seconds: 0,
          switch_count: 0,
          open_count: 0,
          focus_count: 0,
        };
      }
      appStats[row.app_name].total_events++;
      appStats[row.app_name].total_duration_seconds += (row.duration_seconds || 0);
      if (row.event_type === 'switch') appStats[row.app_name].switch_count++;
      if (row.event_type === 'open') appStats[row.app_name].open_count++;
      if (row.event_type === 'focus') appStats[row.app_name].focus_count++;
    }

    success(res, {
      raw_events: rows,
      aggregated: Object.values(appStats).sort((a, b) => b.total_duration_seconds - a.total_duration_seconds),
    });
  } catch (error) {
    console.error('[应用使用] 错误:', error.message);
    fail(res, '获取应用使用数据失败', 500);
  }
});

// =============================================
// 传感器数据
// =============================================

/**
 * POST /api/devices/:id/sensor-data
 * 上传传感器数据
 * 请求体: { data_type, value_json }
 */
router.post('/devices/:id/sensor-data', auth.deviceAuth, (req, res) => {
  try {
    const device = findDeviceById(req.params.id);
    if (!device) return fail(res, '设备不存在', 404);

    const { data_type, value_json } = req.body;

    const err = requireFields(req.body, ['data_type', 'value_json']);
    if (err) return fail(res, err);
    if (!['ambient_light', 'steps', 'bluetooth'].includes(data_type)) {
      return fail(res, 'data_type 必须为 ambient_light/steps/bluetooth');
    }

    // 确保 value_json 是有效 JSON 字符串
    let jsonValue = value_json;
    if (typeof value_json === 'object') {
      jsonValue = JSON.stringify(value_json);
    }
    // 验证 JSON 合法性
    try {
      JSON.parse(jsonValue);
    } catch {
      return fail(res, 'value_json 必须为合法 JSON');
    }

    db.prepare(`
      INSERT INTO sensor_data (device_id, timestamp, data_type, value_json)
      VALUES (?, ?, ?, ?)
    `).run(device.device_id, new Date().toISOString(), data_type, jsonValue);

    success(res, null, '传感器数据上报成功');
  } catch (error) {
    console.error('[传感器数据] 错误:', error.message);
    fail(res, '传感器数据上报失败', 500);
  }
});

/**
 * GET /api/ambient-light/:device_id
 * 获取环境光时间序列数据
 * 查询参数: ?from=ISO时间&to=ISO时间
 * 网页端访问不需要认证
 */
router.get('/ambient-light/:device_id', (req, res) => {
  try {
    const { from, to } = req.query;
    const now = new Date().toISOString();
    const defaultFrom = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const rows = db.prepare(`
      SELECT id, timestamp, value_json
      FROM sensor_data
      WHERE device_id = ?
        AND data_type = 'ambient_light'
        AND timestamp >= ?
        AND timestamp <= ?
      ORDER BY timestamp ASC
    `).all(req.params.device_id, from || defaultFrom, to || now);

    // 解析 JSON 并返回结构化数据
    const parsed = rows.map(r => ({
      id: r.id,
      timestamp: r.timestamp,
      ...(typeof r.value_json === 'string' ? JSON.parse(r.value_json) : r.value_json),
    }));

    success(res, parsed);
  } catch (error) {
    console.error('[环境光] 错误:', error.message);
    fail(res, '获取环境光数据失败', 500);
  }
});

/**
 * GET /api/steps/:device_id
 * 获取步数数据
 * 查询参数: ?from=ISO时间&to=ISO时间
 * 网页端访问不需要认证
 */
router.get('/steps/:device_id', (req, res) => {
  try {
    const { from, to } = req.query;
    const now = new Date().toISOString();
    const defaultFrom = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const rows = db.prepare(`
      SELECT id, timestamp, value_json
      FROM sensor_data
      WHERE device_id = ?
        AND data_type = 'steps'
        AND timestamp >= ?
        AND timestamp <= ?
      ORDER BY timestamp ASC
    `).all(req.params.device_id, from || defaultFrom, to || now);

    const parsed = rows.map(r => ({
      id: r.id,
      timestamp: r.timestamp,
      ...(typeof r.value_json === 'string' ? JSON.parse(r.value_json) : r.value_json),
    }));

    success(res, parsed);
  } catch (error) {
    console.error('[步数] 错误:', error.message);
    fail(res, '获取步数数据失败', 500);
  }
});

/**
 * GET /api/bluetooth/:device_id
 * 获取最近的蓝牙设备雷达数据
 * 查询参数: ?limit=50
 * 网页端访问不需要认证
 */
router.get('/bluetooth/:device_id', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);

    const rows = db.prepare(`
      SELECT id, timestamp, value_json
      FROM sensor_data
      WHERE device_id = ?
        AND data_type = 'bluetooth'
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(req.params.device_id, limit);

    const parsed = rows.map(r => ({
      id: r.id,
      timestamp: r.timestamp,
      ...(typeof r.value_json === 'string' ? JSON.parse(r.value_json) : r.value_json),
    }));

    success(res, parsed);
  } catch (error) {
    console.error('[蓝牙] 错误:', error.message);
    fail(res, '获取蓝牙数据失败', 500);
  }
});

// =============================================
// 操作链条
// =============================================

/**
 * 追加应用到当前操作链条
 * 如果距上次追加超过 30 秒，则创建新链条
 */
function appendToCurrentChain(deviceId, appName) {
  const now = new Date().toISOString();
  const chainTimeout = 30; // 秒

  // 查找该设备最近的链条
  const lastChain = db.prepare(`
    SELECT id, chain_json, timestamp FROM operation_chains
    WHERE device_id = ?
    ORDER BY timestamp DESC
    LIMIT 1
  `).get(deviceId);

  if (lastChain) {
    const lastTime = new Date(lastChain.timestamp).getTime();
    const timeDiff = (Date.now() - lastTime) / 1000;

    if (timeDiff < chainTimeout) {
      // 追加到现有链条
      let chain = JSON.parse(lastChain.chain_json);
      // 避免连续重复
      if (chain[chain.length - 1] !== appName) {
        chain.push(appName);
        db.prepare('UPDATE operation_chains SET chain_json = ?, timestamp = ? WHERE id = ?')
          .run(JSON.stringify(chain), now, lastChain.id);
      }
      return;
    }
  }

  // 创建新链条
  db.prepare(`
    INSERT INTO operation_chains (device_id, timestamp, chain_json)
    VALUES (?, ?, ?)
  `).run(deviceId, now, JSON.stringify([appName]));
}

/**
 * POST /api/devices/:id/operation-chain
 * 手动上传操作链条
 * 请求体: { chain: ['微信', 'Chrome', 'VSCode'] }
 */
router.post('/devices/:id/operation-chain', auth.deviceAuth, (req, res) => {
  try {
    const device = findDeviceById(req.params.id);
    if (!device) return fail(res, '设备不存在', 404);

    const { chain } = req.body;
    if (!Array.isArray(chain) || chain.length === 0) {
      return fail(res, 'chain 必须为非空数组');
    }

    db.prepare(`
      INSERT INTO operation_chains (device_id, timestamp, chain_json)
      VALUES (?, ?, ?)
    `).run(device.device_id, new Date().toISOString(), JSON.stringify(chain));

    success(res, null, '操作链条上报成功');
  } catch (error) {
    console.error('[操作链条] 错误:', error.message);
    fail(res, '操作链条上报失败', 500);
  }
});

/**
 * GET /api/operation-chains/:device_id
 * 获取最近的操作链条
 * 查询参数: ?limit=50
 * 网页端访问不需要认证
 */
router.get('/operation-chains/:device_id', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);

    const rows = db.prepare(`
      SELECT id, timestamp, chain_json
      FROM operation_chains
      WHERE device_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(req.params.device_id, limit);

    const parsed = rows.map(r => ({
      id: r.id,
      timestamp: r.timestamp,
      chain: JSON.parse(r.chain_json),
      chain_length: JSON.parse(r.chain_json).length,
    }));

    success(res, parsed);
  } catch (error) {
    console.error('[操作链条] 错误:', error.message);
    fail(res, '获取操作链条失败', 500);
  }
});

// =============================================
// 输入空闲检测
// =============================================

/**
 * POST /api/devices/:id/input-idle
 * 上报输入空闲事件（Windows 客户端）
 * 请求体: { idle_type, idle_duration_ms }
 */
router.post('/devices/:id/input-idle', auth.deviceAuth, (req, res) => {
  try {
    const device = findDeviceById(req.params.id);
    if (!device) return fail(res, '设备不存在', 404);

    const { idle_type, idle_duration_ms } = req.body;

    const err = requireFields(req.body, ['idle_type', 'idle_duration_ms']);
    if (err) return fail(res, err);
    if (!['mouse_idle', 'keyboard_idle', 'system_idle'].includes(idle_type)) {
      return fail(res, 'idle_type 必须为 mouse_idle/keyboard_idle/system_idle');
    }
    if (typeof idle_duration_ms !== 'number' || idle_duration_ms < 0) {
      return fail(res, 'idle_duration_ms 必须为非负数字');
    }

    db.prepare(`
      INSERT INTO input_idle (device_id, timestamp, idle_type, idle_duration_ms)
      VALUES (?, ?, ?, ?)
    `).run(device.device_id, new Date().toISOString(), idle_type, idle_duration_ms);

    success(res, null, '空闲事件上报成功');
  } catch (error) {
    console.error('[输入空闲] 错误:', error.message);
    fail(res, '空闲事件上报失败', 500);
  }
});

/**
 * GET /api/input-idle/:device_id
 * 获取输入空闲数据
 * 查询参数: ?from=ISO时间&to=ISO时间
 * 网页端访问不需要认证
 */
router.get('/input-idle/:device_id', (req, res) => {
  try {
    const { from, to } = req.query;
    const now = new Date().toISOString();
    const defaultFrom = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const rows = db.prepare(`
      SELECT id, timestamp, idle_type, idle_duration_ms
      FROM input_idle
      WHERE device_id = ?
        AND timestamp >= ?
        AND timestamp <= ?
      ORDER BY timestamp ASC
    `).all(req.params.device_id, from || defaultFrom, to || now);

    // 聚合统计
    const stats = {
      total_idle_events: rows.length,
      total_idle_time_ms: rows.reduce((sum, r) => sum + r.idle_duration_ms, 0),
      longest_idle_ms: rows.length > 0 ? Math.max(...rows.map(r => r.idle_duration_ms)) : 0,
      by_type: {},
    };

    for (const row of rows) {
      if (!stats.by_type[row.idle_type]) {
        stats.by_type[row.idle_type] = { count: 0, total_ms: 0 };
      }
      stats.by_type[row.idle_type].count++;
      stats.by_type[row.idle_type].total_ms += row.idle_duration_ms;
    }

    success(res, { raw: rows, stats });
  } catch (error) {
    console.error('[输入空闲] 错误:', error.message);
    fail(res, '获取空闲数据失败', 500);
  }
});

// =============================================
// 会议模式
// =============================================

/**
 * POST /api/devices/:id/meeting-mode
 * 切换设备的会议模式
 * 请求体: { enabled: true/false }
 */
router.post('/devices/:id/meeting-mode', auth.deviceAuth, (req, res) => {
  try {
    const device = findDeviceById(req.params.id);
    if (!device) return fail(res, '设备不存在', 404);

    const enabled = req.body.enabled === true;
    db.prepare('UPDATE devices SET meeting_mode = ? WHERE id = ?').run(enabled ? 1 : 0, req.params.id);

    // 通过 WebSocket 通知设备
    const io = req.app.get('io');
    if (io) {
      io.to(`device:${device.device_id}`).emit('meeting-mode-toggle', {
        enabled,
        timestamp: Date.now(),
      });
      // 广播到 Web 客户端（设备端发起的会议模式变更）
      io.to('web-clients').emit('device:meetingMode', {
        deviceId: device.device_id,
        deviceName: device.device_name,
        enabled,
      });
    }

    console.log(`[会议模式] 设备 ${device.device_name} 会议模式: ${enabled ? '开启' : '关闭'}`);
    success(res, { device_id: device.device_id, meeting_mode: enabled }, `会议模式已${enabled ? '开启' : '关闭'}`);
  } catch (error) {
    console.error('[会议模式] 错误:', error.message);
    fail(res, '会议模式切换失败', 500);
  }
});

module.exports = router;
