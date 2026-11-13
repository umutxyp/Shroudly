package me.codeshare.shroudly

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/* The logos to choose between (Logos.kt): every one has its launcher alias
 * and its pictures, the classic one keeps the launcher entry every phone has
 * pinned (".MainActivity"), and the list is the desktop's and the Apple
 * apps' (scripts/logo/variants.py). */
class LogosTest {
    private val manifest = File("src/main/AndroidManifest.xml").readText()
    private val res = File("src/main/res")

    @Test
    fun theClassicLogoKeepsTheLauncherEntryPhonesHavePinned() {
        assertEquals(".MainActivity", Logos.alias("classic"))
        val classic = Regex("<activity-alias\\s+android:name=\"\\.MainActivity\"[\\s\\S]*?</activity-alias>").find(manifest)!!.value
        assertTrue("on unless something else is chosen", !classic.contains("android:enabled=\"false\""))
        assertTrue(classic.contains("android.intent.category.LAUNCHER") && classic.contains("android:targetActivity=\".HomeActivity\""))
        // Nothing opens the window by the alias: an alias that is off cannot be started.
        val code = File("src").walkTopDown().filter { it.extension == "kt" && !it.path.contains("/test/") }.joinToString("\n") { it.readText() }
        assertTrue(!code.contains("MainActivity::class.java"))
    }

    @Test
    fun everyLogoHasItsAliasAndItsPictures() {
        assertEquals(24, Logos.IDS.size)
        assertEquals(Logos.IDS.size, Logos.IDS.toSet().size)
        for (id in Logos.IDS) {
            if (id == "classic") continue
            val a = Regex("<activity-alias\\s+android:name=\"\\.Logo_$id\"[\\s\\S]*?</activity-alias>").find(manifest)?.value
            assertTrue("alias for $id", a != null && a.contains("android:enabled=\"false\"") && a.contains("@mipmap/ic_logo_$id") && a.contains("LAUNCHER"))
            assertTrue("icon for $id", File(res, "mipmap-anydpi/ic_logo_$id.xml").exists() && File(res, "drawable-nodpi/logo_${id}_fg.png").exists())
            assertTrue("picture for $id", File(res, "drawable-nodpi/logo_$id.png").exists())
        }
    }

    @Test
    fun theSameLogosAsTheDesktopAndTheAppleApps() {
        val desktop = File("../../electron/logos.js").readText()
        val script = File("../../scripts/logo/variants.py").readText()
        for ((group, ids) in Logos.GROUPS) {
            val list = ids.joinToString(", ") { "'$it'" }
            assertTrue("$group in electron/logos.js", desktop.contains("['$group', [$list]]"))
            assertTrue("$group in variants.py", script.contains("('$group', [$list])"))
        }
    }
}
