package com.askqing.stalker.service

import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import com.askqing.stalker.api.ApiClient
import com.askqing.stalker.model.StepCountUpload
import com.askqing.stalker.util.PreferenceManager
import kotlinx.coroutines.*
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneOffset
import java.time.temporal.ChronoUnit

/**
 * Health Connect 管理器
 * 读取步数数据并定期上传到服务器
 * 需要 Android 14+ 或安装了 Health Connect APK 的设备
 */
class HealthConnectManager(private val context: Context) {

    companion object {
        private const val TAG = "HealthConnect"
        private const val UPLOAD_INTERVAL_MS = 5 * 60 * 1000L  // 5 分钟上传一次

        @Volatile
        private var instance: HealthConnectManager? = null

        fun getInstance(context: Context): HealthConnectManager {
            return instance ?: synchronized(this) {
                instance ?: HealthConnectManager(context.applicationContext).also { instance = it }
            }
        }
    }

    private val preferenceManager = PreferenceManager(context)
    private val apiClient = ApiClient.getInstance(context)
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    private var healthConnectClient: HealthConnectClient? = null
    private var uploadJob: Job? = null

    // 上传回调
    var onStepsUploaded: ((steps: Long) -> Unit)? = null
    var onError: ((error: String) -> Unit)? = null

    init {
        initHealthConnect()
    }

    /**
     * 初始化 Health Connect 客户端
     */
    private fun initHealthConnect() {
        try {
            healthConnectClient = HealthConnectClient.getOrCreate(context)
            Log.i(TAG, "Health Connect 客户端初始化成功")
        } catch (e: Exception) {
            Log.e(TAG, "Health Connect 不可用", e)
            onError?.invoke("设备不支持 Health Connect")
        }
    }

    /**
     * 检查 Health Connect 是否可用
     */
    fun isAvailable(): Boolean {
        return HealthConnectClient.getSdkStatus(context) ===
                HealthConnectClient.SDK_AVAILABLE
    }

    /**
     * 检查是否有步数读取权限
     */
    fun hasPermissions(): Boolean {
        val client = healthConnectClient ?: return false
        return try {
            val permissions = setOf(
                android.health.connect.HealthPermissions.READ_STEPS
            )
            val granted = PermissionController.getGrantedPermissions(client)
            granted.containsAll(permissions)
        } catch (e: Exception) {
            false
        }
    }

    /**
     * 请求权限（需要调用方启动 Activity 来处理结果）
     * 返回权限请求 Intent
     */
    fun createPermissionRequestIntent(): Intent? {
        val client = healthConnectClient ?: return null
        return try {
            PermissionController.createRequestPermissionResultContract().createIntent(
                context,
                setOf(android.health.connect.HealthPermissions.READ_STEPS)
            )
        } catch (e: Exception) {
            Log.e(TAG, "创建权限请求失败", e)
            null
        }
    }

    /**
     * 读取今日步数
     */
    suspend fun readTodaySteps(): Long {
        val client = healthConnectClient ?: return 0L

        return try {
            // 今日 0 点到当前时间
            val startTime = LocalDateTime.now()
                .toLocalDate()
                .atStartOfDay()
                .toInstant(ZoneOffset.systemDefault())
            val endTime = Instant.now()

            val request = ReadRecordsRequest(
                recordType = StepsRecord::class,
                timeRangeFilter = TimeRangeFilter.between(startTime, endTime)
            )

            val response = client.readRecords(request)
            val totalSteps = response.records.sumOf { it.count }

            Log.d(TAG, "今日步数: $totalSteps")
            totalSteps
        } catch (e: Exception) {
            Log.e(TAG, "读取步数失败", e)
            0L
        }
    }

    /**
     * 读取累计总步数
     */
    suspend fun readTotalSteps(): Long {
        val client = healthConnectClient ?: return 0L

        return try {
            val request = ReadRecordsRequest(
                recordType = StepsRecord::class,
                timeRangeFilter = TimeRangeFilter.between(
                    Instant.EPOCH,
                    Instant.now()
                )
            )

            val response = client.readRecords(request)
            response.records.sumOf { it.count }
        } catch (e: Exception) {
            Log.e(TAG, "读取总步数失败", e)
            0L
        }
    }

    /**
     * 开始定期上传步数
     */
    fun startPeriodicUpload() {
        if (uploadJob?.isActive == true) return

        uploadJob = scope.launch {
            while (isActive && preferenceManager.isHealthConnectEnabled) {
                try {
                    if (!preferenceManager.isMeetingMode) {
                        uploadStepsData()
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "定期上传步数失败", e)
                }
                delay(UPLOAD_INTERVAL_MS)
            }
        }

        Log.i(TAG, "已启动定期步数上传（间隔 ${UPLOAD_INTERVAL_MS / 1000} 秒）")
    }

    /**
     * 停止定期上传
     */
    fun stopPeriodicUpload() {
        uploadJob?.cancel()
        uploadJob = null
        Log.i(TAG, "已停止定期步数上传")
    }

    /**
     * 上传步数数据到服务器
     */
    private suspend fun uploadStepsData() {
        val todaySteps = readTodaySteps()
        val totalSteps = readTotalSteps()

        if (todaySteps <= 0 && totalSteps <= 0) return

        val upload = StepCountUpload(
            deviceId = preferenceManager.deviceId,
            timestamp = System.currentTimeMillis(),
            totalSteps = totalSteps,
            stepsToday = todaySteps
        )

        apiClient.uploadSteps(upload)
        onStepsUploaded?.invoke(todaySteps)

        Log.d(TAG, "步数已上传: 今日 $todaySteps 步, 总计 $totalSteps 步")
    }

    /**
     * 销毁
     */
    fun destroy() {
        uploadJob?.cancel()
        scope.cancel()
        instance = null
    }
}
