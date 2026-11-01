package me.codeshare.shroudly

import android.content.Context
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket

/*
 * Proxy only's port on this phone (ShroudlyProxyService). Apps are pointed at
 * it by hand (the Wi-Fi network's proxy, an app's own proxy setting), so it
 * stays the same from one start to the next: the one used last, kept here.
 * Another app may hold it: v2rayNG's own proxy listens on 10808 too, and
 * v2rayNG is the other VPN most often run beside Proxy only (issue #31).
 * Then the next free port close by is taken and kept, as on the desktop
 * (electron/engine-manager.js pickPort), and the window and the notice say
 * which (androidProxyOnlyMoved). Up to 2.6.43 it never moved: a check the
 * wrong way round ended every start while 10808 was held, with "Protection
 * stopped because of an error".
 */
object ProxyPort {
    const val DEFAULT = 10808
    private const val NEARBY = 20
    private const val PREFS = "settings"
    private const val KEY = "proxyPort"

    /* The port asked for first: the one used last, else DEFAULT. */
    fun remembered(ctx: Context): Int =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getInt(KEY, DEFAULT).takeIf { it in 1..65535 } ?: DEFAULT

    fun remember(ctx: Context, port: Int) {
        if (port in 1..65535) ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putInt(KEY, port).apply()
    }

    /* For the window and Settings: the port it listens on while on, else
     * the one it will ask for first. */
    fun shown(ctx: Context): Int = if (Protection.proxyOnly && Protection.socksPort > 0) Protection.socksPort else remembered(ctx)

    /* Where apps are to be pointed while it is on (the window and the
     * notice): the port, and which app held the one it asked for. */
    fun onText(ctx: Context, port: Int): String {
        val taken = Protection.proxyPortTaken
        return if (taken > 0 && taken != port) ctx.text(R.string.androidProxyOnlyMoved, "taken" to taken, "port" to port)
        else ctx.text(R.string.androidProxyOnlyOn, "port" to port)
    }

    /* Shroudly's own: the port it listens on or asks for first, or
     * DEFAULT, where it listened before it had to move. */
    fun ours(ctx: Context, port: Int): Boolean =
        port == DEFAULT || port == remembered(ctx) || (Protection.proxyOnly && port == Protection.socksPort)

    /* `first`, then the ports right after it. */
    fun candidates(first: Int): List<Int> = (first..first + NEARBY).filter { it in 1..65535 }

    /* Nothing listens on 127.0.0.1:port here right now. Bound as the engine
     * binds (SO_REUSEADDR), so a port its last run left connections in
     * TIME_WAIT on counts as free, as it is for the engine. */
    fun free(port: Int): Boolean = try {
        ServerSocket().use {
            it.reuseAddress = true
            it.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), port))
        }
        true
    } catch (_: Exception) {
        false
    }

    /* How one start of the engine on a port went. */
    data class Tried(val ok: Boolean, val stillRunning: Boolean = false, val error: String? = null)

    /* The first of `ports` the engine listens on. The next one is tried only
     * when this one is taken (the engine's "listen failed",
     * core/src/main.c); any other failure, or an engine that did not stop
     * after it, ends the start. */
    fun listenOn(ports: Sequence<Int>, start: (Int) -> Tried): Int {
        for (p in ports) {
            val t = start(p)
            if (t.ok) return p
            val err = t.error ?: "the engine did not start"
            if (t.stillRunning) throw IllegalStateException("the engine did not stop after a failed start: $err")
            if (!err.contains("listen failed")) throw IllegalStateException(err)
        }
        throw IllegalStateException("no port for the engine")
    }
}
