package me.codeshare.shroudly

import me.codeshare.shroudly.PlayUpdatePolicy.Downloaded
import me.codeshare.shroudly.PlayUpdatePolicy.Type
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/* Google Play's in-app updates (the copy Play updates): offered gently,
 * pushed only when it matters, never locking the user out, and never
 * filling the screen by itself. */
class PlayUpdatePolicyTest {
    private val day = 24L * 60 * 60 * 1000

    @Test
    fun theVersionAPlayCodeStandsFor() {
        assertEquals("2.6.44", Versions.fromCode(20644))
        assertEquals("3.0.0", Versions.fromCode(30000))
        assertEquals("2.10.5", Versions.fromCode(21005))
    }

    @Test
    fun howFarBehind() {
        assertEquals(5, Versions.behind(20643, 20648))
        assertEquals(0, Versions.behind(20648, 20643))
        assertEquals(0, Versions.behind(20643, 20643))
        // Into a newer minor: its patches, and one for the step.
        assertEquals(1, Versions.behind(20643, 20700))
        assertEquals(13, Versions.behind(20643, 20712))
        // A newer major is as far as it goes.
        assertEquals(Int.MAX_VALUE, Versions.behind(20643, 30000))
    }

    @Test
    fun pushedOnlyWhenUrgentFarBehindOrLeftWaiting() {
        assertFalse(PlayUpdatePolicy.pushed(20643, 20644, priority = 0, staleDays = 0))
        // A hand-uploaded release a dozen tags ahead is still only offered.
        assertFalse(PlayUpdatePolicy.pushed(20643, 20655, priority = 0, staleDays = 2))
        assertFalse(PlayUpdatePolicy.pushed(20643, 20700, priority = 3, staleDays = 6))
        assertTrue(PlayUpdatePolicy.pushed(20643, 20644, priority = 4, staleDays = 0))
        assertTrue(PlayUpdatePolicy.pushed(20643, 20644, priority = 5, staleDays = 0))
        assertTrue(PlayUpdatePolicy.pushed(20643, 20643 + PlayUpdatePolicy.FAR_BEHIND, priority = 0, staleDays = 0))
        assertTrue(PlayUpdatePolicy.pushed(20643, 30000, priority = 0, staleDays = 0))
        assertTrue(PlayUpdatePolicy.pushed(20643, 20644, priority = 0, staleDays = 7))
    }

    @Test
    fun theFlowFollowsWhatPlayAllows() {
        assertEquals(Type.FLEXIBLE, PlayUpdatePolicy.type(pushed = false, flexibleAllowed = true, immediateAllowed = true))
        assertEquals(Type.IMMEDIATE, PlayUpdatePolicy.type(pushed = true, flexibleAllowed = true, immediateAllowed = true))
        // Pushed, but Play allows only the flexible one: offered, not forced.
        assertEquals(Type.FLEXIBLE, PlayUpdatePolicy.type(pushed = true, flexibleAllowed = true, immediateAllowed = false))
        assertEquals(Type.IMMEDIATE, PlayUpdatePolicy.type(pushed = false, flexibleAllowed = false, immediateAllowed = true))
        assertEquals(Type.NONE, PlayUpdatePolicy.type(pushed = true, flexibleAllowed = false, immediateAllowed = false))
    }

    @Test
    fun askedAtMostOnceADay() {
        val now = 100 * day
        assertFalse(PlayUpdatePolicy.due(now - 60_000, now, PlayUpdatePolicy.ASK_EVERY_MS))
        assertFalse(PlayUpdatePolicy.due(now - day, now, PlayUpdatePolicy.ASK_EVERY_MS))
        assertTrue(PlayUpdatePolicy.due(now - day - 1, now, PlayUpdatePolicy.ASK_EVERY_MS))
        assertTrue(PlayUpdatePolicy.due(0, now, PlayUpdatePolicy.CHECK_EVERY_MS))
        // The clock set back: a time "in the future" counts as long ago.
        assertTrue(PlayUpdatePolicy.due(now + day, now, PlayUpdatePolicy.ASK_EVERY_MS))
    }

