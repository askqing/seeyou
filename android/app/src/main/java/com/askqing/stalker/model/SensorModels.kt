package com.askqing.stalker.model

import com.google.gson.annotations.SerializedName

/**
 * 步数数据上传
 */
data class StepCountUpload(
    @SerializedName("device_id") val deviceId: String,
    @SerializedName("timestamp") val timestamp: Long = System.currentTimeMillis(),
    @SerializedName("total_steps") val totalSteps: Long,
    @SerializedName("steps_today") val stepsToday: Long,
    @SerializedName("distance_meters") val distanceMeters: Double? = null,
    @SerializedName("calories") val calories: Double? = null
)

/**
 * 环境光传感器数据
 */
data class LightSensorData(
    @SerializedName("device_id") val deviceId: String,
    @SerializedName("timestamp") val timestamp: Long = System.currentTimeMillis(),
    @SerializedName("lux") val lux: Float,
    @SerializedName("accuracy") val accuracy: Int
)

/**
 * 环境光曲线数据（批量上传）
 */
data class LightCurveUpload(
    @SerializedName("device_id") val deviceId: String,
    @SerializedName("start_time") val startTime: Long,
    @SerializedName("end_time") val endTime: Long,
    @SerializedName("readings") val readings: List<LightSensorData>,
    @SerializedName("average_lux") val averageLux: Float,
    @SerializedName("max_lux") val maxLux: Float,
    @SerializedName("min_lux") val minLux: Float
)
