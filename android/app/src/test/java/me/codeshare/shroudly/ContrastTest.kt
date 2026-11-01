package me.codeshare.shroudly

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/* White text on an accent button reads at 4.5:1 (WCAG AA) on all of it, in
 * every accent: both ends of its fill. */
class ContrastTest {
    private fun channel(c: Int): Double {
        val v = c / 255.0
        return if (v <= 0.03928) v / 12.92 else Math.pow((v + 0.055) / 1.055, 2.4)
    }

    private fun luminance(argb: String): Double {
        val rgb = argb.removePrefix("#").takeLast(6).toInt(16)
        return 0.2126 * channel(rgb shr 16 and 255) + 0.7152 * channel(rgb shr 8 and 255) + 0.0722 * channel(rgb and 255)
    }

    @Test
    fun whiteOnEveryAccentButton() {
        val themes = File("src/main/res/values/themes.xml").readText()
        val colors = File("src/main/res/values/colors.xml").readText()
        val named = Regex("""<color name="(\w+)">(#[0-9A-Fa-f]{8})</color>""").findAll(colors).associate { it.groupValues[1] to it.groupValues[2] }
        val ends = Regex("""<item name="accentButton(?:Start|End)">([^<]+)</item>""").findAll(themes).map { it.groupValues[1] }.toList()
        assertTrue(ends.size >= 20)
        for (e in ends) {
            val hex = if (e.startsWith("@color/")) named.getValue(e.removePrefix("@color/")) else e
            val ratio = 1.05 / (luminance(hex) + 0.05)
            assertTrue("$e: ${"%.2f".format(ratio)}:1", ratio >= 4.5)
        }
    }
}
