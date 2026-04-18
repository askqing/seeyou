package com.askqing.stalker.ui

import android.os.Bundle
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.askqing.stalker.BuildConfig
import com.askqing.stalker.R
import com.askqing.stalker.util.PreferenceManager
import com.google.android.material.appbar.MaterialToolbar
import com.google.android.material.snackbar.Snackbar

/**
 * 设置 Activity
 * 服务器地址、设备名称、上传间隔等配置
 */
class SettingsActivity : AppCompatActivity() {

    private lateinit var preferenceManager: PreferenceManager

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)

        preferenceManager = PreferenceManager(this)

        // Toolbar
        val toolbar = findViewById<MaterialToolbar>(R.id.toolbar)
        toolbar.setNavigationOnClickListener { finish() }

        // 版本信息
        findViewById<TextView>(R.id.tvVersion).text = getString(R.string.settings_version, "1.0.0")

        // 加载当前设置
        loadSettings()

        // 保存按钮
        findViewById<android.view.View>(R.id.btnSaveSettings).setOnClickListener {
            saveSettings()
        }
    }

    /**
     * 加载当前设置到表单
     */
    private fun loadSettings() {
        findViewById<com.google.android.material.textfield.TextInputEditText>(R.id.etSettingsServerUrl)
            .setText(preferenceManager.serverUrl)
        findViewById<com.google.android.material.textfield.TextInputEditText>(R.id.etSettingsDeviceName)
            .setText(preferenceManager.deviceName)
        findViewById<com.google.android.material.textfield.TextInputEditText>(R.id.etHeartbeatInterval)
            .setText(preferenceManager.heartbeatInterval.toString())
        findViewById<com.google.android.material.textfield.TextInputEditText>(R.id.etUploadInterval)
            .setText(preferenceManager.uploadInterval.toString())
    }

    /**
     * 保存设置
     */
    private fun saveSettings() {
        val serverUrl = findViewById<com.google.android.material.textfield.TextInputEditText>(R.id.etSettingsServerUrl)
            .text.toString().trim()
        val deviceName = findViewById<com.google.android.material.textfield.TextInputEditText>(R.id.etSettingsDeviceName)
            .text.toString().trim()
        val heartbeatInterval = findViewById<com.google.android.material.textfield.TextInputEditText>(R.id.etHeartbeatInterval)
            .text.toString().trim().toIntOrNull() ?: 30
        val uploadInterval = findViewById<com.google.android.material.textfield.TextInputEditText>(R.id.etUploadInterval)
            .text.toString().trim().toIntOrNull() ?: 300

        if (serverUrl.isEmpty()) {
            Snackbar.make(findViewById(android.R.id.content), R.string.error_empty_server_url, Snackbar.LENGTH_SHORT).show()
            return
        }

        preferenceManager.serverUrl = serverUrl
        preferenceManager.deviceName = if (deviceName.isEmpty()) android.os.Build.MODEL else deviceName
        preferenceManager.heartbeatInterval = heartbeatInterval.coerceIn(5, 300)
        preferenceManager.uploadInterval = uploadInterval.coerceIn(10, 3600)

        Snackbar.make(findViewById(android.R.id.content), "设置已保存", Snackbar.LENGTH_SHORT).show()
        Toast.makeText(this, "设置已保存，部分更改将在重启服务后生效", Toast.LENGTH_SHORT).show()
    }
}
