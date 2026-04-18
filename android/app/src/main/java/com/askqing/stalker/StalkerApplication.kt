package com.askqing.stalker

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import com.askqing.stalker.util.PreferenceManager

/**
 * 应用入口类
 * 负责全局初始化：通知渠道、偏好设置、API 客户端等
 */
class StalkerApplication : Application() {

    companion object {
        const val CHANNEL_ID_MAIN = "stalker_channel_main"
        const val CHANNEL_ID_SCREENSHOT = "stalker_channel_screenshot"
        const val CHANNEL_ID_AUDIO = "stalker_channel_audio"
        const val CHANNEL_ID_SENSOR = "stalker_channel_sensor"

        @Volatile
        private lateinit var instance: StalkerApplication

        fun getInstance(): StalkerApplication = instance
    }

    lateinit var preferenceManager: PreferenceManager
        private set

    override fun onCreate() {
        super.onCreate()
        instance = this
        preferenceManager = PreferenceManager(this)

        // 创建通知渠道
        createNotificationChannels()
    }

    /**
     * 创建通知渠道（Android 8.0+）
     */
    private fun createNotificationChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channels = listOf(
                NotificationChannel(
                    CHANNEL_ID_MAIN,
                    getString(R.string.notification_channel_main),
                    NotificationManager.IMPORTANCE_LOW
                ).apply {
                    description = getString(R.string.notification_channel_main_desc)
                    setShowBadge(false)
                },
                NotificationChannel(
                    CHANNEL_ID_SCREENSHOT,
                    getString(R.string.notification_channel_screenshot),
                    NotificationManager.IMPORTANCE_DEFAULT
                ).apply {
                    description = getString(R.string.notification_channel_screenshot_desc)
                },
                NotificationChannel(
                    CHANNEL_ID_AUDIO,
                    "音频监控",
                    NotificationManager.IMPORTANCE_LOW
                ).apply {
                    description = "环境音频分析服务"
                    setShowBadge(false)
                },
                NotificationChannel(
                    CHANNEL_ID_SENSOR,
                    "传感器服务",
                    NotificationManager.IMPORTANCE_LOW
                ).apply {
                    description = "环境光传感器采集服务"
                    setShowBadge(false)
                }
            )

            val notificationManager = getSystemService(NotificationManager::class.java)
            notificationManager.createNotificationChannels(channels)
        }
    }
}
