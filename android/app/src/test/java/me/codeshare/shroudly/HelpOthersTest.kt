package me.codeshare.shroudly

import org.junit.Assert.assertEquals
import org.junit.Test

/* "Help people in censored countries": Conduit's page in the app's
 * language where its site has it, English otherwise; Orbot on Google Play. */
class HelpOthersTest {
    @Test
    fun pages() {
        assertEquals("https://conduit.psiphon.ca/fa/download", HelpOthers.conduitUrl("fa"))
        assertEquals("https://conduit.psiphon.ca/tr/download", HelpOthers.conduitUrl("tr"))
        assertEquals("https://conduit.psiphon.ca/en/download", HelpOthers.conduitUrl("am"))
        assertEquals("https://conduit.psiphon.ca/en/download", HelpOthers.conduitUrl(""))
        assertEquals("https://play.google.com/store/apps/details?id=org.torproject.android", HelpOthers.orbotUrl())
    }
}
