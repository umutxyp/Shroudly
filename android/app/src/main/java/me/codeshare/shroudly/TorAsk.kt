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
     * again). Not in the lite APK (LiteOffer), nor with an own server. A
     * day, not a week: another Iran user turned Tor off, YouTube and
     * Instagram stayed dead for days, and nothing was said (since 2.6.75
     * Tor carries only what nothing else opens, so saying yes costs little). */
    const val REST_MS = 24 * 60 * 60 * 1000L
    private const val KEY_REST = "torAskRest"

    /* Whether a "no" is old enough to ask again (pure, for the tests): one
     * kept before this version (0) is. */
    fun restOver(restAt: Long, now: Long): Boolean = restAt == 0L || now - restAt !in 0 until REST_MS

    fun rest(ctx: Context) {
        ctx.getSharedPreferences("ui", Context.MODE_PRIVATE).edit().putLong(KEY_REST, System.currentTimeMillis()).apply()
    }

    /* From the services: `host` (or the app, by name) stayed shut with the
     * last way out off. True: asked. */
    fun askAgain(ctx: Context, host: String, app: Boolean = false): Boolean {
        if (host.isEmpty() || TorRoute.enabled(ctx) || !TorRoute.bundled(ctx) || Protection.torAsk != null) return false
        if (AppSettings.ownServerTyped(ctx).isNotBlank() || Protection.ownServerDown != null) return false
        if (!restOver(ctx.getSharedPreferences("ui", Context.MODE_PRIVATE).getLong(KEY_REST, 0L), System.currentTimeMillis())) return false
        rest(ctx)
        ShroudlyVpnService.log("The last way out is off and $host stays shut; asking again whether to use Tor")
        if (app) askApp(ctx, host) else ask(ctx, host)
        return true
    }

    /* What the last way out does for an app's connections that cannot get
     * through (RawWatch): carries them (allowed), asks (not yet), is turned
     * off, or is not there (the lite APK, or the user's own server). Pure,
     * for the tests. */
    enum class Raw { CARRIES, ASKS, OFF, NONE }
    fun forRaw(lite: Boolean, bundled: Boolean, enabled: Boolean, approved: Boolean, ownServer: Boolean): Raw = when {
        lite || !bundled || ownServer -> Raw.NONE
        !enabled -> Raw.OFF
        approved -> Raw.CARRIES
        else -> Raw.ASKS
    }

    /* What the question names (an Iran Telegram report: "Open
     * 2001:4188:2:600:10:10:34:35 through Tor?", never answered, so Telegram
     * stayed shut): an app by its name where its servers are known (Telegram
     * for 149.154.167.92, t.me), a site by its name, a bare address only when
     * nothing better came. A better one replaces the one asked about; a worse
     * one never does. Rank: 2 an app, 1 a name, 0 an address, -1 nothing.
     * Pure, for the tests (the desktop's askLabel, raw-apps.js). */
    fun label(had: String?, hadRank: Int, host: String, appOf: (String) -> String?): Pair<String, Int> {
        val h = host.trim().lowercase().removePrefix("[").removeSuffix("]")
        val app = if (h.isEmpty()) null else try { appOf(h) } catch (_: Exception) { null }
        val cand = when {
            app != null -> app to 2
            h.isEmpty() -> null
            RawApps.literal(h) != null -> h to 0
            else -> h to 1
        }
        if (had.isNullOrEmpty()) return cand ?: ("" to -1)
        return if (cand != null && cand.second > hadRank) cand else had to hadRank
    }
    // The rank of what Protection.torAsk names now.
    @Volatile private var rank = -1

    /* Protection stopped: a new start asks again. */
    @Synchronized
    fun reset() { lastAt = 0L }

    fun ask(ctx: Context, host: String) = put(ctx, host, null)

    /* For an app named by RawWatch (Telegram): the question names it. */
    fun askApp(ctx: Context, app: String) = put(ctx, app, app)

    @Synchronized
    private fun put(ctx: Context, host: String, app: String?) {
        val h = host.lowercase()
        val had = Protection.torAsk
        val apps = try { RawApps.of(ctx) } catch (_: Exception) { null }
        val (shown, r) = label(had, if (had == null) -1 else rank, h) { x -> if (app != null) app else apps?.serviceOf(x) ?: Conns.appOfName(x) }
        Protection.torAsk = shown
        rank = r
        Protection.changed()
        val better = had != null && shown != had
        // Said in the log, as on the desktop: a report sent after the user
        // turned protection off (which clears the question) could not tell
        // whether Tor had been asked for at all (an Irancell YouTube report).
        val named = if (h.isNotEmpty() && shown.lowercase() != h) "$shown ($h)" else shown.ifEmpty { "a site" }
        if (had == null) ShroudlyVpnService.logSite("The last way out: $named needs Tor; asking before it starts")
        else if (better) ShroudlyVpnService.logSite("The last way out: the question now names $named")
        // A better name is said again at once: the notice named an address.
        if (!better && !due(System.currentTimeMillis())) return
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
                .setSmallIcon(R.drawable.ic_stat_logo)
                .setContentTitle(ctx.text(R.string.torAskTitle, "host" to (Protection.torAsk ?: "")))
                .setContentText(text)
                .setStyle(Notification.BigTextStyle().bigText(text))
                .setContentIntent(ShroudlyVpnService.openApp(ctx))
                .setAutoCancel(true)
                .setOnlyAlertOnce(true)
                .setColor(Accent.swatch(ctx))
                .build()
            ctx.getSystemService(NotificationManager::class.java).notify(ID, n)
        } catch (_: Exception) {}
    }

    /* The question answered or gone: the notification with it. */
    fun clear(ctx: Context) {
        Protection.torAsk = null
        rank = -1
        Protection.changed()
        try { ctx.getSystemService(NotificationManager::class.java).cancel(ID) } catch (_: Exception) {}
    }
}
