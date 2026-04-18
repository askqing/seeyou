package com.askqing.stalker.service

import android.accessibilityservice.AccessibilityService
import android.content.Intent
import android.os.Build
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import com.askqing.stalker.StalkerApplication
import com.askqing.stalker.R
import com.askqing.stalker.api.ApiClient
import com.askqing.stalker.model.AppSwitchChain
import com.askqing.stalker.model.AppSwitchEvent
import com.askqing.stalker.model.WindowContentChangeEvent
import com.askqing.stalker.util.AppInfoHelper
import com.askqing.stalker.util.PreferenceManager
import kotlinx.coroutines.*
import android.app.Notification
import android.app.PendingIntent
import android.graphics.PixelFormat
import android.view.Gravity
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView

/**
 * 无障碍监控服务
 * 核心服务，监控前台应用切换、窗口内容变化
 * 功能：
 * - 检测当前前台应用（包名 + 应用名）
 * - 检测窗口标题/内容变化
 * - 记录应用切换事件
 * - 构建应用切换链（时间窗口内的连续切换序列）
 * - 跟踪操作节奏（每个应用停留时长）
 * - 实时发送事件到服务器
 * - 会议模式：停止监控并显示"会议中"状态
 */
class AccessibilityMonitorService : AccessibilityService() {

    companion object {
        private const val TAG = "AccessibilityMonitor"

        // 应用切换链的时间窗口（毫秒）
        private const val CHAIN_WINDOW_MS = 5 * 60 * 1000L  // 5 分钟

        // 窗口内容变化节流（毫秒）
        private const val CONTENT_CHANGE_THROTTLE_MS = 2000L

        // 上次内容变化的时间，用于节流
        private var lastContentChangeTime = 0L

        // 服务是否正在运行
        @Volatile
        var isRunning = false
            private set
    }

    private val preferenceManager: PreferenceManager by lazy {
        PreferenceManager(this)
    }

    private val apiClient: ApiClient by lazy {
        ApiClient.getInstance(this)
    }

    private val serviceScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    // 当前前台应用
    private var currentPackageName: String = ""
    private var currentAppName: String = ""
    private var currentWindowTitle: String? = null
    private var appEnterTime: Long = 0L  // 进入当前应用的时间

    // 应用切换链
    private val switchEvents = mutableListOf<AppSwitchEvent>()
    private var chainStartTime: Long = 0L

    // 操作分析器
    private val operationAnalyzer = OperationAnalyzer()

    // 会议模式悬浮窗
    private var meetingOverlay: WindowManager? = null
    private var meetingTextView: TextView? = null

    override fun onServiceConnected() {
        super.onServiceConnected()
        isRunning = true
        Log.i(TAG, "无障碍服务已连接")
        startForegroundNotification()
        startChainTimer()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null) return

        // 会议模式下不处理事件
        if (preferenceManager.isMeetingMode) return

