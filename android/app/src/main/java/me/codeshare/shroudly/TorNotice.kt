package me.codeshare.shroudly

import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.widget.Toast

/*
 * A site that only the last way out (Tor) opened, said to the user: it is
 * slower, and some sites ask Tor's visitors for a captcha. On a phone or
 * tablet a notification; on a TV, which shows no notifications from apps,
 * a message on the screen, saying what it means there (videos loading
 * slowly). Once per site while protection is on, and at most once every
 * EVERY_MS, so a page of blocked resources cannot become a stream of them.
 */
object TorNotice {
    // 10 and 11 are the APK's update notices (ApkUpdates.kt).
    private const val ID = 12
    const val EVERY_MS = 15 * 60 * 1000L
    private val told = HashSet<String>()
    private var lastAt = 0L

    /* Whether `host` is to be said now (pure, for the tests). */
    @Synchronized
    fun due(host: String, now: Long): Boolean {
        val h = host.lowercase()
        if (h.isEmpty() || !told.add(h)) return false
        if (lastAt != 0L && now - lastAt < EVERY_MS) return false
        lastAt = now
        return true
    }

    /* Protection stopped: a new start says it again. */
    @Synchronized
    fun reset() { told.clear(); lastAt = 0L }

    fun used(ctx: Context, host: String) {
        if (!due(host, System.currentTimeMillis())) return
        val h = host.lowercase()
        if (Tv.isTv(ctx)) {
            val text = ctx.text(R.string.torUsedTv, "host" to h)
            Handler(Looper.getMainLooper()).post {
                try { Toast.makeText(ctx.applicationContext, text, Toast.LENGTH_LONG).show() } catch (_: Exception) {}
            }
            return
        }
        try {
            ShroudlyVpnService.channels(ctx)
            val text = ctx.text(R.string.torUsedPhone, "host" to h)
            val n = Notification.Builder(ctx, ShroudlyVpnService.ALERT_CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_logo)
                .setContentTitle(ctx.getString(R.string.app_name))
                .setContentText(text)
                .setStyle(Notification.BigTextStyle().bigText(text))
                .setContentIntent(ShroudlyVpnService.openApp(ctx))
                .setAutoCancel(true)
                .setColor(Accent.swatch(ctx))
                .build()
            ctx.getSystemService(NotificationManager::class.java).notify(ID, n)
        } catch (_: Exception) {}
    }
}
