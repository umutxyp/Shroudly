package me.codeshare.shroudly

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/* What the main window says, so that it is true and someone who knows
 * nothing knows what to do: what protection covers, what the VPN's consent
 * coming back refused means, and the lines that used to be jargon, cut off,
 * or wrong while starting. */
class CoverageTest {
    @Test
    fun whatProtectionCovers() {
        assertEquals(Coverage.Apps.ALL to 0, Coverage.apps(appsOnly = false, included = 0, excluded = 0))
        assertEquals(Coverage.Apps.SKIP to 2, Coverage.apps(appsOnly = false, included = 3, excluded = 2))
        assertEquals(Coverage.Apps.ONLY to 3, Coverage.apps(appsOnly = true, included = 3, excluded = 2))
        // "Only these" with none of them installed: the VPN takes the other
        // list, as establish() does.
        assertEquals(Coverage.Apps.SKIP to 2, Coverage.apps(appsOnly = true, included = 0, excluded = 2))
        assertEquals(Coverage.Apps.ALL to 0, Coverage.apps(appsOnly = true, included = 0, excluded = 0))
    }

    @Test
    fun theLines() {
        val all = Coverage.apps(appsOnly = false, included = 0, excluded = 0)
        assertEquals(listOf(R.string.androidAllApps to 0), Coverage.lines(all, workProfile = false, bypassOff = false))
        // A work profile's apps have its own VPN.
        assertEquals(listOf(R.string.androidAllApps to 0, R.string.androidWorkApps to 0), Coverage.lines(all, workProfile = true, bypassOff = false))
        assertEquals(listOf(R.string.androidAppsSkipping to 2, R.string.androidWorkApps to 0),
            Coverage.lines(Coverage.apps(appsOnly = false, included = 0, excluded = 2), workProfile = true, bypassOff = false))
        // Only the apps chosen: the work profile goes without saying.
        assertEquals(listOf(R.string.androidSomeApps to 1), Coverage.lines(Coverage.apps(true, 1, 0), workProfile = true, bypassOff = false))
        // The technique off: nothing is got past, and that is said too.
        assertEquals(listOf(R.string.androidAllApps to 0, R.string.androidBypassOff to 0), Coverage.lines(all, workProfile = false, bypassOff = true))
    }

    /* Android's own refusal (another app's always-on VPN, VPN changes not
     * allowed) comes back at once without the dialog ever on screen; a user
     * who says no saw it. */
    @Test
    fun aRefusedConsentIsAndroidsOrTheUsers() {
        assertTrue(Protector.refusedByAndroid(dialogSeen = false, ms = 120, restricted = false))
        assertFalse(Protector.refusedByAndroid(dialogSeen = true, ms = 120, restricted = false))
        assertFalse(Protector.refusedByAndroid(dialogSeen = true, ms = 4000, restricted = false))
        // Slow and never seen: not taken for Android's.
        assertFalse(Protector.refusedByAndroid(dialogSeen = false, ms = Protector.REFUSED_AT_ONCE_MS, restricted = false))
        // VPN changes not allowed on this phone: always Android's.
        assertTrue(Protector.refusedByAndroid(dialogSeen = true, ms = 4000, restricted = true))
    }

    @Test
    fun theWindowSaysItPlainlyAndWhole() {
        val src = File("src/main")
        val main = File(src, "java/me/codeshare/shroudly/MainActivity.kt").readText()
        val render = main.substringAfter("private fun render()").substringBefore("\n    }\n")
        // No "DPI bypass is stopped": what a tap does.
        assertFalse(render.contains("dpiBypassStopped"))
        assertTrue(render.contains("!on -> getString(R.string.androidOffHint)"))
        // Starting or stopping: neither "stopped" nor the stats' "start protection".
        assertTrue(render.contains("busy -> \"\""))
        assertTrue(render.contains("statsHint.visibility = if (off) View.VISIBLE else View.GONE"))
        // What VPN mode covers, never "every app" whatever is set.
        assertTrue(render.contains("else -> coverage"))
        assertFalse(render.contains("R.string.androidAllApps"))
        // The window's own words for a reason, not the notice's "open Shroudly".
        assertTrue(render.contains("detail.show(getString(here(error)))"))
        // The line under the circle starts and stops too.
        assertTrue(main.contains("hint.setOnClickListener { onToggle() }"))
        val layout = File(src, "res/layout/activity_main.xml").readText()
        val detail = layout.substringAfter("android:id=\"@+id/detail\"").substringBefore("/>")
        assertFalse("a warning is never cut off", detail.contains("maxLines") || detail.contains("ellipsize"))
        // The notice says what the window says.
        val vpn = File(src, "java/me/codeshare/shroudly/ShroudlyVpnService.kt").readText()
        assertTrue(vpn.contains("val text = if (starting) getString(R.string.starting) else Coverage.text(this)"))
        // A start that failed is never announced as "Protection stopped".
        assertTrue(vpn.contains("notifyStopped(res, title = if (res == R.string.startFailed) R.string.app_name else R.string.startFailed)"))
        assertFalse(vpn.contains("getString(R.string.androidAllApps)"))
    }
}
