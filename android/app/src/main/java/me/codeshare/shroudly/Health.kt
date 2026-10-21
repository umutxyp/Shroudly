package me.codeshare.shroudly

import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.Socket
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/*
 * Is protection still carrying the phone's traffic?
 *
 * While the VPN is up, every app's connection goes into it, so a part that
 * stops working (hev, the engine, the engine's way to the network) would
 * leave the phone without internet while it says "Protected". The service
 * looks at each part (ShroudlyVpnService.tick) and, when one has stopped and
 * cannot be brought back, ends protection and says so: apps then connect
 * directly, which is better than not at all.
 *
 *   hev          its thread is running (Tun2Socks.TProxyIsRunning);
 *   the engine   its run has not returned, it answers STATS, and it accepts
 *                a connection on its port (EngineProbe.answers);
 *   the path     a connection through the engine reaches the internet
 *                (EngineProbe.reaches), looked at when PathWatch says so.
 */

/* Probes of the engine's SOCKS5 port, from this app, which is outside its
 * own VPN: they go straight to the engine and from there to the network. */
object EngineProbe {
    /* Where the path check connects, through the engine, by name: the
     * engine has to look the name up and connect before it answers. The
     * hosts Android itself checks the network with (so a network Android
     * calls working reaches them), and those Apple's, Microsoft's and
     * Chinese phones check with, for networks where Google is blocked; any
     * one answering is enough. */
    val TARGETS = listOf(
        "www.google.com" to 443, "connectivitycheck.gstatic.com" to 80, "one.one.one.one" to 443,
        "captive.apple.com" to 80, "www.msftconnecttest.com" to 80, "connect.rom.miui.com" to 80,
    )

    /* TARGETS, and the hosts of the check addresses this Android was given
     * (Settings.Global captive_portal_*_url), when it was given any. */
    fun targets(captivePortalUrls: List<String?>): List<Pair<String, Int>> {
        val own = captivePortalUrls.mapNotNull { u ->
            try {
                val url = java.net.URL(u ?: return@mapNotNull null)
                val host = url.host?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
                host to (if (url.port > 0) url.port else url.defaultPort)
            } catch (_: Exception) {
                null
            }
        }
        return (own + TARGETS).distinct()
    }

    /* Android's own checks of a network wait 10 seconds. */
    const val DEADLINE_MS = 10_000L

    /* The engine accepts a connection and answers the SOCKS5 greeting and
     * the session's password: its accept loop and its connection threads
     * work. Loopback only: no traffic on the network. */
    fun answers(port: Int, auth: SocksAuth?, timeoutMs: Int = 3000): Boolean = try {
        Socket(Proxy.NO_PROXY).use { s ->
            s.connect(InetSocketAddress(InetAddress.getByName("127.0.0.1"), port), timeoutMs)
            s.soTimeout = timeoutMs
            Socks5.greet(s, auth)
            true
        }
    } catch (_: Exception) {
        false
    }

    /* A connection through the engine to host:port works. The engine has
     * resolved the name (its encrypted DNS, or the fallbacks) and connected
     * when it says yes. Nothing is sent over it. */
    fun reaches(port: Int, auth: SocksAuth?, host: String, hostPort: Int, timeoutMs: Int = 20000): Boolean = try {
        Socket(Proxy.NO_PROXY).use { s ->
            s.connect(InetSocketAddress(InetAddress.getByName("127.0.0.1"), port), 3000)
            s.soTimeout = timeoutMs
            Socks5.connect(s, host, hostPort, auth)
            true
        }
    } catch (_: Exception) {
        false
    }

    /* The first target that answers, or null when none does within
     * deadlineMs. All are tried at once: on a network that drops what it
     * blocks, one after the other would take a minute to say no. */
    fun reachesAny(port: Int, auth: SocksAuth?, targets: List<Pair<String, Int>> = TARGETS, deadlineMs: Long = DEADLINE_MS): String? {
        val results = LinkedBlockingQueue<String>()
        for ((h, p) in targets) {
            Thread({
                val ok = reaches(port, auth, h, p, deadlineMs.toInt())
                results.put(if (ok) "$h:$p" else "")
            }, "path-check").apply { isDaemon = true }.start()
        }
        val end = System.nanoTime() / 1_000_000 + deadlineMs
        var answered = 0
        while (answered < targets.size) {
            val wait = end - System.nanoTime() / 1_000_000
            if (wait <= 0) return null
            val r = results.poll(wait, TimeUnit.MILLISECONDS) ?: return null
            answered++
            if (r.isNotEmpty()) return r
        }
        return null
    }
}

/*
 * When to check that the engine reaches the internet, and what failures
 * mean. Plain logic on the clock it is given (SystemClock.uptimeMillis in the
 * service), so it is tested on the JVM.
 *
 * A check is a real connection, so it is made only when there is a reason:
 *   - soon after protection comes on, after the engine or the tunnel was
 *     restarted, after the network changed (ask());
 *   - when apps keep sending and nothing has come back for STALL_MS: the
 *     sign of traffic going nowhere;
 *   - while apps are busy, at most every INTERVAL_MS.
 * An idle phone is never checked.
 *
 * A failure counts only while Android says the network underneath works
 * (NET_CAPABILITY_VALIDATED): with no network, nothing would work with or
 * without Shroudly. FAILURES failures in a row, RETRY_MS apart, mean the way
 * through the engine is broken while the network is not; one is enough when
 * the check was made because apps get nothing back (a stall), which is
 * evidence already, or right after the service restarted everything for a
 * broken way through (oneStrike).
 */