        when (event.eventType) {
            AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED -> {
                handleWindowStateChanged(event)
            }
            AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED -> {
                handleWindowContentChanged(event)
            }
        }
    }

    override fun onInterrupt() {
        Log.w(TAG, "无障碍服务被中断")
    }

    override fun onDestroy() {
        super.onDestroy()
        isRunning = false
        serviceScope.cancel()
        removeMeetingOverlay()
        Log.i(TAG, "无障碍服务已销毁")
    }

    // ==================== 窗口状态变化 ====================

    /**
     * 处理窗口状态变化事件（应用切换）
     */
    private fun handleWindowStateChanged(event: AccessibilityEvent) {
        val packageName = event.packageName?.toString() ?: return

        // 过滤掉自身的事件
        if (packageName == this.packageName) return

        // 如果是新应用，记录切换事件
        if (packageName != currentPackageName) {
            val appName = AppInfoHelper.getAppName(this, packageName)
            val windowTitle = event.text?.firstOrNull()?.toString()

            // 构建应用切换事件
            val switchEvent = AppSwitchEvent(
                deviceId = preferenceManager.deviceId,
                timestamp = System.currentTimeMillis(),
                fromPackage = currentPackageName.ifEmpty { null },
                fromAppName = currentAppName.ifEmpty { null },
                toPackage = packageName,
                toAppName = appName,
                windowTitle = windowTitle,
                durationInPreviousMs = if (appEnterTime > 0) System.currentTimeMillis() - appEnterTime else null
            )

            // 更新当前应用状态
            val previousPackage = currentPackageName
            currentPackageName = packageName
            currentAppName = appName
            currentWindowTitle = windowTitle
            appEnterTime = System.currentTimeMillis()

            // 更新偏好设置
            preferenceManager.lastForegroundApp = "$appName ($packageName)"

            // 添加到切换链
            addToSwitchChain(switchEvent)

            // 添加到操作分析器
            operationAnalyzer.recordSwitch(switchEvent)

            // 发送到服务器（异步）
            serviceScope.launch {
                apiClient.reportAppSwitch(switchEvent)
            }

            // 更新通知
            updateNotification()

            Log.d(TAG, "应用切换: ${switchEvent.fromAppName} -> ${switchEvent.toAppName}")
        }
    }

    // ==================== 窗口内容变化 ====================

    /**
     * 处理窗口内容变化事件
     * 带有节流控制，避免过于频繁
     */
    private fun handleWindowContentChanged(event: AccessibilityEvent) {
        val now = System.currentTimeMillis()
        if (now - lastContentChangeTime < CONTENT_CHANGE_THROTTLE_MS) return
        lastContentChangeTime = now

        val packageName = event.packageName?.toString() ?: return
        val source = event.source ?: return

        // 提取内容描述
        val contentDescription = extractContentDescription(source)

        if (contentDescription.isNotEmpty()) {
            val changeEvent = WindowContentChangeEvent(
                deviceId = preferenceManager.deviceId,
                timestamp = now,
                packageName = packageName,
                eventType = event.eventType,
                contentDescription = contentDescription
            )

            serviceScope.launch {
                apiClient.reportWindowContentChange(changeEvent)
            }
        }
    }

    /**
     * 从节点树中提取内容描述
     */
    private fun extractContentDescription(node: AccessibilityNodeInfo): String {
        val descriptions = mutableListOf<String>()
        collectDescriptions(node, descriptions, 0, 3)  // 最多递归 3 层
        return descriptions.joinToString(" | ")
    }

    private fun collectDescriptions(
        node: AccessibilityNodeInfo,
        descriptions: MutableList<String>,
        depth: Int,
        maxDepth: Int
    ) {
        if (depth > maxDepth) return

        node.contentDescription?.toString()?.let {
            if (it.isNotBlank()) descriptions.add(it)
        }
        node.text?.toString()?.let {
            if (it.isNotBlank() && it.length < 100) descriptions.add(it)
        }

        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            collectDescriptions(child, descriptions, depth + 1, maxDepth)
        }
    }

    // ==================== 应用切换链 ====================

    /**
     * 添加事件到切换链
     */
    private fun addToSwitchChain(event: AppSwitchEvent) {
        val now = System.currentTimeMillis()

        // 如果当前链已超时，先保存旧链
        if (chainStartTime > 0 && now - chainStartTime > CHAIN_WINDOW_MS) {
            flushSwitchChain()
        }

        if (switchEvents.isEmpty()) {
            chainStartTime = event.timestamp
        }

        switchEvents.add(event)
    }

    /**
     * 启动定时器，定期发送切换链
     */
    private fun startChainTimer() {
        serviceScope.launch {
            while (isActive) {
                delay(60_000)  // 每分钟检查一次
                if (switchEvents.isNotEmpty()) {
                    flushSwitchChain()
                }
            }
        }
    }

    /**
     * 发送当前切换链到服务器
     */
    private fun flushSwitchChain() {
        if (switchEvents.isEmpty()) return

        val chain = AppSwitchChain(
            deviceId = preferenceManager.deviceId,
            startTime = switchEvents.firstOrNull()?.timestamp ?: System.currentTimeMillis(),
            endTime = System.currentTimeMillis(),
            switches = switchEvents.toList()
        )

        serviceScope.launch {
            apiClient.reportAppSwitchChain(chain)
            Log.d(TAG, "发送切换链: ${chain.totalSwitches} 次切换, ${chain.uniqueApps} 个不同应用")
        }

        switchEvents.clear()
        chainStartTime = 0L
    }

    // ==================== 通知 ====================

    private fun startForegroundNotification() {
        updateNotification()
    }

    private fun updateNotification() {
        val notification = createNotification()
        startForeground(1, notification)
    }

    private fun createNotification(): Notification {
        val intent = packageManager.getLaunchIntentForPackage(packageName) ?: Intent()
        val pendingIntent = PendingIntent.getActivity(
            this, 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // 会议模式 Action
        val meetingIntent = Intent(this, AccessibilityMonitorService::class.java).apply {
            action = "TOGGLE_MEETING_MODE"
        }
        val meetingPendingIntent = PendingIntent.getService(
            this, 1, meetingIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val contentText = if (preferenceManager.isMeetingMode) {
            getString(R.string.notification_text_meeting)
        } else if (currentAppName.isNotEmpty()) {
            getString(R.string.notification_text_monitoring, currentAppName)
        } else {
            getString(R.string.notification_text_idle)
        }

        return Notification.Builder(this, StalkerApplication.CHANNEL_ID_MAIN)
            .setContentTitle(getString(R.string.notification_title))
            .setContentText(contentText)
            .setSmallIcon(android.R.drawable.ic_menu_compass)
            .setOngoing(true)
            .setContentIntent(pendingIntent)
            .addAction(
                android.R.drawable.ic_menu_today,
                if (preferenceManager.isMeetingMode) "结束会议" else "开会模式",
                meetingPendingIntent
            )
            .build()
    }

    // ==================== 会议模式 ====================

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)

        if (intent?.action == "TOGGLE_MEETING_MODE") {
            toggleMeetingMode()
        }

        return START_STICKY
    }

    /**
     * 切换会议模式
     */
    private fun toggleMeetingMode() {
        preferenceManager.isMeetingMode = !preferenceManager.isMeetingMode
        val isMeeting = preferenceManager.isMeetingMode

        if (isMeeting) {
            showMeetingOverlay()
            Log.i(TAG, "会议模式已开启")
        } else {
            removeMeetingOverlay()
            Log.i(TAG, "会议模式已关闭")
        }

        updateNotification()

        // 广播会议模式变化
        val broadcastIntent = Intent("com.askqing.stalker.MEETING_MODE_CHANGED").apply {
            putExtra("meeting_mode", isMeeting)
        }
        sendBroadcast(broadcastIntent)
    }

    /**
     * 显示会议模式悬浮窗
     */
    private fun showMeetingOverlay() {
        if (meetingOverlay != null) return

        meetingOverlay = getSystemService(WINDOW_SERVICE) as WindowManager

        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            else
                @Suppress("DEPRECATION")
                WindowManager.LayoutParams.TYPE_PHONE,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL
            y = 100
        }

        meetingTextView = TextView(this).apply {
            text = "🎙️ 会议模式中"
            setTextColor(0xFFFFFFFF.toInt())
            setPadding(32, 16, 32, 16)
            setBackgroundColor(0xCCFF5722.toInt())
            textSize = 14f
            setTextAppearance(android.R.style.TextAppearance_Medium)
        }

        try {
            meetingOverlay?.addView(meetingTextView, params)
        } catch (e: Exception) {
            Log.w(TAG, "无法显示悬浮窗（可能缺少权限）", e)
            meetingOverlay = null
        }
    }

    private fun removeMeetingOverlay() {
        try {
            meetingTextView?.let {
                meetingOverlay?.removeView(it)
            }
        } catch (e: Exception) {
            // ignore
        }
        meetingOverlay = null
        meetingTextView = null
    }
}

