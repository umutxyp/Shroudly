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
        // nothing got through: told at once
        assertTrue(w.onEvent(RawWatch.Kind.BLOCKED, "149.154.167.50", 443, 6, now) is RawWatch.Outcome.Tell)
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
}
