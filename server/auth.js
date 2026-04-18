/**
 * 认证中间件
 *
 * 两层认证体系：
 *   1. 设备端：JWT Token（设备注册时签发，包含 device_id）
 *   2. 网页端：固定 Web Token（WEB_TOKEN，通过环境变量或自动生成）
 *
 * 安全策略：
 *   - 设备注册需要提供 password（≥16 字符，含特殊字符）
 *   - 密码使用 bcrypt 哈希存储
 *   - 所有设备 API 需要 Bearer Token
 *   - 所有 Web API 需要 web_token 查询参数或请求头
 *   - WebSocket 连接需要对应类型的 Token
 */

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const config = require('./config');

// =============================================
// 密码哈希工具
// =============================================

/**
 * 哈希密码（SHA-256 + 盐值，10000 轮迭代）
 * 不用 bcrypt 是为了减少原生依赖，使用纯 JS 实现
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

/**
 * 验证密码
 */
function verifyPassword(password, storedHash) {
  const [salt, hash] = storedHash.split(':');
  const verifyHash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return hash === verifyHash;
}

/**
 * 生成随机强密码（24 字符，含大小写字母、数字、特殊字符）
 */
function generateStrongPassword() {
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  const digits = '0123456789';
  const special = '!@#$%^&*_+-=';

  // 确保每类字符至少一个
  let password = '';
  password += upper[crypto.randomInt(upper.length)];
  password += lower[crypto.randomInt(lower.length)];
  password += digits[crypto.randomInt(digits.length)];
  password += special[crypto.randomInt(special.length)];

  // 填充剩余字符（从合并字符集中随机选取）
  const all = upper + lower + digits + special;
  for (let i = 4; i < 24; i++) {
    password += all[crypto.randomInt(all.length)];
  }

  // 打乱顺序
  const arr = password.split('');
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }

  return arr.join('');
}

// =============================================
// 密码强度校验
// =============================================

/**
 * 校验密码强度
 * 要求：≥16 字符，必须包含大写字母、小写字母、数字、特殊字符
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validatePassword(password) {
  const errors = [];

  if (!password || password.length < config.DEVICE_PASSWORD_MIN_LENGTH) {
    errors.push(`密码长度不能少于 ${config.DEVICE_PASSWORD_MIN_LENGTH} 个字符`);
  }

  if (!/[A-Z]/.test(password)) {
    errors.push('密码必须包含至少一个大写字母');
  }

  if (!/[a-z]/.test(password)) {
    errors.push('密码必须包含至少一个小写字母');
  }

  if (!/[0-9]/.test(password)) {
    errors.push('密码必须包含至少一个数字');
  }

  if (!new RegExp(`[${config.DEVICE_PASSWORD_SPECIAL_CHARS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}]`).test(password)) {
    errors.push('密码必须包含至少一个特殊字符');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// =============================================
// JWT Token 管理
// =============================================

/**
 * 签发设备 JWT Token
 * @param {string} deviceId
 * @param {string} deviceType - 'android' | 'windows'
 * @returns {string} JWT Token
 */
function issueDeviceToken(deviceId, deviceType) {
  const payload = {
    device_id: deviceId,
    device_type: deviceType,
    iat: Math.floor(Date.now() / 1000),
  };

  return jwt.sign(payload, config.JWT_SECRET, {
    expiresIn: config.JWT_EXPIRES_IN,
    issuer: 'stalker-panel',
    subject: deviceId,
  });
}

/**
 * 验证 JWT Token
 * @param {string} token
 * @returns {{ valid: boolean, decoded?: object, error?: string }}
 */
function verifyDeviceToken(token) {
  try {
    const decoded = jwt.verify(token, config.JWT_SECRET, {
      issuer: 'stalker-panel',
    });

    return {
      valid: true,
      decoded: {
        device_id: decoded.device_id,
        device_type: decoded.device_type,
      },
    };
  } catch (error) {
    return {
      valid: false,
      error: error.message === 'jwt expired' ? 'Token 已过期，请重新认证' : '无效的 Token',
    };
  }
}

// =============================================
// Express 中间件
// =============================================

/**
 * 设备认证中间件
 * 从 Authorization: Bearer <token> 中提取并验证 JWT
 */
function deviceAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      message: '缺少认证 Token，请在 Authorization 头中提供 Bearer Token',
    });
  }

  const token = authHeader.substring(7);
  const result = verifyDeviceToken(token);

  if (!result.valid) {
    return res.status(401).json({
      success: false,
      message: result.error,
    });
  }

  // 将设备信息注入到请求对象
  req.deviceAuth = result.decoded;
  next();
}

/**
 * Web 认证中间件
 * 从 Authorization: Bearer <web_token> 或查询参数 ?token=<web_token> 中验证
 */
function webAuth(req, res, next) {
  let token = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.substring(7)
    : req.query.token;

  if (!token) {
    return res.status(401).json({
      success: false,
      message: '缺少 Web Token，请在 Authorization 头或 token 参数中提供',
    });
  }

  // 使用恒定时间比较防止时序攻击
  const expected = config.WEB_TOKEN;
  if (token.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
    return res.status(403).json({
      success: false,
      message: '无效的 Web Token',
    });
  }

  next();
}

/**
 * 设备或 Web 认证中间件（二选一即可）
 * 用于同时支持设备端和 Web 端访问的端点
 */
function deviceOrWebAuth(req, res, next) {
  // 优先尝试 Web Token
  let webToken = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.substring(7)
    : req.query.token;

  if (webToken) {
    const expected = config.WEB_TOKEN;
    if (webToken.length === expected.length && crypto.timingSafeEqual(Buffer.from(webToken), Buffer.from(expected))) {
      req.authType = 'web';
      return next();
    }
  }

  // 其次尝试设备 JWT
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const jwtToken = authHeader.substring(7);
    const result = verifyDeviceToken(jwtToken);
    if (result.valid) {
      req.deviceAuth = result.decoded;
      req.authType = 'device';
      return next();
    }
  }

  return res.status(401).json({
    success: false,
    message: '缺少有效认证（需要设备 Token 或 Web Token）',
  });
}

module.exports = {
  hashPassword,
  verifyPassword,
  generateStrongPassword,
  validatePassword,
  issueDeviceToken,
  verifyDeviceToken,
  deviceAuth,
  webAuth,
  deviceOrWebAuth,
};
