package me.codeshare.shroudly

import java.net.InetAddress

/*
 * Apps whose connections are not TLS or HTTP (a messenger's own protocol, a
 * game's) that cannot get through, told in one line as the desktop does
 * (electron/raw-apps.js). The engine searches for a technique for them by
 * itself; what it cannot change is an address the network blocks outright
 * ("unreachable", raw), or a filter no technique gets past ("blocked", raw).
 * An app waiting on either cannot say so, so Shroudly does, naming the app by
 * the service its servers belong to (assets/raw-apps.txt, generated from the
 * desktop's list). Android does not say which app holds a connection that
 * reached us through the tunnel, so an address of no known service is a line
 * in the log only: peer-to-peer and game clients try dead addresses all day.
 */
class RawApps(lines: List<String>) {
    private data class Range(val name: String, val net: ByteArray, val bits: Int)

    private val ranges = ArrayList<Range>()
    private val domains = ArrayList<Pair<String, String>>()   // name, ".domain"

    init {
        for (raw in lines) {
            val line = raw.trim()
            if (line.isEmpty() || line.startsWith("#")) continue
            val sp = line.lastIndexOf(' ')
            if (sp <= 0) continue
            val name = line.substring(0, sp).trim()
            val what = line.substring(sp + 1)
            if (what.startsWith(".")) { domains += name to what.lowercase(); continue }
            val slash = what.indexOf('/')
            if (slash <= 0) continue
            val net = literal(what.substring(0, slash)) ?: continue
            val bits = what.substring(slash + 1).toIntOrNull() ?: continue
            ranges += Range(name, net, bits)
        }
    }

    /* The service an address or name belongs to, or null. */
    fun serviceOf(host: String): String? {
        val h = host.trim().lowercase().removeSuffix(".").removePrefix("[").removeSuffix("]")
        if (h.isEmpty()) return null
        val a = literal(h)
        if (a != null) return ranges.firstOrNull { it.net.size == a.size && prefixEq(a, it.net, it.bits) }?.name
        return domains.firstOrNull { (_, d) -> h == d.substring(1) || h.endsWith(d) }?.first
    }

    companion object {
        private val V4 = Regex("^\\d{1,3}(\\.\\d{1,3}){3}$")
        private val V6 = Regex("^[0-9a-fA-F:.]+$")

        /* The bytes of an address literal; never a lookup by name. */
        fun literal(s: String): ByteArray? {
            if (!(V4.matches(s) || (s.contains(':') && V6.matches(s)))) return null
            if (V4.matches(s) && s.split('.').any { it.toInt() > 255 }) return null
            return try { InetAddress.getByName(s).address } catch (_: Exception) { null }
        }

        fun prefixEq(a: ByteArray, b: ByteArray, bits: Int): Boolean {
            var left = bits
            var i = 0
            while (left > 0 && i < a.size) {
                val m = if (left >= 8) 0xff else (0xff shl (8 - left)) and 0xff
                if ((a[i].toInt() and m) != (b[i].toInt() and m)) return false
                left -= 8; i++
            }
            return true
        }

        const val WINDOW_MS = 5L * 60 * 1000
        const val MIN_ADDRS = 2
        const val AGAIN_MS = 30L * 1000
    }
}

/* What to tell, from the engine's raw lines (the desktop's raw-apps.js, the
 * same rules):
 *  - unreachable: a known service after MIN_ADDRS of its addresses did not
 *    answer within WINDOW_MS, or one of them still did not AGAIN_MS later
 *    (the engine says it again at most once a minute while the app keeps
 *    trying); never for a name that did not resolve (stage "dns");
 *  - no technique got through: only once it is the network's doing rather
 *    than an outage (a server that takes connections and drops them looks
 *    the same): on two of the service's addresses, or on the same one again
 *    after the engine's rest (BLOCKED_AGAIN_MS later); never when the
 *    connections only went unanswered (note "silent": an app that sends and
 *    waits looks the same);
 *  - never while nothing else comes back either (networkWorks: an
 *    underlying network, and something received lately): offline is not a
 *    block.
 * Once per service and kind on a network. */
class RawWatch(private val apps: RawApps, private val networkWorks: () -> Boolean = { true }) {
    enum class Kind { UNREACHABLE, BLOCKED }
    data class Notice(val kind: Kind, val app: String, val addrs: List<String>)
    sealed class Outcome {
        data class Tell(val notice: Notice) : Outcome()
        data class Log(val line: String) : Outcome()
        object Nothing : Outcome()
    }

    companion object {
        const val BLOCKED_AGAIN_MS = 9L * 60 * 1000
        const val BLOCKED_WINDOW_MS = 30L * 60 * 1000
    }

    private val recent = HashMap<String, ArrayList<Pair<String, Long>>>()   // "kind app" -> (addr, at)
    private val told = HashSet<String>()
    private val logged = HashMap<String, Long>()

    @Synchronized fun networkChanged() { recent.clear(); told.clear(); logged.clear() }

    private fun logRarely(k: String, line: String, now: Long): Outcome {
        if (now - (logged[k] ?: Long.MIN_VALUE / 2) < 30 * 60 * 1000L) return Outcome.Nothing
        if (logged.size > 500) logged.clear()
        logged[k] = now
        return Outcome.Log(line)
    }

    @Synchronized fun onEvent(
        kind: Kind, host: String, port: Int, attempts: Int, now: Long,
        stage: String? = null, note: String? = null,
    ): Outcome {
        if (kind == Kind.UNREACHABLE && stage == "dns") return Outcome.Nothing
        val addr = if (host.contains(':')) "[$host]:$port" else "$host:$port"
        val unreach = "$addr: could not be reached (not a web connection)"
        val blocked = "$addr: still blocked after $attempts techniques (not a web connection)"
        if (kind == Kind.BLOCKED && note == "silent") return logRarely("silent $addr", blocked, now)
        val app = apps.serviceOf(host)
            ?: return logRarely("$kind $addr", if (kind == Kind.UNREACHABLE) unreach else blocked, now)
        val key = "$kind $app"
        val seen = recent.getOrPut(key) { ArrayList() }
        seen.removeAll { now - it.second > (if (kind == Kind.BLOCKED) BLOCKED_WINDOW_MS else RawApps.WINDOW_MS) }
        val again = seen.any { it.first == addr && now - it.second >= (if (kind == Kind.BLOCKED) BLOCKED_AGAIN_MS else RawApps.AGAIN_MS) }
        seen += addr to now
        val addrs = seen.map { it.first }.distinct()
        val enough = if (kind == Kind.BLOCKED) addrs.size >= 2 || again else addrs.size >= RawApps.MIN_ADDRS || again
        if (!enough || key in told) return Outcome.Nothing
        if (!networkWorks()) return Outcome.Nothing
        told += key
        return Outcome.Tell(Notice(kind, app, addrs.take(3)))
    }
}
