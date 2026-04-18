/**
 * 数据库初始化模块
 * 使用 sql.js（纯 JavaScript / WebAssembly SQLite）替代 better-sqlite3
 * 无需 C++ 编译环境，跨平台零配置
 *
 * 对外暴露 better-sqlite3 兼容 API：
 *   db.prepare(sql).run(...params)  → { changes: number }
 *   db.prepare(sql).get(...params)  → row | undefined
 *   db.prepare(sql).all(...params)  → row[]
 *   db.exec(sql)
 *   db.pragma(pragmaString)
 *   db.save()     → 手动保存到磁盘
 *   db.init()     → 异步初始化（启动时调用一次）
 *   db.close()    → 关闭并保存
 */

const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const config = require('./config');

// =============================================
// 内部数据库实例（init 后赋值）
// =============================================
let _rawDb = null;
let _saveTimer = null;

// =============================================
// better-sqlite3 兼容 Statement
// =============================================

class Statement {
  constructor(sql) {
    this._sql = sql;
  }

  /**
   * 执行 INSERT / UPDATE / DELETE
   * 返回 { changes: number }，兼容 cleanup.js 中 result.changes
   */
  run(...params) {
    const stmt = _rawDb.prepare(this._sql);
    if (params.length > 0) stmt.bind(params);
    try {
      stmt.step();
    } finally {
      stmt.free();
    }
    return { changes: _rawDb.getRowsModified() };
  }

  /**
   * 查询单行，返回对象或 undefined
   */
  get(...params) {
    const stmt = _rawDb.prepare(this._sql);
    if (params.length > 0) stmt.bind(params);
    try {
      if (stmt.step()) {
        return stmt.getAsObject();
      }
      return undefined;
    } finally {
      stmt.free();
    }
  }

  /**
   * 查询所有行，返回对象数组
   */
  all(...params) {
    const stmt = _rawDb.prepare(this._sql);
    if (params.length > 0) stmt.bind(params);
    const results = [];
    try {
      while (stmt.step()) {
        results.push(stmt.getAsObject());
      }
    } finally {
      stmt.free();
    }
    return results;
  }
}

// =============================================
// 数据库操作
// =============================================

function prepare(sql) {
  return new Statement(sql);
}

function exec(sql) {
  _rawDb.run(sql);
}

function pragma(pragmaString) {
  // sql.js 不支持 WAL（纯内存模式），静默跳过
  const p = pragmaString.toLowerCase();
  if (p.includes('wal') || p.includes('journal_mode')) {
    return;
  }
  try {
    _rawDb.exec('PRAGMA ' + pragmaString);
  } catch (e) {
    // 某些 pragma 在 sql.js 中不可用，静默忽略
  }
}

function save() {
  if (!_rawDb) return;
  const data = _rawDb.export();
  fs.writeFileSync(config.DB_PATH, Buffer.from(data));
}

function close() {
  save();
  if (_saveTimer) {
    clearInterval(_saveTimer);
    _saveTimer = null;
  }
}

// =============================================
// 表结构初始化 SQL
// =============================================

