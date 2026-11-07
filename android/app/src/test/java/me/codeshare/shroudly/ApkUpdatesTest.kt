package me.codeshare.shroudly

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException

/* The APK from GitHub updates itself: a version found in the background is
 * said once; its APK comes from the release, else Shroudly's download
 * server; it is installed only if it is this app, newer, and signed with the
 * same certificate. None of it is in the copy for Google Play. */
class ApkUpdatesTest {
    @Test
    fun oneNotificationAVersion() {
        assertTrue(ApkUpdatePolicy.notifyFor("2.6.45", null, notificationsOn = true))
        assertFalse(ApkUpdatePolicy.notifyFor("2.6.45", "2.6.45", notificationsOn = true))
        assertTrue(ApkUpdatePolicy.notifyFor("2.6.46", "2.6.45", notificationsOn = true))
        // Notifications not allowed: none, and the version is not taken as said.
        assertFalse(ApkUpdatePolicy.notifyFor("2.6.46", "2.6.45", notificationsOn = false))
        assertFalse(ApkUpdatePolicy.notifyFor(null, null, notificationsOn = true))
    }

    @Test
    fun theReleaseThenTheMirror() {
        val gh = "https://github.com/umutxyp/Shroudly/releases/download/v2.6.45/Shroudly-2.6.45-Android.apk"
        val mirror = "https://shroudly.codeshare.me/dl/Shroudly-2.6.45-Android.apk"
        assertEquals(listOf(gh, mirror), ApkUpdatePolicy.sources(gh, "2.6.45"))
        // Found on the mirror already: once.
        assertEquals(listOf(mirror), ApkUpdatePolicy.sources(mirror, "2.6.45"))
        // A link from anywhere else is not followed.
        assertEquals(listOf(mirror), ApkUpdatePolicy.sources("https://evil.example/Shroudly.apk", "2.6.45"))
        assertEquals(listOf(mirror), ApkUpdatePolicy.sources(null, "v2.6.45"))
    }

    @Test
    fun redirectsOverHttpsOnly() {
        val from = "https://github.com/umutxyp/Shroudly/releases/download/v1/a.apk"
        assertEquals("https://objects.githubusercontent.com/x?y=1", ApkUpdatePolicy.redirect(from, "https://objects.githubusercontent.com/x?y=1", 0))
        assertEquals("https://github.com/b.apk", ApkUpdatePolicy.redirect(from, "/b.apk", 0))
        assertNull(ApkUpdatePolicy.redirect(from, "http://objects.githubusercontent.com/x", 0))
        assertNull(ApkUpdatePolicy.redirect(from, null, 0))
        assertNull(ApkUpdatePolicy.redirect(from, "https://objects.githubusercontent.com/x", 5))
    }

    @Test
    fun theSignatureCheck() {
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", ApkUpdatePolicy.sha256Hex("abc".toByteArray()))
        val ours = "23ac014b7226343b74c7c9c0a4fd6f1ded97518a3bfd35bcde65b6c1eca8bd76"
        assertTrue(ApkUpdatePolicy.sameSigner(listOf(ours), listOf(ours.uppercase())))
        assertFalse(ApkUpdatePolicy.sameSigner(listOf(ours), listOf("00".repeat(32))))
        // One more signer, or one missing: not the same.
        assertFalse(ApkUpdatePolicy.sameSigner(listOf(ours), listOf(ours, "00".repeat(32))))
        // Nothing read on either side: never the same.
        assertFalse(ApkUpdatePolicy.sameSigner(emptyList(), emptyList()))
        assertFalse(ApkUpdatePolicy.sameSigner(listOf(ours), emptyList()))
    }

    @Test
    fun onlyThisAppNewerAndSignedAsIt() {
        val pkg = "me.codeshare.shroudly"
        assertTrue(ApkUpdatePolicy.installable(pkg, 20645, pkg, 20644, sameSigner = true))
        assertFalse(ApkUpdatePolicy.installable(pkg, 20645, pkg, 20644, sameSigner = false))
        assertFalse(ApkUpdatePolicy.installable(pkg, 20644, pkg, 20644, sameSigner = true))
        assertFalse(ApkUpdatePolicy.installable("com.other", 20645, pkg, 20644, sameSigner = true))
        assertFalse(ApkUpdatePolicy.installable(null, -1, pkg, 20644, sameSigner = true))
    }

    /* The APK comes as it is read, by its length or in chunks, never more
     * than the cap, and a cut-off download is an error, not a short file. */
    @Test
    fun aLargeBodyAsItComes() {
        fun copy(raw: String, max: Long = 1000): String {
            val input = ByteArrayInputStream(raw.toByteArray(Charsets.ISO_8859_1))
            val head = Http1.head(input)
            val out = ByteArrayOutputStream()
            Http1.copyBody(input, head, out, max)
            return out.toString("ISO-8859-1")
        }
        assertEquals("hello", copy("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello"))
        assertEquals("hello world", copy("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n"))
        assertEquals("to the end", copy("HTTP/1.1 200 OK\r\n\r\nto the end"))
        assertTrue(runCatching { copy("HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nshort") }.exceptionOrNull() is IOException)
        assertTrue(runCatching { copy("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello", max = 4) }.exceptionOrNull() is IOException)
        assertTrue(runCatching { copy("HTTP/1.1 200 OK\r\n\r\ntoo long", max = 4) }.exceptionOrNull() is IOException)
        val head = Http1.head(ByteArrayInputStream("HTTP/1.1 302 Found\r\nLocation: https://x/y\r\n\r\n".toByteArray()))
        assertEquals(302, head.status)
        assertEquals("https://x/y", head.headers["location"])
    }

    /* Only the APK from GitHub: the permission and the installer's receiver
     * in its own manifest, added to that build alone; the copy for Play has
     * an empty ApkUpdates and no way to install anything. */
    @Test
    fun notInTheCopyForGooglePlay() {
        val main = File("src/main/AndroidManifest.xml").readText()
        assertFalse(main.contains("REQUEST_INSTALL_PACKAGES"))
        val apk = File("src/apk/AndroidManifest.xml").readText()
        assertTrue(apk.contains("android.permission.REQUEST_INSTALL_PACKAGES") && apk.contains(".UpdateInstallReceiver"))
        val gradle = File("build.gradle.kts").readText()
        assertTrue(gradle.contains("if (!playBuild) variant.sources.manifests?.addStaticManifestFile(\"src/apk/AndroidManifest.xml\")"))
        val play = File("src/play/kotlin/me/codeshare/shroudly/ApkUpdates.kt").readText()
        for (s in listOf("PackageInstaller", "REQUEST_INSTALL_PACKAGES", "openConnection", "getViaEngine", "startActivity")) assertFalse(s, play.contains(s))
        assertTrue(play.contains("fun available(ctx: Context): Boolean = false"))
        // The real one checks the signature before Android's installer gets it.
        val real = File("src/apk/kotlin/me/codeshare/shroudly/ApkUpdates.kt").readText().substringAfter("private fun run(")
        assertTrue(real.indexOf("if (!verified(ctx, file") in 0 until real.indexOf("install(ctx, file, version)"))
    }
}
