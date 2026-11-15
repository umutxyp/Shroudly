package me.codeshare.shroudly

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/* The VPN's routes: everything but the local network and multicast
 * (casting to a TV, SR-EP2D), the engine's own addresses included. */
class TunnelRoutesTest {
    private fun n(a: String): Long = a.split('.').fold(0L) { acc, p -> (acc shl 8) or p.toLong() }
    private fun covered(ip: String): Boolean = TunnelConfig.routesV4().any { (a, len) ->
        val base = n(a); val size = 1L shl (32 - len); n(ip) in base until base + size
    }

    @Test fun theInternetAndTheEngineGoThrough() {
        for (ip in listOf("1.1.1.1", "8.8.8.8", "142.250.1.1", "198.18.0.1", "198.18.0.2", "198.19.200.5", "100.64.0.1", "223.255.255.255"))
            assertTrue(ip, covered(ip))
    }

    @Test fun theLocalNetworkAndMulticastStayOff() {
        for (ip in listOf("192.168.1.20", "10.0.0.5", "172.16.3.4", "172.31.255.1", "169.254.1.1", "224.0.0.251", "239.255.255.250", "255.255.255.255"))
            assertFalse(ip, covered(ip))
    }

    @Test fun noOverlapsAndFew() {
        val r = TunnelConfig.routesV4()
        assertTrue("${r.size} routes", r.size in 5..40)
        assertTrue(covered("172.15.255.255") && covered("172.32.0.0") && covered("11.0.0.0"))
    }
}
