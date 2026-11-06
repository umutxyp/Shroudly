package me.codeshare.shroudly

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.MessageDigest

/* "Something not working?" on Android (Report): the same limits, references
 * and proof of work as the desktop (tests/net/report.test.js) and the
 * server (codeshare.me, server/shroudly/report.ts). */
class ReportTest {
    private val now = 1_794_000_000_000L
    private val h = Report.HOUR
    private val d = Report.DAY
    private fun ref(n: Int) = "SR-AAAA-BBBB-%04d".format(n)

    @Test
    fun historyKeepsSixtyDaysNewestFirst() {
        val l = Report.history(listOf(
            Report.Sent(ref(1), now - 61 * d), Report.Sent(ref(2), now - 2 * d), Report.Sent(ref(3), now - h / 2),
            Report.Sent("nonsense", now),
        ), now)
        assertEquals(listOf(ref(3), ref(2)), l.map { it.ref })
    }

    @Test
    fun oneAnHourThreeADay() {
        assertEquals(0L, Report.wait(emptyList(), now).ms)
        val w = Report.wait(listOf(Report.Sent(ref(1), now - 20 * 60_000)), now)
        assertEquals(40 * 60_000L, w.ms)
        assertEquals("hour", w.limit)
        assertEquals(0L, Report.wait(listOf(Report.Sent(ref(1), now - 61 * 60_000)), now).ms)
        val day = Report.wait(listOf(Report.Sent(ref(1), now - 2 * h), Report.Sent(ref(2), now - 5 * h), Report.Sent(ref(3), now - 9 * h)), now)
        assertEquals("day", day.limit)
        assertEquals(15 * h, day.ms)
    }

    @Test
    fun charactersAsTheServerCounts() {
        assertEquals(3, Report.chars("  ab😀 "))
        assertEquals(50, Report.WHAT_MIN)
        assertEquals(1000, Report.WHAT_MAX)
    }

    @Test
    fun proofOfWorkTheServerTakes() {
        val body = "{\"v\":1}"
        val proof = Report.proofOfWork(body, nowMs = now)
        val (at, nonce) = proof.split('.')
        assertEquals((now / 1000).toString(), at)
        val md = MessageDigest.getInstance("SHA-256")
        val bh = md.digest(body.toByteArray()).joinToString("") { "%02x".format(it) }
        val hash = md.digest("shroudly-report-v1\n$at\n$bh\n$nonce".toByteArray())
        assertTrue(hash[0].toInt() == 0 && hash[1].toInt() == 0 && (hash[2].toInt() and 0xc0) == 0)
    }
}
