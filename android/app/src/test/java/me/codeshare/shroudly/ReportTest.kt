package me.codeshare.shroudly

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.assertFalse
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
    fun theLinkInIranShowsOnlyAfterOwnFaultForADay() {
        val day = Report.FAULT_SHOWS_MS
        // Elsewhere: always.
        assertTrue(Report.offered(false, 0, 0, 1_000_000))
        // Iran, nothing went wrong: hidden.
        assertFalse(Report.offered(true, 0, 0, 1_000_000))
        // Shroudly itself failed an hour ago: shown.
        assertTrue(Report.offered(true, 1_000_000, 0, 1_000_000 + 3_600_000))
        // A day later with no report: hidden again.
        assertFalse(Report.offered(true, 1_000_000, 0, 1_000_000 + day))
        // A report sent after the fault: hidden at once.
        assertFalse(Report.offered(true, 1_000_000, 1_500_000, 2_000_000))
        // A new fault after that report: shown again.
        assertTrue(Report.offered(true, 3_000_000, 1_500_000, 3_100_000))
    }

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

    @Test
    fun connectionsAsTheDesktopGivesThem() {
        val rows = listOf(
            Conns.Row("auth.riotgames.com", 0, 9, 0, 0, "direct", false, 0),
            Conns.Row("discord.com", 1, 2, 0, 0, "technique", false, 0),
            Conns.Row("pulsar.roblox.com", 0, 1, 0, 0, "tor", false, 2),
            Conns.Row("news.example", 0, 50, 0, 0, "direct", false, 0),
        )
        val t = Report.connsText(rows).split("\n")
        assertEquals(3, t.size)
        assertEquals("pulsar.roblox.com  tor  1 conns  up 0 B, down 0 B  (2 refused)", t[0])
        assertTrue(t[1].startsWith("discord.com  technique"))
        assertTrue(t[2].startsWith("auth.riotgames.com  direct  9 conns"))
        assertEquals("(none)", Report.connsText(emptyList()))
        // An app that connects by address (a VPN app chained through Proxy
        // only) and anything refused stay in the list; browsing does not.
        val byAddr = Report.connsText(listOf(
            Conns.Row("185.12.3.4", 0, 3, 0, 0, "direct", false, 0),
            Conns.Row("news.example", 0, 9, 0, 0, "direct", false, 0),
            Conns.Row("shop.example", 0, 2, 0, 0, "direct", false, 2),
        )).split("\n")
        assertEquals(2, byAddr.size)
        assertTrue(byAddr.any { it.startsWith("185.12.3.4  direct  3 conns") } && byAddr.any { it.contains("shop.example") && it.contains("2 refused") })
        assertTrue(Report.isAddress("10.0.0.1") && Report.isAddress("fe80::1") && !Report.isAddress("example.com") && !Report.isAddress("cafe.example"))
        assertTrue(Report.isApp("edge-mqtt.facebook.com") && Report.isApp("G.WhatsApp.NET.") && !Report.isApp("notwhatsapp.net"))
        // The same list as the desktop's (electron/report.js).
        val js = java.io.File("../../electron/report.js").readText()
        for (d in Report.APP_DOMAINS) assertTrue(d, js.contains("'$d'"))
    }

    @Test
    fun connectionsSayOpenBytesAndLastUse() {
        val r = Conns.Row("gateway.discord.gg", 1, 1, 1500, 0, "technique", false, 0, 70_000)
        assertEquals("gateway.discord.gg  technique  1 conns  1 open, up 1 KB, down 0 B, last 70 s ago", Report.connsText(listOf(r)))
        assertEquals("2.2 MB", Report.bytes(2_300_000))
    }

    @Test
    fun recentSiteEventsKeepTheTroublesOnly() {
        SiteEvents.clear()
        SiteEvents.note("""{"type":"bypass","host":"a.example","strategy":"x"}""")
        for (i in 0 until 90) SiteEvents.note("""{"type":"cut","host":"h$i.example","note":"stall","attempts":2}""")
        val lines = SiteEvents.section().split("\n")
        assertEquals("== Recent site events ==", lines[0])
        assertEquals(SiteEvents.MAX + 1, lines.size)
        assertTrue(lines[1], lines[1].endsWith("cut h10.example attempts=2 note=stall"))
        assertTrue(lines.none { it.contains("bypass") })
        SiteEvents.clear()
        assertTrue(SiteEvents.section().endsWith("(none)"))
    }

    @Test
    fun aReportAfterAStopHasTheLastSession() {
        val row = Conns.Row("cdn.roblox.com", 0, 3, 0, 0, "technique", false, 0)
        assertTrue(Report.connsSection(true, listOf(row), null, 0).startsWith("== Connections this session ==\ncdn.roblox.com"))
        val off = Report.connsSection(false, emptyList(), listOf(row), 1_794_000_000_000L)
        assertTrue(off.startsWith("== Connections last session (ended ") && off.contains("cdn.roblox.com  technique"))
        assertTrue(Report.connsSection(false, emptyList(), null, 0).contains("has not run"))
    }
}
