package com.askqing.stalker.model

import com.google.gson.annotations.SerializedName

/**
 * 音频标签
 * 环境音频分析产生的标签
 */
data class AudioTag(
    @SerializedName("device_id") val deviceId: String,
    @SerializedName("timestamp") val timestamp: Long = System.currentTimeMillis(),
    @SerializedName("tag") val tag: String,  // silent, speech, music, noise, meeting, outdoor
    @SerializedName("confidence") val confidence: Float,  // 0.0 - 1.0
    @SerializedName("decibel") val decibel: Float = -1f,  // 近似分贝值
    @SerializedName("duration_ms") val durationMs: Long = 3000  // 分析窗口时长
)

/**
 * 操作节奏分析结果
 */
data class OperationRhythmAnalysis(
    @SerializedName("device_id") val deviceId: String,
    @SerializedName("timestamp") val timestamp: Long = System.currentTimeMillis(),
    @SerializedName("period_minutes") val periodMinutes: Int = 30,

    // 应用使用统计
    @SerializedName("total_app_switches") val totalAppSwitches: Int = 0,
    @SerializedName("unique_apps_used") val uniqueAppsUsed: Int = 0,
    @SerializedName("app_usage_distribution") val appUsageDistribution: Map<String, Long> = emptyMap(),

    // 模式检测
    @SerializedName("pattern") val pattern: String = "normal",  // normal, work, social, distracted, meeting
    @SerializedName("pattern_confidence") val patternConfidence: Float = 0f,

    // 节奏指标
    @SerializedName("avg_switch_interval_ms") val avgSwitchIntervalMs: Long = 0,
    @SerializedName("max_focus_duration_ms") val maxFocusDurationMs: Long = 0,
    @SerializedName("focus_score") val focusScore: Float = 0f  // 专注度评分 0-100
)
