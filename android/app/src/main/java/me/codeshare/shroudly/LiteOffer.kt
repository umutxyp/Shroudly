package me.codeshare.shroudly

import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.widget.Toast

/*
 * The lite APK has no Tor (issue #75), so a site no technique opens, or
 * whose addresses the network does not let through at all (Instagram and
 * WhatsApp in Iran, Telegram's servers), stayed shut without a word: the
 * full APK would have asked to open it through Tor (TorAsk). Here the same
 * moment offers the full APK instead: a card on the main screen (the site,
 * "Get the full version", "Not now"), and, so the user knows to look there,
 * a notification on a phone or tablet or a message on the screen of a TV,
 * at most once a day. "Get the full version" downloads the full APK of the
 * same version and hands it to Android's installer (ApkUpdates.startFull):
 * the same app, signed the same, so it installs over this one and keeps
 * every setting. "Not now" rests for a week.
 */
object LiteOffer {
    // 10, 11: the APK's update notices; 12: TorNotice; 13: DnsNotice; 14: TorAsk.
    private const val ID = 15
    const val EVERY_MS = 24 * 60 * 60 * 1000L
    const val REST_MS = 7 * 24 * 60 * 60 * 1000L
    private const val PREFS = "ui"
    private const val KEY_REST = "liteOfferRest"
    private const val KEY_SAID = "liteOfferSaid"

    /* This copy is the lite APK. */
    val lite: Boolean get() = BuildConfig.APK_VARIANT == "lite"

    /* An engine event the full APK would have taken to Tor (core/src/engine.c,
     * fallback_ok's callers): a site still blocked after every technique (not
     * one whose server refused by itself), one the network cuts once
     * connected, or one whose address does not answer. A name that does not
     * resolve is not one: it may not exist at all. Pure, for the tests. */
    fun wants(kind: String, alert: Boolean, stage: String?): Boolean = when (kind) {
        "blocked" -> !alert
        "cut" -> true
        "unreachable" -> stage != "dns"
        else -> false
    }

    /* Not now: in the last REST_MS. Pure, for the tests. */
    fun resting(restAt: Long, now: Long): Boolean = restAt > 0 && now - restAt in 0 until REST_MS

    /* Said in a notification (or on a TV's screen): once in EVERY_MS. Pure. */
    fun due(saidAt: Long, now: Long): Boolean = saidAt == 0L || now - saidAt !in 0 until EVERY_MS

    /* From the services: `name` (a site, or an app) stayed shut. false:
     * nothing offered (not the lite APK, or "Not now" lately). */
    fun offer(ctx: Context, name: String): Boolean {
        if (!lite || name.isEmpty() || Protection.ownServerDown != null) return false
        val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val now = System.currentTimeMillis()
        if (resting(p.getLong(KEY_REST, 0L), now)) return false
        if (Protection.liteOffer == null) {
            Protection.liteOffer = name.lowercase()
            Protection.changed()
        }
        if (!due(p.getLong(KEY_SAID, 0L), now)) return true
        p.edit().putLong(KEY_SAID, now).apply()
        ShroudlyVpnService.log("$name stays shut; the full APK (with Tor) is offered on the main screen")
        val shown = Protection.liteOffer ?: name
        val text = ctx.text(R.string.liteOfferNotice, "host" to shown)
        if (Tv.isTv(ctx)) {
            Handler(Looper.getMainLooper()).post {
                try { Toast.makeText(ctx.applicationContext, text, Toast.LENGTH_LONG).show() } catch (_: Exception) {}
            }
            return true
        }
        try {
            ShroudlyVpnService.channels(ctx)
            val n = Notification.Builder(ctx, ShroudlyVpnService.ALERT_CHANNEL)
                .setSmallIcon(R.drawable.ic_shield)
                .setContentTitle(ctx.text(R.string.liteOfferTitle, "host" to shown))
                .setContentText(text)
                .setStyle(Notification.BigTextStyle().bigText(text))
                .setContentIntent(ShroudlyVpnService.openApp(ctx))
                .setAutoCancel(true)
                .setColor(Accent.swatch(ctx))
                .build()
            ctx.getSystemService(NotificationManager::class.java).notify(ID, n)
        } catch (_: Exception) {}
        return true
    }

    /* "Not now": the card and its notification go, for REST_MS. */
    fun rest(ctx: Context) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putLong(KEY_REST, System.currentTimeMillis()).apply()
        clear(ctx)
    }

    fun clear(ctx: Context) {
        Protection.liteOffer = null
        Protection.changed()
        try { ctx.getSystemService(NotificationManager::class.java).cancel(ID) } catch (_: Exception) {}
    }
}
