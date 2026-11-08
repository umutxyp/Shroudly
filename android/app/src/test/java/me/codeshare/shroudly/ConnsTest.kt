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
}
