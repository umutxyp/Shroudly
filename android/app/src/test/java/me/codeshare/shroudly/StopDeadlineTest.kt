package me.codeshare.shroudly

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/* A stop that hangs ends the process; a stop that ended does not end the
 * process of the next one (a report: the mode changed 15 s after a stop, and
 * the app was ended 0.3 s into the second stop). */
class StopDeadlineTest {
    @Test
    fun onlyTheStopStillUnderWayEndsTheProcess() {
        // Its own stop, still stopping when the time is up.
        assertTrue(StopDeadline.due(mine = 3, latest = 3, stopping = true))
        // It ended in time.
        assertFalse(StopDeadline.due(mine = 3, latest = 3, stopping = false))
        // It ended, and another stop began since: that one has its own time.
        assertFalse(StopDeadline.due(mine = 3, latest = 4, stopping = true))
        assertFalse(StopDeadline.due(mine = 3, latest = 4, stopping = false))
    }
}
