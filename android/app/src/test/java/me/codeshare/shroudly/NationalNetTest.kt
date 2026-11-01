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
}
