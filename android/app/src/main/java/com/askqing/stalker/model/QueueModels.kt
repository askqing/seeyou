package com.askqing.stalker.model

import com.google.gson.annotations.SerializedName

/**
 * 离线队列中的事件条目
 * 当网络不可用时，事件暂存于此
 */
data class OfflineQueueEntry(
    @SerializedName("id") val id: String,
    @SerializedName("endpoint") val endpoint: String,
    @SerializedName("method") val method: String = "POST",
    @SerializedName("body") val body: String,  // JSON 字符串
    @SerializedName("created_at") val createdAt: Long = System.currentTimeMillis(),
    @SerializedName("retry_count") val retryCount: Int = 0,
    @SerializedName("max_retries") val maxRetries: Int = 10
)
