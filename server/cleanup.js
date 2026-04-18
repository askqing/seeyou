/**
 * 定时清理任务模块
 * 使用 node-cron 定期清理过期的截图数据
 */

const cron = require('node-cron');
const db = require('./db');
const config = require('./config');

/**
 * 清理过期的截图
 * 删除超过 SCREENSHOT_RETENTION_HOURS 小时的截图记录
 * @returns {{ deleted: number }} 被删除的记录数
 */
function cleanupExpiredScreenshots() {
  try {
    const retentionHours = config.SCREENSHOT_RETENTION_HOURS;
    const cutoffTime = new Date(Date.now() - retentionHours * 60 * 60 * 1000).toISOString();

    const result = db.prepare(`
      DELETE FROM screenshots
      WHERE timestamp < ?
    `).run(cutoffTime);

    const deletedCount = result.changes;
    if (deletedCount > 0) {
      console.log(`[清理] 已删除 ${deletedCount} 条过期截图 (早于 ${cutoffTime})`);
    }

    return { deleted: deletedCount };
  } catch (error) {
    console.error('[清理] 截图清理失败:', error.message);
    return { deleted: 0, error: error.message };
  }
}

/**
 * 清理过期的传感器数据（可选，默认保留 7 天）
 * 避免传感器数据无限增长占用磁盘空间
 */
function cleanupOldSensorData() {
  try {
    const daysToKeep = 7;
    const cutoffTime = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000).toISOString();

    const result = db.prepare(`
      DELETE FROM sensor_data
      WHERE timestamp < ?
    `).run(cutoffTime);

    if (result.changes > 0) {
      console.log(`[清理] 已删除 ${result.changes} 条过期传感器数据 (${daysToKeep}天前)`);
    }

    return { deleted: result.changes };
  } catch (error) {
    console.error('[清理] 传感器数据清理失败:', error.message);
    return { deleted: 0, error: error.message };
  }
}

/**
 * 清理过期的应用事件数据（可选，默认保留 30 天）
 */
function cleanupOldAppEvents() {
  try {
    const daysToKeep = 30;
    const cutoffTime = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000).toISOString();

    const result = db.prepare(`
      DELETE FROM app_events
      WHERE timestamp < ?
    `).run(cutoffTime);

    if (result.changes > 0) {
      console.log(`[清理] 已删除 ${result.changes} 条过期应用事件 (${daysToKeep}天前)`);
    }

    return { deleted: result.changes };
  } catch (error) {
    console.error('[清理] 应用事件清理失败:', error.message);
    return { deleted: 0, error: error.message };
  }
}

/**
 * 清理过期的输入空闲数据（可选，默认保留 30 天）
 */
function cleanupOldInputIdle() {
  try {
    const daysToKeep = 30;
    const cutoffTime = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000).toISOString();

    const result = db.prepare(`
      DELETE FROM input_idle
      WHERE timestamp < ?
    `).run(cutoffTime);

    if (result.changes > 0) {
      console.log(`[清理] 已删除 ${result.changes} 条过期空闲数据 (${daysToKeep}天前)`);
    }

    return { deleted: result.changes };
  } catch (error) {
    console.error('[清理] 空闲数据清理失败:', error.message);
    return { deleted: 0, error: error.message };
  }
}

/**
 * 执行所有数据库维护任务
 * 包含 SQLite WAL 模式的 checkpoint 操作
 */
function runAllMaintenance() {
  try {
    // 截图清理（24 小时）
    cleanupExpiredScreenshots();

    // 每次运行时执行一次全量维护
    // 传感器数据清理（7 天）
    cleanupOldSensorData();
    // 应用事件清理（30 天）
    cleanupOldAppEvents();
    // 输入空闲数据清理（30 天）
    cleanupOldInputIdle();

    // SQLite WAL checkpoint：将 WAL 文件合并到主数据库
    db.pragma('wal_checkpoint(TRUNCATE)');

    console.log('[清理] 数据库维护完成');
  } catch (error) {
    console.error('[清理] 数据库维护失败:', error.message);
  }
}

/**
 * 启动定时清理任务
 * @returns {cron.ScheduledTask} cron 任务实例（可用于停止）
 */
function startCleanupCron() {
  // 验证 cron 表达式合法性
  if (!cron.validate(config.CLEANUP_CRON)) {
    console.error(`[清理] 无效的 cron 表达式: ${config.CLEANUP_CRON}，使用默认值 "0 * * * *"`);
    config.CLEANUP_CRON = '0 * * * *';
  }

  // 启动时立即执行一次清理
  console.log(`[清理] 启动定时清理任务，cron: ${config.CLEANUP_CRON}，截图保留: ${config.SCREENSHOT_RETENTION_HOURS}小时`);
  runAllMaintenance();

  // 定时执行
  const task = cron.schedule(config.CLEANUP_CRON, () => {
    runAllMaintenance();
  });

  return task;
}

module.exports = { startCleanupCron, cleanupExpiredScreenshots, runAllMaintenance };
