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
    }
}
