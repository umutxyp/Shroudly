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

    /* What the engine is given after it starts. */
    fun commands(ctx: Context): List<String> {
        val b = blocked(ctx)
        return if (b.isEmpty()) emptyList() else listOf("BLOCK-CLEAR") + b.sorted().map { "BLOCK $it" }
    }

    /* The engine's lines: rows until conns_end (one collector per service). */
    class Collector {
        private val pending = ArrayList<Row>()
        fun take(ev: EngineEvent): Boolean = when (ev) {
            is EngineEvent.Conn -> { synchronized(pending) { pending += ev.row }; true }
            is EngineEvent.ConnsEnd -> { synchronized(pending) { rows = pending.toList(); pending.clear() }; Protection.changed(); true }
            else -> false
        }
    }
}
