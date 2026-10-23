package me.codeshare.shroudly

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/* Protection comes back by itself when it was not turned off by the user
 * (issue #39), but not over and over on a network where it cannot work. */
class KeepOnTest {
    private val hour = KeepOn.WINDOW_MS

    @Test
    fun broughtBackAtMostThreeTimesAnHour() {
        val now = 10 * hour
        assertTrue(KeepOn.mayResume(emptyList(), now))
        assertTrue(KeepOn.mayResume(listOf(now - 50 * 60_000L, now - 10 * 60_000L), now))
        assertFalse(KeepOn.mayResume(listOf(now - 50 * 60_000L, now - 10 * 60_000L, now - 60_000L), now))
        // Older than the hour: they do not count.
        assertTrue(KeepOn.mayResume(listOf(now - 2 * hour, now - hour, now - hour - 1), now))
        // The clock set back: a time "in the future" still counts as recent.
        assertFalse(KeepOn.mayResume(listOf(now + 60_000L, now + 120_000L, now - 1), now))
    }

    /* Wired in: Android runs the job (declared, with the permission only the
     * system holds), the services say when protection is on, turned off by
     * the user, or ended by itself, and a lost network arms it. */
    @Test
    fun theServicesTellIt() {
        val src = File("src/main")
        val manifest = File(src, "AndroidManifest.xml").readText()
        assertTrue(Regex("""android:name="\.ResumeJob"[^>]*android:permission="android\.permission\.BIND_JOB_SERVICE"""").containsMatchIn(manifest))
        val vpn = File(src, "java/me/codeshare/shroudly/ShroudlyVpnService.kt").readText()
        assertTrue(vpn.contains("KeepOn.on(this)"))
        assertTrue(vpn.contains("if (errorRes == 0 || errorRes == R.string.androidVpnRevoked) KeepOn.stoppedByUser(this)"))
        assertTrue(vpn.contains("KeepOn.endedByItself(this)"))
        assertTrue(Regex("""log\("Network: none"\)\s*\n(\s*//.*\n)*\s*KeepOn\.networkGone\(this\)""").containsMatchIn(vpn))
        val proxy = File(src, "java/me/codeshare/shroudly/ShroudlyProxyService.kt").readText()
        assertTrue(proxy.contains("KeepOn.on(this)") && proxy.contains("if (byUser) KeepOn.stoppedByUser(this) else KeepOn.endedByItself(this)"))
    }
}
