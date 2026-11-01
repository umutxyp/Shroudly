package me.codeshare.shroudly

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/* Google Play: whether Shroudly is on it right now (stores.json), and the
 * rating card in the copy Play installed: when it may show, and how long a
 * "no" keeps it away. */
class StoreCardsTest {
    private val day = 24L * 60 * 60 * 1000
    private val now = 1_800_000_000_000L
    private val installed = now - 10 * day

    @Test
    fun theFlag() {
        assertEquals(true, Stores.parsePlay("""{ "play": { "live": true }, "appStore": { "live": false }, "macAppStore": { "live": false } }"""))
        assertEquals(false, Stores.parsePlay("""{"play":{"live":false},"appStore":{"live":true}}"""))
        // Another store live, or no "play" at all: not Play.
        assertEquals(false, Stores.parsePlay("""{"appStore":{"live":true}}"""))
        assertEquals(false, Stores.parsePlay("""{"play":{}}"""))
        assertEquals(false, Stores.parsePlay("""{"play":{"live":"yes"}}"""))
        // Not the file (an error page): no answer.
        assertNull(Stores.parsePlay("<html>404</html>"))
        assertNull(Stores.parsePlay(""))
    }

    @Test
    fun aRecentAnswerOnly() {
        assertTrue(Stores.live(said = true, checkedAt = now - day, now = now))
        assertFalse(Stores.live(said = false, checkedAt = now - day, now = now))
        // Never fetched, or only long ago: not live, nothing shown.
        assertFalse(Stores.live(said = true, checkedAt = 0, now = now))
        assertFalse(Stores.live(said = true, checkedAt = now - Stores.VALID_MS, now = now))
        // A clock set back before the answer: unknown until asked again.
        assertFalse(Stores.live(said = true, checkedAt = now + day, now = now))
        assertTrue(Stores.due(checkedAt = now + day, triedAt = 0, now = now))
        // Asked every 12 hours, again an hour after a failure.
        assertFalse(Stores.due(checkedAt = now - 11 * 60 * 60 * 1000L, triedAt = 0, now = now))
        assertTrue(Stores.due(checkedAt = now - Stores.EVERY_MS, triedAt = 0, now = now))
        assertFalse(Stores.due(checkedAt = 0, triedAt = now - 10 * 60 * 1000L, now = now))
        assertTrue(Stores.due(checkedAt = 0, triedAt = now - Stores.RETRY_MS, now = now))
    }

    /* The file the app reads, as the repository serves it. */
    @Test
    fun theRepositorysFile() {
        val f = generateSequence(File("").absoluteFile) { it.parentFile }.map { File(it, "stores.json") }.first { it.exists() }
        val text = f.readText()
        assertEquals(true, Stores.parsePlay(text))
        for (k in listOf("\"play\"", "\"appStore\"", "\"macAppStore\"")) assertTrue(k, text.contains(k))
        assertEquals("https://raw.githubusercontent.com/umutxyp/Shroudly/main/stores.json", "https://${Stores.HOST}${Stores.PATH}")
    }

    private fun rate(s: StoreCards.State = StoreCards.State(), fromPlay: Boolean = true, live: Boolean = true, working: Boolean = true,
                     installedAt: Long = installed, days: Int = 5, at: Long = now) =
        StoreCards.rateDue(fromPlay, live, working, installedAt, days, s, at)

    @Test
    fun whenTheRatingCardMayShow() {
        assertTrue(rate())
        // Only the copy Google Play installed or updates.
        assertTrue(StoreCards.fromPlay(InstallSource.PLAY_STORE))
        assertFalse(StoreCards.fromPlay(null))
        assertFalse(StoreCards.fromPlay("com.google.android.packageinstaller"))
        assertFalse(rate(fromPlay = false))
        // Only while Shroudly is on Play, and while protection works.
        assertFalse(rate(live = false))
        assertFalse(rate(working = false))
        // Installed three days, protection worked on three days.
        assertFalse(rate(installedAt = now - 2 * day))
        assertTrue(rate(installedAt = now - 3 * day))
        assertFalse(rate(days = 2))
        assertTrue(rate(days = 3))
    }

    @Test
    fun eachNoDoublesTheWait() {
        var s = StoreCards.State()
        var at = now
        for (wait in listOf(14L, 28L, 56L, 112L, 224L)) {
            assertTrue(rate(s, at = at))
            s = StoreCards.rateShown(s, at)
            assertFalse(rate(s, at = at + wait * day - 1))
            assertTrue(rate(s, at = at + wait * day))
            at += wait * day
        }
        assertEquals(5, s.shown)
        // Rated: never again.
        val done = s.copy(done = true)
        assertFalse(rate(done, at = at + 1000 * day))
        // No overflow however many times.
        assertTrue(StoreCards.rateWaitMs(500) > 0)
    }