class PathWatch(
    private val intervalMs: Long = INTERVAL_MS,
    private val stallMs: Long = STALL_MS,
    private val retryMs: Long = RETRY_MS,
    private val failuresToStop: Int = FAILURES,
) {
    companion object {
        const val INTERVAL_MS = 120_000L
        const val STALL_MS = 12_000L
        const val RETRY_MS = 3_000L
        const val FAILURES = 2
        // Packets apps sent into the tunnel since anything came back, before
        // silence counts as a stall (a phone's background chatter is less).
        const val STALL_PACKETS = 20L
    }

    enum class Verdict {
        /* The engine reached the internet. */
        HEALTHY,
        /* It did not; check again in a moment. */
        RETRY,
        /* It did not, FAILURES times in a row, while the network worked. */
        BROKEN,
        /* It did not, but the network underneath does not work either. */
        NO_NETWORK,
    }

    private var askedAt = 0L
    private var lastCheckAt = 0L
    private var failures = 0
    /* The next failure alone is enough (until a check succeeds): the way
     * through was found broken already, and what was done about it is being
     * checked (the service restarted everything). */
    var oneStrike = false
    var checking = false
        private set
    // The check under way was made because of a stall.
    private var stallCheck = false

    // Traffic: hev's packets from apps, the engine's bytes to them.
    private var appPackets = -1L
    private var bytesDown = -1L
    // When bytes last came back (-1: not yet known).
    private var downAt = -1L
    private var packetsSinceDown = 0L
    private var appsSinceCheck = false

    /* A check in delayMs (0: at the next tick); an earlier one asked for stays. */
    fun ask(now: Long, delayMs: Long) {
        val at = now + delayMs
        if (askedAt == 0L || at < askedAt) askedAt = at
    }

    /* The counters now. Either may be -1 when unknown. */
    fun traffic(now: Long, appPacketsNow: Long, bytesDownNow: Long) {
        if (downAt < 0) downAt = now
        if (bytesDownNow >= 0) {
            if (bytesDownNow != bytesDown) {
                // Bytes came back (or the engine restarted and counts anew).
                if (bytesDown >= 0) { downAt = now; packetsSinceDown = 0 }
                bytesDown = bytesDownNow
            }
        }
        if (appPacketsNow >= 0) {
            if (appPackets >= 0 && appPacketsNow > appPackets) {
                packetsSinceDown += appPacketsNow - appPackets
                appsSinceCheck = true
            }
            appPackets = appPacketsNow
        }
    }

    /* Apps keep sending and nothing comes back. */
    fun stalled(now: Long) = downAt >= 0 && packetsSinceDown >= STALL_PACKETS && now - downAt >= stallMs

    /* Whether to start a check now. */
    fun due(now: Long): Boolean {
        if (checking) return false
        if (askedAt != 0L && now >= askedAt) return true
        if (stalled(now) && now - lastCheckAt >= retryMs) return true
        return appsSinceCheck && now - lastCheckAt >= intervalMs
    }

    fun started(now: Long) {
        stallCheck = stalled(now) && !(askedAt != 0L && now >= askedAt)
        checking = true
        lastCheckAt = now
        askedAt = 0
        appsSinceCheck = false
    }

    fun result(now: Long, ok: Boolean, networkWorks: Boolean): Verdict {
        checking = false
        if (ok) {
            failures = 0
            oneStrike = false
            // What answered is traffic too: no stall right after.
            downAt = now
            packetsSinceDown = 0
            return Verdict.HEALTHY
        }
        if (!networkWorks) {
            failures = 0
            return Verdict.NO_NETWORK
        }
        failures++
        if (failures >= failuresToStop || oneStrike || stallCheck) return Verdict.BROKEN
        ask(now, retryMs)
        return Verdict.RETRY
    }

    /* Everything starts over (a new engine, a new network); a check under
     * way is forgotten (its result is dropped by the caller). */
    fun reset(now: Long) {
        checking = false
        askedAt = 0
        lastCheckAt = now
        failures = 0
        downAt = now
        packetsSinceDown = 0
        appPackets = -1
        bytesDown = -1
        appsSinceCheck = false
    }
}

/*
 * The engine's liveness: it must answer EngineProbe.answers every
 * LIVENESS_MS; FAILURES misses in a row and it is taken for hung.
 */
class Liveness(private val everyMs: Long = LIVENESS_MS, private val failuresToGiveUp: Int = FAILURES) {
    companion object {
        const val LIVENESS_MS = 20_000L
        const val FAILURES = 2
    }

    private var lastAt = 0L
    private var misses = 0
    var checking = false
        private set

    fun due(now: Long) = !checking && now - lastAt >= everyMs

    fun started(now: Long) {
        checking = true
        lastAt = now
    }

    /* true when the engine is to be taken for hung. */
    fun result(ok: Boolean): Boolean {
        checking = false
        misses = if (ok) 0 else misses + 1
        return misses >= failuresToGiveUp
    }

    fun reset(now: Long) {
        misses = 0
        lastAt = now
        checking = false
    }
}
