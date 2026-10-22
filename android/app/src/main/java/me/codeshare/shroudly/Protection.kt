package me.codeshare.shroudly

import android.os.Handler
import android.os.Looper
import java.util.concurrent.CopyOnWriteArraySet

/* What the service is doing, for the window, the tile and the notification. */
object Protection {
    enum class State { OFF, STARTING, ON, STOPPING }

    @Volatile var state = State.OFF
        private set
    /* Why the last start failed or protection ended on its own: a string
     * resource, and a detail in English for the log (may be null). */
    @Volatile var errorRes = 0
        private set
    @Volatile var errorDetail: String? = null
        private set
    /* While on: what is wrong and being worked on (a string resource; 0:
     * nothing), e.g. offline under lockdown (ShroudlyVpnService.holdOn). */
    @Volatile var troubleRes = 0
        private set
    @Volatile var stats: EngineEvent.Stats? = null
    // SystemClock.elapsedRealtime() when protection came on (0: off): how long
    // it has been on, which no change of the date moves.
    @Volatile var startedAt = 0L
    // How Android runs this VPN, and whether it carries IPv6 (for "Share logs").
    @Volatile var alwaysOn = false
    @Volatile var lockdown = false
    @Volatile var ipv6 = false
    /* The engine's SOCKS5 port while protection is on, 0 otherwise, and the
     * session's password for it (null when the engine takes none). */
    @Volatile var socksPort = 0
    @Volatile var socksAuth: SocksAuth? = null
    /* Proxy only (ShroudlyProxyService): no VPN, apps that are set to use
     * 127.0.0.1:socksPort go through Shroudly; the VPN slot stays free. */
    @Volatile var proxyOnly = false
    /* The window is on screen (between its onStart and onStop). */
    @Volatile var windowVisible = false

    private val listeners = CopyOnWriteArraySet<() -> Unit>()
    private val main = Handler(Looper.getMainLooper())

    fun set(s: State) {
        state = s
        if (s == State.STARTING) { errorRes = 0; errorDetail = null }
        if (s != State.ON) { socksPort = 0; socksAuth = null }
        if (s == State.OFF) { stats = null; startedAt = 0; proxyOnly = false }
        changed()
    }

    fun fail(res: Int, detail: String?) {
        errorRes = res
        errorDetail = detail
        changed()
    }

    fun trouble(res: Int) {
        if (troubleRes == res) return
        troubleRes = res
        changed()
    }

    fun clearError() {
        errorRes = 0
        errorDetail = null
        changed()
    }

    /* Nobody looking (no window, no tile): nothing to post. */
    fun changed() {
        if (listeners.isEmpty()) return
        main.post { for (l in listeners) l() }
    }

    fun hasListeners() = listeners.isNotEmpty()

    fun listen(l: () -> Unit) { listeners += l }
    fun unlisten(l: () -> Unit) { listeners -= l }
}
