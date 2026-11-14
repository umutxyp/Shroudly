package me.codeshare.shroudly

import android.content.Context

/*
 * The Connections list (issue #74), as on the desktop (electron/
 * engine-manager.js, system-hosts.js): what went through Shroudly, by site
 * name, as the engine counts it (core/src/conns.c, its CONNS command), and
 * the names the user blocked there. The blocks are kept on this device only
 * and given to the engine at every start (BLOCK); a new one ends that site's
 * open connections at once.
 */
object Conns {
    data class Row(
        val host: String, val active: Int, val conns: Long, val up: Long, val down: Long,
        val route: String, val blocked: Boolean, val refused: Long,
        /* Since the name was last used, ms; -1 when the engine did not say. */
        val ago: Long = -1L,
    )

    /* A name the ad and tracker list stopped, how often, and how long ago (ms). */
    data class AdRow(val host: String, val count: Long, val ago: Long)

    /* The names Shroudly itself uses (electron/system-hosts.js): marked, and
     * blocking one asks first. */
    val SYSTEM = listOf(
        "cloudflare-dns.com", "one.one.one.one", "dns.google", "dns.quad9.net", "doh.opendns.com", "dns.opendns.com",
        "doh.sb", "dns.sb", "unfiltered.adguard-dns.com", "dns.adguard-dns.com", "dns.mullvad.net",
        "codeshare.me", "github.com", "githubusercontent.com", "api.github.com",
        "torproject.net", "torproject.org",
    )
    private val NAME = Regex("^[a-z0-9._:-]{1,253}$")
    private const val KEY = "userBlocked"
    private const val KEY_TOR = "torSites"
    private const val KEY_TOR_APPS = "torApps"
    private const val KEY_ONLY_MODE = "onlySitesMode"
    private const val KEY_ONLY = "onlySites"

    /* The last list the engine gave, newest first. */
    @Volatile var rows: List<Row> = emptyList()
        internal set

    /* What the ad list stopped lately, newest first: shown in Connections
     * with a button to let one through (a link shortener's page the list
     * blocks whole, SR-G563: 2.6.77 said nowhere that the list did it). */
    @Volatile var ads: List<AdRow> = emptyList()
        internal set

    fun isSystem(host: String, own: String?): Boolean {
        val h = host.lowercase().trimEnd('.')
        return (SYSTEM + listOfNotNull(own)).any { h == it || h.endsWith(".$it") }
    }

    fun clean(host: String): String? = host.trim().lowercase().trimEnd('.').takeIf { NAME.matches(it) }

    fun blocked(ctx: Context): Set<String> =
        ctx.getSharedPreferences("settings", Context.MODE_PRIVATE).getStringSet(KEY, emptySet())?.toSet() ?: emptySet()

    /* Kept, and the running engine told at once (the service sends BLOCK or
     * UNBLOCK). null for a name that cannot be one. */
    fun setBlocked(ctx: Context, host: String, on: Boolean): Set<String>? {
        val h = clean(host) ?: return null
        val now = blocked(ctx).toMutableSet()
        if (on) now += h else now -= h
        ctx.getSharedPreferences("settings", Context.MODE_PRIVATE).edit().putStringSet(KEY, now).apply()
        Protector.tell(ctx, ShroudlyVpnService.ACTION_CONNS, "${if (on) "BLOCK" else "UNBLOCK"} $h")
        return now
    }

    /* The sites the user sends through Tor (the last way out), for a site
     * that turns the user's country away itself. */
    fun torSites(ctx: Context): Set<String> =
        ctx.getSharedPreferences("settings", Context.MODE_PRIVATE).getStringSet(KEY_TOR, emptySet())?.toSet() ?: emptySet()

    /* Kept, and the running engine told at once (TOR or UNTOR). Choosing it
     * is the user's consent to Tor: the last way out is turned on and
     * allowed, the engine started again with it if it was off. */
    fun setTorSite(ctx: Context, host: String, on: Boolean): Set<String>? {
        val h = clean(host) ?: return null
        val now = torSites(ctx).toMutableSet()
        if (on) now += h else now -= h
        ctx.getSharedPreferences("settings", Context.MODE_PRIVATE).edit().putStringSet(KEY_TOR, now).apply()
        // Back the usual way only if no app picked needs it too.
        if (on || h !in appEntries(torApps(ctx))) Protector.tell(ctx, ShroudlyVpnService.ACTION_CONNS, "${if (on) "TOR" else "UNTOR"} $h")
        if (on) consentToTor(ctx)
        AppLog.add(if (on) "Connections: $h goes through Tor (the last way out) from now on" else "Connections: $h goes the usual way again")
        return now
    }

