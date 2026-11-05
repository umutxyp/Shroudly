package me.codeshare.shroudly

import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.widget.Toast

/*
 * Tor is slow: before it first starts, the user says yes (issue #77). A site
 * no technique opened makes the engine ask for the last way out; until the
 * user has allowed it, Shroudly asks instead of starting Tor: a card on the
 * main screen with "Use Tor" and "No" (MainActivity), and, so the user knows
 * to look there, a notification on a phone or tablet or a message on the
 * screen on a TV. Never a dialog of its own. At most once every EVERY_MS,
 * and again after a new start. The answer is kept (TorRoute.approved, or the
 * last way out turned off); Settings changes it.
 */
object TorAsk {
    // 10 and 11: the APK's update notices; 12: TorNotice; 13: DnsNotice.
    private const val ID = 14
    const val EVERY_MS = 30 * 60 * 1000L
    private var lastAt = 0L

    /* Whether to say it now (pure, for the tests). */
    @Synchronized
    fun due(now: Long): Boolean {
        if (lastAt != 0L && now - lastAt < EVERY_MS) return false
        lastAt = now
        return true
    }

    /* Protection stopped: a new start asks again. */
    @Synchronized
    fun reset() { lastAt = 0L }

    fun ask(ctx: Context, host: String) {
        val h = host.lowercase()
        val had = Protection.torAsk
        Protection.torAsk = h.ifEmpty { had ?: "" }
        Protection.changed()
        if (!due(System.currentTimeMillis())) return
        val text = ctx.text(R.string.torAskNotice, "host" to (Protection.torAsk ?: ""))
        if (Tv.isTv(ctx)) {
            Handler(Looper.getMainLooper()).post {
                try { Toast.makeText(ctx.applicationContext, text, Toast.LENGTH_LONG).show() } catch (_: Exception) {}
            }
            return
        }
        try {
            ShroudlyVpnService.channels(ctx)
            val n = Notification.Builder(ctx, ShroudlyVpnService.ALERT_CHANNEL)
                .setSmallIcon(R.drawable.ic_shield)
                .setContentTitle(ctx.text(R.string.torAskTitle, "host" to (Protection.torAsk ?: "")))
                .setContentText(text)
                .setStyle(Notification.BigTextStyle().bigText(text))
                .setContentIntent(ShroudlyVpnService.openApp(ctx))
                .setAutoCancel(true)
                .setColor(Accent.swatch(ctx))
                .build()
            ctx.getSystemService(NotificationManager::class.java).notify(ID, n)
        } catch (_: Exception) {}
    }

    /* The question answered or gone: the notification with it. */
    fun clear(ctx: Context) {
        Protection.torAsk = null
        Protection.changed()
        try { ctx.getSystemService(NotificationManager::class.java).cancel(ID) } catch (_: Exception) {}
    }
}