/**
 * 操作分析器
 * 分析应用切换频率和模式
 */
class OperationAnalyzer {

    companion object {
        private const val TAG = "OperationAnalyzer"

        // 工作类应用包名模式
        private val WORK_APPS = listOf(
            "com.microsoft.office", "com.google.android.apps.docs",
            "com.tencent.wework", "com.alibaba.android.rimet",
            "com.slack", "com.microsoft.teams",
            "com.zoho.chat", "com.notion.id"
        )

        // 社交类应用包名模式
        private val SOCIAL_APPS = listOf(
            "com.tencent.mm", "com.tencent.mobileqq",
            "com.sina.weibo", "com.instagram.android",
            "com.twitter.android", "com.facebook.katana",
            "com.zhiliaoapp.musically"
        )
    }

    // 应用使用时间记录（包名 -> 累计时长 ms）
    private val appUsageTime = mutableMapOf<String, Long>()
    // 应用切换记录（时间戳列表）
    private val switchTimestamps = mutableListOf<Long>()
    // 应用停留时段记录: (timestamp, packageName, durationMs)
    private data class Session(val timestamp: Long, val packageName: String, val durationMs: Long)
    private val appSessions = mutableListOf<Session>()

    /**
     * 记录一次应用切换
     */
    fun recordSwitch(event: AppSwitchEvent) {
        switchTimestamps.add(event.timestamp)

        // 记录上一个应用的停留时长
        if (event.fromPackage != null && event.durationInPreviousMs != null) {
            appSessions.add(Session(event.timestamp, event.fromPackage, event.durationInPreviousMs))
            appUsageTime[event.fromPackage] = (appUsageTime[event.fromPackage] ?: 0L) + event.durationInPreviousMs
        }
    }

