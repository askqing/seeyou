package com.askqing.stalker.ui

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.text.format.DateUtils
import android.view.View
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.askqing.stalker.R
import com.askqing.stalker.api.ApiClient
import com.askqing.stalker.service.*
import com.askqing.stalker.util.PreferenceManager
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.snackbar.Snackbar
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.*

/**
 * 主界面 Activity
 * 显示服务器配置、状态信息、功能开关
 */
class MainActivity : AppCompatActivity() {

    private lateinit var preferenceManager: PreferenceManager
    private lateinit var apiClient: ApiClient

    // Health Connect 权限请求
    private val healthConnectPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == RESULT_OK) {
            Toast.makeText(this, "Health Connect 权限已授权", Toast.LENGTH_SHORT).show()
        }
    }

    // 截屏权限请求
    private val screenshotPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == RESULT_OK) {
            ScreenshotService.resultCode = result.resultCode
            ScreenshotService.resultData = result.data
            Toast.makeText(this, "截屏权限已获取", Toast.LENGTH_SHORT).show()
        } else {
            Toast.makeText(this, "截屏权限被拒绝", Toast.LENGTH_SHORT).show()
        }
    }

    // 通知权限请求
    private val notificationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (!granted) {
            Toast.makeText(this, "通知权限被拒绝，部分功能可能受影响", Toast.LENGTH_SHORT).show()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        preferenceManager = PreferenceManager(this)
        apiClient = ApiClient.getInstance(this)

        initViews()
        loadSettings()
        requestPermissions()
        startStatusUpdateLoop()
    }

    override fun onResume() {
        super.onResume()
        updateAllStatus()
    }

    // ==================== 初始化视图 ====================

    private fun initViews() {
        // 测试连接按钮
        findViewById<View>(R.id.btnTestConnection).setOnClickListener {
            testConnection()
        }

        // 保存设置按钮
        findViewById<View>(R.id.btnSaveSettings).setOnClickListener {
            saveSettings()
        }

        // 手动截图按钮
        findViewById<View>(R.id.btnManualScreenshot).setOnClickListener {
            startActivity(Intent(this, ManualScreenshotActivity::class.java))
        }

        // 设置按钮
        findViewById<View>(R.id.btnSettings).setOnClickListener {
            startActivity(Intent(this, SettingsActivity::class.java))
        }

        // 无障碍开关
        findViewById<View>(R.id.switchAccessibility).setOnClickListener {
            val switch = it as com.google.android.material.switchmaterial.SwitchMaterial
            handleAccessibilityToggle(switch.isChecked)
        }

        // 健康连接开关
        findViewById<View>(R.id.switchHealthConnect).setOnClickListener {
            val switch = it as com.google.android.material.switchmaterial.SwitchMaterial
            handleHealthConnectToggle(switch.isChecked)
        }

        // 截图开关
        findViewById<View>(R.id.switchScreenshot).setOnClickListener {
            val switch = it as com.google.android.material.switchmaterial.SwitchMaterial
            handleScreenshotToggle(switch.isChecked)
        }

        // 音频开关
        findViewById<View>(R.id.switchAudio).setOnClickListener {
            val switch = it as com.google.android.material.switchmaterial.SwitchMaterial
            handleAudioToggle(switch.isChecked)
        }

        // 传感器开关
        findViewById<View>(R.id.switchSensor).setOnClickListener {
            val switch = it as com.google.android.material.switchmaterial.SwitchMaterial
            handleSensorToggle(switch.isChecked)
        }

        // 会议模式开关
        findViewById<View>(R.id.switchMeetingMode).setOnClickListener {
            val switch = it as com.google.android.material.switchmaterial.SwitchMaterial
            handleMeetingModeToggle(switch.isChecked)
        }
    }

    // ==================== 加载设置 ====================

    private fun loadSettings() {
        findViewById<com.google.android.material.textfield.TextInputEditText>(R.id.etServerUrl)
            .setText(preferenceManager.serverUrl)
        findViewById<com.google.android.material.textfield.TextInputEditText>(R.id.etDeviceName)
            .setText(preferenceManager.deviceName)

        // 设置开关状态
        findViewById<com.google.android.material.switchmaterial.SwitchMaterial>(R.id.switchAccessibility)
            .isChecked = preferenceManager.isAccessibilityEnabled
        findViewById<com.google.android.material.switchmaterial.SwitchMaterial>(R.id.switchHealthConnect)
            .isChecked = preferenceManager.isHealthConnectEnabled
        findViewById<com.google.android.material.switchmaterial.SwitchMaterial>(R.id.switchScreenshot)
            .isChecked = preferenceManager.isScreenshotEnabled
        findViewById<com.google.android.material.switchmaterial.SwitchMaterial>(R.id.switchAudio)
            .isChecked = preferenceManager.isAudioEnabled
        findViewById<com.google.android.material.switchmaterial.SwitchMaterial>(R.id.switchSensor)
            .isChecked = preferenceManager.isSensorEnabled
        findViewById<com.google.android.material.switchmaterial.SwitchMaterial>(R.id.switchMeetingMode)
            .isChecked = preferenceManager.isMeetingMode
    }

    // ==================== 保存设置 ====================

    private fun saveSettings() {
        val serverUrl = findViewById<com.google.android.material.textfield.TextInputEditText>(R.id.etServerUrl)
            .text.toString().trim()
        val deviceName = findViewById<com.google.android.material.textfield.TextInputEditText>(R.id.etDeviceName)
            .text.toString().trim()

        if (serverUrl.isEmpty()) {
            Snackbar.make(findViewById(android.R.id.content), R.string.error_empty_server_url, Snackbar.LENGTH_SHORT).show()
            return
        }

        preferenceManager.serverUrl = serverUrl
        preferenceManager.deviceName = if (deviceName.isEmpty()) android.os.Build.MODEL else deviceName

        Snackbar.make(findViewById(android.R.id.content), "设置已保存", Snackbar.LENGTH_SHORT).show()

        // 注册设备
        registerDevice()
    }

    // ==================== 测试连接 ====================

    private fun testConnection() {
        val serverUrl = findViewById<com.google.android.material.textfield.TextInputEditText>(R.id.etServerUrl)
            .text.toString().trim()

        if (serverUrl.isEmpty()) {
            Snackbar.make(findViewById(android.R.id.content), R.string.error_empty_server_url, Snackbar.LENGTH_SHORT).show()
            return
        }

        preferenceManager.serverUrl = serverUrl

        lifecycleScope.launch {
            val result = apiClient.testConnection()
            if (result.isSuccess) {
                Snackbar.make(
                    findViewById(android.R.id.content),
                    "连接成功: ${result.getOrNull()}",
                    Snackbar.LENGTH_SHORT
                ).show()
                updateConnectionStatus(true)
            } else {
                Snackbar.make(
                    findViewById(android.R.id.content),
                    "连接失败: ${result.exceptionOrNull()?.message}",
                    Snackbar.LENGTH_LONG
                ).show()
                updateConnectionStatus(false)
            }
        }
    }

    // ==================== 设备注册 ====================

    private fun registerDevice() {
        lifecycleScope.launch {
            val result = apiClient.registerDevice()
            if (result.isSuccess) {
                val deviceId = result.getOrNull()
                findViewById<android.widget.TextView>(R.id.tvDeviceId).text = "设备ID: $deviceId"
                // 启动同步服务
                startSyncService()
            }
        }
    }

    // ==================== 功能开关处理 ====================

    /**
     * 无障碍服务开关
     */
    private fun handleAccessibilityToggle(enabled: Boolean) {
        if (enabled) {
            // 检查无障碍服务是否已开启
            if (!isAccessibilityServiceEnabled()) {
                MaterialAlertDialogBuilder(this)
                    .setTitle(R.string.accessibility_not_enabled)
                    .setMessage(R.string.accessibility_enable_prompt)
                    .setPositiveButton(R.string.go_to_settings) { _, _ ->
                        openAccessibilitySettings()
                    }
                    .setNegativeButton(R.string.cancel) { _, _ ->
                        findViewById<com.google.android.material.switchmaterial.SwitchMaterial>(R.id.switchAccessibility)
                            .isChecked = false
                    }
                    .show()
                return
            }
            preferenceManager.isAccessibilityEnabled = true
            Toast.makeText(this, "无障碍监控已启用", Toast.LENGTH_SHORT).show()
        } else {
            preferenceManager.isAccessibilityEnabled = false
            Toast.makeText(this, "无障碍监控已禁用", Toast.LENGTH_SHORT).show()
        }
    }

    /**
     * 健康连接开关
     */
    private fun handleHealthConnectToggle(enabled: Boolean) {
        if (enabled) {
            // 请求 Health Connect 权限
            val healthConnectManager = com.askqing.stalker.service.HealthConnectManager.getInstance(this)
            if (!healthConnectManager.isAvailable()) {
                Toast.makeText(this, R.string.health_connect_not_available, Toast.LENGTH_LONG).show()
                findViewById<com.google.android.material.switchmaterial.SwitchMaterial>(R.id.switchHealthConnect)
                    .isChecked = false
                return
            }

            if (!healthConnectManager.hasPermissions()) {
                val intent = healthConnectManager.createPermissionRequestIntent()
                if (intent != null) {
                    healthConnectPermissionLauncher.launch(intent)
                } else {
                    Toast.makeText(this, R.string.health_connect_permission_required, Toast.LENGTH_SHORT).show()
                    findViewById<com.google.android.material.switchmaterial.SwitchMaterial>(R.id.switchHealthConnect)
                        .isChecked = false
                    return
                }
            }

            preferenceManager.isHealthConnectEnabled = true
            healthConnectManager.startPeriodicUpload()
            Toast.makeText(this, "健康数据同步已启用", Toast.LENGTH_SHORT).show()
        } else {
            preferenceManager.isHealthConnectEnabled = false
            com.askqing.stalker.service.HealthConnectManager.getInstance(this).stopPeriodicUpload()
            Toast.makeText(this, "健康数据同步已禁用", Toast.LENGTH_SHORT).show()
        }
    }

    /**
     * 截图开关
     */
    private fun handleScreenshotToggle(enabled: Boolean) {
        if (enabled) {
            // 请求截屏权限
            val projectionManager = getSystemService(MEDIA_PROJECTION_SERVICE) as android.media.projection.MediaProjectionManager
            screenshotPermissionLauncher.launch(projectionManager.createScreenCaptureIntent())
            preferenceManager.isScreenshotEnabled = true
            startScreenshotService()
        } else {
            preferenceManager.isScreenshotEnabled = false
            stopService(Intent(this, ScreenshotService::class.java))
        }
    }

    /**
     * 音频开关
     */
    private fun handleAudioToggle(enabled: Boolean) {
        if (enabled) {
            // 检查麦克风权限
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED
            ) {
                requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 100)
                findViewById<com.google.android.material.switchmaterial.SwitchMaterial>(R.id.switchAudio)
                    .isChecked = false
                return
            }

            preferenceManager.isAudioEnabled = true
            startAudioService()
            Toast.makeText(this, "音频监控已启用", Toast.LENGTH_SHORT).show()
        } else {
            preferenceManager.isAudioEnabled = false
            stopService(Intent(this, AudioMonitorService::class.java))
        }
    }

    /**
     * 传感器开关
     */
    private fun handleSensorToggle(enabled: Boolean) {
        if (enabled) {
            preferenceManager.isSensorEnabled = true
            startSensorService()
            Toast.makeText(this, "传感器已启用", Toast.LENGTH_SHORT).show()
        } else {
            preferenceManager.isSensorEnabled = false
            stopService(Intent(this, SensorCollectionService::class.java))
        }
    }

    /**
     * 会议模式开关
     */
    private fun handleMeetingModeToggle(enabled: Boolean) {
        preferenceManager.isMeetingMode = enabled

        if (enabled) {
            Toast.makeText(this, R.string.meeting_mode_active, Toast.LENGTH_SHORT).show()
        } else {
            Toast.makeText(this, R.string.meeting_mode_inactive, Toast.LENGTH_SHORT).show()
        }

        // 通知所有服务
        val intent = Intent("com.askqing.stalker.MEETING_MODE_CHANGED").apply {
            putExtra("meeting_mode", enabled)
        }
        sendBroadcast(intent)
    }

    // ==================== 服务管理 ====================

    private fun startSyncService() {
        val intent = Intent(this, SyncService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
    }

    private fun startScreenshotService() {
        val intent = Intent(this, ScreenshotService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
    }

    private fun startAudioService() {
        val intent = Intent(this, AudioMonitorService::class.java).apply {
            action = "START_MONITORING"
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
    }

    private fun startSensorService() {
        val intent = Intent(this, SensorCollectionService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
    }

    // ==================== 权限 ====================

    private fun requestPermissions() {
        // 通知权限（Android 13+）
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED
            ) {
                notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        when (requestCode) {
            100 -> {  // RECORD_AUDIO
                if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                    findViewById<com.google.android.material.switchmaterial.SwitchMaterial>(R.id.switchAudio)
                        .isChecked = true
                    handleAudioToggle(true)
                } else {
                    Toast.makeText(this, R.string.audio_permission_required, Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    // ==================== 状态更新 ====================

    private fun startStatusUpdateLoop() {
        lifecycleScope.launch {
            while (true) {
                updateAllStatus()
                kotlinx.coroutines.delay(2000)  // 每 2 秒更新一次
            }
        }
    }

    private fun updateAllStatus() {
        // 更新设备 ID
        val deviceId = preferenceManager.deviceId
        findViewById<android.widget.TextView>(R.id.tvDeviceId).text =
            if (deviceId.isNotEmpty()) "设备ID: $deviceId" else "设备ID: 未注册"

        // 更新最后同步时间
        val lastSync = preferenceManager.lastSyncTime
        findViewById<android.widget.TextView>(R.id.tvLastSync).text = if (lastSync > 0) {
            "上次同步: ${formatTime(lastSync)}"
        } else {
            getString(R.string.last_sync)
        }

        // 更新当前前台应用
        val currentApp = preferenceManager.lastForegroundApp
        findViewById<android.widget.TextView>(R.id.tvCurrentApp).text =
            if (currentApp.isNotEmpty()) "前台应用: $currentApp" else "前台应用: 无"

        // 更新会议模式状态
        val isMeeting = preferenceManager.isMeetingMode
        findViewById<com.google.android.material.switchmaterial.SwitchMaterial>(R.id.switchMeetingMode)
            .isChecked = isMeeting
    }

    private fun updateConnectionStatus(connected: Boolean) {
        val statusDot = findViewById<View>(R.id.statusDot)
        val statusText = findViewById<android.widget.TextView>(R.id.tvConnectionStatus)

        statusDot.setBackgroundResource(
            if (connected) R.drawable.status_dot_connected else R.drawable.status_dot
        )
        statusText.text = if (connected) getString(R.string.status_connected) else getString(R.string.status_disconnected)
    }

    // ==================== 工具方法 ====================

    private fun isAccessibilityServiceEnabled(): Boolean {
        val am = getSystemService(Context.ACCESSIBILITY_SERVICE) as android.view.accessibility.AccessibilityManager
        val enabledServices = am.getEnabledAccessibilityServiceList(
            android.view.accessibility.AccessibilityServiceInfo.FEEDBACK_ALL_MASK
        )
        return enabledServices.any {
            it.resolveInfo.serviceInfo.packageName == packageName
        }
    }

    private fun openAccessibilitySettings() {
        val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
        startActivity(intent)
    }

    private fun formatTime(timestamp: Long): String {
        val sdf = SimpleDateFormat("HH:mm:ss", Locale.getDefault())
        return sdf.format(Date(timestamp))
    }
}
