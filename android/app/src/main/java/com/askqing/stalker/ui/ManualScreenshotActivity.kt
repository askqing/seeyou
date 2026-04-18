package com.askqing.stalker.ui

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.View
import android.widget.ImageView
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.askqing.stalker.R
import com.askqing.stalker.service.ScreenshotService
import com.askqing.stalker.util.PreferenceManager
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.util.Base64

/**
 * 手动截图 Activity
 * 允许用户手动截取屏幕并上传到服务器
 * 也可以接收来自其他 App 的图片分享
 */
class ManualScreenshotActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "ManualScreenshot"
    }

    private lateinit var preferenceManager: PreferenceManager

    // 截屏权限请求
    private val screenshotPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == RESULT_OK) {
            ScreenshotService.resultCode = result.resultCode
            ScreenshotService.resultData = result.data
            performScreenshot()
        } else {
            hideProgress()
            Toast.makeText(this, R.string.error_screenshot_permission, Toast.LENGTH_SHORT).show()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_manual_screenshot)

        preferenceManager = PreferenceManager(this)

        // 设置 Toolbar
        val toolbar = findViewById<com.google.android.material.appbar.MaterialToolbar>(R.id.toolbar)
        toolbar.setNavigationOnClickListener { finish() }

        // 截图按钮
        findViewById<View>(R.id.btnTakeScreenshot).setOnClickListener {
            takeScreenshot()
        }

        // 处理来自其他 App 的图片分享
        handleSharedImage(intent)
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        handleSharedImage(intent)
    }

    /**
     * 处理从其他 App 分享过来的图片
     */
    private fun handleSharedImage(intent: Intent?) {
        if (intent?.action == Intent.ACTION_SEND && intent.type?.startsWith("image/") == true) {
            val uri: android.net.Uri? = intent.getParcelableExtra(Intent.EXTRA_STREAM)
            if (uri != null) {
                try {
                    val inputStream: InputStream? = contentResolver.openInputStream(uri)
                    val bitmap = BitmapFactory.decodeStream(inputStream)
                    showPreview(bitmap)

                    // 上传分享的图片
                    uploadBitmap(bitmap, "share")
                    Toast.makeText(this, "正在上传分享的图片", Toast.LENGTH_SHORT).show()
                } catch (e: Exception) {
                    Log.e(TAG, "读取分享图片失败", e)
                    Toast.makeText(this, "读取图片失败", Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    /**
     * 点击截图按钮
     */
    private fun takeScreenshot() {
        // 会议模式检查
        if (preferenceManager.isMeetingMode) {
            Toast.makeText(this, R.string.screenshot_meeting_mode, Toast.LENGTH_SHORT).show()
            return
        }

        // 服务器检查
        if (preferenceManager.serverUrl.isEmpty() || preferenceManager.deviceId.isEmpty()) {
            Toast.makeText(this, "请先配置服务器地址并注册设备", Toast.LENGTH_SHORT).show()
            return
        }

        // 如果已有权限，直接截图
        if (ScreenshotService.hasProjection) {
            performScreenshot()
        } else {
            // 请求截屏权限
            requestScreenshotPermission()
        }
    }

    /**
     * 请求截屏权限
     */
    private fun requestScreenshotPermission() {
        val projectionManager = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        screenshotPermissionLauncher.launch(projectionManager.createScreenCaptureIntent())
    }

    /**
     * 执行截图
     */
    private fun performScreenshot() {
        showProgress()

        // 设置回调来更新 UI
        ScreenshotService.onScreenshotResult = { success, message ->
            runOnUiThread {
                hideProgress()
                if (success) {
                    Toast.makeText(this, R.string.screenshot_success, Toast.LENGTH_SHORT).show()
                } else {
                    Toast.makeText(this, "$R.string.screenshot_failed: $message", Toast.LENGTH_SHORT).show()
                }
            }
        }

        // 启动截图服务
        val intent = Intent(this, com.askqing.stalker.service.ScreenshotService::class.java).apply {
            action = "TAKE_SCREENSHOT"
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
    }

    /**
     * 上传 Bitmap 到服务器
     */
    private fun uploadBitmap(bitmap: Bitmap, trigger: String) {
        showProgress()

        try {
            val outputStream = java.io.ByteArrayOutputStream()
            bitmap.compress(Bitmap.CompressFormat.PNG, 80, outputStream)
            val imageBytes = outputStream.toByteArray()

            val base64 = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Base64.getEncoder().encodeToString(imageBytes)
            } else {
                @Suppress("DEPRECATION")
                android.util.Base64.encodeToString(imageBytes, android.util.Base64.NO_WRAP)
            }

            val upload = com.askqing.stalker.model.ScreenshotUploadRequest(
                deviceId = preferenceManager.deviceId,
                imageBase64 = base64,
                width = bitmap.width,
                height = bitmap.height,
                currentApp = preferenceManager.lastForegroundApp,
                trigger = trigger
            )

            Thread {
                val apiClient = com.askqing.stalker.api.ApiClient.getInstance(this)
                val success = apiClient.uploadScreenshot(upload)

                runOnUiThread {
                    hideProgress()
                    if (success) {
                        Toast.makeText(this, R.string.screenshot_success, Toast.LENGTH_SHORT).show()
                    } else {
                        Toast.makeText(this, R.string.screenshot_failed, Toast.LENGTH_SHORT).show()
                    }
                }
            }.start()

        } catch (e: Exception) {
            hideProgress()
            Log.e(TAG, "上传图片失败", e)
            Toast.makeText(this, "上传失败: ${e.message}", Toast.LENGTH_SHORT).show()
        }
    }

    /**
     * 显示截图预览
     */
    private fun showPreview(bitmap: Bitmap?) {
        val imageView = findViewById<ImageView>(R.id.ivScreenshotPreview)
        val emptyState = findViewById<TextView>(R.id.tvEmptyState)

        if (bitmap != null) {
            imageView.setImageBitmap(bitmap)
            imageView.visibility = View.VISIBLE
            emptyState.visibility = View.GONE
        } else {
            imageView.visibility = View.VISIBLE
            emptyState.visibility = View.VISIBLE
        }
    }

    private fun showProgress() {
        findViewById<ProgressBar>(R.id.progressBar).visibility = View.VISIBLE
        findViewById<TextView>(R.id.tvEmptyState).visibility = View.GONE
    }

    private fun hideProgress() {
        findViewById<ProgressBar>(R.id.progressBar).visibility = View.GONE
    }
}
