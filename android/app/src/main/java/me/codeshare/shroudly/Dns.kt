package me.codeshare.shroudly

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream

/* The little of the DNS wire format the forwarder needs. */
object Dns {
    const val TYPE_A = 1

    private fun u16(m: ByteArray, p: Int) = ((m[p].toInt() and 0xff) shl 8) or (m[p + 1].toInt() and 0xff)

    /* Where the single question of a message ends (after QTYPE and QCLASS),
     * or -1 if there is not exactly one well-formed question. */
    fun questionEnd(m: ByteArray, len: Int = m.size): Int {
        if (len < 17 || u16(m, 4) != 1) return -1
        var p = 12
        while (true) {
            if (p >= len) return -1
            val l = m[p].toInt() and 0xff
            if (l == 0) { p++; break }
            if (l and 0xc0 != 0) return -1          // no compression in a question
            p += 1 + l
        }
        return if (p + 4 <= len) p + 4 else -1
    }

    /* A standard query (QR clear, opcode 0) with one question. */
    fun isQuery(m: ByteArray, len: Int = m.size): Boolean {
        if (len < 17 || len > 4096) return false
        val flags = m[2].toInt() and 0xff
        if (flags and 0x80 != 0) return false        // a response, not a query
        if ((flags shr 3) and 0x0f != 0) return false // opcode QUERY only
        return questionEnd(m, len) > 0
    }

    /* The answer, if it is the response to this query: QR set and the same
     * question (names compared without case). Its ID is set to the query's,
     * whatever the resolver put there. null otherwise. */
    fun matchAnswer(query: ByteArray, answer: ByteArray): ByteArray? {
        val qEnd = questionEnd(query)
        if (qEnd < 0 || answer.size < qEnd) return null
        if (answer[2].toInt() and 0x80 == 0) return null
        if (questionEnd(answer) != qEnd) return null
        for (i in 12 until qEnd) {
            val a = query[i].toInt() and 0xff
            val b = answer[i].toInt() and 0xff
            if (a != b && lower(a) != lower(b)) return null
        }
        val out = answer.copyOf()
        out[0] = query[0]
        out[1] = query[1]
        return out
    }

    private fun lower(c: Int) = if (c in 'A'.code..'Z'.code) c + 32 else c

    /* "Server failure" (SERVFAIL): the resolver could not get an answer it
     * trusts, mostly for a name whose DNSSEC signatures are wrong. */
    fun serverFailed(m: ByteArray) = m.size >= 12 && m[3].toInt() and 0x0f == 2

    /* A server failure for this query: its header and question, with
     * recursion available. null if the question cannot be read. */
    fun failReply(query: ByteArray): ByteArray? {
        val end = questionEnd(query)
        if (end < 0) return null
        val out = query.copyOf(end)
        out[2] = (0x80 or (query[2].toInt() and 0x79)).toByte()   // a response; opcode, RD kept
        out[3] = 0x82.toByte()                                      // RA, SERVFAIL
        for (i in 6 until 12) out[i] = 0
        return out
    }

    /* Name and type of the question, for logs and tests. */
    fun question(m: ByteArray): Pair<String, Int>? {
        val end = questionEnd(m)
        if (end < 0) return null
        val parts = ArrayList<String>()
        var p = 12
        while (true) {
            val l = m[p].toInt() and 0xff
            if (l == 0) break
            parts.add(String(m, p + 1, l, Charsets.ISO_8859_1).lowercase())
            p += 1 + l
        }
        return parts.joinToString(".") to u16(m, end - 4)
    }

    /* The first IPv4 address among the answers, or null. */
    fun firstA(m: ByteArray?): String? {
        if (m == null) return null
        try {
            val end = questionEnd(m)
            if (end < 0) return null
            var p = end
            repeat(u16(m, 6)) {
                while (true) {
                    val l = m[p].toInt() and 0xff
                    if (l == 0) { p++; break }
                    if (l and 0xc0 != 0) { p += 2; break }
                    p += 1 + l
                }
                val type = u16(m, p)
                val len = u16(m, p + 8)
                if (type == TYPE_A && len == 4) return (0 until 4).joinToString(".") { (m[p + 10 + it].toInt() and 0xff).toString() }
                p += 10 + len
            }
        } catch (_: IndexOutOfBoundsException) {}
        return null
    }

