package me.codeshare.shroudly

import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Build
import java.net.Inet4Address
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

    /* The network in a few words, for the log and "Share logs": no address,
     * nothing that identifies the user. */
    data class Summary(
        val kind: String,
        val validated: Boolean,
        val ipv4: Boolean,
        val ipv6: Boolean,
        /* 464XLAT: the network is IPv6 only and Android translates IPv4 into
         * it (null: Android too old to say). */
        val nat64: Boolean?,
        /* not in use, automatic, strict (with the name), or null: Android too old. */
        val privateDns: String?,
        val metered: Boolean,
        val mtu: Int,
    ) {
        override fun toString() = buildString {
            append(kind)
            if (kind == "none") return@buildString
            append(if (validated) ", validated" else ", not validated")
            append(", IPv4 ").append(if (ipv4) "yes" else "no")
            append(", IPv6 ").append(if (ipv6) "yes" else "no")
            if (nat64 != null) append(", 464XLAT ").append(if (nat64) "yes" else "no")
            if (privateDns != null) append(", Private DNS ").append(privateDns)
            if (metered) append(", metered")
            if (mtu > 0) append(", MTU ").append(mtu)
        }
    }

    /* `net`: the network to describe; this app's default one when null. */
    fun summary(cm: ConnectivityManager, netGiven: Network? = null, lpGiven: LinkProperties? = null): Summary {
        val net = netGiven ?: cm.activeNetwork
        val caps = net?.let { cm.getNetworkCapabilities(it) }
        val lp = lpGiven ?: net?.let { cm.getLinkProperties(it) }
        if (caps == null || lp == null) return Summary("none", false, false, false, null, null, false, 0)
        val kind = when {
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "Wi-Fi"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "mobile data"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "Ethernet"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_BLUETOOTH) -> "Bluetooth"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> "VPN"
            else -> "other"
        }
        val addrs = lp.linkAddresses.map { it.address }
        val v4 = addrs.any { it is Inet4Address && !it.isLinkLocalAddress && !it.isLoopbackAddress }
        val nat64 = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) lp.nat64Prefix != null else null
        val pdns = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            when {
                !lp.isPrivateDnsActive -> "not in use"
                lp.privateDnsServerName != null -> "strict (${lp.privateDnsServerName})"
                else -> "automatic"
            }
        } else {
            null
        }
        return Summary(
            kind = kind,
            validated = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED),
            ipv4 = v4,
            ipv6 = hasIpv6(lp),
            nat64 = nat64,
            privateDns = pdns,
            metered = !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED),
            mtu = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) lp.mtu else 0,
        )
    }

    fun describe(cm: ConnectivityManager, net: Network? = null, lp: LinkProperties? = null): String = try {
        summary(cm, net, lp).toString()
    } catch (e: Exception) {
        "unknown ($e)"
    }
}
