/**
 * 视奸面板 - 后端服务器入口
 *
 * 技术栈: Express + Socket.IO + better-sqlite3
 * 功能: 接收客户端数据、实时 WebSocket 推送、REST API、定时清理
 *
 * 启动方式:
 *   npm start        - 生产模式
 *   npm run dev      - 开发模式（--watch 自动重启）
 */

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const cors = require('cors');
const config = require('./config');
const routes = require('./routes');
const { initSocketIO } = require('./socket');
const { startCleanupCron } = require('./cleanup');
const db = require('./db');

// =============================================
// 初始化 Express 应用
// =============================================
const app = express();

// 请求体大小限制：50MB（用于 base64 截图上传）
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// CORS 跨域配置
app.use(cors({
  origin: config.CORS_ORIGIN,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// 请求日志（简易版，生产环境建议使用 morgan 等中间件）
app.use((req, res, next) => {
  if (config.LOG_LEVEL === 'debug') {
    console.log(`[HTTP] ${req.method} ${req.path}`);
  }
  next();
});

// 健康检查端点
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: '视奸面板服务器运行中',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// 托管网页端 Dashboard（静态文件）
const webPath = path.join(__dirname, '..', 'web');
app.use(express.static(webPath));
// SPA fallback: 非 API 请求返回 index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(webPath, 'index.html'));
});

// 挂载 API 路由
app.use('/api', routes);

// 404 处理（仅 API 路径）
app.use('/api', (req, res) => {
  res.status(404).json({ success: false, message: '接口不存在' });
});

// 全局错误处理
app.use((err, req, res, _next) => {
  console.error('[服务器错误]', err.stack);
  res.status(500).json({ success: false, message: '服务器内部错误' });
});

// =============================================
// 初始化 HTTP 服务器和 Socket.IO
// =============================================
const server = http.createServer(app);

const io = new Server(server, {
  // CORS 配置与 Express 保持一致
  cors: {
    origin: config.CORS_ORIGIN,
    methods: ['GET', 'POST'],
  },
  // Socket.IO 传输方式
  transports: ['websocket', 'polling'],
  // 心跳配置
  pingInterval: 25000,
  pingTimeout: 60000,
});

// 将 io 实例注入到 Express app 中，供路由使用
app.set('io', io);

// 初始化 WebSocket 事件处理
initSocketIO(io);

// =============================================
// 启动服务器
// =============================================
async function startServer() {
  // 先初始化数据库
  await db.init();

  server.listen(config.PORT, () => {
    console.log('');
    console.log('========================================');
    console.log('  🔍 视奸面板 - 后端服务器');
    console.log('========================================');
    console.log(`  HTTP:       http://localhost:${config.PORT}`);
    console.log(`  WebSocket:  ws://localhost:${config.PORT}`);
    console.log(`  DB:         ${config.DB_PATH}`);
    console.log(`  JWT Expiry: ${config.JWT_EXPIRES_IN}`);
    console.log('');
    console.log('  🔑 WEB_TOKEN (请安全保存):');
    console.log(`  ${config.WEB_TOKEN}`);
    console.log('');
    console.log('  ⚠️ 生产环境请通过环境变量设置:');
    console.log('  • JWT_SECRET=xxx (固定JWT密钥)');
    console.log('  • WEB_TOKEN=xxx (固定Web Token)');
    console.log('  • CORS_ORIGIN=https://your.domain');
    console.log('========================================');
    console.log('');
  });

  // 数据库初始化完成后再启动定时清理任务
  startCleanupCron();
}

startServer().catch(err => {
  console.error('[服务器] 启动失败:', err);
  process.exit(1);
});

// =============================================
// 优雅关闭
// =============================================
function gracefulShutdown(signal) {
  console.log(`\n[服务器] 收到 ${signal} 信号，正在关闭...`);

  // 停止接收新连接
  server.close(() => {
    console.log('[服务器] HTTP 服务器已关闭');
  });

  // 关闭 Socket.IO
  io.close(() => {
    console.log('[服务器] Socket.IO 已关闭');
  });

  // 关闭数据库连接
  try {
    const db = require('./db');
    db.close();
    console.log('[服务器] 数据库连接已关闭');
  } catch (e) {
    // 数据库可能未初始化
  }

  console.log('[服务器] 优雅关闭完成');
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// 未捕获异常处理
process.on('uncaughtException', (err) => {
  console.error('[服务器] 未捕获异常:', err);
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[服务器] 未处理的 Promise 拒绝:', reason);
});
