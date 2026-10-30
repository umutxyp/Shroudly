package me.codeshare.shroudly

/*
 * The forwarder's answers, by question (the name without case, and the
 * type), kept for their smallest TTL, as the desktop's forwarder keeps them
 * (electron/doh-forwarder.js). The engine keeps the addresses it looks up
 * itself, but an app that asks DNS on its own (its own resolver on port 53,
 * which the engine sends here) was asked over the network every time, a
 * full round trip of encrypted DNS before the app could connect anywhere.
 *
 * Only answers without an error and with at least one record are kept; at
 * most MAX of them, the least recently used going first. Dropped when the
 * DNS server changes (DohForwarder.setCustom) and when the forwarder stops.
 */
class AnswerCache(private val max: Int = MAX, private val now: () -> Long = { System.currentTimeMillis() }) {
    companion object {
        const val MAX = 1500
        // As the engine holds its own answers (core/src/doh.c TTL_MAX_S).
        const val TTL_MAX_S = 300L
    }

    private class Entry(val answer: ByteArray, val expires: Long)

    private val map = LinkedHashMap<String, Entry>(64, 0.75f, true)

    private fun key(query: ByteArray): String? = Dns.question(query)?.let { "${it.first}|${it.second}" }

    /* The kept answer to this query, under its id; null when there is none. */
    @Synchronized
    fun get(query: ByteArray): ByteArray? {
        val k = key(query) ?: return null
        val e = map[k] ?: return null
        if (e.expires <= now()) {
            map.remove(k)
            return null
        }
        return Dns.matchAnswer(query, e.answer)
    }

    @Synchronized
    fun put(query: ByteArray, answer: ByteArray) {
        val k = key(query) ?: return
        val ttl = Dns.answerTtl(answer) ?: return
        if (ttl <= 0) return
        if (Dns.matchAnswer(query, answer) == null) return
        val it = map.keys.iterator()
        while (map.size >= max && it.hasNext()) { it.next(); it.remove() }
        map[k] = Entry(answer.copyOf(), now() + minOf(ttl, TTL_MAX_S) * 1000)
    }

    @Synchronized
    fun clear() = map.clear()

    @get:Synchronized
    val size get() = map.size
}
