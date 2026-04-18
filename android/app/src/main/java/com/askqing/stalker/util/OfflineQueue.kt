package com.askqing.stalker.util

import android.content.Context
import android.util.Log
import com.askqing.stalker.model.OfflineQueueEntry
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import java.io.File
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * 离线队列
 * 当网络不可用时，将数据暂存到本地文件
 * 网络恢复后自动上传
 */
class OfflineQueue(context: Context) {

    private val queueFile = File(context.filesDir, "offline_queue.json")
    private val gson = Gson()
    private val lock = ReentrantLock()

    private val queue: MutableList<OfflineQueueEntry> by lazy {
        load()
    }

    companion object {
        private const val TAG = "OfflineQueue"
        private const val MAX_QUEUE_SIZE = 500  // 最大缓存条数
    }

    /**
     * 添加条目到队列
     */
    fun add(entry: OfflineQueueEntry) {
        lock.withLock {
            // 去重：相同 ID 的条目不重复添加
            if (queue.any { it.id == entry.id }) return

            // 超过最大数量时，移除最旧的
            if (queue.size >= MAX_QUEUE_SIZE) {
                queue.removeAt(0)
            }

            queue.add(entry)
            save()
        }
        Log.d(TAG, "队列新增条目: ${entry.id}, 当前队列大小: ${queue.size}")
    }

    /**
     * 获取所有条目（按时间排序）
     */
    fun getAll(): List<OfflineQueueEntry> {
        return lock.withLock {
            queue.sortedBy { it.createdAt }
        }
    }

    /**
     * 移除已处理的条目
     */
    fun remove(id: String) {
        lock.withLock {
            queue.removeAll { it.id == id }
            save()
        }
    }

    /**
     * 增加重试次数，超过上限则移除
     */
    fun incrementRetry(id: String) {
        lock.withLock {
            val entry = queue.find { it.id == id } ?: return
            val newRetryCount = entry.retryCount + 1
            if (newRetryCount >= entry.maxRetries) {
                queue.remove(entry)
                Log.w(TAG, "条目超过最大重试次数，已丢弃: $id")
            } else {
                queue[queue.indexOf(entry)] = entry.copy(retryCount = newRetryCount)
            }
            save()
        }
    }

    /**
     * 获取队列大小
     */
    fun size(): Int {
        return lock.withLock { queue.size }
    }

    /**
     * 清空队列
     */
    fun clear() {
        lock.withLock {
            queue.clear()
            queueFile.delete()
        }
    }

    /**
     * 从文件加载队列
     */
    private fun load(): MutableList<OfflineQueueEntry> {
        return try {
            if (queueFile.exists()) {
                val json = queueFile.readText()
                if (json.isNotBlank()) {
                    val type = object : TypeToken<List<OfflineQueueEntry>>() {}.type
                    gson.fromJson(json, type) ?: mutableListOf()
                } else {
                    mutableListOf()
                }
            } else {
                mutableListOf()
            }
        } catch (e: Exception) {
            Log.e(TAG, "加载离线队列失败", e)
            mutableListOf()
        }
    }

    /**
     * 保存队列到文件
     */
    private fun save() {
        try {
            val json = gson.toJson(queue)
            queueFile.writeText(json)
        } catch (e: Exception) {
            Log.e(TAG, "保存离线队列失败", e)
        }
    }
}