    /* Choosing Tor for a site or an app is the user's consent to it: the
     * last way out is turned on and allowed, the engine started again with
     * it if it was off. */
    private fun consentToTor(ctx: Context) {
        TorRoute.setApproved(ctx, true)
        if (!TorRoute.enabled(ctx)) {
            TorRoute.setEnabled(ctx, true)
            Protector.tell(ctx, ShroudlyVpnService.ACTION_SETTINGS, "torLastResort")
        }
    }

    /* "Apps always through Tor" (TorAppsList, from electron/tor-apps.js): the
     * ids picked, known ones only. */
    fun torApps(ctx: Context): Set<String> {
        val kept = ctx.getSharedPreferences("settings", Context.MODE_PRIVATE).getStringSet(KEY_TOR_APPS, emptySet()) ?: emptySet()
        return TorAppsList.apps.map { it.id }.filter { it in kept }.toSet()
    }

    /* The app a name belongs to (its own name or one under it), or null:
     * what the Tor question says instead of one of the app's many names
     * ("Open X (Twitter) through Tor?", not abs.twimg.com). */
    fun appOfName(host: String): String? {
        val h = host.trim().lowercase().trimEnd('.')
        if (h.isEmpty()) return null
        return TorAppsList.apps.firstOrNull { a -> a.entries.any { !it.contains('/') && (h == it || h.endsWith(".$it")) } }?.name
    }

    /* The names and ranges of the apps `ids` (pure, for the tests). */
    fun appEntries(ids: Set<String>): Set<String> =
        TorAppsList.apps.filter { it.id in ids }.flatMap { it.entries }.toCollection(LinkedHashSet())

    /* Everything sent through Tor by the user's choice: the sites typed and
     * the apps picked. */
    fun torEntries(ctx: Context): Set<String> = torSites(ctx) + appEntries(torApps(ctx))

    /* What changes in the engine when the picked apps go from `before` to
     * `after` with `sites` typed: TOR for what is new, UNTOR for what nothing
     * needs any more (a name two apps share stays while one is picked).
     * Pure, for the tests. */
    fun appCommands(sites: Set<String>, before: Set<String>, after: Set<String>): List<String> {
        val was = sites + appEntries(before)
        val now = sites + appEntries(after)
        return was.filter { it !in now }.map { "UNTOR $it" } + now.filter { it !in was }.map { "TOR $it" }
    }

    /* An app picked, or put back: kept, and the running engine told what
     * changed. null for an id not in the list. */
    fun setTorApp(ctx: Context, id: String, on: Boolean): Set<String>? {
        val app = TorAppsList.apps.firstOrNull { it.id == id } ?: return null
        val before = torApps(ctx)
        val after = if (on) before + id else before - id
        ctx.getSharedPreferences("settings", Context.MODE_PRIVATE).edit().putStringSet(KEY_TOR_APPS, after).apply()
        for (c in appCommands(torSites(ctx), before, after)) Protector.tell(ctx, ShroudlyVpnService.ACTION_CONNS, c)
        if (on) consentToTor(ctx)
        AppLog.add(if (on) "Connections: ${app.name} goes through Tor (the last way out) from now on, all of it" else "Connections: ${app.name} goes the usual way again")
        return after
    }

    /* Only the listed sites go through Shroudly's ways (Settings); every
     * other one goes out as it is, with the network's own DNS. */
    fun onlyMode(ctx: Context): Boolean =
        ctx.getSharedPreferences("settings", Context.MODE_PRIVATE).getBoolean(KEY_ONLY_MODE, false)

    fun onlySites(ctx: Context): List<String> =
        ctx.getSharedPreferences("settings", Context.MODE_PRIVATE).getString(KEY_ONLY, "")!!
            .split('\n').mapNotNull { clean(it) }.filter { it.contains('.') || it.contains(':') }.distinct()

    /* Kept, and the running engine given the new list at once. */
    fun setOnly(ctx: Context, mode: Boolean, sites: List<String>) {
        val list = sites.mapNotNull { clean(it.removePrefix("http://").removePrefix("https://").substringBefore('/')) }.distinct()
        ctx.getSharedPreferences("settings", Context.MODE_PRIVATE).edit()
            .putBoolean(KEY_ONLY_MODE, mode).putString(KEY_ONLY, list.joinToString("\n")).apply()
        for (c in onlyCommands(ctx)) Protector.tell(ctx, ShroudlyVpnService.ACTION_CONNS, c)
    }

