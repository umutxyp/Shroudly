package me.codeshare.shroudly

/*
 * The engine's last events about sites, for a report (ReportActivity), as
 * on the desktop (electron/engine-manager.js siteEvents): the log says each
 * kind once per site, so a site that kept being cut or kept failing said so
 * once, and a report sent later could not tell whether it still did. The
 * troubles only, not each technique that worked (the Connections list has
 * those). Kept in memory only, the last MAX, across a stop.
 */
object SiteEvents {
    const val MAX = 80
    private val TYPES = setOf("blocked", "cut", "unreachable", "send_failed", "fallback", "refused", "dns_around", "upstream")
    private val KEYS = listOf("host", "strategy", "next", "attempts", "family", "note", "why", "stage", "raw", "port", "alert", "site_ok", "ok")
    private val list = ArrayDeque<String>()

    /* One engine line: kept when it is one of TYPES. */
    fun note(line: String, now: Long = System.currentTimeMillis()) {
        if (!line.startsWith("{")) return
        val m = FlatJson.parse(line) ?: return
        val type = m["type"] as? String ?: return
        if (type !in TYPES) return
        val host = (m["host"] as? String ?: "").take(120)
        val rest = KEYS.filter { it != "host" && m[it] != null && m[it] != "" }.joinToString(" ") { "$it=${m[it].toString().take(60)}" }
        val t = java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.ROOT).format(java.util.Date(now))
        synchronized(list) {
            list.addLast("$t $type $host${if (rest.isEmpty()) "" else " $rest"}")
            while (list.size > MAX) list.removeFirst()
        }
    }

    fun section(): String {
        val lines = synchronized(list) { list.toList() }
        return "== Recent site events ==\n" + (if (lines.isEmpty()) "(none)" else lines.joinToString("\n"))
    }

    fun clear() = synchronized(list) { list.clear() }
}
