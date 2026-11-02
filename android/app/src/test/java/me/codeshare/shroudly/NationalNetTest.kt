package me.codeshare.shroudly

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/* "Only this country's network works" (NationalNet): the first site inside
 * a country that answers names that country; none answering: nothing; the
 * guide in the app's language, Android's old codes for Hebrew and
 * Indonesian included, English for any other. */
class NationalNetTest {
    @Test
    fun firstThatAnswers() {
        val r = NationalNet.answers(null) { host -> host == "www.aparat.com" }
        assertEquals("IR" to "www.aparat.com", r)
    }

    @Test
    fun noneAnswering() {
        assertNull(NationalNet.answers(null) { false })
        assertNull(NationalNet.answers(null) { throw IllegalStateException("no network") })
    }

    @Test
    fun listed() {
        assertTrue(NationalNet.DOMESTIC.getValue("IR").size >= 3)
        assertTrue(NationalNet.DOMESTIC.values.all { l -> l.isNotEmpty() && l.all { Regex("^[a-z0-9.-]+\\.[a-z]{2,}$").matches(it) } })
    }

    @Test
    fun guide() {
        assertEquals("https://github.com/umutxyp/Shroudly/wiki/Shutdowns-fa", NationalNet.guideUrl("fa"))
        assertEquals("https://github.com/umutxyp/Shroudly/wiki/Shutdowns-he", NationalNet.guideUrl("iw"))
        assertEquals("https://github.com/umutxyp/Shroudly/wiki/Shutdowns-id", NationalNet.guideUrl("in"))
        assertEquals("https://github.com/umutxyp/Shroudly/wiki/Shutdowns-en", NationalNet.guideUrl("sw"))
    }

    @Test
    fun decoyNames() {
        // The country a shutdown showed first, else the time zone's.
        assertEquals("IR", NationalNet.homeCountry(null, "Asia/Tehran"))
        assertEquals("RU", NationalNet.homeCountry(null, "Asia/Vladivostok"))
        assertEquals("IR", NationalNet.homeCountry("IR", "Europe/Berlin"))
        assertEquals("AZ", NationalNet.homeCountry("ZZ", "Asia/Baku"))
        assertNull(NationalNet.homeCountry(null, "Europe/Berlin"))
        assertEquals(NationalNet.DOMESTIC.getValue("IR"), NationalNet.decoyNames("IR"))
        assertTrue(NationalNet.decoyNames(null).isEmpty() && NationalNet.decoyNames("ZZ").isEmpty())
        assertEquals(NationalNet.DOMESTIC.keys, NationalNet.ZONES.keys)
        // The engine gets them as --decoy-name, host names only; none, none.
        val a = Engine.args(1080, 0, emptyList(), decoyNames = listOf("divar.ir", "not a name", "www.aparat.com"))
        assertEquals(listOf("divar.ir", "www.aparat.com"), a.indices.filter { a[it] == "--decoy-name" }.map { a[it + 1] })
        assertTrue("--decoy-name" !in Engine.args(1080, 0, emptyList()))
    }
}
