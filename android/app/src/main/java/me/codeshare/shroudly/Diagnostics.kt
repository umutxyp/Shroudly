package me.codeshare.shroudly

import android.app.ActivityManager
import android.content.Context
import android.net.ConnectivityManager
import android.os.Build
import android.os.PowerManager
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/*
 * "Share logs" (MainActivity): what we need to know when Shroudly does not
 * work for someone, as plain text they send us themselves. Made only when
 * they tap it; nothing is sent anywhere by the app.
 */
object Diagnostics {
    /* The battery state as Android and the phone's maker see it. */
    data class Battery(
        /* The user let the app run without battery optimization. */
        val unrestricted: Boolean,
        /* The user restricted its background work (Android 9+). */
        val backgroundRestricted: Boolean,
        val saver: Boolean,
    ) {
        override fun toString() =
            "optimization ${if (unrestricted) "off for Shroudly" else "on"}, " +
                "background ${if (backgroundRestricted) "restricted" else "allowed"}, " +
                "battery saver ${if (saver) "on" else "off"}"
    }

    fun battery(ctx: Context): Battery {
        val pm = ctx.getSystemService(PowerManager::class.java)
        val am = ctx.getSystemService(ActivityManager::class.java)
        return Battery(
            unrestricted = try { pm?.isIgnoringBatteryOptimizations(ctx.packageName) == true } catch (_: Exception) { false },
            backgroundRestricted = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P &&
                (try { am?.isBackgroundRestricted == true } catch (_: Exception) { false }),
            saver = try { pm?.isPowerSaveMode == true } catch (_: Exception) { false },
        )
    }

    /* Phone makers whose own battery managers end or freeze apps that Android
     * itself lets run in the background (dontkillmyapp.com), by
     * Build.MANUFACTURER or Build.BRAND, lower case. */
    private val STRICT_MAKERS = setOf(
        "xiaomi", "redmi", "poco", "huawei", "honor", "oppo", "realme", "oneplus", "vivo", "iqoo",
        "meizu", "asus", "samsung", "tecno", "infinix", "itel", "transsion", "lenovo", "motorola",
        "zte", "nubia", "sony", "nokia", "hmd global", "wiko", "blackview", "ulefone", "doogee",
        "oukitel", "umidigi", "cubot",
    )

    fun strictMaker(manufacturer: String?, brand: String?): Boolean =
        listOfNotNull(manufacturer, brand).any { it.trim().lowercase(Locale.ROOT) in STRICT_MAKERS }

    /* Whether the window asks the user to let Shroudly run without battery
     * restrictions: always when they restricted it, and on phones whose maker
     * stops background apps on its own, until it runs unrestricted. */
    fun batteryHint(b: Battery, manufacturer: String?, brand: String?): Boolean =
        b.backgroundRestricted || (!b.unrestricted && strictMaker(manufacturer, brand))

    fun report(ctx: Context): String {
        val sb = StringBuilder()
        val source = try { if (InstallSource.githubUpdates(ctx)) "APK from GitHub" else "Google Play" } catch (_: Exception) { "unknown source" }
        sb.append("Shroudly ").append(BuildConfig.VERSION_NAME).append(" (").append(BuildConfig.VERSION_CODE).append(") for Android, ")
            .append(source).append(if (BuildConfig.DEBUG) ", debug build" else "").append('\n')
        sb.append("Android ").append(Build.VERSION.RELEASE).append(" (API ").append(Build.VERSION.SDK_INT).append("), ")
            .append(Build.MANUFACTURER).append(' ').append(Build.MODEL).append(" (").append(Build.DEVICE).append("), ")
            .append(Build.SUPPORTED_ABIS.joinToString(",")).append('\n')
        sb.append("Build: ").append(Build.DISPLAY).append('\n')
        val cm = ctx.getSystemService(ConnectivityManager::class.java)
        sb.append("Network: ").append(if (cm != null) Net.describe(cm) else "unknown").append('\n')
        sb.append("Battery: ").append(battery(ctx)).append('\n')
        sb.append("Protection: ").append(Protection.state.name.lowercase(Locale.ROOT))
        Protection.errorDetail?.let { sb.append("; last error: ").append(it) }
        sb.append('\n')
        sb.append("Now: ").append(SimpleDateFormat("yyyy-MM-dd HH:mm:ss Z", Locale.ROOT).format(Date())).append('\n')
        val lines = AppLog.snapshot()
        sb.append('\n').append("Log, last ").append(lines.size).append(" lines (with the names of sites Shroudly handled):\n")
        for (l in lines) sb.append(l).append('\n')
        return sb.toString()
    }
}
