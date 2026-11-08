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
    private const val KEY_ONLY_MODE = "onlySitesMode"
    private const val KEY_ONLY = "onlySites"

    /* The last list the engine gave, newest first. */
    @Volatile var rows: List<Row> = emptyList()
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
        Protector.tell(ctx, ShroudlyVpnService.ACTION_CONNS, "${if (on) "TOR" else "UNTOR"} $h")
        if (on) {
            TorRoute.setApproved(ctx, true)
            if (!TorRoute.enabled(ctx)) {
                TorRoute.setEnabled(ctx, true)
                Protector.tell(ctx, ShroudlyVpnService.ACTION_SETTINGS, "torLastResort")
            }
        }
        AppLog.add(if (on) "Connections: $h goes through Tor (the last way out) from now on" else "Connections: $h goes the usual way again")
        return now
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
        val t = torSites(ctx)
        return (if (b.isEmpty()) emptyList() else listOf("BLOCK-CLEAR") + b.sorted().map { "BLOCK $it" }) +
            (if (t.isEmpty()) emptyList() else listOf("TOR-CLEAR") + t.sorted().map { "TOR $it" }) +
            (if (onlyMode(ctx)) onlyCommands(ctx) else emptyList())
    }

    /* What the start's commands did, for the log. */
    fun summary(ctx: Context): String {
        val parts = mutableListOf<String>()
        blocked(ctx).size.takeIf { it > 0 }?.let { parts += "$it name${if (it == 1) "" else "s"} you blocked are refused" }
        torSites(ctx).size.takeIf { it > 0 }?.let { parts += "$it site${if (it == 1) "" else "s"} you send through Tor go there first" }
        if (onlyMode(ctx)) parts += "only the ${onlySites(ctx).size} listed sites are worked on, the rest go out as they are"
        return "Connections: " + parts.joinToString("; ")
    }

    /* A command the Connections list or Settings may send to the engine. */
    val COMMAND = Regex("^(CONNS|ONLY-CLEAR|ONLY-MODE [01]|(BLOCK|UNBLOCK|TOR|UNTOR|ONLY) [a-z0-9._:-]{1,253})$")

    /* A new list came (counted, so a wait can tell). */
    @Volatile var rowsGen = 0L
        internal set

    /* The list of the session that ended last, kept in memory only until the
     * next start: a report sent after the user turned protection off (most
     * are: "it does not work", off, then report) still says what went
     * through and how. */
    @Volatile var lastSession: List<Row>? = null
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
        if (rowsGen != g) { lastSession = rows; lastSessionEnded = System.currentTimeMillis() }
    }

    /* A new session: the last one's list goes. */
    fun newSession() { lastSession = null; lastSessionEnded = 0L; rows = emptyList() }

    /* The engine's lines: rows until conns_end (one collector per service). */
    class Collector {
        private val pending = ArrayList<Row>()
        fun take(ev: EngineEvent): Boolean = when (ev) {
            is EngineEvent.Conn -> { synchronized(pending) { pending += ev.row }; true }
            is EngineEvent.ConnsEnd -> { synchronized(pending) { rows = pending.toList(); pending.clear() }; rowsGen++; Protection.changed(); true }
            else -> false
        }
    }
}
