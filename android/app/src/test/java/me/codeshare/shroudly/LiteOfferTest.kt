package me.codeshare.shroudly

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/* The lite APK (no Tor): a site the full APK would take to Tor offers the
 * full APK instead (LiteOffer), installed over it at the same version; and
 * a report says which APK it came from and where Tor stands (Diagnostics). */
class LiteOfferTest {
    @Test
    fun whatTheFullApkWouldTakeToTor() {
        assertTrue(LiteOffer.wants("blocked", alert = false, stage = null))
        assertTrue(LiteOffer.wants("cut", alert = false, stage = null))
        assertTrue(LiteOffer.wants("unreachable", alert = false, stage = "connect"))
        assertTrue(LiteOffer.wants("unreachable", alert = false, stage = null))
        // The server refused by itself: not a block.
        assertFalse(LiteOffer.wants("blocked", alert = true, stage = null))
        // A name that does not resolve may not exist at all.
        assertFalse(LiteOffer.wants("unreachable", alert = false, stage = "dns"))
        assertFalse(LiteOffer.wants("bypass", alert = false, stage = null))
        assertFalse(LiteOffer.wants("send_failed", alert = false, stage = null))
    }

    @Test
    fun onceADayAndAWeekOfRestAfterNotNow() {
        val now = 1_800_000_000_000L
        assertTrue(LiteOffer.due(0L, now))
        assertFalse(LiteOffer.due(now - 60_000L, now))
        assertTrue(LiteOffer.due(now - LiteOffer.EVERY_MS, now))
        // A clock set back: said again.
        assertTrue(LiteOffer.due(now + 60_000L, now))
        assertFalse(LiteOffer.resting(0L, now))
        assertTrue(LiteOffer.resting(now - 3 * 24 * 3600_000L, now))
        assertFalse(LiteOffer.resting(now - LiteOffer.REST_MS, now))
        assertFalse(LiteOffer.resting(now + 60_000L, now))
    }

    @Test
    fun theFullApkOfTheSameVersion() {
        assertEquals("https://github.com/umutxyp/Shroudly/releases/download/v2.6.61/Shroudly-2.6.61-Android.apk", ApkUpdatePolicy.fullApkUrl("2.6.61"))
        assertEquals("https://github.com/umutxyp/Shroudly/releases/download/v2.6.61/Shroudly-2.6.61-Android.apk", ApkUpdatePolicy.fullApkUrl("v2.6.61"))
        val full = ApkUpdatePolicy.sources(ApkUpdatePolicy.fullApkUrl("2.6.61"), "2.6.61", "")
        assertEquals(listOf(ApkUpdatePolicy.fullApkUrl("2.6.61"), "https://shroudly.codeshare.me/dl/Shroudly-2.6.61-Android.apk"), full)
        // The lite APK's own updates stay lite.
        assertEquals("https://shroudly.codeshare.me/dl/Shroudly-2.6.61-Android-lite.apk", ApkUpdatePolicy.sources(null, "2.6.61", "lite").single())
        val p = "me.codeshare.shroudly"
        // Only the switch takes the same version; never an older one, never another signer.
        assertTrue(ApkUpdatePolicy.installable(p, 20661, p, 20661, sameSigner = true, sameVersion = true))
        assertFalse(ApkUpdatePolicy.installable(p, 20661, p, 20661, sameSigner = true))
        assertFalse(ApkUpdatePolicy.installable(p, 20660, p, 20661, sameSigner = true, sameVersion = true))
        assertFalse(ApkUpdatePolicy.installable(p, 20661, p, 20661, sameSigner = false, sameVersion = true))
        assertFalse(ApkUpdatePolicy.installable("other.app", 20661, p, 20661, sameSigner = true, sameVersion = true))
    }

    @Test
    fun theReportSaysWhichApkAndWhereTorStands() {
        assertEquals("full", Diagnostics.apkKind(""))
        assertEquals("lite, without Tor", Diagnostics.apkKind("lite"))
        assertEquals("arm64", Diagnostics.apkKind("arm64"))
        assertEquals("not in this copy", Diagnostics.torLine(false, true, false, "off", 0, 0))
        assertEquals("turned off in Settings", Diagnostics.torLine(true, false, false, "off", 0, 0))
        assertEquals("on; not allowed yet (asked when a site needs it); now off; 0 connections carried", Diagnostics.torLine(true, true, false, "off", 0, 0))
        assertEquals("on; allowed by the user; now starting (40%); 3 connections carried", Diagnostics.torLine(true, true, true, "starting", 40, 3))
    }
}
