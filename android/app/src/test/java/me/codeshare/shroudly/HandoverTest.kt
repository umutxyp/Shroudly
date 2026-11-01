package me.codeshare.shroudly

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/* The phone moving to another network while protection is on (Handover):
 * heard even when no network comes or goes, and what apps opened over the
 * old one ended unless it still works there. */
class HandoverTest {
    private val wifi = Handover.rank(ethernet = false, wifi = true, cellular = false)
    private val mobile = Handover.rank(ethernet = false, wifi = false, cellular = true)
    private val wired = Handover.rank(ethernet = true, wifi = false, cellular = false)

    @Test
    fun androidsOrder() {
        assertTrue(wired > wifi && wifi > mobile)
        assertTrue(Handover.rank(ethernet = false, wifi = false, cellular = false) in (mobile + 1) until wifi)
    }

    @Test
    fun whatWasOpenedOverTheOldNetworkIsEndedUnlessItStillWorks() {
        val wifiUp = Handover.Look(there = true, validated = true, rank = wifi)
        val mobileUp = Handover.Look(there = true, validated = true, rank = mobile)
        // Wi-Fi out of range but still joined: no longer validated.
        assertTrue(Handover.endsOld(wifiUp.copy(validated = false), mobileUp))
        // Wi-Fi left for mobile data while Android still shows it validated
        // (its score dropped): it went bad all the same.
        assertTrue(Handover.endsOld(wifiUp, mobileUp))
        // Wi-Fi gone.
        assertTrue(Handover.endsOld(wifiUp.copy(there = false), mobileUp))
        // One Wi-Fi for another.
        assertTrue(Handover.endsOld(wifiUp, wifiUp))
        // Back after no network at all.
        assertTrue(Handover.endsOld(null, wifiUp))
        // Mobile data kept on beside a Wi-Fi just joined: a call or a
        // download over mobile data goes on.
        assertFalse(Handover.endsOld(mobileUp, wifiUp))
        // ...unless mobile data had stopped reaching the internet.
        assertTrue(Handover.endsOld(mobileUp.copy(validated = false), wifiUp))
        // Kept that way, ended once it goes or stops working.
        assertFalse(Handover.keptEnds(mobileUp))
        assertTrue(Handover.keptEnds(mobileUp.copy(validated = false)))
        assertTrue(Handover.keptEnds(mobileUp.copy(there = false)))
    }

    /* IPv6 that goes is taken off the interface at once; IPv6 that comes
     * (often seconds after the network) waits until apps' connections end
     * anyway, so a move costs at most one end of everything, and none at
     * all where the old network still works. */
    @Test
    fun ipv6ThatComesWaitsForTheNextEnd() {
        // Gone: at once, whether or not the connections end anyway.
        assertTrue(Handover.renewsForV6(wanted = false, routed = true, ending = false))
        assertTrue(Handover.renewsForV6(wanted = false, routed = true, ending = true))
        // Come: along with an end anyway, never on its own.
        assertTrue(Handover.renewsForV6(wanted = true, routed = false, ending = true))
        assertFalse(Handover.renewsForV6(wanted = true, routed = false, ending = false))
        // Unchanged: never.
        for (v6 in listOf(true, false)) for (ending in listOf(true, false)) {
            assertFalse(Handover.renewsForV6(wanted = v6, routed = v6, ending = ending))
        }
    }

    /* Wired in, in both modes: both callbacks (the default network's alone
     * hears Android move to a network that was already up), and the
     * capabilities looked at only when what matters changed, so a stream of
     * signal-strength reports never keeps putting the look off. */
    @Test
    fun bothModesFollowTheDefaultNetwork() {
        val src = File("src/main/java/me/codeshare/shroudly")
        val watch = File(src, "Handover.kt").readText()
        assertTrue(watch.contains("cm.registerDefaultNetworkCallback(default)"))
        assertTrue(watch.contains("cm.registerNetworkCallback(request, each)"))
        assertTrue(watch.contains("post { if (seen.put(net, k) != k) changed() }"))
        assertTrue(watch.contains("post { if (k != defaultSeen) { defaultSeen = k; changed() } }"))
        assertTrue(watch.contains("override fun onLosing(net: Network, maxMsToLive: Int) = post { changed() }"))
        val key = watch.substringAfter("fun key(net: Network, caps: NetworkCapabilities): String =").substringBefore("\n}")
        assertFalse(key.contains("SignalStrength") || key.contains("Bandwidth"))

        val vpn = File(src, "ShroudlyVpnService.kt").readText()
        assertTrue(vpn.contains("NetWatch(::later, { networks += it }, { networks -= it }, ::onNetwork)"))
        // Read by the path checks on their own thread too.
        assertTrue(vpn.contains("private val networks = java.util.concurrent.CopyOnWriteArraySet<Network>()"))
        val settled = vpn.substringAfter("private fun onNetworkSettled()").substringBefore("\n    }\n")
        assertTrue(settled.contains("!Handover.endsOld(Handover.look(cm, old), Handover.look(cm, now.first))"))
        assertTrue(settled.contains("if (keptGone.isNotEmpty()) endOldConnections("))
        assertTrue(settled.contains("val ending = (changed || keptGone.isNotEmpty()) && !keepOld"))
        assertTrue(settled.contains("if (Handover.renewsForV6(routesV6(v6), v6Routed, ending)) {"))
        assertTrue(settled.contains("if (ending) endOldConnections()"))
        // IPv6 that came meanwhile comes with the next end of the connections.
        val ends = vpn.substringAfter("private fun endOldConnections(").substringBefore("\n    }\n")
        assertTrue(ends.contains("if (routesV6(underlyingV6) != v6Routed) {\n            renewInterface(routesV6(underlyingV6))"))

        val proxy = File(src, "ShroudlyProxyService.kt").readText()
        assertTrue(proxy.contains("NetWatch(::later, {\n            networks += it\n"))
        val proxySettled = proxy.substringAfter("private fun onNetworkSettled()").substringBefore("\n    }\n")
        assertTrue(proxySettled.contains("doh?.networkChanged()"))
        assertTrue(proxySettled.contains("Handover.endsOld(Handover.look(cm, old), Handover.look(cm, now))"))
        assertEquals(1, Regex("""restartEngine\("restarted on its port, so apps' connections end"\)""").findAll(proxy).count())
    }
}
