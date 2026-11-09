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
    /* Apps' lookups go around the tunnel (DnsNotice): said in the window too. */
    @Volatile var dnsAround = false
    /* A site needs Tor and the user has not said yes yet (TorAsk): its name
     * ("" when the engine did not give one), null when nothing is asked. */
    @Volatile var torAsk: String? = null
    /* The lite APK: a site stayed shut that the full APK's Tor could open
     * (LiteOffer); its name, null when nothing is offered. */
    @Volatile var liteOffer: String? = null
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
    /* Proxy only, while on: the port it asked for first and found held by
     * another app (ProxyPort), 0 when it got it. */
    @Volatile var proxyPortTaken = 0
    /* The window is on screen (between its onStart and onStop). */
    @Volatile var windowVisible = false
    /* While on: only this country's own network answers (NationalNet), its
     * code (IR, RU...), or null. */
    @Volatile var national: String? = null
        private set
    /* While on: the user's own server (OwnServer) is not carrying
     * connections: what it is and why (OwnServer.WHY codes), or null. */
    @Volatile var ownServerDown: Pair<String, String>? = null
        private set
    /* While on and working through the user's own server: the address sites
     * see through it (OwnServer.exitAddress, issue #66), or null. */
    @Volatile var ownServerExit: String? = null
    /* Its country (Cloudflare's "loc=", issue #60), or null. */
    @Volatile var ownServerExitCc: String? = null
        private set

    private val listeners = CopyOnWriteArraySet<() -> Unit>()
    private val main = Handler(Looper.getMainLooper())

    fun set(s: State) {
        state = s
        if (s == State.STARTING) { errorRes = 0; errorDetail = null }
        if (s != State.ON) { socksPort = 0; socksAuth = null; proxyPortTaken = 0 }
        if (s == State.OFF) { stats = null; startedAt = 0; dnsAround = false; torAsk = null; liteOffer = null; proxyOnly = false; national = null; ownServerDown = null; ownServerExit = null; ownServerExitCc = null }
        changed()
    }

    /* When Shroudly last went wrong itself (Report.offered). */
    @Volatile var faultAt = 0L

    fun fail(res: Int, detail: String?) {
        faultAt = System.currentTimeMillis()
        errorRes = res
        errorDetail = detail
        changed()
    }

    fun trouble(res: Int) {
        if (troubleRes == res) return
        if (res != 0) faultAt = System.currentTimeMillis()
        troubleRes = res
        changed()
    }

    fun ownServerDown(v: Pair<String, String>?) {
        if (ownServerDown == v) return
        ownServerDown = v
        changed()
    }

    fun ownServerExit(v: String?, cc: String? = null) {
        if (ownServerExit == v && ownServerExitCc == cc) return
        ownServerExit = v
        ownServerExitCc = cc
        changed()
    }

    fun national(cc: String?) {
        if (national == cc) return
        national = cc
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
