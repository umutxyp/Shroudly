package me.codeshare.shroudly

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/* Settings for someone who knows nothing: what anyone may want first, the
 * rest folded under "Advanced"; words, not the engine's code; a mode change
 * that takes effect; the apps list usable on any screen; and the main
 * window with its settings at the top and nothing it does not show. */
class SettingsTest {
    private val src = File("src/main")
    private val settings = File(src, "java/me/codeshare/shroudly/SettingsActivity.kt").readText()
    private val layout = File(src, "res/layout/activity_settings.xml").readText()

    @Test
    fun whatAnyoneMayWantComesFirst() {
        val order = listOf("@+id/language", "@+id/accents", "@+id/excludedApps", "@+id/startAtBoot", "@+id/shareOnlineCount",
            "@+id/adBlock", "@+id/advanced", "@+id/advancedBox", "@+id/mode", "@+id/strategy", "@+id/dnsServer", "@+id/quicOff", "@+id/remoteControl")
        val at = order.map { layout.indexOf(it) }
        assertTrue(order.zip(at).toString(), at.all { it > 0 } && at == at.sorted())
        // Folded away, open by itself when something in it is set.
        assertTrue(Regex("""android:id="@\+id/advancedBox"[^>]*android:visibility="gone"""").containsMatchIn(layout))
        assertTrue(settings.contains("if (advancedSet()) box.visibility = View.VISIBLE"))
        // No row's icon stands for two unrelated things.
        val icons = Regex("""android:drawableStart="@drawable/(row_\w+)"""").findAll(layout).map { it.groupValues[1] }.toList()
        assertTrue(icons.toString(), icons.size == icons.toSet().size)
    }

    @Test
    fun wordsNotCode() {
        assertFalse("the engine's spec is no explanation", settings.contains("s.spec"))
        assertTrue(settings.contains("if (s.auto) ifOpen(R.id.strategyTitle, getString(R.string.androidStrategyDesc)) else null"))
    }

    /* A new mode while protection is on starts it again in that mode (the VPN's
     * consent first where needed, the old mode kept if it is refused). */
    @Test
    fun aNewModeTakesEffect() {
        assertFalse(settings.contains("androidModeNextStart"))
        assertTrue(settings.contains("Protector.restart(this)"))
        assertTrue(settings.contains("if (resultCode == RESULT_OK) switchMode(false) else checkMode(true)"))
        val protector = File(src, "java/me/codeshare/shroudly/Protector.kt").readText().substringAfter("fun restart(")
        assertTrue(protector.indexOf("Protection.listen(once)") in 0 until protector.indexOf("stop(app)"))
        // Proxy only has no apps list of its own.
        assertTrue(settings.contains("row.text = titled(getString(R.string.excludedApps), getString(R.string.androidAppsVpnOnly))"))
    }

    @Test
    fun theAppsListFitsAnyScreen() {
        val pick = settings.substringAfter("private fun pickApps()").substringBefore("\n    }\n")
        assertTrue(pick.contains("list.addHeaderView("))
        assertTrue(pick.contains("addView(list, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))"))
        assertFalse(pick.contains("heightPixels"))
        assertTrue(pick.contains("shown.getOrNull(position - list.headerViewsCount)"))
    }

    /* The swatches: in rows (none hidden off screen), each said as which of
     * how many, the chosen one as selected. The DNS field's example reads as
     * an example. */
    @Test
    fun swatchesAndHints() {
        assertFalse(layout.contains("HorizontalScrollView"))
        assertTrue(settings.contains("contentDescription = text(R.string.androidAccentSwatch, \"n\" to i + 1, \"total\" to Accent.OPTIONS.size)"))
        assertTrue(settings.contains("isSelected = o.id == chosen"))
        // Pressed, it shows: a round ripple on the swatch.
        assertTrue(settings.contains("android.graphics.drawable.ShapeDrawable(android.graphics.drawable.shapes.OvalShape())"))
        assertTrue(settings.substringAfter("private fun pickDns()").contains("setHintTextColor(getColor(R.color.text_faint))"))
    }

    @Test
    fun theMainWindow() {
        val main = File(src, "res/layout/activity_main.xml").readText()
        // The desktop's frame: its top (logo, name, status) and the six tabs,
        // Settings among them (Chrome.kt), around the tabs' pages.
        assertTrue(main.indexOf("@+id/headerHost") in 0 until main.indexOf("@+id/pageHome"))
        assertTrue(main.indexOf("@+id/pageHome") < main.indexOf("@+id/toggle") && main.contains("@+id/bottomHost"))
        val chrome = File(src, "java/me/codeshare/shroudly/Chrome.kt").readText()
        assertTrue(chrome.contains("SETTINGS(R.drawable.ic_settings_accent, R.string.navSettings)") && chrome.contains("R.string.footerProduct"))
        // The app's own switches are in Settings now; the live total shows.
        assertFalse(main.contains("@+id/shareOnlineCount") || main.contains("@+id/adBlock\""))
        assertTrue(main.contains("@+id/onlineNow"))
        val code = File(src, "java/me/codeshare/shroudly/MainActivity.kt").readText()
        assertTrue(code.contains("val online = OnlineCount.online()"))
    }
}