    fun buildQuery(name: String, qtype: Int, id: Int): ByteArray {
        val out = ByteArrayOutputStream()
        out.write(id shr 8 and 0xff); out.write(id and 0xff)
        out.write(0x01); out.write(0x00)              // RD
        out.write(0); out.write(1)                    // QDCOUNT
        repeat(6) { out.write(0) }
        for (label in name.split('.').filter { it.isNotEmpty() }) {
            val b = label.toByteArray(Charsets.ISO_8859_1)
            require(b.size in 1..63) { "bad label" }
            out.write(b.size); out.write(b)
        }
        out.write(0)
        out.write(qtype shr 8 and 0xff); out.write(qtype and 0xff)
        out.write(0); out.write(1)                    // IN
        return out.toByteArray()
    }
}

/* An HTTP/1.1 response read off a stream: status line, headers, then a body
 * by Content-Length, chunked, or up to the end of the stream. The answer to
 * a HEAD has no body, whatever its Content-Length says (bodyless). */
object Http1 {
    class Response(val status: Int, val headers: Map<String, String>, val body: ByteArray)

    private const val MAX_BODY = 65536

    fun read(input: InputStream, max: Int = MAX_BODY, bodyless: Boolean = false): Response {
        val statusLine = line(input) ?: throw IOException("no response")
        val parts = statusLine.split(' ')
        if (parts.size < 2 || !parts[0].startsWith("HTTP/1.")) throw IOException("not HTTP/1: $statusLine")
        val status = parts[1].toIntOrNull() ?: throw IOException("bad status: $statusLine")
        val headers = HashMap<String, String>()
        while (true) {
            val h = line(input) ?: throw IOException("headers cut short")
            if (h.isEmpty()) break
            val c = h.indexOf(':')
            if (c > 0) headers[h.substring(0, c).trim().lowercase()] = h.substring(c + 1).trim()
        }
        val body = when {
            bodyless -> ByteArray(0)
            headers["transfer-encoding"]?.lowercase()?.contains("chunked") == true -> chunked(input, max)
            headers["content-length"] != null -> {
                val n = headers["content-length"]!!.toIntOrNull() ?: throw IOException("bad length")
                if (n < 0 || n > max) throw IOException("body too large")
                exactly(input, n)
            }
            else -> toEnd(input, max)
        }
        return Response(status, headers, body)
    }

    private fun line(input: InputStream): String? {
        val b = StringBuilder()
        while (true) {
            val c = input.read()
            if (c < 0) return if (b.isEmpty()) null else b.toString()
            if (c == '\n'.code) return b.toString().trimEnd('\r')
            if (b.length > 8192) throw IOException("line too long")
            b.append(c.toChar())
        }
    }

    private fun exactly(input: InputStream, n: Int): ByteArray {
        val out = ByteArray(n)
        var got = 0
        while (got < n) {
            val r = input.read(out, got, n - got)
            if (r < 0) throw IOException("body cut short")
            got += r
        }
        return out
    }

    private fun chunked(input: InputStream, max: Int): ByteArray {
        val out = ByteArrayOutputStream()
        while (true) {
            val size = line(input)?.substringBefore(';')?.trim()?.toIntOrNull(16) ?: throw IOException("bad chunk")
            if (size == 0) break
            if (size < 0 || out.size() + size > max) throw IOException("body too large")
            out.write(exactly(input, size))
            line(input)
        }
        return out.toByteArray()
    }

    private fun toEnd(input: InputStream, max: Int): ByteArray {
        val out = ByteArrayOutputStream()
        val buf = ByteArray(4096)
        while (true) {
            val r = input.read(buf)
            if (r < 0) break
            out.write(buf, 0, r)
            if (out.size() > max) throw IOException("body too large")
        }
        return out.toByteArray()
    }
}
