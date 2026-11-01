package me.codeshare.shroudly

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri

/*
 * Whether Shroudly is on an app store right now, and where: stores.json at
 * the root of the repository's main branch, which the owner sets without an
 * app update (android/PLAY_STORE.md, 4b):
 *
 *   {"play": {"live": true, "countries": ["*"], "exclude": ["XX"]}, ...}
 *
 * "countries" are ISO 3166-1 alpha-2 codes, or "*" for all; "exclude" the
 * ones where the listing is not available (a country's law took it off
 * Play, say). The first shape had "live" alone: no "countries" is "*", no
 * "exclude" is none. Nothing sends anyone to a store page that is not there
 * for them: the rating card in the copy Google Play installed, and the
 * suggestion to move to that copy in the others (StoreCards), show only
 * while "play" is live in the phone's own country (Country). Android reads
 * "play" alone; the others are for the iOS and macOS apps.
 *
 * Fetched as the update check fetches (UpdateCheck.fetch): through the
 * engine while protection is on, so a network that blocks GitHub does not
 * hide it, else directly; at most every EVERY_MS, again after RETRY_MS when
 * it failed. An answer holds for VALID_MS. Missing, unreadable, failed,
 * never fetched, or older than that: not live, and nothing is shown.
 */
object Stores {
    const val HOST = "raw.githubusercontent.com"
    const val PATH = "/umutxyp/Shroudly/main/stores.json"
    const val EVERY_MS = 12L * 60 * 60 * 1000
    const val RETRY_MS = 60L * 60 * 1000
    const val VALID_MS = 7L * 24 * 60 * 60 * 1000
    private const val PREFS = "stores"

    /* A store's listing as stores.json says it. */
    data class Listing(val live: Boolean, val countries: List<String> = listOf("*"), val exclude: List<String> = emptyList())

    private val NOT_LIVE = Listing(false)
    private val PLAY = Regex("\"play\"\\s*:\\s*\\{([^{}]*)\\}")
    private val LIVE = Regex("\"live\"\\s*:\\s*(true|false)")
    private val CODE = Regex("\"([A-Za-z]{2}|\\*)\"")

    /* The codes in a list ("countries": [...]), upper case; null when there
     * is no such list. */
    private fun codes(body: String, name: String): List<String>? {
        val list = Regex("\"$name\"\\s*:\\s*\\[([^\\]]*)\\]").find(body) ?: return null
        return CODE.findAll(list.groupValues[1]).map { it.groupValues[1].uppercase(java.util.Locale.ROOT) }.toList()
    }

    /* "play"'s listing (not live also when it is not there, or "live" is not
     * true); null when the text is not a JSON object at all (an error page). */
    fun parsePlay(text: String): Listing? {
        val t = text.trim()
        if (!t.startsWith("{") || !t.endsWith("}")) return null
        val body = PLAY.find(t)?.groupValues?.get(1) ?: return NOT_LIVE
        return Listing(
            live = LIVE.find(body)?.groupValues?.get(1) == "true",
            countries = codes(body, "countries") ?: listOf("*"),
            exclude = codes(body, "exclude") ?: emptyList(),
        )
    }

    /* Live in `country` (an ISO code, null when it cannot be told: then
     * never). */
    fun availableIn(l: Listing, country: String?): Boolean {
        if (!l.live || country == null) return false
        val c = country.uppercase(java.util.Locale.ROOT)
        return ("*" in l.countries || c in l.countries) && c !in l.exclude
    }

    /* An answer from `checkedAt` still counts: recent. A clock set back
     * before it makes it unknown until asked again. */
    fun fresh(checkedAt: Long, now: Long): Boolean = checkedAt > 0 && now >= checkedAt && now - checkedAt < VALID_MS

    /* Time to ask: no answer for EVERY_MS (or one from a clock set back),
     * and no failed try in the last RETRY_MS. */
    fun due(checkedAt: Long, triedAt: Long, now: Long): Boolean =
        (checkedAt == 0L || now - checkedAt !in 0 until EVERY_MS) && (triedAt == 0L || now - triedAt !in 0 until RETRY_MS)

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /* Shroudly is on Google Play in this phone's country, by a recent answer. */
    fun playHere(ctx: Context, now: Long = System.currentTimeMillis(), country: String? = Country.of(ctx)): Boolean {
        val p = prefs(ctx)
        if (!fresh(p.getLong("checkedAt", 0), now)) return false
        val l = Listing(
            p.getBoolean("playLive", false),
            p.getString("playCountries", "").orEmpty().split(',').filter { it.isNotEmpty() },
            p.getString("playExclude", "").orEmpty().split(',').filter { it.isNotEmpty() },
        )
        return availableIn(l, country)
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
                    404 -> NOT_LIVE
                    else -> null
                }
                if (said == null) {
                    failed(p)
                } else {
                    if (said.live != p.getBoolean("playLive", false)) ShroudlyVpnService.log("Google Play: ${if (said.live) "live" else "not live"} (stores.json)")
                    p.edit().putBoolean("playLive", said.live)
                        .putString("playCountries", said.countries.joinToString(","))
                        .putString("playExclude", said.exclude.joinToString(","))
                        .putLong("checkedAt", System.currentTimeMillis()).remove("triedAt").apply()
                }
            } catch (_: Exception) {
                failed(p)
            } finally {
                asking = false
            }
        }, "stores").apply { isDaemon = true }.start()
    }

    /* A fetch that failed or could not be read: what was known is dropped
     * (nothing shows on an unknown answer), tried again in RETRY_MS. */
    private fun failed(p: android.content.SharedPreferences) {
        p.edit().remove("playLive").remove("playCountries").remove("playExclude").remove("checkedAt")
            .putLong("triedAt", System.currentTimeMillis()).apply()
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

/*
 * The phone's country, as an ISO 3166-1 alpha-2 code, for the stores'
 * listings (Stores): the SIM's country, else the mobile network's (where the
 * phone is; with a SIM, the SIM's comes first, which roaming does not move),
 * else the region of the phone's language. Unknown: null, and no store card.
 */
object Country {
    private val CODE = Regex("^[A-Za-z]{2}$")

    private fun code(s: String?): String? = s?.trim()?.takeIf { CODE.matches(it) }?.uppercase(java.util.Locale.ROOT)

    fun pick(sim: String?, network: String?, locale: String?): String? = code(sim) ?: code(network) ?: code(locale)

    fun of(ctx: Context): String? {
        val tm = try { ctx.getSystemService(android.telephony.TelephonyManager::class.java) } catch (_: Exception) { null }
        val sim = try { tm?.simCountryIso } catch (_: Exception) { null }
        val network = try { tm?.networkCountryIso } catch (_: Exception) { null }
        val locale = try { android.content.res.Resources.getSystem().configuration.locales[0].country } catch (_: Exception) { null }
        return pick(sim, network, locale)
    }
}
