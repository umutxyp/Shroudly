package me.codeshare.shroudly

import android.net.LinkProperties
import java.net.Inet6Address
import java.net.InetAddress

/* What the network underneath the VPN offers. */
object Net {
    /* A global IPv6 address: not loopback, link-local, site-local or unique
     * local (fc00::/7). */
    fun isGlobalV6(a: InetAddress): Boolean {
        if (a !is Inet6Address) return false
        if (a.isLoopbackAddress || a.isLinkLocalAddress || a.isSiteLocalAddress || a.isAnyLocalAddress || a.isMulticastAddress) return false
        return (a.address[0].toInt() and 0xfe) != 0xfc
    }

    /* IPv6 is worth routing into the tunnel only when the real network can
     * carry it: a global address and an IPv6 default route. Otherwise apps
     * get "unreachable" at once and use IPv4, instead of an IPv6 connection
     * the tunnel accepts and the engine then cannot make. */
    fun hasIpv6(addresses: List<InetAddress>, v6DefaultRoute: Boolean): Boolean =
        v6DefaultRoute && addresses.any { isGlobalV6(it) }

    fun hasIpv6(lp: LinkProperties?): Boolean {
        if (lp == null) return false
        val route = lp.routes.any { it.isDefaultRoute && it.destination.address is Inet6Address }
        return hasIpv6(lp.linkAddresses.map { it.address }, route)
    }
}
