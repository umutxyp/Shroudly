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

    /* "No" (or the last way out turned off in Settings) is kept, but not
     * for ever: a user in Iran who had said no once saw X and YouTube stay
     * shut, and nothing said that Tor was the one way left. A site no
     * technique opens asks again after REST_MS (the same card; "No" rests
     * again). Not in the lite APK (LiteOffer), nor with an own server. */
    const val REST_MS = 7 * 24 * 60 * 60 * 1000L
    private const val KEY_REST = "torAskRest"

    /* Whether a "no" is old enough to ask again (pure, for the tests): one
     * kept before this version (0) is. */
    fun restOver(restAt: Long, now: Long): Boolean = restAt == 0L || now - restAt !in 0 until REST_MS

    fun rest(ctx: Context) {
        ctx.getSharedPreferences("ui", Context.MODE_PRIVATE).edit().putLong(KEY_REST, System.currentTimeMillis()).apply()
    }

    /* From the services: `host` stayed shut with the last way out off. */
    fun askAgain(ctx: Context, host: String) {
        if (host.isEmpty() || TorRoute.enabled(ctx) || !TorRoute.bundled(ctx) || Protection.torAsk != null) return
        if (AppSettings.ownServerTyped(ctx).isNotBlank() || Protection.ownServerDown != null) return
        if (!restOver(ctx.getSharedPreferences("ui", Context.MODE_PRIVATE).getLong(KEY_REST, 0L), System.currentTimeMillis())) return
        rest(ctx)
        ShroudlyVpnService.log("The last way out is off and $host stays shut; asking again whether to use Tor")
        ask(ctx, host)
    }

    /* Protection stopped: a new start asks again. */
    @Synchronized
    fun reset() { lastAt = 0L }

    fun ask(ctx: Context, host: String) {
        val h = host.lowercase()
        val had = Protection.torAsk
        Protection.torAsk = h.ifEmpty { had ?: "" }
        Protection.changed()
        // Said in the log, as on the desktop: a report sent after the user
        // turned protection off (which clears the question) could not tell
        // whether Tor had been asked for at all (an Irancell YouTube report).
        if (had == null) ShroudlyVpnService.logSite("The last way out: ${h.ifEmpty { "a site" }} needs Tor; asking before it starts")
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
