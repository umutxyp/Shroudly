package me.codeshare.shroudly

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
}
