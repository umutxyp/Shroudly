package me.codeshare.shroudly

import org.junit.Assert.assertEquals
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
        // Proxy only too (the mode of those with another VPN): the last network
        // gone, or the service ended by Android while on, arms it.
        assertTrue(Regex("""log\("Network: none"\)\s*\n\s*KeepOn\.networkGone\(this@ShroudlyProxyService\)""").containsMatchIn(proxy))
        assertTrue(proxy.contains("watchNetwork()") && proxy.contains("network?.stop(getSystemService(ConnectivityManager::class.java))"))
        assertTrue(Regex("""override fun onDestroy\(\)[\s\S]*KeepOn\.networkGone\(this\)""").containsMatchIn(proxy))
    }

    /* An update of Shroudly (Google Play's, inside the app or by itself, or
     * a new APK over it) ends the app and protection with it: Android tells
     * the app once it is replaced, and protection comes back if the user had
     * not turned it off. */
    @Test
    fun protectionComesBackAfterAnUpdate() {
        val src = File("src/main")
        val manifest = File(src, "AndroidManifest.xml").readText()
        // In BootReceiver's own block, not a receiver after it.
        assertTrue(Regex("""android:name="\.BootReceiver"(?:(?!</receiver>)[\s\S])*android\.intent\.action\.MY_PACKAGE_REPLACED""").containsMatchIn(manifest))
        val receiver = File(src, "java/me/codeshare/shroudly/BootReceiver.kt").readText()
        assertTrue(receiver.contains("Intent.ACTION_MY_PACKAGE_REPLACED -> KeepOn.updated(Lang.wrap(context))"))
        // "Start when the phone starts" stays its own setting; an update does
        // not need it. Without it, what was on comes back (booted).
        assertTrue(Regex("""ACTION_BOOT_COMPLETED -> \{\s*if \(!AppSettings\.startAtBoot\(context\)\) \{ KeepOn\.booted\(Lang\.wrap\(context\)\); return \}""").containsMatchIn(receiver))
        val keepOn = File(src, "java/me/codeshare/shroudly/KeepOn.kt").readText()
        assertTrue(Regex("""fun updated\(ctx: Context\) \{\s*if \(!wanted\(ctx\) \|\| Protection\.state != Protection\.State\.OFF\) return""").containsMatchIn(keepOn))
    }

    /* A restart of the phone is not the user turning protection off: what
     * was on comes back, in either mode (the VPN only where it is still
     * allowed). Proxy only off while a network's proxy points at it is no
     * connection at all for the apps that use it, so it also comes back
     * after Android ended the app while it was on (START_STICKY), unless
     * the user has turned it off since. */
    @Test
    fun protectionComesBackAfterARestartAndProxyOnlyAfterAKill() {
        val src = File("src/main")
        val keepOn = File(src, "java/me/codeshare/shroudly/KeepOn.kt").readText()
        assertTrue(Regex("""fun booted\(ctx: Context\) \{\s*if \(!wanted\(ctx\) \|\| Protection\.state != Protection\.State\.OFF\) return\s*startAgain\(""").containsMatchIn(keepOn))
        // Started again through Protector, which starts the VPN only where it is
        // allowed; not started there, it stays off (stoppedByUser).
        assertTrue(Regex("""private fun startAgain\([\s\S]*Protector\.start\(ctx\)[\s\S]*if \(!started\) stoppedByUser\(ctx\)""").containsMatchIn(keepOn))
        val proxy = File(src, "java/me/codeshare/shroudly/ShroudlyProxyService.kt").readText()
        val start = proxy.substringAfter("override fun onStartCommand(").substringBefore("private fun log(")
        // Started: Android brings it back should it end the app.
        assertTrue(start.trimEnd().endsWith("work.execute { startAll() }\n        return START_STICKY\n    }"))
        // Brought back by Android (no intent): only while wanted, in this mode.
        assertTrue(start.contains("if (again && (!KeepOn.wanted(this) || !AppSettings.proxyOnly(this) || active))"))
        // Refused from the background: a notice offers it, as KeepOn's job does.
        assertTrue(start.contains("if (again) KeepOn.offer(this)"))
        // A setting sent while it runs does not take START_STICKY back (the
        // last answer counts), in either mode: the four settings commands,
        // the Connections list's (issue #74), and Android's own restart
        // while already on.
        assertEquals(6, Regex("""return if \(active\) START_STICKY else START_NOT_STICKY""").findAll(start).count())
        val vpn = File(src, "java/me/codeshare/shroudly/ShroudlyVpnService.kt").readText()
        assertEquals(5, Regex("""return stickyWhileOn\(\)""").findAll(vpn).count())
        assertTrue(vpn.contains("private fun stickyWhileOn() = if (active) START_STICKY else START_NOT_STICKY"))
    }

    /* The Quick Settings tile (issue #49): a switch the panel asks for its
     * state each time it opens (not an "active" tile, which some phones'
     * panels never ask), showing what a tap asked for while it happens. */
    @Test
    fun theTileIsAPlainSwitch() {
        val src = File("src/main")
        val manifest = File(src, "AndroidManifest.xml").readText()
        assertFalse(manifest.contains("quicksettings.ACTIVE_TILE"))
        assertTrue(manifest.contains("quicksettings.TOGGLEABLE_TILE"))
        val tile = File(src, "java/me/codeshare/shroudly/ShroudlyTileService.kt").readText()
        assertTrue(tile.contains("Protection.State.ON, Protection.State.STARTING -> Tile.STATE_ACTIVE"))
        assertTrue(tile.contains("Protection.State.OFF, Protection.State.STOPPING -> Tile.STATE_INACTIVE"))
        assertFalse(tile.contains("STATE_UNAVAILABLE"))
    }
}
