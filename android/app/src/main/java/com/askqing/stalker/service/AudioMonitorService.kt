package com.askqing.stalker.service

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.IBinder
import android.util.Log
import com.askqing.stalker.StalkerApplication
import com.askqing.stalker.api.ApiClient
import com.askqing.stalker.model.AudioTag
import com.askqing.stalker.util.PreferenceManager
import kotlinx.coroutines.*
import kotlin.math.abs
import kotlin.math.sqrt

/**
 * 环境音频监听服务
 * 使用麦克风采集环境音频，分析并生成音频标签
 * 不保存音频文件，仅分析音频特征
 *
 * 标签类型：
 * - silent: 安静（低于阈值）
 * - speech: 语音（有节奏的声波变化）
 * - music: 音乐（频率范围广）
 * - noise: 噪音（不规则高振幅）
 * - meeting: 会议（多人语音特征）
 * - outdoor: 户外（环境噪音 + 风声特征）
 */
class AudioMonitorService : Service() {

    companion object {
        private const val TAG = "AudioMonitor"

        // 音频参数
        private const val SAMPLE_RATE = 16000
        private const val CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_MONO
        private const val AUDIO_FORMAT = AudioFormat.ENCODING_PCM_16BIT
        private const val BUFFER_SIZE_FACTOR = 2

        // 分析参数
        private const val ANALYSIS_WINDOW_MS = 3000L  // 3 秒分析窗口
        private const val SILENCE_THRESHOLD_DB = 30    // 安静阈值（分贝）

        @Volatile
        var isRunning = false
            private set
    }

    private val preferenceManager: PreferenceManager by lazy { PreferenceManager(this) }
    private val apiClient: ApiClient by lazy { ApiClient.getInstance(this) }
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    private var audioRecord: AudioRecord? = null
    private var bufferSize = 0
    private var isRecording = false

