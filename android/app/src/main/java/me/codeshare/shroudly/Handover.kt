package me.codeshare.shroudly

import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest

/*
 * The phone moving to another network while protection is on, and what
 * becomes of what apps had opened over the old one (ShroudlyVpnService,
 * ShroudlyProxyService).
 *
 * The move is not always a network coming or going. With "Mobile data always
 * active" (on by default on most phones) mobile data stays up beside Wi-Fi.
 * Walking out of the Wi-Fi's range, or with its router's line down, Wi-Fi
 * stays joined while Android finds it no longer reaches the internet (it
 * loses VALIDATED, or its score drops) and makes mobile data the phone's
 * network. A callback on every network hears nothing of that: mobile data
 * was already there and Wi-Fi did not go. Up to 2.6.43 that move went
 * unseen, and apps waited on connections over the dead Wi-Fi until their own
 * heartbeat gave up. So the services also listen to the phone's default
 * network (Android's callback for it: this app is left out of its own VPN,
 * so that is the real one), and to a network gaining or losing VALIDATED
 * (NetWatch).
 *
 * What was opened over the old network is ended, and apps connect again over
 * the new one, unless it still works where it is: the old network still up,
 * still validated, and left only because Android prefers the new one (mobile
 * data kept on beside a Wi-Fi the phone has just joined; a call or a
 * download goes on). Kept, it is ended once that network goes or stops
 * reaching the internet. Wi-Fi is left for mobile data only once it has gone
 * bad, even while Android still shows it as validated: ended at once.
 */
object Handover {
    /* A network as these decisions see it: still there (not lost), reaching
     * the internet when Android last checked (VALIDATED), and how Android
     * prefers it (rank). */
    data class Look(val there: Boolean, val validated: Boolean, val rank: Int)

    private val GONE = Look(there = false, validated = false, rank = -1)

    /* Android's order: wired first, then Wi-Fi, mobile data last. */
    fun rank(ethernet: Boolean, wifi: Boolean, cellular: Boolean): Int = when {
        ethernet -> 3
        wifi -> 2
        cellular -> 0
        else -> 1
    }

    fun look(cm: ConnectivityManager, net: Network?): Look {
        val caps = try { net?.let { cm.getNetworkCapabilities(it) } } catch (_: Exception) { null } ?: return GONE
        return Look(true, caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED), rank(caps))
    }

    private fun rank(caps: NetworkCapabilities) = rank(
        caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET),
        caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI),
        caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR),
    )

    /* Moved from `old` (null: from no network at all) to `now`: whether
     * what apps opened over `old` is ended now. */
    fun endsOld(old: Look?, now: Look): Boolean =
        old == null || !old.there || !old.validated || now.rank <= old.rank

    /* A network whose connections were kept (endsOld false): they are ended
     * once it is gone or no longer validated. */
    fun keptEnds(kept: Look): Boolean = !kept.there || !kept.validated

    /* Whether the VPN interface is made again for IPv6 (wanted: the network
     * has it and it is not turned off; routed: the interface carries it),
     * which ends every connection apps have through the tunnel. IPv6 gone:
     * at once, or apps' IPv6 would go into a tunnel that cannot carry it.
     * IPv6 come: only when apps' connections are being ended anyway (ending),
     * else it waits for that. It often arrives seconds after the network
     * itself (the router's advertisement after DHCP), and up to 2.6.44 it
     * cost a second end of everything right after a move, the connections
     * kept on the old network included. Meanwhile apps use IPv4, which
     * reaches every site: each name they look up through the tunnel gets an
     * IPv4 stand-in (TunnelConfig), and the engine itself uses IPv6 where
     * the network has it. */
    fun renewsForV6(wanted: Boolean, routed: Boolean, ending: Boolean): Boolean =
        wanted != routed && (!wanted || ending)

    /* What of a network's capabilities matters here: its kind and whether it
     * reaches the internet. Not its signal strength or speed, which the same
     * callback reports all the time: each report puts the services' look
     * off by a moment (NET_SETTLE_MS), and it would never come. */
    fun key(net: Network, caps: NetworkCapabilities): String =
        "$net ${rank(caps)} ${caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)} ${caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)}"
}

/*
 * How a service follows the networks: a callback on every network that could
 * be underneath (with internet, not a VPN), and one on the phone's default
 * network, which alone hears Android move from one network to another that
 * was already up (Handover). Their calls run on the service's own thread
 * (`post`): `came` and `went` for its set of networks, `changed` for
 * anything that may have moved the phone, which the service looks at once
 * things have settled.
 */
class NetWatch(
    private val post: (() -> Unit) -> Unit,
    private val came: (Network) -> Unit,
    private val went: (Network) -> Unit,
    private val changed: () -> Unit,
) {
    // Handover.key as last seen, per network and for the default one; only
    // touched on the service's thread.
    private val seen = HashMap<Network, String>()
    private var defaultSeen: String? = null

    private val each = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(net: Network) = post { came(net); changed() }
        override fun onCapabilitiesChanged(net: Network, caps: NetworkCapabilities) {
            val k = Handover.key(net, caps)
            post { if (seen.put(net, k) != k) changed() }
        }
        override fun onLinkPropertiesChanged(net: Network, lp: LinkProperties) = post { changed() }
        // Android lets go of it soon (another network is preferred).
        override fun onLosing(net: Network, maxMsToLive: Int) = post { changed() }
        override fun onLost(net: Network) = post { seen.remove(net); went(net); changed() }
    }

    private val default = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(net: Network) = post { changed() }
        override fun onCapabilitiesChanged(net: Network, caps: NetworkCapabilities) {
            val k = Handover.key(net, caps)
            post { if (k != defaultSeen) { defaultSeen = k; changed() } }
        }
        override fun onLost(net: Network) = post { defaultSeen = null; changed() }
    }

    private var registered = 0

    /* Null once both follow; else why not (each that could is kept). */
    fun start(cm: ConnectivityManager): String? {
        val request = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)
            .build()
        var why: String? = null
        try { cm.registerNetworkCallback(request, each); registered = registered or 1 } catch (e: Exception) { why = e.message ?: e.javaClass.simpleName }
        try { cm.registerDefaultNetworkCallback(default); registered = registered or 2 } catch (e: Exception) { why = e.message ?: e.javaClass.simpleName }
        return why
    }

    fun stop(cm: ConnectivityManager) {
        if (registered and 1 != 0) try { cm.unregisterNetworkCallback(each) } catch (_: Exception) {}
        if (registered and 2 != 0) try { cm.unregisterNetworkCallback(default) } catch (_: Exception) {}
        registered = 0
    }
}
