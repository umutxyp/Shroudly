package me.codeshare.shroudly

/*
 * What worked where, kept across restarts (as engine-manager.js does on the
 * desktop): the engine forgets everything when it stops, so without this every
 * start searched again and the first connections to a blocked site failed
 * meanwhile. Sent back at each start with its age (LEARN host technique
 * seconds), so one that no longer works is checked and replaced.
 *
 * Stored as text, one "host technique epoch-ms" per line.
 */
class Learned(text: String?) {
    companion object {
        const val MAX = 300
        const val TTL_MS = 30L * 24 * 60 * 60 * 1000
        private val HOST = Regex("^[a-z0-9.-]{1,253}$", RegexOption.IGNORE_CASE)
        private val TECHNIQUE = Regex("^[\\w.()+-]{1,63}$")
    }

    private val entries = LinkedHashMap<String, Pair<String, Long>>()

    init {
        text?.lineSequence()?.forEach { line ->
            val p = line.trim().split(' ')
            if (p.size == 3) {
                val t = p[2].toLongOrNull()
                if (t != null && HOST.matches(p[0]) && TECHNIQUE.matches(p[1])) entries[p[0]] = p[1] to t
            }
        }
    }

    /* Unexpired entries, oldest first, so where two names of one site disagree the newer wins. */
    fun current(now: Long): List<Triple<String, String, Long>> =
        entries.entries.filter { (_, v) -> now - v.second < TTL_MS && v.second <= now + 60000 }
            .sortedBy { it.value.second }
            .map { Triple(it.key, it.value.first, it.value.second) }

    fun remember(host: String, technique: String, now: Long) {
        if (!HOST.matches(host) || !TECHNIQUE.matches(technique)) return
        entries.remove(host)
        entries[host] = technique to now
        val keep = current(now).takeLast(MAX)
        entries.clear()
        for ((h, s, t) in keep) entries[h] = s to t
    }

    /* The engine's LEARN commands. */
    fun commands(now: Long): List<String> =
        current(now).map { (h, s, t) -> "LEARN $h $s ${maxOf(0L, (now - t) / 1000)}" }

    fun encode(): String = entries.entries.joinToString("\n") { "${it.key} ${it.value.first} ${it.value.second}" }
}
