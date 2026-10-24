package me.codeshare.shroudly

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/* The Settings window's techniques are the desktop's, in its order, with the
 * same engine specs (components/SettingsPanel.js STRATEGIES), and the engine
 * is started with the one chosen. */
class AppSettingsTest {
    @Test
    fun theTechniquesAreTheDesktops() {
        val panel = generateSequence(File("").absoluteFile) { it.parentFile }
            .map { File(it, "components/SettingsPanel.js") }.first { it.exists() }.readText()
        val desktop = Regex("""\{ id: '([^']+)', labelKey: '([^']+)', spec: '([^']+)', auto: (true|false) \}""")
            .findAll(panel).map { AppSettings.Strategy(it.groupValues[1], it.groupValues[2], it.groupValues[3], it.groupValues[4] == "true") }.toList()
        assertEquals(desktop, AppSettings.STRATEGIES)
    }

    @Test
    fun anUnknownTechniqueIsAutomatic() {
        assertEquals("auto", AppSettings.byId(null).id)
        assertEquals("auto", AppSettings.byId("gone").id)
        assertEquals("disorder(sni)", AppSettings.byId("disorder-sni").spec)
    }

    @Test
    fun theEngineIsStartedWithTheTechnique() {
        val auto = Engine.args(1080, 5353, emptyList())
        assertEquals("split(sni)", auto[auto.indexOf("--strategy") + 1])
        assertTrue("automatic looks for what works", auto.contains("--auto"))
        val one = Engine.args(1080, 5353, emptyList(), strategy = AppSettings.byId("disorder-sni"))
        assertEquals("disorder(sni)", one[one.indexOf("--strategy") + 1])
        assertFalse("one technique for every site: no --auto", one.contains("--auto"))
        assertTrue("encrypted DNS either way", one.contains("--doh"))
        assertFalse(one.contains("--dns-strict"))
        assertTrue("only the user's DNS server", Engine.args(1080, 5353, emptyList(), dnsStrict = true).contains("--dns-strict"))
        assertFalse("nothing to be strict about without the forwarder", Engine.args(1080, 0, emptyList(), dnsStrict = true).contains("--dns-strict"))
    }

    /* Proxy only (#31) leaves the VPN slot to another app: the engine listens
     * on 127.0.0.1 alone, with no password and no stand-in range, and nothing
     * on that path asks Android for the VPN (VpnService.prepare would end the
     * other VPN app's connection). */
    @Test
    fun proxyOnlyNeverTouchesTheVpn() {
        val a = Engine.args(ShroudlyProxyService.PORT, 5353, emptyList(), null, null)
        assertEquals("127.0.0.1", a[a.indexOf("--listen") + 1])
        assertEquals(ShroudlyProxyService.PORT.toString(), a[a.indexOf("--port") + 1])
        assertFalse("no password", a.contains(SocksAuth.OPTION))
        assertFalse("no stand-in range", a.contains(Engine.FAKE_NET_OPTION))

        val src = generateSequence(File("").absoluteFile) { it.parentFile }
            .map { File(it, "android/app/src/main/java/me/codeshare/shroudly") }.first { it.isDirectory }
        val proxy = File(src, "ShroudlyProxyService.kt").readText()
        assertFalse("the proxy service never prepares the VPN", proxy.contains("prepare("))
        assertFalse("nor builds one", proxy.replace("NetworkRequest.Builder()", "").contains("Builder()"))
        val protector = File(src, "Protector.kt").readText().substringAfter("fun start(")
        assertTrue("proxy only starts before the VPN's start is reached",
            protector.indexOf("ShroudlyProxyService.start") in 0 until protector.indexOf("ShroudlyVpnService.start"))
        val consent = File(src, "MainActivity.kt").readText().substringAfter("private fun startWithConsent()")
        assertTrue("the window asks for the VPN only in VPN mode",
            consent.indexOf("needsVpnConsent") in 0 until consent.indexOf("VpnService.prepare"))
    }

    /* Automation apps (#32): another app turns protection on or off only
     * once the user has allowed it; the check comes before anything is done. */
    @Test
    fun automationAppsOnlyWhenAllowed() {
        val src = generateSequence(File("").absoluteFile) { it.parentFile }
            .map { File(it, "android/app/src/main") }.first { File(it, "AndroidManifest.xml").exists() }
        val receiver = File(src, "java/me/codeshare/shroudly/AutomationReceiver.kt").readText().substringAfter("override fun onReceive(")
        val gate = receiver.indexOf("AppSettings.remoteControl(context)")
        assertTrue("allowed or not is asked", gate > 0)
        assertTrue("before any start", gate < receiver.indexOf("Protector.start"))
        assertTrue("before any stop", gate < receiver.indexOf("Protector.stop"))
        val manifest = File(src, "AndroidManifest.xml").readText()
        for (a in listOf(AutomationReceiver.ACTION_START, AutomationReceiver.ACTION_STOP, AutomationReceiver.ACTION_TOGGLE)) {
            assertTrue("the manifest takes $a", manifest.contains("android:name=\"$a\""))
        }
    }
}
