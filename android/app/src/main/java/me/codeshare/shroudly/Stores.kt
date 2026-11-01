package me.codeshare.shroudly

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri

/*
 * Whether Shroudly is on an app store right now: stores.json at the root of
 * the repository's main branch, {"play": {"live": true}, ...}, which the
 * owner sets without an app update (android/PLAY_STORE.md, 4b). Nothing
 * sends anyone to a store page that is not there: the rating card in the
 * copy Google Play installed, and the suggestion to move to that copy in the
 * others (StoreCards), show only while "play" is live. Android reads "play"
 * alone; the others are for the iOS and macOS apps.
 *
 * Fetched as the update check fetches (UpdateCheck.fetch): through the
 * engine while protection is on, so a network that blocks GitHub does not
 * hide it, else directly; at most every EVERY_MS, again after RETRY_MS when
 * it failed. An answer holds for VALID_MS. Missing, unreadable, never
 * fetched, or older than that: not live, and nothing is shown.
 */
object Stores {
    const val HOST = "raw.githubusercontent.com"
    const val PATH = "/umutxyp/Shroudly/main/stores.json"
    const val EVERY_MS = 12L * 60 * 60 * 1000
    const val RETRY_MS = 60L * 60 * 1000
    const val VALID_MS = 7L * 24 * 60 * 60 * 1000
    private const val PREFS = "stores"

    private val PLAY = Regex("\"play\"\\s*:\\s*\\{([^{}]*)\\}")
    private val LIVE = Regex("\"live\"\\s*:\\s*(true|false)")

    /* "play"'s "live": true or false (false also when it is not there);
     * null when the text is not a JSON object at all (an error page). */
    fun parsePlay(text: String): Boolean? {
        val t = text.trim()
        if (!t.startsWith("{") || !t.endsWith("}")) return null
        val play = PLAY.find(t) ?: return false
        return LIVE.find(play.groupValues[1])?.groupValues?.get(1) == "true"
    }

    /* Live by an answer `said` at `checkedAt`: only while it is recent. A
     * clock set back before it makes it unknown until asked again. */
    fun live(said: Boolean, checkedAt: Long, now: Long): Boolean =
        said && checkedAt > 0 && now >= checkedAt && now - checkedAt < VALID_MS

    /* Time to ask: no answer for EVERY_MS (or one from a clock set back),
     * and no failed try in the last RETRY_MS. */
    fun due(checkedAt: Long, triedAt: Long, now: Long): Boolean =
        (checkedAt == 0L || now - checkedAt !in 0 until EVERY_MS) && (triedAt == 0L || now - triedAt !in 0 until RETRY_MS)

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun playLive(ctx: Context, now: Long = System.currentTimeMillis()): Boolean {
        val p = prefs(ctx)
        return live(p.getBoolean("play", false), p.getLong("checkedAt", 0), now)
    }

    @Volatile private var asking = false

    /* Asked on a thread of its own when due; `port` and `auth`: the engine's
     * while protection is on (0: directly). */
    fun refreshIfDue(ctx: Context, port: Int, auth: SocksAuth?) {
        val app = ctx.applicationContext
        val p = prefs(app)
        if (asking || !due(p.getLong("checkedAt", 0), p.getLong("triedAt", 0), System.currentTimeMillis())) return
        asking = true
        Thread({
            try {
                val resp = UpdateCheck.fetch(HOST, PATH, "application/json", port, auth)
                // Gone from the repository: no store to send anyone to.
                val said = when (resp.status) {
                    200 -> parsePlay(resp.body.toString(Charsets.UTF_8))
                    404 -> false
                    else -> null
                }
                if (said == null) {
                    p.edit().putLong("triedAt", System.currentTimeMillis()).apply()
                } else {
                    if (said != p.getBoolean("play", false)) ShroudlyVpnService.log("Google Play: ${if (said) "live" else "not live"} (stores.json)")
                    p.edit().putBoolean("play", said).putLong("checkedAt", System.currentTimeMillis()).remove("triedAt").apply()
                }
            } catch (_: Exception) {
                p.edit().putLong("triedAt", System.currentTimeMillis()).apply()
            } finally {
                asking = false
            }
        }, "stores").apply { isDaemon = true }.start()
    }

    /* Shroudly's page in the Play Store app, else on the web. */
    fun openPlay(ctx: Context) {
        val id = ctx.packageName
        try {
            ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=$id")).setPackage(InstallSource.PLAY_STORE)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            return
        } catch (_: ActivityNotFoundException) {
        } catch (_: SecurityException) {
        }
        try {
            ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=$id")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: ActivityNotFoundException) {
        }
    }
}
