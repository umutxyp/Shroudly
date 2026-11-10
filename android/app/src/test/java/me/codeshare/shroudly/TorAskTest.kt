package me.codeshare.shroudly

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/* A "no" to Tor rests a week, then a site no technique opens asks again. */
class TorAskTest {
    private val now = 1_800_000_000_000L

    @Test fun noKeptBeforeThisVersionAsksAgain() = assertTrue(TorAsk.restOver(0L, now))

    @Test fun withinTheWeekItRests() {
        assertFalse(TorAsk.restOver(now - 60_000L, now))
        assertFalse(TorAsk.restOver(now - TorAsk.REST_MS + 1, now))
    }

    @Test fun afterTheWeekItAsks() = assertTrue(TorAsk.restOver(now - TorAsk.REST_MS, now))

    @Test fun aClockSetBackAsks() = assertTrue(TorAsk.restOver(now + 60_000L, now))

    /* What the question names (an Iran Telegram report: asked about a bare
     * IPv6 address, never answered, Telegram stayed shut). */
    private val apps = RawApps(File("src/main/assets/raw-apps.txt").readLines())
    private fun next(had: Pair<String, Int>?, host: String) = TorAsk.label(had?.first, had?.second ?: -1, host) { apps.serviceOf(it) }

    @Test fun anAppIsNamedNotItsAddress() {
        var q = next(null, "2001:4188:2:600:10:10:34:35")
        assertEquals("2001:4188:2:600:10:10:34:35" to 0, q)
        q = next(q, "t.me")
        assertEquals("Telegram" to 2, q)
        assertEquals(q, next(q, "2001:b28:f23d:f001::a"))
        assertEquals(q, next(q, "example.com"))
        assertEquals(q, next(q, ""))
        assertEquals("Telegram", next(null, "[2001:67c:4e8:f004::a]").first)
        assertEquals("Telegram", next(null, "149.154.167.92").first)
    }

    @Test fun aSiteKeepsItsName() {
        val q = next(null, "www.youtube.com")
        assertEquals("www.youtube.com" to 1, q)
        assertEquals(q, next(q, "172.217.117.4"))
        assertEquals("x.example", next("192.0.2.1" to 0, "x.example").first)
        assertEquals("" to -1, next(null, ""))
    }

    /* An app's connections that cannot get through: Tor carries them or is
     * asked for, rather than "use the app's own proxy". */
    @Test fun rawAppsGoToTor() {
        assertEquals(TorAsk.Raw.CARRIES, TorAsk.forRaw(lite = false, bundled = true, enabled = true, approved = true, ownServer = false))
        assertEquals(TorAsk.Raw.ASKS, TorAsk.forRaw(lite = false, bundled = true, enabled = true, approved = false, ownServer = false))
        assertEquals(TorAsk.Raw.OFF, TorAsk.forRaw(lite = false, bundled = true, enabled = false, approved = false, ownServer = false))
        assertEquals(TorAsk.Raw.NONE, TorAsk.forRaw(lite = true, bundled = false, enabled = true, approved = false, ownServer = false))
        assertEquals(TorAsk.Raw.NONE, TorAsk.forRaw(lite = false, bundled = true, enabled = true, approved = true, ownServer = true))
    }
}
