package me.codeshare.shroudly

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class RawAppsTest {
    /* The list the app ships (generated from the desktop's). */
    private val apps = RawApps(File("src/main/assets/raw-apps.txt").readLines())

    @Test
    fun services() {
        assertEquals("Telegram", apps.serviceOf("149.154.167.50"))
        assertEquals("Telegram", apps.serviceOf("91.108.56.130"))
        assertEquals("Telegram", apps.serviceOf("2001:67c:4e8:f002::a"))
        assertEquals("Telegram", apps.serviceOf("[2001:b28:f23d:f001::a]"))
        assertEquals("Telegram", apps.serviceOf("kws2.web.telegram.org"))
        assertEquals("Telegram", apps.serviceOf("t.me"))
        assertEquals("WhatsApp", apps.serviceOf("g.whatsapp.net"))
        assertNull(apps.serviceOf("149.154.176.1"))
        assertNull(apps.serviceOf("8.8.8.8"))
        assertNull(apps.serviceOf("nottelegram.org"))
        assertNull(apps.serviceOf("1.2.3.256"))
        // never a lookup by name
        assertNull(RawApps.literal("example.com"))
    }

    @Test
    fun telling() {
        val w = RawWatch(apps)
        var now = 1_000_000L
        val u = RawWatch.Kind.UNREACHABLE
        assertEquals(RawWatch.Outcome.Nothing, w.onEvent(u, "149.154.167.50", 443, 0, now))
        val o = w.onEvent(u, "149.154.175.50", 443, 0, now) as RawWatch.Outcome.Tell
        assertEquals("Telegram", o.notice.app)
        assertEquals(listOf("149.154.167.50:443", "149.154.175.50:443"), o.notice.addrs)
        // once per network
        assertEquals(RawWatch.Outcome.Nothing, w.onEvent(u, "149.154.167.91", 443, 0, now))
        // nothing got through: on one address it may be an outage; on a second, told
        val b = RawWatch.Kind.BLOCKED
        assertEquals(RawWatch.Outcome.Nothing, w.onEvent(b, "149.154.167.50", 443, 6, now))
        assertTrue(w.onEvent(b, "149.154.175.50", 443, 6, now) is RawWatch.Outcome.Tell)
        // or the same address again after the engine's rest
        val wr = RawWatch(apps)
        assertEquals(RawWatch.Outcome.Nothing, wr.onEvent(b, "91.108.56.130", 443, 6, now))
        assertTrue(wr.onEvent(b, "91.108.56.130", 443, 6, now + RawWatch.BLOCKED_AGAIN_MS) is RawWatch.Outcome.Tell)
        // never: a name that did not resolve, connections only unanswered,
        // or while nothing else comes back either (no network)
        val wn = RawWatch(apps)
        assertEquals(RawWatch.Outcome.Nothing, wn.onEvent(u, "149.154.167.50", 443, 0, now, stage = "dns"))
        assertEquals(RawWatch.Outcome.Nothing, wn.onEvent(u, "149.154.175.50", 443, 0, now, stage = "dns"))
        assertTrue(wn.onEvent(b, "149.154.167.50", 443, 6, now, note = "silent") is RawWatch.Outcome.Log)
        assertTrue(wn.onEvent(b, "149.154.175.50", 443, 6, now, note = "silent") is RawWatch.Outcome.Log)
        val off = RawWatch(apps) { false }
        off.onEvent(u, "149.154.167.50", 443, 0, now)
        assertEquals(RawWatch.Outcome.Nothing, off.onEvent(u, "149.154.175.50", 443, 0, now))
        // an address of no known app: a log line, rarely
        val l = w.onEvent(u, "203.0.113.5", 5222, 0, now) as RawWatch.Outcome.Log
        assertEquals("203.0.113.5:5222: could not be reached (not a web connection)", l.line)
        assertEquals(RawWatch.Outcome.Nothing, w.onEvent(u, "203.0.113.5", 5222, 0, now))
        val l6 = w.onEvent(RawWatch.Kind.BLOCKED, "2001:db8::5", 443, 6, now) as RawWatch.Outcome.Log
        assertEquals("[2001:db8::5]:443: still blocked after 6 techniques (not a web connection)", l6.line)
        // one address still failing half a minute on (an app retrying it)
        val w2 = RawWatch(apps)
        assertEquals(RawWatch.Outcome.Nothing, w2.onEvent(u, "91.108.56.130", 443, 0, now))
        assertEquals(RawWatch.Outcome.Nothing, w2.onEvent(u, "91.108.56.130", 443, 0, now + 10_000))
        assertTrue(w2.onEvent(u, "91.108.56.130", 443, 0, now + 10_000 + RawApps.AGAIN_MS) is RawWatch.Outcome.Tell)
        // another network: told again; failures far apart are not added up
        w.networkChanged()
        w.onEvent(u, "149.154.167.50", 443, 0, now)
        now += RawApps.WINDOW_MS + 1
        assertEquals(RawWatch.Outcome.Nothing, w.onEvent(u, "149.154.175.50", 443, 0, now))
        assertTrue(w.onEvent(u, "149.154.167.51", 443, 0, now) is RawWatch.Outcome.Tell)
    }

    @Test
    fun anotherAppTryingServersIsCountedNotListed() {
        val w = RawWatch(apps)
        var now = 1_800_000_000_000L
        val outs = (0 until 20).map { w.onEvent(RawWatch.Kind.UNREACHABLE, "192.0.2.$it", 22, 0, now) }
        assertEquals(RawWatch.BURST_LINES, outs.count { it is RawWatch.Outcome.Log })
        // The third address made it look like an app the network blocks: one
        // question, the rest logged as before.
        assertEquals(1, outs.count { it is RawWatch.Outcome.Tell })
        now += RawWatch.BURST_MS
        val next = w.onEvent(RawWatch.Kind.UNREACHABLE, "192.0.2.200", 443, 0, now) as RawWatch.Outcome.Log
        assertTrue(next.before!!.startsWith("16 more addresses"))
        assertTrue(next.line.startsWith("192.0.2.200:443"))
    }

    /* An app no list knows, its servers blocked by address (Jakaroo in
     * Somalia, SR-T2DN): three servers that do not answer within a minute
     * are told, as an app with no name; one or two are not, nor anything
     * while the network itself does not work; once in half an hour. */
    @Test
    fun anUnknownAppWhoseServersDoNotAnswer() {
        var now = 1_800_000_000_000L
        val w = RawWatch(apps)
        assertTrue(w.onEvent(RawWatch.Kind.UNREACHABLE, "175.97.187.49", 443, 0, now) !is RawWatch.Outcome.Tell)
        assertTrue(w.onEvent(RawWatch.Kind.UNREACHABLE, "47.100.112.101", 443, 0, now + 1000) !is RawWatch.Outcome.Tell)
        val t = w.onEvent(RawWatch.Kind.UNREACHABLE, "8.209.112.161", 443, 0, now + 2000) as RawWatch.Outcome.Tell
        assertEquals("", t.notice.app)
        assertEquals(listOf("175.97.187.49:443", "47.100.112.101:443", "8.209.112.161:443"), t.notice.addrs)
        assertTrue(w.onEvent(RawWatch.Kind.UNREACHABLE, "8.209.112.162", 443, 0, now + 3000) !is RawWatch.Outcome.Tell)
        // Spread over more than a minute: not three at once.
        val slow = RawWatch(apps)
        for ((i, ip) in listOf("198.51.100.1", "198.51.100.2", "198.51.100.3").withIndex()) {
            assertTrue(slow.onEvent(RawWatch.Kind.UNREACHABLE, ip, 443, 0, now + i * 61_000L) !is RawWatch.Outcome.Tell)
        }
        // The network down: nothing asked.
        val off = RawWatch(apps) { false }
        for (ip in listOf("198.51.100.1", "198.51.100.2", "198.51.100.3")) assertTrue(off.onEvent(RawWatch.Kind.UNREACHABLE, ip, 443, 0, now) !is RawWatch.Outcome.Tell)
        // Half an hour later, again.
        now += RawWatch.UNKNOWN_REST_MS + 3000
        val again = (1..3).map { w.onEvent(RawWatch.Kind.UNREACHABLE, "203.0.113.$it", 443, 0, now) }
        assertEquals(1, again.count { it is RawWatch.Outcome.Tell })
    }
}
