package me.codeshare.shroudly

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/* "Share Shroudly" (ApkShare): the APK goes only to the app the user picks,
 * for that once (a provider no other app can open by itself), read-only,
 * and only from the copy from GitHub, whose one file installs anywhere; the
 * row is shown only where there is such a file. */
class ApkShareTest {
    private val manifest = File("src/main/AndroidManifest.xml").readText()
    private val share = File("src/main/java/me/codeshare/shroudly/ApkShare.kt").readText()
    private val main = File("src/main/java/me/codeshare/shroudly/MainActivity.kt").readText()

    @Test
    fun onlyToTheAppChosen() {
        val p = Regex("""<provider[^>]*android:name="\.ApkProvider"[^>]*/>""").find(manifest)?.value ?: ""
        assertTrue(p, p.contains("android:exported=\"false\"") && p.contains("android:grantUriPermissions=\"true\"") && p.contains("\${applicationId}.apk"))
        assertTrue(share.contains("Intent.FLAG_GRANT_READ_URI_PERMISSION"))
        assertTrue("read only", share.contains("if (mode != \"r\") throw") && share.contains("ParcelFileDescriptor.MODE_READ_ONLY"))
        val writes = share.lines().filter { Regex("""override fun (insert|update|delete)\(""").containsMatchIn(it) }
        assertTrue("nothing written: $writes", writes.size == 3 && writes.all { it.trimEnd().endsWith("= null") || it.trimEnd().endsWith("= 0") })
    }

    @Test
    fun onlyTheGithubCopy() {
        assertTrue(share.contains("!BuildConfig.STORE_BUILD && ctx.applicationInfo.splitSourceDirs.isNullOrEmpty()"))
        assertTrue("the provider asks the same", share.contains("if (!ApkShare.available(ctx)) throw"))
        assertTrue("the row only where it can be shared", main.contains("visibility = if (apk) View.VISIBLE else View.GONE"))
        assertTrue(ApkShare.fileName().matches(Regex("""Shroudly-[\w.-]+\.apk""")))
    }
}