const INIT_SQL = `
  CREATE TABLE IF NOT EXISTS devices (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id         TEXT    NOT NULL UNIQUE,
    device_name       TEXT    NOT NULL DEFAULT '',
    device_type       TEXT    NOT NULL CHECK(device_type IN ('android', 'windows')),
    password_hash     TEXT    NOT NULL DEFAULT '',
    registered_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    last_heartbeat    TEXT,
    meeting_mode      INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_devices_device_id ON devices(device_id);

  CREATE TABLE IF NOT EXISTS screenshots (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id         TEXT    NOT NULL,
    timestamp         TEXT    NOT NULL DEFAULT (datetime('now')),
    image_base64      TEXT    NOT NULL,
    requested_by      TEXT    DEFAULT NULL,
    is_rejected       INTEGER NOT NULL DEFAULT 0,
    response_time_ms  INTEGER DEFAULT NULL,
    FOREIGN KEY (device_id) REFERENCES devices(device_id)
  );
  CREATE INDEX IF NOT EXISTS idx_screenshots_device_id ON screenshots(device_id);
  CREATE INDEX IF NOT EXISTS idx_screenshots_timestamp ON screenshots(timestamp);

  CREATE TABLE IF NOT EXISTS app_events (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id         TEXT    NOT NULL,
    timestamp         TEXT    NOT NULL DEFAULT (datetime('now')),
    app_name          TEXT    NOT NULL DEFAULT '',
    window_title      TEXT    NOT NULL DEFAULT '',
    event_type        TEXT    NOT NULL CHECK(event_type IN ('open', 'switch', 'close', 'focus')),
    duration_seconds  REAL    DEFAULT NULL,
    FOREIGN KEY (device_id) REFERENCES devices(device_id)
  );
  CREATE INDEX IF NOT EXISTS idx_app_events_device_id ON app_events(device_id);
  CREATE INDEX IF NOT EXISTS idx_app_events_timestamp ON app_events(timestamp);
  CREATE INDEX IF NOT EXISTS idx_app_events_app_name ON app_events(app_name);

  CREATE TABLE IF NOT EXISTS sensor_data (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id         TEXT    NOT NULL,
    timestamp         TEXT    NOT NULL DEFAULT (datetime('now')),
    data_type         TEXT    NOT NULL CHECK(data_type IN ('ambient_light', 'steps', 'bluetooth')),
    value_json        TEXT    NOT NULL,
    FOREIGN KEY (device_id) REFERENCES devices(device_id)
  );
  CREATE INDEX IF NOT EXISTS idx_sensor_data_device_id ON sensor_data(device_id);
  CREATE INDEX IF NOT EXISTS idx_sensor_data_type ON sensor_data(data_type);
  CREATE INDEX IF NOT EXISTS idx_sensor_data_timestamp ON sensor_data(timestamp);

  CREATE TABLE IF NOT EXISTS operation_chains (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id         TEXT    NOT NULL,
    timestamp         TEXT    NOT NULL DEFAULT (datetime('now')),
    chain_json        TEXT    NOT NULL,
    FOREIGN KEY (device_id) REFERENCES devices(device_id)
  );
  CREATE INDEX IF NOT EXISTS idx_operation_chains_device_id ON operation_chains(device_id);
  CREATE INDEX IF NOT EXISTS idx_operation_chains_timestamp ON operation_chains(timestamp);

  CREATE TABLE IF NOT EXISTS input_idle (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id         TEXT    NOT NULL,
    timestamp         TEXT    NOT NULL DEFAULT (datetime('now')),
    idle_type         TEXT    NOT NULL CHECK(idle_type IN ('mouse_idle', 'keyboard_idle', 'system_idle')),
    idle_duration_ms  INTEGER NOT NULL,
    FOREIGN KEY (device_id) REFERENCES devices(device_id)
  );
  CREATE INDEX IF NOT EXISTS idx_input_idle_device_id ON input_idle(device_id);
  CREATE INDEX IF NOT EXISTS idx_input_idle_timestamp ON input_idle(timestamp);
`;

// =============================================
// 异步初始化（启动时调用一次）
// =============================================

async function init() {
  // 确保 data 目录存在
  const dbDir = path.dirname(config.DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  // 加载 sql.js
  const SQL = await initSqlJs();

  // 从已有文件加载或创建新数据库
  if (fs.existsSync(config.DB_PATH)) {
    const fileBuffer = fs.readFileSync(config.DB_PATH);
    _rawDb = new SQL.Database(fileBuffer);
    console.log('[数据库] 从文件加载:', config.DB_PATH);
  } else {
    _rawDb = new SQL.Database();
    console.log('[数据库] 创建新数据库');
  }

  // 启用外键
  pragma('foreign_keys = ON');

  // 初始化表结构
  exec(INIT_SQL);
  console.log('[数据库] 表结构初始化完成');

  // 保存初始状态
  save();

  // 每 30 秒自动保存到磁盘
  _saveTimer = setInterval(() => {
    try { save(); } catch (e) { /* ignore */ }
  }, 30000);
}

// =============================================
// 导出兼容接口
// routes.js 和 cleanup.js 通过 require('./db') 直接使用 prepare/get/exec/pragma
// =============================================

module.exports = {
  init,
  close,
  prepare,
  exec,
  pragma,
  save,
};
