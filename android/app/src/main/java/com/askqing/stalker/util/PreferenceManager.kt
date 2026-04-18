package com.askqing.stalker.util

import android.content.Context
import android.content.SharedPreferences

/**
 * 偏好设置管理器
 * 管理服务器地址、设备名称、功能开关等配置
 */
class PreferenceManager(context: Context) {

    private val prefs: SharedPreferences =
        context.getSharedPreferences("stalker_prefs", Context.MODE_PRIVATE)

    companion object {
        private const val KEY_SERVER_URL = "server_url"
        private const val KEY_DEVICE_NAME = "device_name"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_ACCESSIBILITY_ENABLED = "accessibility_enabled"
        private const val KEY_HEALTH_CONNECT_ENABLED = "health_connect_enabled"
        private const val KEY_SCREENSHOT_ENABLED = "screenshot_enabled"
        private const val KEY_AUDIO_ENABLED = "audio_enabled"
        private const val KEY_SENSOR_ENABLED = "sensor_enabled"
        private const val KEY_MEETING_MODE = "meeting_mode"
        private const val KEY_HEARTBEAT_INTERVAL = "heartbeat_interval"
        private const val KEY_UPLOAD_INTERVAL = "upload_interval"
        private const val KEY_LAST_SYNC_TIME = "last_sync_time"
        private const val KEY_LAST_FOREGROUND_APP = "last_foreground_app"
    }

    // ========== 服务器配置 ==========

    var serverUrl: String
        get() = prefs.getString(KEY_SERVER_URL, "") ?: ""
        set(value) = prefs.edit().putString(KEY_SERVER_URL, value).apply()

    var deviceName: String
        get() = prefs.getString(KEY_DEVICE_NAME, android.os.Build.MODEL) ?: android.os.Build.MODEL
        set(value) = prefs.edit().putString(KEY_DEVICE_NAME, value).apply()

    var deviceId: String
        get() = prefs.getString(KEY_DEVICE_ID, "") ?: ""
        set(value) = prefs.edit().putString(KEY_DEVICE_ID, value).apply()

    // ========== 功能开关 ==========

    var isAccessibilityEnabled: Boolean
        get() = prefs.getBoolean(KEY_ACCESSIBILITY_ENABLED, false)
        set(value) = prefs.edit().putBoolean(KEY_ACCESSIBILITY_ENABLED, value).apply()

    var isHealthConnectEnabled: Boolean
        get() = prefs.getBoolean(KEY_HEALTH_CONNECT_ENABLED, false)
        set(value) = prefs.edit().putBoolean(KEY_HEALTH_CONNECT_ENABLED, value).apply()

    var isScreenshotEnabled: Boolean
        get() = prefs.getBoolean(KEY_SCREENSHOT_ENABLED, false)
        set(value) = prefs.edit().putBoolean(KEY_SCREENSHOT_ENABLED, value).apply()

    var isAudioEnabled: Boolean
        get() = prefs.getBoolean(KEY_AUDIO_ENABLED, false)
        set(value) = prefs.edit().putBoolean(KEY_AUDIO_ENABLED, value).apply()

    var isSensorEnabled: Boolean
        get() = prefs.getBoolean(KEY_SENSOR_ENABLED, false)
        set(value) = prefs.edit().putBoolean(KEY_SENSOR_ENABLED, value).apply()

    // ========== 会议模式 ==========

    var isMeetingMode: Boolean
        get() = prefs.getBoolean(KEY_MEETING_MODE, false)
        set(value) = prefs.edit().putBoolean(KEY_MEETING_MODE, value).apply()

    // ========== 间隔配置 ==========

    var heartbeatInterval: Int
        get() = prefs.getInt(KEY_HEARTBEAT_INTERVAL, 30)
        set(value) = prefs.edit().putInt(KEY_HEARTBEAT_INTERVAL, value).apply()

    var uploadInterval: Int
        get() = prefs.getInt(KEY_UPLOAD_INTERVAL, 300)
        set(value) = prefs.edit().putInt(KEY_UPLOAD_INTERVAL, value).apply()

    // ========== 状态数据 ==========

    var lastSyncTime: Long
        get() = prefs.getLong(KEY_LAST_SYNC_TIME, 0L)
        set(value) = prefs.edit().putLong(KEY_LAST_SYNC_TIME, value).apply()

    var lastForegroundApp: String
        get() = prefs.getString(KEY_LAST_FOREGROUND_APP, "") ?: ""
        set(value) = prefs.edit().putString(KEY_LAST_FOREGROUND_APP, value).apply()
}
