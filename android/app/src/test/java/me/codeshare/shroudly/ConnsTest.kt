package me.codeshare.shroudly

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/* What the Connections list and Settings may send to the engine: blocks,
 * sites through Tor, the only-listed-sites list and its mode; nothing else. */
class ConnsTest {
    @Test fun theListsCommandsPass() {
        for (c in listOf("CONNS", "BLOCK a.example", "UNBLOCK a.example", "TOR chatgpt.com", "UNTOR chatgpt.com",
            "ONLY youtube.com", "ONLY-CLEAR", "ONLY-MODE 1", "ONLY-MODE 0")) assertTrue(c, Conns.COMMAND.matches(c))
    }

    @Test fun nothingElsePasses() {
        for (c in listOf("STOP", "TOR a.example\nSTOP", "TOR-CLEAR", "ONLY-MODE 2", "TOR ", "TOR A B", "ADBLOCK OFF", "LEARN x 1 2"))
            assertFalse(c, Conns.COMMAND.matches(c))
    }

    @Test fun aNameIsCleaned() {
        assertEquals("build.nvidia.com", Conns.clean(" Build.NVIDIA.com. "))
        assertNull(Conns.clean("bad name;rm"))
    }

    /* Apps always through Tor: a picked app's names and ranges, what changes
     * when one is put back, and the range commands let through. */
    @Test fun appsThroughTor() {
        for (c in listOf("TOR 149.154.160.0/20", "UNTOR 2001:67c:4e8::/48")) assertTrue(c, Conns.COMMAND.matches(c))
        for (c in listOf("TOR 1.2.3.4/x", "TOR a/b/c", "TOR 10.0.0.0/8\nSTOP")) assertFalse(c, Conns.COMMAND.matches(c))
        val tg = Conns.appEntries(setOf("telegram"))
        assertTrue("t.me" in tg && "149.154.160.0/20" in tg && "2001:67c:4e8::/48" in tg)
        assertTrue(Conns.appEntries(setOf("nosuch")).isEmpty())
        val ig = Conns.appCommands(emptySet(), emptySet(), setOf("instagram"))
        assertTrue("TOR instagram.com" in ig && "TOR fbcdn.net" in ig && ig.none { it.startsWith("UNTOR") })
        // Instagram put back while Facebook stays: fbcdn.net is Facebook's too.
        val back = Conns.appCommands(emptySet(), setOf("instagram", "facebook"), setOf("facebook"))
        assertTrue("UNTOR instagram.com" in back && "UNTOR fbcdn.net" !in back && back.none { it.startsWith("TOR ") })
        // A site typed by hand that an app also has stays when the app goes.
        assertTrue("UNTOR x.com" !in Conns.appCommands(setOf("x.com"), setOf("x"), emptySet()))
        // Every command a pick makes passes the filter the service applies.
        for (c in Conns.appCommands(emptySet(), emptySet(), TorAppsList.apps.map { it.id }.toSet())) assertTrue(c, Conns.COMMAND.matches(c))
    }
}
