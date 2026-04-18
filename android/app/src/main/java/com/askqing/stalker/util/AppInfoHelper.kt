package com.askqing.stalker.util

import android.content.Context
import android.content.pm.PackageManager
import android.graphics.drawable.Drawable

/**
 * 应用信息工具类
 * 获取应用名称、图标等信息
 */
object AppInfoHelper {

    /**
     * 根据 PackageName 获取应用名称
     */
    fun getAppName(context: Context, packageName: String): String {
        return try {
            val packageManager = context.packageManager
            val appInfo = packageManager.getApplicationInfo(packageName, 0)
            packageManager.getApplicationLabel(appInfo).toString()
        } catch (e: PackageManager.NameNotFoundException) {
            packageName  // 如果找不到，返回包名
        }
    }

    /**
     * 根据 PackageName 获取应用图标
     */
    fun getAppIcon(context: Context, packageName: String): Drawable? {
        return try {
            val packageManager = context.packageManager
            val appInfo = packageManager.getApplicationInfo(packageName, 0)
            packageManager.getApplicationIcon(appInfo)
        } catch (e: PackageManager.NameNotFoundException) {
            null
        }
    }

    /**
     * 判断是否是系统应用
     */
    fun isSystemApp(context: Context, packageName: String): Boolean {
        return try {
            val packageManager = context.packageManager
            val appInfo = packageManager.getApplicationInfo(packageName, 0)
            (appInfo.flags and android.content.pm.ApplicationInfo.FLAG_SYSTEM) != 0
        } catch (e: PackageManager.NameNotFoundException) {
            false
        }
    }
}