    override fun onCreate() {
        super.onCreate()
        isRunning = true
        startForegroundNotification()
        initAudioRecord()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            "START_MONITORING" -> startMonitoring()
            "STOP_MONITORING" -> stopMonitoring()
        }
        return START_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
        stopMonitoring()
        isRunning = false
        scope.cancel()
    }

    // ==================== 音频初始化 ====================

    /**
     * 初始化 AudioRecord
     */
    private fun initAudioRecord() {
        bufferSize = AudioRecord.getMinBufferSize(
            SAMPLE_RATE, CHANNEL_CONFIG, AUDIO_FORMAT
        ) * BUFFER_SIZE_FACTOR

        try {
            audioRecord = AudioRecord(
                MediaRecorder.AudioSource.MIC,
                SAMPLE_RATE,
                CHANNEL_CONFIG,
                AUDIO_FORMAT,
                bufferSize
            )
            Log.i(TAG, "AudioRecord 初始化成功, bufferSize=$bufferSize")
        } catch (e: Exception) {
            Log.e(TAG, "AudioRecord 初始化失败", e)
        }
    }

    // ==================== 开始/停止监控 ====================

    private fun startMonitoring() {
        if (isRecording) return

        val record = audioRecord ?: run {
            Log.e(TAG, "AudioRecord 未初始化")
            return
        }

        try {
            record.startRecording()
            isRecording = true

            // 启动音频分析任务
            scope.launch {
                analyzeAudioLoop()
            }

            Log.i(TAG, "音频监控已开始")
        } catch (e: Exception) {
            Log.e(TAG, "启动音频录制失败", e)
        }
    }

    private fun stopMonitoring() {
        try {
            audioRecord?.stop()
        } catch (e: Exception) {
            // ignore
        }
        isRecording = false
        Log.i(TAG, "音频监控已停止")
    }

    // ==================== 音频分析 ====================

    /**
     * 音频分析主循环
     */
    private suspend fun analyzeAudioLoop() {
        val record = audioRecord ?: return
        val buffer = ShortArray(bufferSize / 2)

        while (isRecording && isActive) {
            // 读取音频数据
            val readCount = record.read(buffer, 0, buffer.size)
            if (readCount <= 0) {
                delay(100)
                continue
            }

            // 分析音频特征
            val features = analyzeAudioFeatures(buffer, readCount)

            // 生成标签
            val tag = generateTag(features)

            // 上传标签
            if (preferenceManager.deviceId.isNotEmpty() && !preferenceManager.isMeetingMode) {
                scope.launch {
                    val audioTag = AudioTag(
                        deviceId = preferenceManager.deviceId,
                        tag = tag,
                        confidence = features.confidence,
                        decibel = features.decibel,
                        durationMs = ANALYSIS_WINDOW_MS
                    )
                    apiClient.uploadAudioTag(audioTag)
                }
            }

            Log.d(TAG, "音频标签: $tag (${features.decibel}dB, 置信度: ${features.confidence})")

            // 等待下一个分析窗口
            delay(ANALYSIS_WINDOW_MS)
        }
    }

    /**
     * 分析音频特征
     */
    private fun analyzeAudioFeatures(buffer: ShortArray, readCount: Int): AudioFeatures {
        // 计算振幅（RMS）
        var sumSquares = 0.0
        var maxAmplitude = 0.0

        for (i in 0 until readCount) {
            val sample = buffer[i].toDouble()
            sumSquares += sample * sample
            maxAmplitude = maxOf(maxAmplitude, abs(sample))
        }

        val rms = sqrt(sumSquares / readCount)
        val decibel = if (rms > 0) {
            (20 * kotlin.math.log10(rms / 32767.0)).toFloat()
        } else {
            -Float.MAX_VALUE
        }

        // 计算 ZCR（过零率）- 用于区分语音和噪音
        var zeroCrossings = 0
        for (i in 1 until readCount) {
            if ((buffer[i] >= 0) != (buffer[i - 1] >= 0)) {
                zeroCrossings++
            }
        }
        val zcr = zeroCrossings.toFloat() / readCount

        // 计算能量分布（低频 vs 高频）
        var lowFreqEnergy = 0.0
        var highFreqEnergy = 0.0
        val splitPoint = readCount / 4
        for (i in 0 until readCount) {
            val energy = (buffer[i].toDouble() * buffer[i].toDouble())
            if (i < splitPoint) {
                lowFreqEnergy += energy
            } else {
                highFreqEnergy += energy
            }
        }

        val energyRatio = if (highFreqEnergy > 0) {
            lowFreqEnergy / highFreqEnergy
        } else {
            Float.MAX_VALUE.toDouble()
        }

        return AudioFeatures(
            rms = rms.toFloat(),
            decibel = decibel,
            maxAmplitude = maxAmplitude.toFloat(),
            zcr = zcr,
            lowToHighRatio = energyRatio,
            confidence = calculateConfidence(decibel, zcr, energyRatio)
        )
    }

    /**
     * 生成音频标签
     */
    private fun generateTag(features: AudioFeatures): String {
        val db = features.decibel

        return when {
            // 安静
            db < -SILENCE_THRESHOLD_DB -> "silent"

            // 会议模式（较低分贝 + 中等过零率）
            db > -50 && db < -25 && features.zcr > 0.1f && features.zcr < 0.3f -> "meeting"

            // 语音（中等分贝 + 特定过零率范围）
            db > -50 && db < -15 && features.zcr > 0.05f && features.zcr < 0.25f -> "speech"

            // 音乐（能量分布均匀 + 较高过零率）
            features.lowToHighRatio > 0.5 && features.lowToHighRatio < 2.0 && features.zcr > 0.15f -> "music"

            // 户外（高过零率 + 不规则能量）
            features.zcr > 0.2f && features.lowToHighRatio < 0.3 -> "outdoor"

            // 噪音
            else -> "noise"
        }
    }

    /**
     * 计算标签置信度
     */
    private fun calculateConfidence(decibel: Float, zcr: Float, energyRatio: Double): Float {
        // 简单的置信度计算
        val dbConfidence = when {
            decibel < -SILENCE_THRESHOLD_DB -> 0.9f  // 安静比较确定
            decibel < -50 -> 0.6f
            else -> 0.5f
        }

        val zcrConfidence = when {
            zcr < 0.05f -> 0.7f  // 非常低的过零率
            zcr > 0.3f -> 0.7f   // 非常高的过零率
            else -> 0.4f
        }

        return (dbConfidence + zcrConfidence) / 2f
    }

    /**
     * 音频特征数据类
     */
    private data class AudioFeatures(
        val rms: Float,
        val decibel: Float,
        val maxAmplitude: Float,
        val zcr: Float,
        val lowToHighRatio: Double,
        val confidence: Float
    )

    // ==================== 前台通知 ====================

    private fun startForegroundNotification() {
        val notification = createNotification()
        startForeground(3, notification)
    }

    private fun createNotification(): Notification {
        val intent = packageManager.getLaunchIntentForPackage(packageName) ?: Intent()
        val pendingIntent = PendingIntent.getActivity(
            this, 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return Notification.Builder(this, StalkerApplication.CHANNEL_ID_AUDIO)
            .setContentTitle("音频监控")
            .setContentText(if (isRecording) "正在分析环境音频" else "已暂停")
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setOngoing(true)
            .setContentIntent(pendingIntent)
            .build()
    }
}
