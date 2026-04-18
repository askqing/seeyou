package com.askqing.stalker.model

import com.google.gson.annotations.SerializedName

/**
 * 设备注册请求
 * 向服务器注册设备时发送
 */
data class DeviceRegisterRequest(
    @SerializedName("device_name") val deviceName: String,
    @SerializedName("device_model") val deviceModel: String,
    @SerializedName("android_version") val androidVersion: String,
    @SerializedName("app_version") val appVersion: String,
    @SerializedName("device_id") val deviceId: String = android.os.Build.SERIAL ?: "unknown"
)

/**
 * 设备注册响应
 */
data class DeviceRegisterResponse(
    @SerializedName("success") val success: Boolean,
    @SerializedName("device_id") val deviceId: String?,
    @SerializedName("message") val message: String?
)

/**
 * 心跳请求
 */
data class HeartbeatRequest(
    @SerializedName("device_id") val deviceId: String,
    @SerializedName("timestamp") val timestamp: Long,
    @SerializedName("battery_level") val batteryLevel: Int? = null,
    @SerializedName("current_app") val currentApp: String? = null,
    @SerializedName("meeting_mode") val meetingMode: Boolean = false
)

/**
 * 通用 API 响应
 */
data class ApiResponse(
    @SerializedName("success") val success: Boolean,
    @SerializedName("message") val message: String?,
    @SerializedName("data") val data: Any? = null
)
