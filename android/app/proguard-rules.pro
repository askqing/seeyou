# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# 保留 OkHttp 相关类
-dontwarn okhttp3.**
-dontwarn okio.**

# 保留 Gson 序列化模型
-keep class com.askqing.stalker.model.** { *; }

# 保留 Health Connect
-keep class androidx.health.connect.** { *; }
