package me.codeshare.shroudly

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/* "Block ads and trackers" on Android: the exceptions cleaned as on the
 * desktop (electron/adblock.js cleanAllow), when the list is due, what the
 * engine is started with and what it says (the blocking itself is tested in
 * core/test/test_adblock.c and tests/net/adblock.test.js). */
class AdBlockTest {
    @Test
    fun exceptionsAreDomainsOnlyCleanedWithoutRepeats() {
        assertEquals(
            listOf("www.example.com", "ads.org", "x.io", "example.com"),
            AdBlock.clean(listOf("WWW.Example.com", "*.ads.org", "https://x.io/path", "bad", "a b.com", "x.io:443", "Example.com.")),
        )
        assertEquals(AdBlock.ALLOW_MAX, AdBlock.clean((0 until 600).map { "s$it.example.com" }).size)
    }

    @Test
    fun theListIsDueWhenMissingOrAWeekOld() {
        val f = File.createTempFile("adblock", ".txt")
        try {
            f.writeText("")
            assertTrue("an empty or missing list is due", AdBlock.due(f, System.currentTimeMillis()))
            f.writeText("0.0.0.0 doubleclick.net\n")
            val now = f.lastModified()
            assertFalse("a fresh list is not due", AdBlock.due(f, now + 1000))
            assertTrue("a week-old list is due", AdBlock.due(f, now + AdBlock.REFRESH_MS + 1))
            // Where the list in use came from: another source (the hosts list
            // alone, before 2.6.19), or none recorded, is due at once.
            val src = File.createTempFile("adblock", ".source")
            try {
                src.writeText(AdBlock.SOURCE_KEY + "\n")
                assertFalse("a fresh list from this source is not due", AdBlock.due(f, now + 1000, src))
                src.writeText("raw.githubusercontent.com/StevenBlack/hosts/master/hosts\n")
                assertTrue("a list from another source is due at once", AdBlock.due(f, now + 1000, src))
                src.delete()
                assertTrue("a list with no record of its source is due at once", AdBlock.due(f, now + 1000, src))
            } finally {
                src.delete()
            }
        } finally {
            f.delete()
        }
    }

    @Test
    fun theEngineIsStartedWithTheListAndTheExceptions() {
        val list = File("/data/user/0/me.codeshare.shroudly/files/adblock-list.txt")
        val a = Engine.args(1080, 5353, emptyList(), adblock = list, allow = listOf("example.com"))
        val i = a.indexOf("--adblock")
        assertTrue(i != -1 && a[i + 1] == list.path)
        assertEquals("example.com", a[a.indexOf("--allow") + 1])
        assertFalse("off: nothing about it", Engine.args(1080, 5353, emptyList()).contains("--adblock"))
    }

    @Test
    fun theEngineLinesAreRead() {
        assertEquals(EngineEvent.Adblock(true, 81234, null), EngineEvent.parse("""{"type":"adblock","on":true,"entries":81234,"skipped":2,"bytes":1048576,"ms":40}"""))
        assertEquals(EngineEvent.Adblock(false, 0, "cannot read"), EngineEvent.parse("""{"type":"adblock","on":false,"error":"cannot read"}"""))
        assertEquals(EngineEvent.AdblockCheck(false, 1, "too few entries"), EngineEvent.parse("""{"type":"adblock_check","ok":false,"entries":1,"error":"too few entries"}"""))
        val st = EngineEvent.parse("""{"type":"stats","conns_total":3,"conns_active":1,"bytes_up":1,"bytes_down":2,"desync":0,"tls":1,"http":0,"probe_ok":0,"probe_fail":0,"blocked":7}""")
        assertEquals(7L, (st as EngineEvent.Stats).blocked)
        val old = EngineEvent.parse("""{"type":"stats","conns_total":3,"conns_active":1,"bytes_up":1,"bytes_down":2,"desync":0,"tls":1,"http":0,"probe_ok":0,"probe_fail":0}""")
        assertEquals("an engine that does not say: 0", 0L, (old as EngineEvent.Stats).blocked)
    }
}
