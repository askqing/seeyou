# Seeyou

一个跨平台设备监控面板应用，支持 Android、Windows 客户端和 Web 管理后台。

**中文名称：视奸面板**

## 项目结构

```
seeyou/
├── server/          # 后端服务器 (Node.js + Express + Socket.IO + SQLite)
├── web/             # 网页端 Dashboard (HTML + CSS + JS)
├── android/         # Android 客户端 (Kotlin)
└── windows/         # Windows 客户端 (Python)
```

## 功能概览

### 后端服务器 (server/)
- REST API (18 个端点) + WebSocket 实时通信
- SQLite 数据存储，WAL 模式
- 设备注册/心跳管理
- 截图请求转发（含 30s 超时追踪）
- 传感器数据/应用事件/操作链/输入空闲数据聚合
- 自动清理：截图 24h、传感器 7d、事件 30d

### 网页端 Dashboard (web/)
- 暗色毛玻璃 UI 主题
- 6 个功能面板：实时监控、截图中心、传感器、行为分析、蓝牙雷达、输入分析
- 实时设备状态和事件流
- 截图请求 + 压力测试模式（记录拒绝速度）
- 传感器校准命令发送
- 环境光曲线、步数统计、步数 vs 摸鱼交叉分析
- 应用使用热力图（小时 x 星期）
- 蓝牙雷达扫描可视化
- 会议模式切换

### Android 客户端 (android/)
- 无障碍服务：前台应用检测、窗口标题捕获
- 应用切换链记录（5 分钟时间窗口）
- 操作节奏分析和专注度评分
- Health Connect 步数上传
- 远程截图（MediaProjection）+ 手动截图
- 环境光传感器采集
- 环境音频识别标签（静音/语音/音乐/噪音/会议/户外）
- 日历会议自动检测 + 手动会议模式
- 开机自启动、离线队列
- Material3 UI

### Windows 客户端 (windows/)
- 系统托盘应用（后台运行）
- 前台窗口检测（标题/类名/进程名/路径）
- 全屏/窗口截图 + base64 上传
- 任务栏应用监控
- 窗口切换频率热力图数据
- 鼠标/键盘空闲检测（分类：鼠标/键盘/系统）
- Outlook 日历会议自动检测
- tkinter 设置界面
- 离线队列、硬件设备 ID、滚动日志

## 快速开始

### 1. 启动后端服务器

```bash
cd server
npm install
npm start
```

服务器启动后：
- HTTP API: http://localhost:3000
- WebSocket: ws://localhost:3000
- 网页端 Dashboard: http://localhost:3000 (自动托管)

### 2. 访问网页端

直接浏览器打开 http://localhost:3000 即可看到 Dashboard。

### 3. 启动 Windows 客户端

```bash
cd windows
pip install -r requirements.txt
python stalker_client.py
```

首次运行会弹出设置窗口，配置服务器地址和设备名称。

### 4. 编译 Android 客户端

使用 Android Studio 打开 `android/` 目录，Gradle sync 后直接运行。

## API 端点

| 方法 | 路径 | 功能 |
|------|------|------|
| POST | /api/devices/register | 设备注册 |
| GET | /api/devices | 设备列表 |
| POST | /api/devices/:id/heartbeat | 心跳 |
| POST | /api/devices/:id/screenshot | 上传截图 |
| GET | /api/screenshots/:device_id | 截图列表 |
| GET | /api/screenshots/:device_id/:id/image | 截图图片 |
| POST | /api/devices/:id/request-screenshot | 请求截图 |
| POST | /api/devices/:id/calibrate-sensor | 传感器校准 |
| POST | /api/devices/:id/app-event | 应用事件上报 |
| GET | /api/app-usage/:device_id | 应用使用聚合 |
| POST | /api/devices/:id/sensor-data | 传感器数据上报 |
| GET | /api/ambient-light/:device_id | 环境光时间序列 |
| GET | /api/steps/:device_id | 步数数据 |
| GET | /api/bluetooth/:device_id | 蓝牙设备 |
| POST | /api/devices/:id/operation-chain | 操作链上报 |
| GET | /api/operation-chains/:device_id | 操作链查询 |
| POST | /api/devices/:id/input-idle | 输入空闲上报 |
| GET | /api/input-idle/:device_id | 空闲数据 |
| POST | /api/devices/:id/meeting-mode | 会议模式切换 |

## 技术栈

- **Server**: Node.js, Express, Socket.IO, better-sqlite3, node-cron
- **Web**: HTML5, CSS3 (Glassmorphism), Vanilla JS, Chart.js, Socket.IO Client
- **Android**: Kotlin, AndroidX, Material3, OkHttp, Health Connect API
- **Windows**: Python 3.8+, ctypes, win32gui, PIL/Pillow, pynput, tkinter

## 数据保留策略

| 数据类型 | 保留时间 |
|----------|----------|
| 截图 | 24 小时 |
| 传感器数据 | 7 天 |
| 应用事件/操作链 | 30 天 |
| 输入空闲数据 | 30 天 |

## 配置

### 服务器配置 (server/config.js)

```javascript
module.exports = {
  PORT: 3000,
  DB_PATH: './data/stalker.db',
  SCREENSHOT_RETENTION_HOURS: 24,
  SENSOR_RETENTION_DAYS: 7,
  EVENT_RETENTION_DAYS: 30,
  HEARTBEAT_TIMEOUT_MS: 120000,
  SCREENSHOT_REQUEST_TIMEOUT_MS: 30000,
  CORS_ORIGIN: '*',
  LOG_LEVEL: 'info',
};
```

### Windows 客户端配置 (windows/config.json)

```json
{
  "server_url": "http://localhost:3000",
  "device_name": "MyWindowsPC",
  "heartbeat_interval": 30,
  "upload_interval": 5,
  "screenshot_quality": 80,
  "auto_start": false,
  "poll_interval": 5
}
```
