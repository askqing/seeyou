package com.askqing.stalker.service

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.IBinder
import android.util.Log
import com.askqing.stalker.StalkerApplication
import com.askqing.stalker.api.ApiClient
import com.askqing.stalker.model.LightCurveUpload
import com.askqing.stalker.model.LightSensorData
import com.askqing.stalker.util.PreferenceManager
import kotlinx.coroutines.*
import java.util.concurrent.CopyOnWriteArrayList

/**
 * 传感器采集服务
 * 采集环境光传感器数据，构建环境光曲线并上传
 *
 * 功能：
 * - 持续读取光线传感器数据
 * - 每 30 秒上传一次环境光读数
 * - 定期构建环境光曲线（批量数据）并上传
 */
class SensorCollectionService : Service(), SensorEventListener {

    companion object {
        private const val TAG = "SensorService"

        // 上传间隔
        private const val LIGHT_UPLOAD_INTERVAL_MS = 30_000L  // 30 秒
        private const val CURVE_UPLOAD_INTERVAL_MS = 5 * 60 * 1000L  // 5 分钟

        @Volatile
        var isRunning = false
            private set
    }

    private val preferenceManager: PreferenceManager by lazy { PreferenceManager(this) }
    private val apiClient: ApiClient by lazy { ApiClient.getInstance(this) }
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    private lateinit var sensorManager: SensorManager
    private var lightSensor: Sensor? = null

    // 环境光数据缓存（用于曲线构建）
    private val lightReadings = CopyOnWriteArrayList<LightSensorData>()

    private var uploadJob: Job? = null
    private var curveUploadJob: Job? = null

    override fun onCreate() {
        super.onCreate()
        isRunning = true
        startForegroundNotification()
        initSensor()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        return START_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
        // 注销传感器监听
        sensorManager.unregisterListener(this)
        uploadJob?.cancel()
        curveUploadJob?.cancel()
        scope.cancel()
        isRunning = false
        Log.i(TAG, "传感器服务已销毁")
    }

    // ==================== 传感器初始化 ====================

    /**
     * 初始化传感器
     */
    private fun initSensor() {
        sensorManager = getSystemService(SENSOR_SERVICE) as SensorManager

        // 获取光线传感器
        lightSensor = sensorManager.getDefaultSensor(Sensor.TYPE_LIGHT)

        if (lightSensor != null) {
            // 注册传感器监听
            val success = sensorManager.registerListener(
                this,
                lightSensor,
                SensorManager.SENSOR_DELAY_NORMAL  // 约 200ms 间隔
            )
            if (success) {
                Log.i(TAG, "光线传感器已注册")
                startUploadJobs()
            } else {
                Log.w(TAG, "光线传感器注册失败")
            }
        } else {
            Log.w(TAG, "设备没有光线传感器")
        }
    }

    // ==================== 传感器事件 ====================

    override fun onSensorChanged(event: SensorEvent?) {
        if (event == null) return
        if (event.sensor.type != Sensor.TYPE_LIGHT) return

        // 会议模式下不记录数据
        if (preferenceManager.isMeetingMode) return

        val lux = event.values[0]
        val accuracy = event.accuracy

        // 创建数据记录
        val data = LightSensorData(
            deviceId = preferenceManager.deviceId,
            timestamp = System.currentTimeMillis(),
            lux = lux,
            accuracy = accuracy
        )

        // 加入缓存
        lightReadings.add(data)

        Log.d(TAG, "光线传感器: ${lux} lux")
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {
        Log.d(TAG, "传感器精度变化: $accuracy")
    }

    // ==================== 数据上传 ====================

    /**
     * 启动上传任务
     */
    private fun startUploadJobs() {
        // 每 30 秒上传最新一条光数据
        uploadJob = scope.launch {
            while (isActive) {
                delay(LIGHT_UPLOAD_INTERVAL_MS)
                uploadLatestLightData()
            }
        }

        // 每 5 分钟上传环境光曲线
        curveUploadJob = scope.launch {
            while (isActive) {
                delay(CURVE_UPLOAD_INTERVAL_MS)
                uploadLightCurve()
            }
        }
    }

    /**
     * 上传最新的光数据
     */
    private fun uploadLatestLightData() {
        val latest = lightReadings.maxByOrNull { it.timestamp } ?: return

        scope.launch {
            apiClient.uploadLightData(latest)
            Log.d(TAG, "环境光数据已上传: ${latest.lux} lux")
        }
    }

    /**
     * 构建并上传环境光曲线
     */
    private fun uploadLightCurve() {
        if (lightReadings.isEmpty()) return

        // 获取最近 5 分钟的数据
        val cutoff = System.currentTimeMillis() - 5 * 60 * 1000
        val readings = lightReadings.filter { it.timestamp >= cutoff }

        if (readings.isEmpty()) return

        val curve = LightCurveUpload(
            deviceId = preferenceManager.deviceId,
            startTime = readings.first().timestamp,
            endTime = readings.last().timestamp,
            readings = readings,
            averageLux = readings.map { it.lux }.average().toFloat(),
            maxLux = readings.maxOf { it.lux },
            minLux = readings.minOf { it.lux }
        )

        scope.launch {
            apiClient.uploadLightCurve(curve)
            Log.i(TAG, "环境光曲线上传: ${readings.size} 条数据, 平均 ${curve.averageLux} lux")
        }

        // 清理旧数据（保留最近 10 分钟的）
        val retentionCutoff = System.currentTimeMillis() - 10 * 60 * 1000
        lightReadings.removeAll { it.timestamp < retentionCutoff }
    }

    // ==================== 前台通知 ====================

    private fun startForegroundNotification() {
        val notification = createNotification()
        startForeground(4, notification)
    }

    private fun createNotification(): Notification {
        val intent = packageManager.getLaunchIntentForPackage(packageName) ?: Intent()
        val pendingIntent = PendingIntent.getActivity(
            this, 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val latestLux = lightReadings.maxByOrNull { it.timestamp }?.lux ?: 0f

        return Notification.Builder(this, StalkerApplication.CHANNEL_ID_SENSOR)
            .setContentTitle("传感器服务")
            .setContentText("环境光: ${"%.1f".format(latestLux)} lux")
            .setSmallIcon(android.R.drawable.ic_menu_day)
            .setOngoing(true)
            .setContentIntent(pendingIntent)
            .build()
    }
}
