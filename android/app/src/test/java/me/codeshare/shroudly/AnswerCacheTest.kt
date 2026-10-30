package me.codeshare.shroudly

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AnswerCacheTest {
    private fun hex(s: String) = s.replace(" ", "").chunked(2).map { it.toInt(16).toByte() }.toByteArray()

    /* An answer to q with one A record (ttl seconds) and the given rcode. */
    private fun answerFor(q: ByteArray, ttl: Long = 300, rcode: Int = 0, records: Int = 1): ByteArray {
        val a = q.copyOf()
        a[0] = 0x7e; a[1] = 0x7e
        a[2] = 0x81.toByte(); a[3] = (0x80 or rcode).toByte()
        a[7] = records.toByte()
        val t = "%08x".format(ttl)
        return if (records == 0) a else a + hex("c00c 0001 0001 $t 0004 5db8d822")
    }

    @Test
    fun readsTheSmallestTtl() {
        val q = Dns.buildQuery("example.com", Dns.TYPE_A, 1)
        assertEquals(60L, Dns.answerTtl(answerFor(q, 60)))
        val two = answerFor(q, 300).let { it.copyOf().also { b -> b[7] = 2 } + hex("c00c 0001 0001 0000001e 0004 01010101") }
        assertEquals(30L, Dns.answerTtl(two))
        assertNull(Dns.answerTtl(answerFor(q, 60, rcode = 3)))   // no such name
        assertNull(Dns.answerTtl(answerFor(q, records = 0)))     // nothing to keep
        assertNull(Dns.answerTtl(answerFor(q).copyOf(30)))       // cut short
    }

    /* Asked again within its TTL: the kept answer, under the new query's id,
     * whatever the case of the name; after it, nothing. */
    @Test
    fun keepsAnswersForTheirTtl() {
        var t = 1_000_000L
        val c = AnswerCache(now = { t })
        val q = Dns.buildQuery("example.com", Dns.TYPE_A, 0x1111)
        c.put(q, answerFor(q, 60))
        val again = Dns.buildQuery("Example.COM", Dns.TYPE_A, 0x2222)
        val hit = c.get(again)!!
        assertEquals(0x22, hit[0].toInt() and 0xff); assertEquals(0x22, hit[1].toInt() and 0xff)
        assertEquals("93.184.216.34", Dns.firstA(hit))
        assertNull(c.get(Dns.buildQuery("example.com", 28, 3)))   // another type (AAAA)
        t += 59_000
        assertEquals("93.184.216.34", Dns.firstA(c.get(q)))
        t += 2_000
        assertNull(c.get(q))
    }

    @Test
    fun keepsNoErrorsAndAtMostFiveMinutes() {
        var t = 0L
        val c = AnswerCache(now = { t })
        val nx = Dns.buildQuery("nothing.example", Dns.TYPE_A, 1)
        c.put(nx, answerFor(nx, 60, rcode = 3))
        val fail = Dns.buildQuery("bogus.example", Dns.TYPE_A, 2)
        c.put(fail, Dns.failReply(fail)!!)
        assertEquals(0, c.size)
        // An answer to another question is not kept under this one.
        val q = Dns.buildQuery("example.com", Dns.TYPE_A, 3)
        c.put(q, answerFor(Dns.buildQuery("example.org", Dns.TYPE_A, 3)))
        assertEquals(0, c.size)
        c.put(q, answerFor(q, 86_400))
        t += AnswerCache.TTL_MAX_S * 1000 + 1
        assertNull(c.get(q))
    }

    /* Full: the one used longest ago goes first. */
    @Test
    fun dropsTheLeastRecentlyUsed() {
        val c = AnswerCache(max = 3)
        val qs = (1..3).map { Dns.buildQuery("n$it.example", Dns.TYPE_A, it) }
        qs.forEach { c.put(it, answerFor(it)) }
        c.get(qs[0])
        val q4 = Dns.buildQuery("n4.example", Dns.TYPE_A, 4)
        c.put(q4, answerFor(q4))
        assertEquals(3, c.size)
        assertNull(c.get(qs[1]))
        assertArrayEquals(answerFor(q4).copyOfRange(12, 40), c.get(q4)!!.copyOfRange(12, 40))
        c.clear()
        assertEquals(0, c.size)
    }
}
