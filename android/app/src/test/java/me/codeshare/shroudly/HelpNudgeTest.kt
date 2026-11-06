package me.codeshare.shroudly

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/* 2.6.48: the card asking for help and its waits (the desktop's numbers),
 * what changed once after an update, and the address sites see through
 * your own server (issue #66). */
class HelpNudgeTest {
    private val day = HelpNudge.DAY

    @Test
    fun firstAfterAFewDaysThenEachNoDoublesTheWait() {
        val s = HelpNudge.begin(null, 1000)
        assertEquals(1000 + 3 * day, s.next)
        assertFalse(HelpNudge.isDue(s, 1000 + 3 * day - 1, null))
        assertTrue(HelpNudge.isDue(s, 1000 + 3 * day, null))
        assertEquals(s, HelpNudge.begin(s, 99999))
        var t = HelpNudge.refuse(s, 0)
        val waits = mutableListOf(t.next / day)
        repeat(4) { t = HelpNudge.refuse(t, 0); waits += t.next / day }
        assertEquals(listOf(7L, 14L, 28L, 56L, 112L), waits)
        val yes = HelpNudge.accept(t, 5)
        assertEquals(5 + 224 * day, yes.next)
        assertEquals(5L, yes.accepted)
        var long = s
        repeat(40) { long = HelpNudge.refuse(long, 0) }
        assertEquals(7 * day * 1024, long.next)
    }

    @Test
    fun notAskedWhereTorIsBlocked() {
        val s = HelpNudge.State(0, 0, 0)
        for (c in listOf("IR", "ru", "CN", "TM", "BY", "MM")) assertFalse(c, HelpNudge.isDue(s, 1, c))
        for (c in listOf("TR", "DE", "AZ")) assertTrue(c, HelpNudge.isDue(s, 1, c))
        assertTrue(HelpNudge.isDue(s, 1, null))
        assertFalse(HelpNudge.isDue(null, 1, null))
        // The home country, as NationalNet works it out: Tehran's zone is Iran.
        assertEquals("IR", NationalNet.homeCountry(null, "Asia/Tehran"))
    }

    @Test
    fun whatChangedOnceAfterAnUpdate() {
        assertNull("a new install", WhatsNew.decide(null, "2.6.48", false))
        assertEquals("from before 2.6.48", "2.6.48", WhatsNew.decide(null, "2.6.48", true))
        assertEquals("2.6.48", WhatsNew.decide("2.6.47", "2.6.48", false))
        assertNull(WhatsNew.decide("2.6.48", "2.6.48", true))
        assertEquals("• one\n• two", WhatsNew.lines(" one \n\ntwo\n"))
    }

    @Test
    fun theAddressSitesSee() {
        assertEquals("203.0.113.7", OwnServer.traceIp("fl=1\nh=cloudflare.com\nip=203.0.113.7\nts=1\n"))
        assertEquals("2001:db8::1", OwnServer.traceIp("ip=2001:db8::1\r\nts=1"))
        assertNull(OwnServer.traceIp("h=x\n"))
        // Its country (issue #60): the flag and the name in the app's language.
        assertEquals("IT", OwnServer.traceLoc("ip=1.2.3.4\nloc=IT\ntls=TLSv1.3\n"))
        assertNull(OwnServer.traceLoc("loc=XX\n"))
        assertNull(OwnServer.traceLoc("loc=T1\n"))
        assertEquals("80.174.118.60 · \uD83C\uDDEE\uD83C\uDDF9 Italy", OwnServer.withPlace("80.174.118.60", "IT", java.util.Locale.ENGLISH))
        assertEquals("1.2.3.4", OwnServer.withPlace("1.2.3.4", null, java.util.Locale.ENGLISH))
        assertNull(OwnServer.traceIp("ip=999.1.1.1\n"))
        assertNull(OwnServer.traceIp("ip=<b>\n"))
        assertNull(OwnServer.traceIp("xip=1.2.3.4\n"))
    }
}
