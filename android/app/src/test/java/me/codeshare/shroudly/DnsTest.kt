package me.codeshare.shroudly

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.IOException

class DnsTest {
    private fun hex(s: String) = s.replace(" ", "").chunked(2).map { it.toInt(16).toByte() }.toByteArray()

    // example.com A, id 0x1234, RD
    private val query = hex("1234 0100 0001 0000 0000 0000 07 6578616d706c65 03 636f6d 00 0001 0001")

    private fun answerFor(q: ByteArray, id: Int = 0xbeef): ByteArray {
        val a = q.copyOf()
        a[0] = (id shr 8).toByte(); a[1] = id.toByte()
        a[2] = 0x81.toByte(); a[3] = 0x80.toByte() // QR, RD, RA
        a[7] = 1                                    // ANCOUNT
        return a + hex("c00c 0001 0001 0000012c 0004 5db8d822")
    }

    @Test
    fun buildsTheQuery() {
        assertArrayEquals(query, Dns.buildQuery("example.com", Dns.TYPE_A, 0x1234))
        assertEquals("example.com" to 1, Dns.question(query))
    }

    @Test
    fun recognisesQueries() {
        assertTrue(Dns.isQuery(query))
        assertFalse(Dns.isQuery(answerFor(query)))              // a response
        assertFalse(Dns.isQuery(query.copyOf(15)))              // cut short
        val two = query.copyOf().also { it[5] = 2 }
        assertFalse(Dns.isQuery(two))                           // two questions
        val notify = query.copyOf().also { it[2] = 0x20 }
        assertFalse(Dns.isQuery(notify))                        // opcode 4
        val compressed = query.copyOf().also { it[12] = 0xc0.toByte() }
        assertFalse(Dns.isQuery(compressed))
        assertTrue(Dns.isQuery(query + ByteArray(20), query.size)) // length taken from the packet
    }

    @Test
    fun matchesTheAnswerAndRestoresTheId() {
        val got = Dns.matchAnswer(query, answerFor(query))
        assertNotNull(got)
        assertEquals(0x12, got!![0].toInt())
        assertEquals(0x34, got[1].toInt())
        // Name case may differ (0x20 encoding).
        val upper = answerFor(query).also { it[13] = 'E'.code.toByte() }
        assertNotNull(Dns.matchAnswer(query, upper))
    }

    @Test
    fun refusesOtherAnswers() {
        val other = Dns.buildQuery("example.org", Dns.TYPE_A, 0x1234)
        assertNull(Dns.matchAnswer(query, answerFor(other)))     // another name
        val aaaa = Dns.buildQuery("example.com", 28, 0x1234)
        assertNull(Dns.matchAnswer(query, answerFor(aaaa)))      // another type
        assertNull(Dns.matchAnswer(query, query))                // not a response
        assertNull(Dns.matchAnswer(query, ByteArray(5)))
    }

    @Test
    fun answersAServerFailure() {
        val q = Dns.buildQuery("bogus.example", Dns.TYPE_A, 0x1234)
        val f = Dns.failReply(q)!!
        assertTrue(Dns.serverFailed(f))
        assertEquals(q.size, f.size)                             // header and question only
        assertEquals(0x81, f[2].toInt() and 0xff)                // a response, RD kept
        assertEquals(0, (f[6].toInt() or f[7].toInt() or f[8].toInt() or f[9].toInt() or f[10].toInt() or f[11].toInt()))
        assertTrue(Dns.matchAnswer(q, f) != null)                // the engine takes it as the answer to q
        assertNull(Dns.failReply(byteArrayOf(1, 2, 3)))
        assertTrue(!Dns.serverFailed(answerFor(q)))
    }

    @Test
    fun readsHttpResponses() {
        val body = byteArrayOf(1, 2, 3, 4)
        val plain = "HTTP/1.1 200 OK\r\nContent-Type: application/dns-message\r\nContent-Length: 4\r\n\r\n".toByteArray() + body
        val r = Http1.read(ByteArrayInputStream(plain))
        assertEquals(200, r.status)
        assertArrayEquals(body, r.body)
        assertEquals("application/dns-message", r.headers["content-type"])

        val chunked = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n".toByteArray() + byteArrayOf(1, 2) +
            "\r\n2;x=y\r\n".toByteArray() + byteArrayOf(3, 4) + "\r\n0\r\n\r\n".toByteArray()
        assertArrayEquals(body, Http1.read(ByteArrayInputStream(chunked)).body)

        val toEnd = "HTTP/1.0 503 Busy\r\n\r\n".toByteArray() + body
        val e = Http1.read(ByteArrayInputStream(toEnd))
        assertEquals(503, e.status)
        assertArrayEquals(body, e.body)
    }

    @Test(expected = IOException::class)
    fun refusesHttp2Garbage() {
        Http1.read(ByteArrayInputStream("PRI * HTTP/2.0\r\n\r\n".toByteArray()))
    }

    @Test(expected = IOException::class)
    fun refusesShortBodies() {
        Http1.read(ByteArrayInputStream("HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc".toByteArray()))
    }
}
