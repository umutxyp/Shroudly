package me.codeshare.shroudly

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/* The Tor configuration, as the desktop's (tests/net/tor-route.test.js). */
class TorRouteTest {
    @Test
    fun thisCountrysBridgesComeFirstWhenTheBundlesAreBlocked() {
        // As shroudly.codeshare.me/v1/bridges answers for Russia (read with
        // Android's org.json, which these JVM tests do not have).
        val c = mapOf(
            "webtunnel" to listOf("webtunnel [2001:db8::1]:443 FFFF url=https://w.example/x ver=0.0.1", "bad\nline"),
            "obfs4" to listOf("obfs4 198.51.100.7:4444 BBBB cert=y iat-mode=0"),
            "other" to listOf("x"),
        )
        val bundled = mapOf("obfs4" to listOf("obfs4 203.0.113.1:443 A cert=x iat-mode=0"), "snowflake" to listOf("snowflake 192.0.2.3:80 X"))
        val m = TorRoute.mergeBridges(c, bundled)
        assertEquals(listOf("webtunnel", "obfs4", "snowflake"), m.keys.toList())
        assertEquals(listOf("obfs4 198.51.100.7:4444 BBBB cert=y iat-mode=0", "obfs4 203.0.113.1:443 A cert=x iat-mode=0"), m["obfs4"])
        assertTrue(m["webtunnel"]!!.none { it.contains("bad") })
        val rc = TorRoute.torrc(9050, "/d", "/l", m, "country", 1)
        assertTrue(rc, rc.contains("ClientTransportPlugin webtunnel,obfs4,snowflake exec /l"))
        assertTrue(rc.indexOf("Bridge webtunnel") < rc.indexOf("Bridge obfs4 198.51.100.7"))
        assertTrue(rc.indexOf("Bridge obfs4 198.51.100.7") < rc.indexOf("Bridge obfs4 203.0.113.1"))
        assertTrue(TorRoute.mergeBridges(null, emptyMap()).isEmpty())
    }
}