    @Test
    fun daysWaitedArePlaysOrOursWhicheverIsMore() {
        val now = 100 * day
        assertEquals(0, PlayUpdatePolicy.staleDays(null, 0, now))
        assertEquals(3, PlayUpdatePolicy.staleDays(3, 0, now))
        assertEquals(8, PlayUpdatePolicy.staleDays(2, now - 8 * day - 5, now))
        assertEquals(9, PlayUpdatePolicy.staleDays(9, now - 8 * day, now))
        // A first sighting "in the future" (the clock set back) counts nothing.
        assertEquals(0, PlayUpdatePolicy.staleDays(null, now + day, now))
    }

    @Test
    fun aDownloadNeverTakesTheScreenByItself() {
        // In the window: its card offers "Restart now".
        assertEquals(Downloaded.CARD, PlayUpdatePolicy.downloaded(windowVisible = true, appInFront = true, protectionOff = false))
        assertEquals(Downloaded.CARD, PlayUpdatePolicy.downloaded(windowVisible = true, appInFront = true, protectionOff = true))
        // Away from Shroudly with nothing to interrupt: Play installs it silently.
        assertEquals(Downloaded.INSTALL, PlayUpdatePolicy.downloaded(windowVisible = false, appInFront = false, protectionOff = true))
        // In Settings: installing would fill the screen; the window says so later.
        assertEquals(Downloaded.LATER, PlayUpdatePolicy.downloaded(windowVisible = false, appInFront = true, protectionOff = true))
        // Protection on: a notice, the user picks the moment.
        assertEquals(Downloaded.NOTICE, PlayUpdatePolicy.downloaded(windowVisible = false, appInFront = false, protectionOff = false))
        assertEquals(Downloaded.NOTICE, PlayUpdatePolicy.downloaded(windowVisible = false, appInFront = true, protectionOff = false))
    }

    @Test
    fun percentOfTheDownload() {
        assertEquals(0, PlayUpdatePolicy.percent(0, 0))
        assertEquals(50, PlayUpdatePolicy.percent(5, 10))
        assertEquals(100, PlayUpdatePolicy.percent(12, 10))
    }

    /* Play's library only in the bundle for Play: the APK's PlayUpdates
     * does nothing and no code shared by both names Play's classes. The two
     * PlayUpdates have the same calls. */
    @Test
    fun playsLibraryIsInThePlayBuildOnly() {
        val gradle = File("build.gradle.kts").readText()
        assertTrue(gradle.contains("""if (playBuild) implementation("com.google.android.play:app-update:2.1.0")"""))
        assertFalse(gradle.contains("app-update-ktx:"))
        assertTrue(gradle.contains("""kotlin.directories += if (playBuild) "src/play/kotlin" else "src/apk/kotlin""""))
        for (dir in listOf("src/main", "src/apk", "src/debug")) {
            File(dir).walkTopDown().filter { it.isFile && it.extension == "kt" }.forEach {
                assertFalse("${it.path} uses Google Play's library", it.readText().contains("com.google.android.play"))
            }
        }
        val calls = Regex("""^ {4}fun (\w+\(.*\))\s*\{""", RegexOption.MULTILINE)
        fun callsOf(path: String) = calls.findAll(File(path).readText()).map { it.groupValues[1].replace("PlayUpdatePolicy.Card", "Card") }.toSet()
        val apk = callsOf("src/apk/kotlin/me/codeshare/shroudly/PlayUpdates.kt")
        assertEquals(setOf(
            "resume(activity: Activity, mayAsk: () -> Boolean, show: (Card?) -> Unit)",
            "pause()", "offer(activity: Activity)", "install(activity: Activity)",
        ), apk)
        assertEquals(apk, callsOf("src/play/kotlin/me/codeshare/shroudly/PlayUpdates.kt"))
    }
}
