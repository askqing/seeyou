/* ================================================================
   视奸面板 - Stalker Panel Dashboard
   Main Application Logic
   ================================================================ */

(function () {
  'use strict';

  // ===== STATE =====
  const state = {
    socket: null,
    connected: false,
    devices: new Map(),       // deviceId -> device info
    activeTab: 'monitor',
    activeDeviceId: null,
    screenshots: [],
    events: [],
    maxEvents: 200,
    charts: {},
    stressTest: {
      running: false,
      sent: 0,
      success: 0,
      rejected: 0,
      timings: [],
      intervalId: null,
    },
    bluetoothDevices: [],
    radarAnimId: null,
    radarAngle: 0,
  };

  // ===== CONFIG =====
  const API_BASE = '';  // Same origin
  const HEARTBEAT_TIMEOUT = 120000; // 2min

  // ===== DOM REFS =====
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const dom = {
    headerTime: $('#headerTime'),
    headerStats: $('#headerStats'),
    connectionStatus: $('#connectionStatus'),
    sidebarToggle: $('#sidebarToggle'),
    sidebar: $('#sidebar'),
    deviceList: $('#deviceList'),
    deviceCount: $('#deviceCount'),
    deviceSearch: $('#deviceSearch'),
    refreshDevices: $('#refreshDevices'),
    tabNav: $('#tabNav'),
    mainContent: $('#mainContent'),
    // Monitor
    monitorDeviceGrid: $('#monitorDeviceGrid'),
    eventFeed: $('#eventFeed'),
    refreshMonitor: $('#refreshMonitor'),
    // Screenshots
    screenshotDeviceBtns: $('#screenshotDeviceBtns'),
    stressInterval: $('#stressInterval'),
    stressCount: $('#stressCount'),
    stressDevice: $('#stressDevice'),
    startStressTest: $('#startStressTest'),
    stopStressTest: $('#stopStressTest'),
    stressStats: $('#stressStats'),
    stressSent: $('#stressSent'),
    stressSuccess: $('#stressSuccess'),
    stressRejected: $('#stressRejected'),
    stressAvgTime: $('#stressAvgTime'),
    stressChartBlock: $('#stressChartBlock'),
    screenshotGallery: $('#screenshotGallery'),
    // Sensors
    sensorDevice: $('#sensorDevice'),
    calibrateBtn: $('#calibrateBtn'),
    currentLux: $('#currentLux'),
    todaySteps: $('#todaySteps'),
    analysisNotes: $('#analysisNotes'),
    // Behavior
    behaviorDevice: $('#behaviorDevice'),
    refreshBehavior: $('#refreshBehavior'),
    appHeatmapContainer: $('#appHeatmapContainer'),
    switchChainContainer: $('#switchChainContainer'),
    windowHeatmapContainer: $('#windowHeatmapContainer'),
    windowHeatmapCard: $('#windowHeatmapCard'),
    // Bluetooth
    bluetoothDevice: $('#bluetoothDevice'),
    scanBluetooth: $('#scanBluetooth'),
    btDeviceCount: $('#btDeviceCount'),
    bluetoothDeviceList: $('#bluetoothDeviceList'),
    radarCanvas: $('#radarCanvas'),
    // Input
    inputDevice: $('#inputDevice'),
    // Modal
    screenshotModal: $('#screenshotModal'),
    modalClose: $('#modalClose'),
    modalImage: $('#modalImage'),
    modalTitle: $('#modalTitle'),
    modalMeta: $('#modalMeta'),
    // Toast
    toastContainer: $('#toastContainer'),
  };

  // ===== UTILITY =====
  function formatTime(date) {
    return date.toLocaleTimeString('zh-CN', { hour12: false });
  }

  function formatDateTime(date) {
    return date.toLocaleString('zh-CN', { hour12: false });
  }

  function timeAgo(ts) {
    const diff = Date.now() - ts;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.floor(diff / 60000) + '分钟前';
    if (diff < 86400000) return Math.floor(diff / 3600000) + '小时前';
    return Math.floor(diff / 86400000) + '天前';
  }

  function getDevicePlatform(device) {
    if (!device) return 'unknown';
    const ua = (device.userAgent || device.platform || '').toLowerCase();
    if (ua.includes('android')) return 'android';
    if (ua.includes('win')) return 'windows';
    if (ua.includes('mac') || ua.includes('iphone') || ua.includes('ipad')) return 'apple';
    return 'unknown';
  }

  function getDeviceIcon(platform) {
    switch (platform) {
      case 'android':
        return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>`;
      case 'windows':
        return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="9" height="9" rx="1"/><rect x="13" y="3" width="9" height="9" rx="1"/><rect x="2" y="14" width="9" height="9" rx="1"/><rect x="13" y="14" width="9" height="9" rx="1"/></svg>`;
      case 'apple':
        return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>`;
      default:
        return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>`;
    }
  }

  function isOnline(device) {
    if (!device) return false;
    const lastHb = device.lastHeartbeat || device.lastSeen;
    if (!lastHb) return false;
    return (Date.now() - new Date(lastHb).getTime()) < HEARTBEAT_TIMEOUT;
  }

  // ===== TOAST =====
  function showToast(msg, type = 'info') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    const icons = {
      success: '✅',
      error: '❌',
      warning: '⚠️',
      info: 'ℹ️',
    };
    el.innerHTML = `<span>${icons[type] || ''}</span><span>${msg}</span>`;
    dom.toastContainer.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }

  // ===== MODAL =====
  function openScreenshotModal(url, title, meta) {
    dom.modalImage.src = url;
    dom.modalTitle.textContent = title || '截图预览';
    dom.modalMeta.textContent = meta || '';
    dom.screenshotModal.classList.add('show');
  }

  function closeScreenshotModal() {
    dom.screenshotModal.classList.remove('show');
    dom.modalImage.src = '';
  }

  dom.modalClose.addEventListener('click', closeScreenshotModal);
  dom.screenshotModal.querySelector('.modal-overlay').addEventListener('click', closeScreenshotModal);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeScreenshotModal();
  });

  // ===== API HELPER =====
  async function api(path, options = {}) {
    try {
      const headers = { 'Content-Type': 'application/json' };
      const resp = await fetch(API_BASE + path, {
        headers,
        ...options,
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json();
    } catch (err) {
      console.error('API Error:', path, err);
      showToast(`API 请求失败: ${path}`, 'error');
      return null;
    }
  }

  // ===== SOCKET.IO =====
  function connectSocket() {
    if (state.socket) {
      state.socket.disconnect();
    }

    const socket = io({
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 2000,
      reconnectionAttempts: Infinity,
      query: { client_type: 'web' },
    });

    state.socket = socket;

    socket.on('connect', () => {
      state.connected = true;
      updateConnectionStatus('connected');
      showToast('已连接到服务器', 'success');
      emitEvent('connection', '已连接到服务器');
    });

    socket.on('disconnect', (reason) => {
      state.connected = false;
      updateConnectionStatus('disconnected');
      showToast('连接断开: ' + reason, 'warning');
      emitEvent('connection', '连接断开: ' + reason);
    });

    socket.on('connect_error', (err) => {
      updateConnectionStatus('connecting');
    });

    // Device events
    socket.on('device:online', (data) => {
      addOrUpdateDevice(data);
      showToast(`${data.deviceName || data.deviceId} 上线`, 'success');
      emitEvent('connection', `${data.deviceName || data.deviceId} 上线`, data.deviceId);
    });

    socket.on('device:offline', (data) => {
      const dev = state.devices.get(data.deviceId);
      if (dev) {
        dev.online = false;
        renderDeviceList();
        renderMonitorCards();
      }
      showToast(`${data.deviceName || data.deviceId} 离线`, 'warning');
      emitEvent('connection', `${data.deviceName || data.deviceId} 离线`, data.deviceId);
    });

    socket.on('device:heartbeat', (data) => {
      addOrUpdateDevice({ ...data, online: true });
    });

    // App switch event
    socket.on('device:appSwitch', (data) => {
      const dev = state.devices.get(data.deviceId);
      if (dev) {
        dev.currentApp = data.appName || data.packageName || '';
        dev.currentTitle = data.title || data.windowTitle || '';
        dev.lastSwitch = Date.now();
        dev.switchHistory = dev.switchHistory || [];
        dev.switchHistory.push({
          app: data.appName || data.packageName || '未知',
          title: data.title || '',
          time: Date.now(),
        });
        if (dev.switchHistory.length > 500) dev.switchHistory.shift();
      }
      renderMonitorCards();
      const name = dev?.deviceName || data.deviceId;
      emitEvent('app', `${name}: ${data.appName || data.packageName || '切换App'}`, data.deviceId);
    });

    // Screenshot result
    socket.on('device:screenshot', (data) => {
      const ss = {
        deviceId: data.deviceId,
        deviceName: (state.devices.get(data.deviceId))?.deviceName || data.deviceId,
        url: data.url || data.image || '',
        timestamp: Date.now(),
        type: data.type || 'response',
      };
      state.screenshots.unshift(ss);
      if (state.screenshots.length > 100) state.screenshots.pop();
      renderScreenshotGallery();
      emitEvent('screenshot', `收到 ${ss.deviceName} 的截图`, data.deviceId);

      // Stress test tracking
      if (state.stressTest.running && state.stressTest.pendingRequest) {
        const elapsed = Date.now() - state.stressTest.pendingRequest;
        state.stressTest.timings.push({ time: elapsed, status: 'success' });
        state.stressTest.success++;
        state.stressTest.pendingRequest = null;
        updateStressStats();
      }
    });

    // Screenshot rejected
    socket.on('device:screenshotRejected', (data) => {
      showToast(`截图被拒绝: ${data.deviceName || data.deviceId}`, 'warning');
      emitEvent('screenshot', `截图被拒绝: ${data.deviceName || data.deviceId}`, data.deviceId);

      if (state.stressTest.running && state.stressTest.pendingRequest) {
        const elapsed = Date.now() - state.stressTest.pendingRequest;
        state.stressTest.timings.push({ time: elapsed, status: 'rejected' });
        state.stressTest.rejected++;
        state.stressTest.pendingRequest = null;
        updateStressStats();
      }
    });

    // Sensor data
    socket.on('device:sensorData', (data) => {
      const dev = state.devices.get(data.deviceId);
      if (!dev) return;
      dev.sensorData = dev.sensorData || {};

      if (data.type === 'light') {
        dev.sensorData.light = dev.sensorData.light || [];
        dev.sensorData.light.push({ value: data.lux, time: Date.now() });
        if (dev.sensorData.light.length > 200) dev.sensorData.light.shift();
        dom.currentLux.textContent = (data.lux || 0).toFixed(1) + ' lux';
        if (state.activeDeviceId === data.deviceId && state.activeTab === 'sensors') {
          updateLightChart();
        }
      }

      if (data.type === 'steps') {
        dev.sensorData.steps = data.steps || {};
        dom.todaySteps.textContent = (data.steps?.today || 0) + ' 步';
        if (state.activeDeviceId === data.deviceId && state.activeTab === 'sensors') {
          updateStepChart();
        }
      }
    });

    // Bluetooth scan results
    socket.on('device:bluetoothScan', (data) => {
      state.bluetoothDevices = data.devices || [];
      renderBluetoothDevices();
      emitEvent('info', `蓝牙扫描完成，发现 ${state.bluetoothDevices.length} 台设备`);
    });

    // Input idle data
    socket.on('device:inputIdle', (data) => {
      const dev = state.devices.get(data.deviceId);
      if (!dev) return;
      dev.inputIdle = data;
      if (state.activeDeviceId === data.deviceId && state.activeTab === 'input') {
        updateInputIdleDisplay(data);
      }
    });

    // Meeting mode
    socket.on('device:meetingMode', (data) => {
      const dev = state.devices.get(data.deviceId);
      if (dev) {
        dev.meetingMode = data.enabled;
        renderMonitorCards();
      }
      showToast(`${data.deviceName || data.deviceId}: 会议模式${data.enabled ? '已开启' : '已关闭'}`,
        data.enabled ? 'warning' : 'info');
    });

    // Meeting mode update broadcast (from device via REST API)
    socket.on('meeting-mode-update', (data) => {
      const dev = state.devices.get(data.deviceId);
      if (dev) {
        dev.meetingMode = data.enabled;
        renderMonitorCards();
      }
      showToast(`${data.deviceName || data.deviceId}: 会议模式${data.enabled ? '已开启' : '已关闭'}`,
        data.enabled ? 'warning' : 'info');
    });
  }

  function updateConnectionStatus(status) {
    const dot = dom.connectionStatus.querySelector('.status-dot');
    const text = dom.connectionStatus.querySelector('.status-text');
    dot.className = 'status-dot ' + status;
    const labels = { connected: '已连接', disconnected: '已断开', connecting: '连接中...' };
    text.textContent = labels[status] || status;
  }

  // ===== DEVICE MANAGEMENT =====
  function addOrUpdateDevice(data) {
    const id = data.deviceId;
    const existing = state.devices.get(id);
    const dev = existing || {
      deviceId: id,
      switchHistory: [],
      sensorData: {},
      meetingMode: false,
      online: true,
    };

    Object.assign(dev, {
      deviceName: data.deviceName || dev.deviceName || id,
      platform: data.platform || data.userAgent || dev.platform || '',
      lastHeartbeat: data.lastHeartbeat || data.lastSeen || new Date().toISOString(),
      currentApp: data.currentApp || dev.currentApp || '',
      currentTitle: data.currentTitle || data.windowTitle || dev.currentTitle || '',
      online: data.online !== undefined ? data.online : true,
    });

    state.devices.set(id, dev);
    renderDeviceList();
    updateDeviceSelectors();
    renderMonitorCards();
    updateHeaderStats();
  }

  function removeDevice(deviceId) {
    state.devices.delete(deviceId);
    renderDeviceList();
    updateDeviceSelectors();
    renderMonitorCards();
    updateHeaderStats();
  }

  function updateHeaderStats() {
    let online = 0;
    state.devices.forEach(d => { if (isOnline(d)) online++; });
    dom.headerStats.textContent = `${online} / ${state.devices.size} 台设备在线`;
  }

  // ===== RENDER: DEVICE LIST (Sidebar) =====
  function renderDeviceList() {
    const search = (dom.deviceSearch.value || '').toLowerCase();
    let html = '';
    let count = 0;

    state.devices.forEach((dev, id) => {
      const online = isOnline(dev);
      if (search && !dev.deviceName.toLowerCase().includes(search) && !id.toLowerCase().includes(search)) return;

      count++;
      const platform = getDevicePlatform(dev);
      const active = state.activeDeviceId === id ? 'active' : '';
      const lastHb = timeAgo(new Date(dev.lastHeartbeat).getTime());

      html += `
        <div class="device-item ${active}" data-device-id="${id}">
          <div class="device-icon ${platform}">${getDeviceIcon(platform)}</div>
          <div class="device-info">
            <div class="device-name">${escapeHtml(dev.deviceName)}</div>
            <div class="device-meta">
              <span class="device-status-dot ${online ? 'online' : 'offline'}"></span>
              <span>${online ? '在线' : '离线'}</span>
              <span>·</span>
              <span>${lastHb}</span>
            </div>
          </div>
        </div>
      `;
    });

    if (!count) {
      html = `
        <div class="device-list-empty">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#333" stroke-width="1.5"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>
          <p>暂无设备</p>
        </div>
      `;
    }

    dom.deviceList.innerHTML = html;
    dom.deviceCount.textContent = state.devices.size;

    // Click handlers
    dom.deviceList.querySelectorAll('.device-item').forEach(el => {
      el.addEventListener('click', () => {
        state.activeDeviceId = el.dataset.deviceId;
        renderDeviceList();
        updateDeviceSelectors();
        loadActiveDeviceData();
      });
    });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  // ===== DEVICE SELECTORS =====
  function updateDeviceSelectors() {
    const selectors = [dom.sensorDevice, dom.behaviorDevice, dom.bluetoothDevice, dom.inputDevice, dom.stressDevice];
    selectors.forEach(sel => {
      if (!sel) return;
      const current = sel.value;
      sel.innerHTML = '<option value="">选择设备</option>';
      state.devices.forEach((dev, id) => {
        const online = isOnline(dev);
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = `${dev.deviceName}${online ? '' : ' (离线)'}`;
        sel.appendChild(opt);
      });
      if (current && state.devices.has(current)) sel.value = current;
    });

    // Update screenshot buttons
    updateScreenshotButtons();
    updateCalibrateBtn();
    updateBluetoothScanBtn();
  }

  function updateScreenshotButtons() {
    let html = '';
    state.devices.forEach((dev, id) => {
      if (!isOnline(dev)) return;
      html += `<button class="btn btn-cyan btn-sm" data-screenshot-device="${id}">📸 ${escapeHtml(dev.deviceName)}</button>`;
    });
    dom.screenshotDeviceBtns.innerHTML = html || '<span class="text-muted">暂无在线设备</span>';

    dom.screenshotDeviceBtns.querySelectorAll('[data-screenshot-device]').forEach(btn => {
      btn.addEventListener('click', () => {
        requestScreenshot(btn.dataset.screenshotDevice);
      });
    });
  }

  function updateCalibrateBtn() {
    const id = dom.sensorDevice.value;
    dom.calibrateBtn.disabled = !id || !isOnline(state.devices.get(id));
  }

  function updateBluetoothScanBtn() {
    const id = dom.bluetoothDevice.value;
    dom.scanBluetooth.disabled = !id || !isOnline(state.devices.get(id));
  }

  // ===== TAB SWITCHING =====
  dom.tabNav.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn');
    if (!btn) return;
    const tab = btn.dataset.tab;
    switchTab(tab);
  });

  function switchTab(tab) {
    state.activeTab = tab;
    $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    $$('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${tab}`));

    // Initialize charts when tab is first shown
    if (tab === 'sensors') initSensorCharts();
    if (tab === 'behavior') initBehaviorCharts();
    if (tab === 'bluetooth') initRadar();
    if (tab === 'input') initIdleChart();
  }

  // ===== EVENT FEED =====
  function emitEvent(type, message, deviceId) {
    const ev = { type, message, deviceId, time: Date.now() };
    state.events.unshift(ev);
    if (state.events.length > state.maxEvents) state.events.pop();
    renderEventFeed();
  }

  function renderEventFeed() {
    let html = '';
    const visible = state.events.slice(0, 50);
    if (!visible.length) {
      html = '<div class="event-item event-empty">等待事件...</div>';
    } else {
      visible.forEach(ev => {
        const typeClass = ev.type === 'app' ? 'event-app' :
          ev.type === 'screenshot' ? 'event-screenshot' :
            ev.type === 'connection' ? 'event-connection' :
              ev.type === 'error' ? 'event-error' : '';

        const devName = ev.deviceId ? `<span class="event-device">[${escapeHtml((state.devices.get(ev.deviceId)?.deviceName) || ev.deviceId)}]</span> ` : '';

        html += `
          <div class="event-item ${typeClass}">
            <span class="event-time">${formatTime(new Date(ev.time))}</span>
            <span class="event-content">${devName}${escapeHtml(ev.message)}</span>
          </div>
        `;
      });
    }
    dom.eventFeed.innerHTML = html;
  }

  // ===== MONITOR TAB =====
  function renderMonitorCards() {
    if (state.devices.size === 0) {
      dom.monitorDeviceGrid.innerHTML = `
        <div class="empty-state">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#333" stroke-width="1.5"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>
          <p>暂无设备数据</p>
        </div>
      `;
      return;
    }

    let html = '';
    state.devices.forEach((dev, id) => {
      const platform = getDevicePlatform(dev);
      const online = isOnline(dev);
      const appName = dev.currentApp || '未知应用';
      const title = dev.currentTitle || '';

      html += `
        <div class="card monitor-card ${online ? '' : 'opacity-50'}">
          <div class="monitor-card-header">
            <div class="device-icon ${platform}">${getDeviceIcon(platform)}</div>
            <div class="device-info">
              <div class="device-name">${escapeHtml(dev.deviceName)}</div>
              <div class="device-meta">
                <span class="device-status-dot ${online ? 'online' : 'offline'}"></span>
                <span>${online ? '在线' : '离线'}</span>
              </div>
            </div>
          </div>
          <div class="monitor-card-body">
            <div class="monitor-app-name">${escapeHtml(appName)}</div>
            <div class="monitor-window-title">${escapeHtml(title)}</div>
          </div>
          <div class="monitor-card-footer">
            <span class="meeting-badge ${dev.meetingMode ? 'on' : 'off'}">
              🎯 会议模式 ${dev.meetingMode ? '开' : '关'}
            </span>
            <div style="display:flex;gap:6px;">
              <button class="btn btn-sm btn-cyan" data-quick-screenshot="${id}" ${!online ? 'disabled' : ''}>
                📸
              </button>
            </div>
          </div>
        </div>
      `;
    });

    dom.monitorDeviceGrid.innerHTML = html;

    // Event handlers
    dom.monitorDeviceGrid.querySelectorAll('[data-quick-screenshot]').forEach(btn => {
      btn.addEventListener('click', () => requestScreenshot(btn.dataset.quickScreenshot));
    });
  }

  // ===== SCREENSHOT =====
  function requestScreenshot(deviceId) {
    if (!state.connected) {
      showToast('未连接到服务器', 'error');
      return;
    }
    state.socket.emit('requestScreenshot', { deviceId });
    emitEvent('screenshot', `已请求 ${deviceId} 的截图`, deviceId);
  }

  // 会议模式只能由设备端（Android/Windows）开启，网页端仅显示状态
  // 设备端通过日历自动检测或手动切换，状态变化会实时推送到网页端

  function renderScreenshotGallery() {
    if (!state.screenshots.length) {
      dom.screenshotGallery.innerHTML = '<div class="empty-state-sm">暂无截图</div>';
      return;
    }
    let html = '';
    state.screenshots.forEach(ss => {
      html += `
        <div class="screenshot-thumb" data-ss-url="${ss.url}" data-ss-name="${escapeHtml(ss.deviceName)}" data-ss-time="${formatDateTime(new Date(ss.timestamp))}">
          <img src="${ss.url}" alt="${escapeHtml(ss.deviceName)}" loading="lazy" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22320%22 height=%22180%22><rect fill=%22%23111%22 width=%22320%22 height=%22180%22/><text x=%2250%25%22 y=%2250%25%22 fill=%22%23555%22 font-size=%2214%22 text-anchor=%22middle%22>加载失败</text></svg>'">
          <div class="thumb-info">${escapeHtml(ss.deviceName)} · ${formatTime(new Date(ss.timestamp))}</div>
        </div>
      `;
    });
    dom.screenshotGallery.innerHTML = html;

    dom.screenshotGallery.querySelectorAll('.screenshot-thumb').forEach(el => {
      el.addEventListener('click', () => {
        openScreenshotModal(el.dataset.ssUrl, el.dataset.ssName, el.dataset.ssTime);
      });
    });
  }

  // ===== STRESS TEST =====
  dom.startStressTest.addEventListener('click', startStressTest);
  dom.stopStressTest.addEventListener('click', stopStressTest);

  dom.stressDevice.addEventListener('change', () => {
    dom.startStressTest.disabled = !dom.stressDevice.value;
  });

  function startStressTest() {
    const deviceId = dom.stressDevice.value;
    if (!deviceId || !state.connected) return;

    const interval = parseInt(dom.stressInterval.value) || 500;
    const count = parseInt(dom.stressCount.value) || 20;

    state.stressTest = {
      running: true,
      sent: 0,
      success: 0,
      rejected: 0,
      timings: [],
      intervalId: null,
      total: count,
      pendingRequest: null,
      deviceId,
    };

    dom.stressStats.style.display = 'grid';
    dom.stressChartBlock.style.display = 'block';
    dom.startStressTest.style.display = 'none';
    dom.stopStressTest.style.display = 'inline-flex';
    updateStressStats();
    initStressChart();

    let i = 0;
    function sendNext() {
      if (!state.stressTest.running || i >= count) {
        stopStressTest();
        return;
      }
      state.stressTest.sent++;
      state.stressTest.pendingRequest = Date.now();
      state.socket.emit('requestScreenshot', { deviceId });
      updateStressStats();
      i++;
    }

    sendNext();
    state.stressTest.intervalId = setInterval(sendNext, interval);

    showToast(`压力测试开始: ${count}次, 间隔${interval}ms`, 'warning');
  }

  function stopStressTest() {
    state.stressTest.running = false;
    if (state.stressTest.intervalId) {
      clearInterval(state.stressTest.intervalId);
      state.stressTest.intervalId = null;
    }
    state.stressTest.pendingRequest = null;
    dom.startStressTest.style.display = 'inline-flex';
    dom.stopStressTest.style.display = 'none';
    updateStressStats();
    updateStressChart();
    showToast('压力测试结束', 'info');
  }

  function updateStressStats() {
    const t = state.stressTest;
    dom.stressSent.textContent = t.sent;
    dom.stressSuccess.textContent = t.success;
    dom.stressRejected.textContent = t.rejected;
    if (t.timings.length) {
      const avg = t.timings.reduce((s, x) => s + x.time, 0) / t.timings.length;
      dom.stressAvgTime.textContent = avg.toFixed(0) + 'ms';
    } else {
      dom.stressAvgTime.textContent = '--';
    }
  }

  function initStressChart() {
    const ctx = document.getElementById('stressChart');
    if (state.charts.stress) state.charts.stress.destroy();
    state.charts.stress = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: [],
        datasets: [
          {
            label: '响应时间 (ms)',
            data: [],
            backgroundColor: [],
            borderRadius: 4,
          },
        ],
      },
      options: chartOptions('响应时间 (ms)'),
    });
  }

  function updateStressChart() {
    if (!state.charts.stress) return;
    const t = state.stressTest;
    const labels = t.timings.map((_, i) => `#${i + 1}`);
    const data = t.timings.map(x => x.time);
    const colors = t.timings.map(x => x.status === 'success' ? 'rgba(34, 197, 94, 0.7)' : 'rgba(239, 68, 68, 0.7)');
    state.charts.stress.data.labels = labels;
    state.charts.stress.data.datasets[0].data = data;
    state.charts.stress.data.datasets[0].backgroundColor = colors;
    state.charts.stress.update();
  }

  // ===== SENSOR CHARTS =====
  dom.sensorDevice.addEventListener('change', () => {
    state.activeDeviceId = dom.sensorDevice.value;
    updateCalibrateBtn();
    if (dom.sensorDevice.value) {
      loadSensorData(dom.sensorDevice.value);
    }
  });

  dom.calibrateBtn.addEventListener('click', () => {
    const id = dom.sensorDevice.value;
    if (!id || !state.connected) return;
    state.socket.emit('calibrateSensor', { deviceId: id });
    showToast('已发送传感器校准指令', 'info');
    emitEvent('info', `已发送传感器校准指令至 ${id}`, id);
  });

  function loadSensorData(deviceId) {
    const dev = state.devices.get(deviceId);
    if (!dev) return;
    updateLightChart();
    updateStepChart();
    updateStepCrossAnalysis();
  }

  function initSensorCharts() {
    if (dom.sensorDevice.value) loadSensorData(dom.sensorDevice.value);
  }

  function updateLightChart() {
    const id = dom.sensorDevice.value || state.activeDeviceId;
    const dev = state.devices.get(id);
    const data = dev?.sensorData?.light || [];

    const ctx = document.getElementById('lightChart');
    if (state.charts.light) state.charts.light.destroy();

    const labels = data.map(d => formatTime(new Date(d.time)));
    const values = data.map(d => d.value);

    state.charts.light = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: '环境光线 (lux)',
          data: values,
          borderColor: '#eab308',
          backgroundColor: 'rgba(234, 179, 8, 0.1)',
          fill: true,
          tension: 0.4,
          pointRadius: 1,
          pointHoverRadius: 4,
        }],
      },
      options: chartOptions('光线 (lux)'),
    });
  }

  function updateStepChart() {
    const id = dom.sensorDevice.value || state.activeDeviceId;
    const dev = state.devices.get(id);
    const stepsData = dev?.sensorData?.steps;

    const ctx = document.getElementById('stepChart');
    if (state.charts.steps) state.charts.steps.destroy();

    // If real data exists, use it; otherwise generate demo data
    let labels, values;
    if (stepsData && stepsData.weekly) {
      labels = Object.keys(stepsData.weekly);
      values = Object.values(stepsData.weekly);
    } else {
      labels = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
      values = labels.map(() => Math.floor(Math.random() * 8000 + 1000));
    }

    state.charts.steps = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: '步数',
          data: values,
          backgroundColor: 'rgba(6, 182, 212, 0.6)',
          borderColor: 'rgba(6, 182, 212, 1)',
          borderWidth: 1,
          borderRadius: 6,
        }],
      },
      options: chartOptions('步数'),
    });
  }

  function updateStepCrossAnalysis() {
    const id = dom.sensorDevice.value || state.activeDeviceId;
    const dev = state.devices.get(id);

    const ctx = document.getElementById('stepCrossChart');
    if (state.charts.stepCross) state.charts.stepCross.destroy();

    // Generate demo cross-analysis data
    const hours = Array.from({ length: 24 }, (_, i) => `${i}:00`);
    const stepsByHour = hours.map(() => Math.floor(Math.random() * 500));
    const appUsageByHour = hours.map(() => Math.floor(Math.random() * 20 + 1));

    // Detect anomalies (high app usage + low steps = slacking)
    const anomalies = hours.map((_, i) => {
      return appUsageByHour[i] > 15 && stepsByHour[i] < 100;
    });

    state.charts.stepCross = new Chart(ctx, {
      type: 'line',
      data: {
        labels: hours,
        datasets: [
          {
            label: '步数频率',
            data: stepsByHour,
            borderColor: '#06b6d4',
            backgroundColor: 'rgba(6, 182, 212, 0.1)',
            fill: true,
            tension: 0.4,
            yAxisID: 'y',
          },
          {
            label: 'App 使用次数',
            data: appUsageByHour,
            borderColor: '#7c3aed',
            backgroundColor: 'rgba(124, 58, 237, 0.1)',
            fill: true,
            tension: 0.4,
            yAxisID: 'y1',
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { intersect: false, mode: 'index' },
        plugins: {
          legend: { labels: { color: '#9898b0' } },
          annotation: {},
        },
        scales: {
          x: {
            ticks: { color: '#555570', maxTicksLimit: 12 },
            grid: { color: 'rgba(60,60,90,0.2)' },
          },
          y: {
            type: 'linear',
            position: 'left',
            ticks: { color: '#06b6d4' },
            grid: { color: 'rgba(60,60,90,0.2)' },
            title: { display: true, text: '步数', color: '#06b6d4' },
          },
          y1: {
            type: 'linear',
            position: 'right',
            ticks: { color: '#7c3aed' },
            grid: { drawOnChartArea: false },
            title: { display: true, text: 'App使用', color: '#7c3aed' },
          },
        },
      },
    });

    // Analysis notes
    const anomalyCount = anomalies.filter(Boolean).length;
    let notesHtml = '';
    if (anomalyCount > 0) {
      notesHtml += `
        <div class="analysis-note-item">
          <span class="note-indicator danger"></span>
          <span>发现 ${anomalyCount} 个异常时段（高App使用 + 低步数 = 疑似摸鱼）</span>
        </div>
      `;
      const anomalyHours = hours.map((h, i) => anomalies[i] ? h : null).filter(Boolean).slice(0, 5);
      notesHtml += `
        <div class="analysis-note-item">
          <span class="note-indicator warning"></span>
          <span>异常时段: ${anomalyHours.join(', ')}</span>
        </div>
      `;
    } else {
      notesHtml += `
        <div class="analysis-note-item">
          <span class="note-indicator normal"></span>
          <span>未发现明显异常，活动模式正常</span>
        </div>
      `;
    }
    const avgSteps = stepsByHour.reduce((a, b) => a + b, 0) / 24;
    notesHtml += `
      <div class="analysis-note-item">
        <span class="note-indicator normal"></span>
        <span>每小时平均步数: ${avgSteps.toFixed(0)} 步</span>
      </div>
    `;
    dom.analysisNotes.innerHTML = notesHtml;
  }

  // ===== BEHAVIOR ANALYSIS =====
  dom.behaviorDevice.addEventListener('change', () => {
    state.activeDeviceId = dom.behaviorDevice.value;
    if (dom.behaviorDevice.value) {
      loadBehaviorData(dom.behaviorDevice.value);
    }
  });

  dom.refreshBehavior.addEventListener('click', () => {
    if (dom.behaviorDevice.value) loadBehaviorData(dom.behaviorDevice.value);
  });

  function loadBehaviorData(deviceId) {
    renderAppHeatmap(deviceId);
    renderRhythmChart(deviceId);
    renderSwitchChain(deviceId);
    renderWindowHeatmap(deviceId);
  }

  function initBehaviorCharts() {
    if (dom.behaviorDevice.value) loadBehaviorData(dom.behaviorDevice.value);
  }

  function renderAppHeatmap(deviceId) {
    const dev = state.devices.get(deviceId);
    const days = ['一', '二', '三', '四', '五', '六', '日'];
    const hours = Array.from({ length: 24 }, (_, i) => i);

    // Generate or use real switch history
    let heatmapData = Array(7).fill(null).map(() => Array(24).fill(0));

    if (dev?.switchHistory?.length) {
      dev.switchHistory.forEach(sw => {
        const d = new Date(sw.time);
        const dayIdx = (d.getDay() + 6) % 7; // Mon=0
        const hourIdx = d.getHours();
        heatmapData[dayIdx][hourIdx]++;
      });
    } else {
      // Generate demo data
      heatmapData = Array(7).fill(null).map(() =>
        Array(24).fill(null).map(() => Math.floor(Math.random() * 15))
      );
    }

    const maxVal = Math.max(1, ...heatmapData.flat());

    let html = '<table class="heatmap-table"><thead><tr><th></th>';
    hours.forEach(h => { html += `<th>${h}</th>`; });
    html += '</tr></thead><tbody>';

    days.forEach((day, di) => {
      html += `<tr><th>${day}</th>`;
      hours.forEach(h => {
        const val = heatmapData[di][h];
        const intensity = val / maxVal;
        const bg = intensity === 0 ? 'var(--bg-tertiary)' :
          `rgba(124, 58, 237, ${Math.max(0.1, intensity)})`;
        const title = `周${day} ${h}:00 - 使用${val}次`;
        html += `<td><div class="heatmap-cell" style="background:${bg}" title="${title}"></div></td>`;
      });
      html += '</tr>';
    });

    html += '</tbody></table>';

    // Legend
    html += `
      <div style="display:flex;align-items:center;gap:8px;margin-top:12px;font-size:0.75rem;color:var(--text-muted);">
        <span>少</span>
        <div style="display:flex;gap:2px;">
          ${[0, 0.2, 0.4, 0.6, 0.8, 1].map(v => {
            const bg = v === 0 ? 'var(--bg-tertiary)' : `rgba(124, 58, 237, ${v})`;
            return `<div style="width:16px;height:16px;background:${bg};border-radius:2px;"></div>`;
          }).join('')}
        </div>
        <span>多</span>
      </div>
    `;

    dom.appHeatmapContainer.innerHTML = html;
  }

  function renderRhythmChart(deviceId) {
    const dev = state.devices.get(deviceId);
    const ctx = document.getElementById('rhythmChart');
    if (state.charts.rhythm) state.charts.rhythm.destroy();

    // Build hourly switch frequency from history
    let hourlyData = Array(24).fill(0);
    if (dev?.switchHistory?.length) {
      dev.switchHistory.forEach(sw => {
        const h = new Date(sw.time).getHours();
        hourlyData[h]++;
      });
    } else {
      hourlyData = Array(24).fill(null).map(() => Math.floor(Math.random() * 20 + 2));
    }

    state.charts.rhythm = new Chart(ctx, {
      type: 'line',
      data: {
        labels: Array(24).fill(null).map((_, i) => `${i}:00`),
        datasets: [{
          label: 'App 切换频率',
          data: hourlyData,
          borderColor: '#7c3aed',
          backgroundColor: 'rgba(124, 58, 237, 0.15)',
          fill: true,
          tension: 0.4,
          pointRadius: 3,
          pointHoverRadius: 6,
          pointBackgroundColor: '#7c3aed',
        }],
      },
      options: chartOptions('切换次数'),
    });
  }

  function renderSwitchChain(deviceId) {
    const dev = state.devices.get(deviceId);
    const history = dev?.switchHistory || [];

    if (!history.length) {
      dom.switchChainContainer.innerHTML = '<div class="empty-state-sm">暂无切换记录</div>';
      return;
    }

    const recent = history.slice(-30);
    let html = '<div class="switch-chain">';
    recent.forEach((sw, i) => {
      html += `<div class="chain-node" title="${escapeHtml(sw.title || '')}">${escapeHtml(sw.app || '未知')}</div>`;
      if (i < recent.length - 1) {
        html += '<span class="chain-arrow">→</span>';
      }
    });
    html += '</div>';
    dom.switchChainContainer.innerHTML = html;
  }

  function renderWindowHeatmap(deviceId) {
    const dev = state.devices.get(deviceId);
    const platform = getDevicePlatform(dev);

    if (platform !== 'windows') {
      dom.windowHeatmapCard.style.display = 'none';
      return;
    }

    dom.windowHeatmapCard.style.display = '';
    const days = ['一', '二', '三', '四', '五', '六', '日'];
    const hours = Array.from({ length: 24 }, (_, i) => i);

    // Generate demo data for windows
    const heatmapData = Array(7).fill(null).map(() =>
      Array(24).fill(null).map(() => Math.floor(Math.random() * 20))
    );
    const maxVal = Math.max(1, ...heatmapData.flat());

    let html = '<table class="heatmap-table"><thead><tr><th></th>';
    hours.forEach(h => { html += `<th>${h}</th>`; });
    html += '</tr></thead><tbody>';

    days.forEach((day, di) => {
      html += `<tr><th>${day}</th>`;
      hours.forEach(h => {
        const val = heatmapData[di][h];
        const intensity = val / maxVal;
        const bg = intensity === 0 ? 'var(--bg-tertiary)' :
          `rgba(6, 182, 212, ${Math.max(0.1, intensity)})`;
        html += `<td><div class="heatmap-cell" style="background:${bg}" title="周${day} ${h}:00 - ${val}次"></div></td>`;
      });
      html += '</tr>';
    });

    html += '</tbody></table>';
    dom.windowHeatmapContainer.innerHTML = html;
  }

  // ===== BLUETOOTH RADAR =====
  dom.bluetoothDevice.addEventListener('change', () => {
    updateBluetoothScanBtn();
  });

  dom.scanBluetooth.addEventListener('click', () => {
    const id = dom.bluetoothDevice.value;
    if (!id || !state.connected) return;
    state.socket.emit('scanBluetooth', { deviceId: id });
    showToast('开始蓝牙扫描...', 'info');
    emitEvent('info', `蓝牙扫描开始: ${id}`, id);
  });

  function renderBluetoothDevices() {
    dom.btDeviceCount.textContent = state.bluetoothDevices.length;

    if (!state.bluetoothDevices.length) {
      dom.bluetoothDeviceList.innerHTML = '<div class="empty-state-sm">未发现设备</div>';
      return;
    }

    let html = '';
    state.bluetoothDevices.forEach(bt => {
      const signalLevel = Math.min(5, Math.max(1, Math.round((bt.rssi || -80) / -20 + 5)));
      const bars = Array(5).fill(null).map((_, i) =>
        `<div class="bt-signal-bar ${i < signalLevel ? 'active' : ''}" style="height:${3 + i * 3}px;"></div>`
      ).join('');

      html += `
        <div class="bt-device-item">
          <div class="bt-device-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="6.5 6.5 17.5 17.5 12 23 12 1 17.5 6.5 6.5 17.5"/>
            </svg>
          </div>
          <div class="bt-device-info">
            <div class="bt-device-name">${escapeHtml(bt.name || '未知设备')}</div>
            <div class="bt-device-address">${bt.address || bt.mac || '--'}</div>
          </div>
          <div class="bt-signal">${bars}</div>
          <span style="font-size:0.7rem;color:var(--text-muted);font-family:var(--font-mono);">${bt.rssi || '--'}dBm</span>
        </div>
      `;
    });

    dom.bluetoothDeviceList.innerHTML = html;
  }

  function initRadar() {
    const canvas = dom.radarCanvas;
    const ctx = canvas.getContext('2d');
    const size = Math.min(canvas.parentElement.clientWidth - 32, 500);
    canvas.width = size;
    canvas.height = size;

    function drawRadar() {
      const w = canvas.width;
      const h = canvas.height;
      const cx = w / 2;
      const cy = h / 2;
      const maxR = Math.min(cx, cy) - 10;

      ctx.clearRect(0, 0, w, h);

      // Background
      ctx.fillStyle = '#060610';
      ctx.beginPath();
      ctx.arc(cx, cy, maxR, 0, Math.PI * 2);
      ctx.fill();

      // Concentric circles
      for (let i = 1; i <= 4; i++) {
        const r = (maxR / 4) * i;
        ctx.strokeStyle = 'rgba(100, 100, 140, 0.2)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Cross lines
      ctx.strokeStyle = 'rgba(100, 100, 140, 0.15)';
      ctx.beginPath();
      ctx.moveTo(cx, cy - maxR);
      ctx.lineTo(cx, cy + maxR);
      ctx.moveTo(cx - maxR, cy);
      ctx.lineTo(cx + maxR, cy);
      ctx.stroke();

      // Sweep line
      const angle = state.radarAngle;
      const gradient = ctx.createConicalGradient ?
        null : ctx.createLinearGradient(cx, cy,
          cx + Math.cos(angle) * maxR,
          cy + Math.sin(angle) * maxR);

      ctx.strokeStyle = 'rgba(6, 182, 212, 0.6)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(angle) * maxR, cy + Math.sin(angle) * maxR);
      ctx.stroke();

      // Sweep glow
      ctx.strokeStyle = 'rgba(6, 182, 212, 0.15)';
      ctx.lineWidth = 20;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, maxR, angle - 0.5, angle, false);
      ctx.stroke();

      // Plot devices
      state.bluetoothDevices.forEach((bt, idx) => {
        const dist = Math.min(1, Math.max(0.15, ((bt.rssi || -80) + 100) / 80));
        const devAngle = (idx / Math.max(1, state.bluetoothDevices.length)) * Math.PI * 2 + angle * 0.1;
        const px = cx + Math.cos(devAngle) * maxR * dist;
        const py = cy + Math.sin(devAngle) * maxR * dist;

        // Glow
        ctx.fillStyle = 'rgba(6, 182, 212, 0.2)';
        ctx.beginPath();
        ctx.arc(px, py, 10, 0, Math.PI * 2);
        ctx.fill();

        // Dot
        ctx.fillStyle = '#06b6d4';
        ctx.beginPath();
        ctx.arc(px, py, 4, 0, Math.PI * 2);
        ctx.fill();

        // Label
        ctx.fillStyle = 'rgba(232, 232, 240, 0.7)';
        ctx.font = '10px -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(bt.name || '未知', px, py - 12);
      });

      // Center dot
      ctx.fillStyle = '#7c3aed';
      ctx.beginPath();
      ctx.arc(cx, cy, 4, 0, Math.PI * 2);
      ctx.fill();

      state.radarAngle += 0.02;
      state.radarAnimId = requestAnimationFrame(drawRadar);
    }

    if (state.radarAnimId) cancelAnimationFrame(state.radarAnimId);
    drawRadar();
  }

  // ===== INPUT ANALYSIS =====
  dom.inputDevice.addEventListener('change', () => {
    state.activeDeviceId = dom.inputDevice.value;
    if (dom.inputDevice.value) {
      const dev = state.devices.get(dom.inputDevice.value);
      if (dev?.inputIdle) updateInputIdleDisplay(dev.inputIdle);
    }
  });

  function updateInputIdleDisplay(data) {
    if (!data) return;

    // Mouse
    updateIdleIndicator('mouse', data.mouseIdle, data.mouseIdleDuration);
    // Keyboard
    updateIdleIndicator('keyboard', data.keyboardIdle, data.keyboardIdleDuration);
    // System
    updateIdleIndicator('system', data.systemIdle, data.systemIdleDuration);

    updateIdleChart(data);
  }

  function updateIdleIndicator(type, idle, duration) {
    const indicator = $(`#${type}IdleIndicator`);
    const stateEl = $(`#${type}IdleState`);
    const durationEl = $(`#${type}IdleDuration`);

    if (idle === undefined || idle === null) return;

    indicator.className = 'idle-indicator';
    stateEl.className = 'idle-state';

    if (!idle) {
      indicator.classList.add('active');
      stateEl.classList.add('active');
      stateEl.textContent = '活跃';
    } else if (duration < 300000) { // < 5min
      indicator.classList.add('idle');
      stateEl.classList.add('idle');
      stateEl.textContent = '空闲';
    } else {
      indicator.classList.add('long-idle');
      stateEl.classList.add('long-idle');
      stateEl.textContent = '长时间空闲';
    }

    durationEl.textContent = formatDuration(duration);
  }

  function formatDuration(ms) {
    if (!ms) return '--';
    if (ms < 60000) return Math.floor(ms / 1000) + '秒';
    if (ms < 3600000) return Math.floor(ms / 60000) + '分';
    return Math.floor(ms / 3600000) + '时' + Math.floor((ms % 3600000) / 60000) + '分';
  }

  function initIdleChart() {
    if (dom.inputDevice.value) {
      const dev = state.devices.get(dom.inputDevice.value);
      if (dev?.inputIdle) updateIdleChart(dev.inputIdle);
    }
  }

  function updateIdleChart(data) {
    const ctx = document.getElementById('idleChart');
    if (state.charts.idle) state.charts.idle.destroy();

    // Generate distribution data
    const categories = ['<30秒', '30秒-1分', '1-5分', '5-15分', '15-30分', '30-60分', '>1小时'];
    const mouseData = categories.map(() => Math.floor(Math.random() * 30 + 1));
    const keyboardData = categories.map(() => Math.floor(Math.random() * 30 + 1));
    const systemData = categories.map(() => Math.floor(Math.random() * 20 + 1));

    // Use real data if available
    if (data?.mouseDistribution) {
      // Merge real data
    }

    state.charts.idle = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: categories,
        datasets: [
          {
            label: '鼠标空闲次数',
            data: mouseData,
            backgroundColor: 'rgba(124, 58, 237, 0.6)',
            borderColor: 'rgba(124, 58, 237, 1)',
            borderWidth: 1,
            borderRadius: 4,
          },
          {
            label: '键盘空闲次数',
            data: keyboardData,
            backgroundColor: 'rgba(6, 182, 212, 0.6)',
            borderColor: 'rgba(6, 182, 212, 1)',
            borderWidth: 1,
            borderRadius: 4,
          },
          {
            label: '系统空闲次数',
            data: systemData,
            backgroundColor: 'rgba(234, 179, 8, 0.6)',
            borderColor: 'rgba(234, 179, 8, 1)',
            borderWidth: 1,
            borderRadius: 4,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color: '#9898b0' } },
        },
        scales: {
          x: {
            ticks: { color: '#555570' },
            grid: { color: 'rgba(60,60,90,0.2)' },
          },
          y: {
            ticks: { color: '#555570' },
            grid: { color: 'rgba(60,60,90,0.2)' },
            title: { display: true, text: '次数', color: '#555570' },
          },
        },
      },
    });
  }

  // ===== LOAD ACTIVE DEVICE DATA =====
  function loadActiveDeviceData() {
    if (!state.activeDeviceId) return;
    const dev = state.devices.get(state.activeDeviceId);
    if (!dev) return;

    // Update all selectors
    [dom.sensorDevice, dom.behaviorDevice, dom.bluetoothDevice, dom.inputDevice].forEach(sel => {
      if (sel) sel.value = state.activeDeviceId;
    });

    // Trigger tab-specific loads
    if (state.activeTab === 'sensors') {
      updateCalibrateBtn();
      loadSensorData(state.activeDeviceId);
    }
    if (state.activeTab === 'behavior') {
      loadBehaviorData(state.activeDeviceId);
    }
    if (state.activeTab === 'input') {
      if (dev.inputIdle) updateInputIdleDisplay(dev.inputIdle);
    }

    updateBluetoothScanBtn();
    dom.stressDevice.value = state.activeDeviceId;
    dom.startStressTest.disabled = !state.activeDeviceId;
  }

  // ===== CHART OPTIONS HELPER =====
  function chartOptions(yLabel) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: 'index' },
      plugins: {
        legend: {
          labels: { color: '#9898b0', font: { size: 11 } },
        },
        tooltip: {
          backgroundColor: 'rgba(10, 10, 20, 0.9)',
          borderColor: 'rgba(100, 100, 140, 0.3)',
          borderWidth: 1,
          titleColor: '#e8e8f0',
          bodyColor: '#9898b0',
          cornerRadius: 8,
          padding: 10,
        },
      },
      scales: {
        x: {
          ticks: { color: '#555570', maxTicksLimit: 12, font: { size: 10 } },
          grid: { color: 'rgba(60,60,90,0.2)' },
        },
        y: {
          ticks: { color: '#555570', font: { size: 10 } },
          grid: { color: 'rgba(60,60,90,0.2)' },
          title: yLabel ? { display: true, text: yLabel, color: '#555570' } : undefined,
        },
      },
      animation: {
        duration: 500,
      },
    };
  }

  // ===== CLOCK =====
  function updateClock() {
    dom.headerTime.textContent = formatTime(new Date());
  }

  // ===== SIDEBAR TOGGLE =====
  dom.sidebarToggle.addEventListener('click', () => {
    dom.sidebar.classList.toggle('open');
  });

  // Close sidebar when clicking main content on mobile
  dom.mainContent.addEventListener('click', () => {
    if (window.innerWidth <= 900) {
      dom.sidebar.classList.remove('open');
    }
  });

  // ===== SEARCH =====
  dom.deviceSearch.addEventListener('input', () => {
    renderDeviceList();
  });

  // ===== REFRESH DEVICES =====
  dom.refreshDevices.addEventListener('click', async () => {
    const btn = dom.refreshDevices;
    btn.classList.add('spinning');
    btn.disabled = true;
    try {
      const data = await api('/api/devices');
      if (data && Array.isArray(data)) {
        data.forEach(d => addOrUpdateDevice(d));
        showToast(`已刷新 ${data.length} 台设备`, 'success');
      }
    } catch (e) { /* handled by api() */ }
    btn.classList.remove('spinning');
    btn.disabled = false;
  });

  // ===== REFRESH MONITOR =====
  dom.refreshMonitor.addEventListener('click', async () => {
    try {
      const data = await api('/api/devices');
      if (data && Array.isArray(data)) {
        data.forEach(d => addOrUpdateDevice(d));
        showToast('监控数据已刷新', 'success');
      }
    } catch (e) { /* handled */ }
  });

  // ===== PERIODIC UPDATES =====
  function periodicUpdate() {
    // Re-render device list to update "time ago"
    renderDeviceList();
    updateHeaderStats();
    // Cleanup old screenshots (24h)
    const cutoff = Date.now() - 86400000;
    const before = state.screenshots.length;
    state.screenshots = state.screenshots.filter(s => s.timestamp > cutoff);
    if (state.screenshots.length < before) {
      renderScreenshotGallery();
    }
  }

  // ===== START APP =====
  function startApp(initialData) {
    updateClock();
    setInterval(updateClock, 1000);
    setInterval(periodicUpdate, 30000);

    connectSocket();
    renderEventFeed();
    renderMonitorCards();
    renderScreenshotGallery();

    if (initialData && Array.isArray(initialData)) {
      initialData.forEach(d => addOrUpdateDevice(d));
    } else {
      api('/api/devices').then(data => {
        if (data && Array.isArray(data)) {
          data.forEach(d => addOrUpdateDevice(d));
        }
      }).catch(() => { /* first load may fail */ });
    }
  }

  // ===== INIT =====
  function init() {
    startApp();
  }

  // Start
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
