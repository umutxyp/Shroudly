package me.codeshare.shroudly

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/* The main window's notices: battery settings that may stop protection, and
 * notifications turned off. Neither on a new install's first screen, both
 * with "Not now", the battery's back as soon as Android has ended protection
 * by itself; and the days protection worked, which they go by. */
class NoticeTest {
    private val day = 24L * 60 * 60 * 1000
    private val now = 1_800_000_000_000L

    @Test
    fun aDayCountsOnce() {
        assertEquals(1 to 100L, Usage.countDay(0, Long.MIN_VALUE, 100))
        assertEquals(1 to 100L, Usage.countDay(1, 100, 100))
        assertEquals(2 to 101L, Usage.countDay(1, 100, 101))
        // A clock set back to another day: counted, never taken away.
        assertEquals(3 to 99L, Usage.countDay(2, 101, 99))
    }

    @Test
    fun theBatteryNotice() {
        // Never before protection has been used.
        assertFalse(Diagnostics.batteryDue(hint = true, workedDays = 0, laterAt = 0, endedAt = 0, now = now))
        // Used, or ended by Android while on.
        assertTrue(Diagnostics.batteryDue(hint = true, workedDays = 1, laterAt = 0, endedAt = 0, now = now))
        assertTrue(Diagnostics.batteryDue(hint = true, workedDays = 0, laterAt = 0, endedAt = now - day, now = now))
        assertFalse(Diagnostics.batteryDue(hint = false, workedDays = 5, laterAt = 0, endedAt = now, now = now))
        // "Not now": a month, or until Android ends protection again.
        assertFalse(Diagnostics.batteryDue(hint = true, workedDays = 5, laterAt = now - day, endedAt = 0, now = now))
        assertTrue(Diagnostics.batteryDue(hint = true, workedDays = 5, laterAt = now - 31 * day, endedAt = 0, now = now))
        assertTrue(Diagnostics.batteryDue(hint = true, workedDays = 5, laterAt = now - day, endedAt = now - day + 1, now = now))
        assertFalse(Diagnostics.batteryDue(hint = true, workedDays = 5, laterAt = now - day, endedAt = now - 2 * day, now = now))
        // A clock set back: shown again rather than hidden for good.
        assertTrue(Diagnostics.batteryDue(hint = true, workedDays = 5, laterAt = now + day, endedAt = 0, now = now))
    }

    @Test
    fun theNotificationsNotice() {
        assertFalse(Diagnostics.notificationsDue(enabled = true, workedDays = 5, laterAt = 0, now = now))
        assertFalse(Diagnostics.notificationsDue(enabled = false, workedDays = 0, laterAt = 0, now = now))
        assertTrue(Diagnostics.notificationsDue(enabled = false, workedDays = 1, laterAt = 0, now = now))
        assertFalse(Diagnostics.notificationsDue(enabled = false, workedDays = 1, laterAt = now - 29 * day, now = now))
        assertTrue(Diagnostics.notificationsDue(enabled = false, workedDays = 1, laterAt = now - 30 * day, now = now))
    }

    /* Wired in: the services count a day only once traffic came back, and
     * note Android ending them; the window shows one notice at most. */
    @Test
    fun wiredIn() {
        val src = File("src/main")
        for (name in listOf("ShroudlyVpnService.kt", "ShroudlyProxyService.kt")) {
            val s = File(src, "java/me/codeshare/shroudly/$name").readText()
            assertTrue(name, s.contains("if (ev.bytesDown > 0 && !workedToday && active && Protection.troubleRes == 0) { workedToday = true; Usage.worked(this) }"))
            assertTrue(name, s.contains("Usage.endedByAndroid(this)"))
        }
        val main = File(src, "java/me/codeshare/shroudly/MainActivity.kt").readText()
        assertTrue(main.contains("battery -> R.string.androidBatterySettings\n            notifications -> R.string.showNotifications"))
        assertTrue(main.contains("getString(R.string.androidBatteryHint) + \"\\n\" + getString(R.string.androidBatterySteps)"))
    }
}