    private fun onlyCommands(ctx: Context): List<String> =
        listOf("ONLY-CLEAR") + onlySites(ctx).map { "ONLY $it" } + "ONLY-MODE ${if (onlyMode(ctx)) 1 else 0}"

    /* What the engine is given after it starts. */
    fun commands(ctx: Context): List<String> {
        val b = blocked(ctx)
        val t = torEntries(ctx)
        return (if (b.isEmpty()) emptyList() else listOf("BLOCK-CLEAR") + b.sorted().map { "BLOCK $it" }) +
            (if (t.isEmpty()) emptyList() else listOf("TOR-CLEAR") + t.sorted().map { "TOR $it" }) +
            (if (onlyMode(ctx)) onlyCommands(ctx) else emptyList())
    }

    /* What the start's commands did, for the log. */
    fun summary(ctx: Context): String {
        val parts = mutableListOf<String>()
        blocked(ctx).size.takeIf { it > 0 }?.let { parts += "$it name${if (it == 1) "" else "s"} you blocked are refused" }
        torSites(ctx).size.takeIf { it > 0 }?.let { parts += "$it site${if (it == 1) "" else "s"} you send through Tor go there first" }
        torApps(ctx).takeIf { it.isNotEmpty() }?.let { ids -> parts += TorAppsList.apps.filter { it.id in ids }.joinToString(", ") { it.name } + " always through Tor" }
        if (onlyMode(ctx) && onlySites(ctx).isNotEmpty()) parts += "only the ${onlySites(ctx).size} listed sites are worked on, the rest go out as they are"
        return "Connections: " + parts.joinToString("; ")
    }

    /* Not a command of the engine's: the services give it the Tor list
     * again (Tor just became ready). */
    const val TOR_AGAIN = "TOR-AGAIN"

    /* A command the Connections list or Settings may send to the engine. */
    // TOR and UNTOR take a range too (an app picked that connects by address).
    val COMMAND = Regex("^(CONNS|ONLY-CLEAR|ONLY-MODE [01]|(BLOCK|UNBLOCK|TOR|UNTOR|ONLY) [a-z0-9._:-]{1,253}|(TOR|UNTOR) [0-9a-f.:]{2,45}/[0-9]{1,3})$")

    /* A new list came (counted, so a wait can tell). */
    @Volatile var rowsGen = 0L
        internal set

    /* The list of the session that ended last, kept in memory only until the
     * next start: a report sent after the user turned protection off (most
     * are: "it does not work", off, then report) still says what went
     * through and how. */
    @Volatile var lastSession: List<Row>? = null
    @Volatile var lastAds: List<AdRow> = emptyList()
    @Volatile var lastSessionEnded = 0L

    /* At a stop, the engine still running: its list asked for (`ask`), and
     * kept once it comes, waiting at most waitMs. */
    fun keepLastSession(ask: () -> Unit, waitMs: Long = 700) {
        val g = rowsGen
        try { ask() } catch (_: Exception) { return }
        val until = System.currentTimeMillis() + waitMs
        while (rowsGen == g && System.currentTimeMillis() < until) {
            try { Thread.sleep(25) } catch (_: InterruptedException) { break }
        }
        if (rowsGen != g) { lastSession = rows; lastAds = ads; lastSessionEnded = System.currentTimeMillis() }
    }

    /* A new session: the last one's list goes. */
    fun newSession() { lastSession = null; lastAds = emptyList(); lastSessionEnded = 0L; rows = emptyList(); ads = emptyList() }

    /* One the user let through: gone from the list at once. */
    fun adAllowed(host: String) { ads = ads.filter { it.host != host && !it.host.endsWith(".$host") } }

    /* The engine's lines: rows until conns_end (one collector per service). */
    class Collector {
        private val pending = ArrayList<Row>()
        private val pendingAds = ArrayList<AdRow>()
        fun take(ev: EngineEvent): Boolean = when (ev) {
            is EngineEvent.Conn -> { synchronized(pending) { pending += ev.row }; true }
            is EngineEvent.Ad -> { synchronized(pending) { pendingAds += ev.row }; true }
            is EngineEvent.ConnsEnd -> {
                synchronized(pending) {
                    rows = pending.toList(); pending.clear()
                    ads = pendingAds.sortedBy { it.ago }; pendingAds.clear()
                }
                rowsGen++; Protection.changed(); true
            }
            else -> false
        }
    }
}
