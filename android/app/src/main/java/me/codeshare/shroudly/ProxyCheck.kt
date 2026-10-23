package me.codeshare.shroudly

import android.content.Context
import android.net.ConnectivityManager
import java.net.ConnectException
import java.net.InetSocketAddress
import java.net.Socket

/*
 * A network's proxy (Wi-Fi settings, the network, Proxy: Manual) that points
 * at a proxy on this phone where nothing runs: every app that uses the
 * network's proxy (Chrome among them) reaches nothing. Left by a proxy app
 * that has gone, or by Shroudly's own Proxy only once it is off
 * (127.0.0.1:10808). No app may change a network's proxy, so the user is
 * told and taken to the Wi-Fi settings (MainActivity, ShroudlyProxyService).
 */
object ProxyCheck {
    private fun loopback(host: String?) = host != null && (host.startsWith("127.") || host == "localhost" || host == "::1" || host == "[::1]")

    /* Each network's proxy, and the phone-wide one (set by a device
     * administrator or adb), on this phone: (host, port), each once. */
    @Suppress("DEPRECATION")
    fun localProxies(ctx: Context): List<Pair<String, Int>> {
        val cm = ctx.getSystemService(ConnectivityManager::class.java) ?: return emptyList()
        val nets = try { cm.allNetworks.toList() } catch (_: Exception) { emptyList() }
        val all = nets.mapNotNull { n -> try { cm.getLinkProperties(n)?.httpProxy } catch (_: Exception) { null } } +
            listOfNotNull(try { cm.defaultProxy } catch (_: Exception) { null })
        return all
            .filter { loopback(it.host) && it.port in 1..65535 }
            .map { it.host to it.port }
            .distinct()
    }

    /* Nothing listens on that port here: true; something does: false; it
     * cannot be told (no answer at all): null. Not on the main thread. */
    fun refused(port: Int): Boolean? = try {
        Socket().use { it.connect(InetSocketAddress("127.0.0.1", port), 400) }
        false
    } catch (_: ConnectException) {
        true
    } catch (_: Exception) {
        null
    }

    /* "host:port" of a network's proxy on this phone where nothing runs, or
     * null. Shroudly's own, while Proxy only runs on it, is never one. Not on
     * the main thread. */
    fun deadLocal(ctx: Context): String? {
        for ((host, port) in localProxies(ctx)) {
            if (Protection.proxyOnly && Protection.state == Protection.State.ON && port == Protection.socksPort) continue
            if (refused(port) == true) return "$host:$port"
        }
        return null
    }

    /* "host:port" of a network's proxy pointing at `port` here, or null. */
    fun pointsAt(ctx: Context, port: Int): String? = localProxies(ctx).firstOrNull { it.second == port }?.let { "${it.first}:${it.second}" }
}