    /**
     * 检测当前模式
     */
    fun detectPattern(): String {
        val thirtyMinutesAgo = System.currentTimeMillis() - 30 * 60 * 1000
        val recentSwitches = switchTimestamps.filter { it > thirtyMinutesAgo }
        val recentSessions = appSessions.filter { it.timestamp > thirtyMinutesAgo }

        if (recentSwitches.isEmpty()) return "idle"

        // 计算最近 30 分钟内的应用切换频率
        val switchRate = recentSwitches.size.toFloat() / 30f  // 次/分钟

        // 分析使用的应用类型
        val workTime = recentSessions.filter { isWorkApp(it.packageName) }.sumOf { it.durationMs }
        val socialTime = recentSessions.filter { isSocialApp(it.packageName) }.sumOf { it.durationMs }
        val totalTime = recentSessions.sumOf { it.durationMs }

        if (totalTime == 0L) return "normal"

        val workRatio = workTime.toFloat() / totalTime
        val socialRatio = socialTime.toFloat() / totalTime

        return when {
            switchRate > 10 -> "distracted"  // 频繁切换
            workRatio > 0.7 -> "work"         // 主要使用工作应用
            socialRatio > 0.6 -> "social"     // 主要使用社交应用
            switchRate < 2 -> "focused"       // 很少切换
            else -> "normal"
        }
    }

    /**
     * 计算专注度评分
     */
    fun calculateFocusScore(): Float {
        val thirtyMinutesAgo = System.currentTimeMillis() - 30 * 60 * 1000
        val recentSessions = appSessions.filter { it.timestamp > thirtyMinutesAgo }
        if (recentSessions.isEmpty()) return 0f

        val recentSwitches = switchTimestamps.filter { it > thirtyMinutesAgo }
        val switchRate = recentSwitches.size.toFloat() / 30f

        val totalDuration = recentSessions.sumOf { it.durationMs }.toFloat()
        if (totalDuration <= 0f) return 0f

        // 专注度 = 100 - (切换频率惩罚) + (工作应用加分) - (社交应用惩罚)
        val switchPenalty = (switchRate * 5).coerceAtMost(50f)  // 最多扣 50 分
        val workTime = recentSessions.filter { isWorkApp(it.packageName) }.sumOf { it.durationMs }.toFloat()
        val socialTime = recentSessions.filter { isSocialApp(it.packageName) }.sumOf { it.durationMs }.toFloat()
        val workBonus = (workTime / totalDuration) * 20  // 最多加 20 分
        val socialPenalty = (socialTime / totalDuration) * 15  // 最多扣 15 分

        return (100 - switchPenalty + workBonus - socialPenalty).coerceIn(0f, 100f)
    }

    /**
     * 获取最长专注时段（毫秒）
     */
    fun getMaxFocusDuration(): Long {
        return appSessions
            .filter { isWorkApp(it.packageName) }
            .maxOfOrNull { it.durationMs } ?: 0L
    }

    /**
     * 获取平均切换间隔
     */
    fun getAvgSwitchInterval(): Long {
        val recent = switchTimestamps.filter { it > System.currentTimeMillis() - 30 * 60 * 1000 }
        if (recent.size < 2) return 0L

        var total = 0L
        for (i in 1 until recent.size) {
            total += recent[i] - recent[i - 1]
        }
        return total / (recent.size - 1)
    }

    private fun isWorkApp(packageName: String): Boolean {
        return WORK_APPS.any { packageName.startsWith(it) || packageName.contains(it) }
    }

    private fun isSocialApp(packageName: String): Boolean {
        return SOCIAL_APPS.any { packageName.startsWith(it) || packageName.contains(it) }
    }
}
