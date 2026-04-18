/**
 * 服务器配置文件
 * 可通过环境变量覆盖默认值
 */

const crypto = require('crypto');
const path = require('path');

// =============================================
// 安全配置（⚠️ 首次部署时必须修改）
// =============================================

// JWT 密钥：用于签发和验证设备 Token
// 生产环境务必通过环境变量 JWT_SECRET 设置，否则每次重启 Token 失效
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex');

// Web 管理面板访问 Token：网页端 Dashboard 连接时需要提供此 Token
// 首次启动时自动生成并打印到控制台，也可通过环境变量设置
const WEB_TOKEN = process.env.WEB_TOKEN || 'stk_' + crypto.randomBytes(32).toString('hex');

module.exports = {
  // 服务器端口
  PORT: parseInt(process.env.PORT, 10) || 3000,

  // SQLite 数据库文件路径
  DB_PATH: process.env.DB_PATH || path.join(__dirname, 'data', 'stalker.db'),

  // 截图保留时间（小时），超过此时间的截图将被自动清理
  SCREENSHOT_RETENTION_HOURS: parseInt(process.env.SCREENSHOT_RETENTION_HOURS, 10) || 24,

  // 截图清理定时任务 cron 表达式（默认每小时执行一次）
  CLEANUP_CRON: process.env.CLEANUP_CRON || '0 * * * *',

  // 心跳超时时间（毫秒），超过此时间未收到心跳则视为设备离线
  HEARTBEAT_TIMEOUT_MS: parseInt(process.env.HEARTBEAT_TIMEOUT_MS, 10) || 5 * 60 * 1000,

  // 截图请求超时时间（毫秒），超过此时间未收到响应则视为拒绝
  SCREENSHOT_REQUEST_TIMEOUT_MS: parseInt(process.env.SCREENSHOT_REQUEST_TIMEOUT_MS, 10) || 30000,

  // CORS 允许的源（生产环境应设为具体域名）
  CORS_ORIGIN: process.env.CORS_ORIGIN || '*',

  // 日志级别: 'error' | 'warn' | 'info' | 'debug'
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',

  // 单张截图最大体积（字节），默认 5MB
  MAX_SCREENSHOT_SIZE: parseInt(process.env.MAX_SCREENSHOT_SIZE, 10) || 5 * 1024 * 1024,

  // JWT 密钥
  JWT_SECRET,

  // JWT Token 有效期（秒），默认 30 天
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '30d',

  // Web 管理面板访问 Token
  WEB_TOKEN,

  // 设备密码最小长度
  DEVICE_PASSWORD_MIN_LENGTH: 16,

  // 设备密码必须包含的特殊字符
  DEVICE_PASSWORD_SPECIAL_CHARS: '!@#$%^&*()_+-=[]{}|;:,.<>?',
};
