package com.askqing.stalker.receiver

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.askqing.stalker.util.PreferenceManager

/**
 * 会议模式检测接收器
 * 监听日历变化，自动检测会议
 */
class MeetingModeReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "MeetingReceiver"
    }

    override fun onReceive(context: Context, intent: Intent?) {
        if (intent?.action == "android.intent.action.PROVIDER_CHANGED") {
            Log.d(TAG, "日历数据变化，检查是否有会议")
            checkForMeetings(context)
        }

        // 处理来自其他组件的会议模式变化广播
        if (intent?.action == "com.askqing.stalker.MEETING_MODE_CHANGED") {
            val isMeeting = intent.getBooleanExtra("meeting_mode", false)
            Log.i(TAG, "会议模式状态变化: $isMeeting")
        }
    }

    /**
     * 检查日历中是否有正在进行的会议
     */
    private fun checkForMeetings(context: Context) {
        val preferenceManager = PreferenceManager(context)

        try {
            val now = System.currentTimeMillis()
            val calendarUri = android.provider.CalendarContract.Calendars.CONTENT_URI

            // 查询正在进行的日历事件
            val eventsUri = android.provider.CalendarContract.Events.CONTENT_URI
            val projection = arrayOf(
                android.provider.CalendarContract.Events.TITLE,
                android.provider.CalendarContract.Events.DTSTART,
                android.provider.CalendarContract.Events.DTEND,
                android.provider.CalendarContract.Events.AVAILABILITY
            )

            val selection = "(${android.provider.CalendarContract.Events.DTSTART} <= ?) AND (${android.provider.CalendarContract.Events.DTEND} >= ?) AND (${android.provider.CalendarContract.Events.AVAILABILITY} != ?)"
            val selectionArgs = arrayOf(now.toString(), now.toString(), "0")  // 排除"暂定"事件

            val cursor = context.contentResolver.query(
                eventsUri, projection, selection, selectionArgs, null
            )

            cursor?.use {
                if (it.count > 0) {
                    // 有正在进行的会议，开启会议模式
                    if (!preferenceManager.isMeetingMode) {
                        preferenceManager.isMeetingMode = true
                        Log.i(TAG, "检测到日历会议，自动开启会议模式")
                        notifyMeetingModeChanged(context, true)
                    }
                } else {
                    // 没有会议，关闭会议模式（如果之前是自动开启的）
                    if (preferenceManager.isMeetingMode) {
                        preferenceManager.isMeetingMode = false
                        Log.i(TAG, "没有进行中的会议，关闭会议模式")
                        notifyMeetingModeChanged(context, false)
                    }
                }
            }
        } catch (e: SecurityException) {
            Log.w(TAG, "没有日历读取权限", e)
        } catch (e: Exception) {
            Log.e(TAG, "检查会议失败", e)
        }
    }

    /**
     * 通知会议模式变化
     */
    private fun notifyMeetingModeChanged(context: Context, isMeeting: Boolean) {
        val intent = Intent("com.askqing.stalker.MEETING_MODE_CHANGED").apply {
            putExtra("meeting_mode", isMeeting)
            putExtra("auto_detected", true)
        }
        context.sendBroadcast(intent)
    }
}