    @Test
    fun aClockSetBack() {
        val s = StoreCards.rateShown(StoreCards.State(), now)
        // Set back a year: the 14 days start over from then, neither early
        // nor never.
        val back = now - 365 * day
        val r = StoreCards.rebase(s, back)
        assertEquals(back, r.lastAt)
        assertEquals(back + 14 * day, r.nextAt)
        assertFalse(rate(r, installedAt = back - 10 * day, at = back + day))
        assertTrue(rate(r, installedAt = back - 10 * day, at = back + 14 * day))
        // Forward is no change.
        assertEquals(s, StoreCards.rebase(s, now + day))
    }

    private fun move(s: StoreCards.State = StoreCards.State(), fromPlay: Boolean = false, live: Boolean = true, playStore: Boolean = true,
                     working: Boolean = true, adBlock: Boolean = false, installedAt: Long = installed, days: Int = 5, at: Long = now) =
        StoreCards.moveDue(fromPlay, live, playStore, working, adBlock, installedAt, days, s, at)

    /* The suggestion to move to the copy from Google Play: in any other copy,
     * only while Play is live and the Play Store is there, never while the
     * ad blocker (which the Play copy lacks) is on, at a good moment. */
    @Test
    fun whenTheSuggestionMayShow() {
        assertTrue(move())
        // The copy from Play: nothing.
        assertFalse(move(fromPlay = true))
        // Play not live, or not known to be: nothing.
        assertFalse(move(live = false))
        assertFalse(move(playStore = false))
        assertFalse(move(working = false))
        assertFalse(move(adBlock = true))
        // Not on a new install.
        assertFalse(move(installedAt = now - day))
        assertFalse(move(days = 1))
        assertTrue(move(days = 2))
    }

    /* Twice at most: again 30 days after the first, never after the second;
     * "Open Google Play" ends it at once. */
    @Test
    fun twiceAtMost() {
        var s = StoreCards.State()
        assertTrue(move(s))
        s = StoreCards.moveShown(s, now)
        assertFalse(move(s, at = now + 29 * day))
        assertTrue(move(s, at = now + 30 * day))
        s = StoreCards.moveShown(s, now + 30 * day)
        assertFalse(move(s, at = now + 1000 * day))
        assertFalse(move(StoreCards.moveShown(StoreCards.State(), now).copy(done = true), at = now + 1000 * day))
        // A clock set back after the first: 30 days from then.
        val back = StoreCards.rebase(StoreCards.moveShown(StoreCards.State(), now), now - 365 * day)
        assertFalse(move(back, installedAt = now - 400 * day, at = now - 365 * day + 29 * day))
        assertTrue(move(back, installedAt = now - 400 * day, at = now - 365 * day + 30 * day))
    }

    /* The notification only when the window has not been opened for three
     * days (it counts as a showing). */
    @Test
    fun theNotificationOnlyForAWindowNotOpened() {
        assertFalse(StoreCards.windowIdle(now - 2 * day, now))
        assertTrue(StoreCards.windowIdle(now - 3 * day, now))
        assertTrue(StoreCards.windowIdle(0, now))
        assertTrue(StoreCards.windowIdle(now + day, now))
        val look = File("src/main/java/me/codeshare/shroudly/StoreCards.kt").readText().substringAfter("fun look(")
        assertTrue(look.indexOf("if (promptedThisRun || !windowIdle(") in 0 until look.indexOf("notify(NOTICE_ID, n)"))
        assertTrue(look.contains("save(ctx, MOVE, moveShown(load(ctx, MOVE, now), now))"))
        // The quiet channel: low importance, no sound, no heads-up.
        assertTrue(look.contains("Notification.Builder(ctx, ShroudlyVpnService.CHANNEL)"))
        for (name in listOf("ShroudlyVpnService.kt", "ShroudlyProxyService.kt")) {
            assertTrue(name, File("src/main/java/me/codeshare/shroudly/$name").readText().contains("StoreCards.look(this, port, "))
        }
    }

    /* Wired in: once a run, after the other cards, never beside one; the
     * button opens the Play page itself and ends it. */
    @Test
    fun wiredIn() {
        val main = File("src/main/java/me/codeshare/shroudly/MainActivity.kt").readText()
        val show = main.substringAfter("private fun showStoreCard(").substringBefore("\n    }\n")
        assertTrue(show.contains("if (StoreCards.promptedThisRun || !working) return"))
        // One a run: shown, it is the run's prompt.
        assertTrue(show.trimEnd().endsWith("StoreCards.promptedThisRun = true"))
        assertTrue(show.contains("if (listOf(notice, update, support).any { it.visibility == View.VISIBLE }) return"))
        assertTrue(main.contains("StoreCards.save(this, key, StoreCards.load(this, key).copy(done = true))"))
        assertTrue(main.contains("Stores.openPlay(this)"))
        assertFalse(main.contains("ReviewManager"))
        val stores = File("src/main/java/me/codeshare/shroudly/Stores.kt").readText()
        assertTrue(stores.contains("market://details?id=\$id") && stores.contains("https://play.google.com/store/apps/details?id=\$id"))
    }
}
