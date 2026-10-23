package me.codeshare.shroudly

import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.Socket
import java.util.concurrent.Future
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
    /* Where the path check connects, by name: through the engine, the
     * engine has to look the name up and connect before it answers. Hosts
     * that check networks for phones and computers everywhere (Android's,
     * Cloudflare's, Apple's and Microsoft's), so a working network reaches
     * at least one; any one answering is enough. */
    val TARGETS = listOf(
        "www.google.com" to 443, "connectivitycheck.gstatic.com" to 80, "one.one.one.one" to 443,
        "captive.apple.com" to 80, "www.msftconnecttest.com" to 80,
    )

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

    /* The first target that answers through the engine, or null when none
     * does within deadlineMs. */
    fun reachesAny(port: Int, auth: SocksAuth?, targets: List<Pair<String, Int>> = TARGETS, deadlineMs: Long = DEADLINE_MS): String? =
        firstOf(targets, deadlineMs) { h, p -> reaches(port, auth, h, p, deadlineMs.toInt()) }

    /* What a connection from this app's own socket found: it is outside the
     * VPN, so it goes straight over the network underneath. */
    class Direct(val reached: String?, val refusedBySystem: Boolean)

    /* The same hosts without the engine. When nothing answers here either,
     * the network may be down (not Shroudly's doing), or this app may be the
     * one cut off (a phone maker's per-app network switch, a firewall app):
     * refusedBySystem says the system itself refused the connection
     * (EPERM/EACCES), which is the second. */
    fun direct(targets: List<Pair<String, Int>> = TARGETS, deadlineMs: Long = DEADLINE_MS): Direct {
        val refused = java.util.concurrent.atomic.AtomicBoolean(false)
        val reached = firstOf(targets, deadlineMs) { h, p ->
            try {
                Socket(Proxy.NO_PROXY).use { s ->
                    s.connect(InetSocketAddress(h, p), deadlineMs.toInt())
                    true
                }
            } catch (e: Exception) {
                if (refusedBySystem(e)) refused.set(true)
                false
            }
        }
        return Direct(reached, reached == null && refused.get())
    }

    fun directAny(targets: List<Pair<String, Int>> = TARGETS, deadlineMs: Long = DEADLINE_MS): String? = direct(targets, deadlineMs).reached

    /* The system, not the network, turned the connection down. */
    fun refusedBySystem(e: Throwable): Boolean {
        var c: Throwable? = e
        while (c != null) {
            val m = c.message ?: ""
            if (m.contains("EPERM") || m.contains("EACCES") || m.contains("Operation not permitted") || m.contains("Permission denied")) return true
            c = c.cause
        }
        return false
    }

    /* All are tried at once: on a network that drops what it blocks, one
     * after the other would take a minute to say no. */
    fun firstOf(targets: List<Pair<String, Int>>, deadlineMs: Long, attempt: (String, Int) -> Boolean): String? {
        val results = LinkedBlockingQueue<String>()
        for ((h, p) in targets) {
            Thread({
                val ok = attempt(h, p)
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
 * A failure counts only when the network underneath works: Android says
 * so (NET_CAPABILITY_VALIDATED), and the same hosts answer this app's own
 * connection, made outside the VPN (EngineProbe.directAny). When they do
 * not, the network is down (an outage, a slow handover), not the way
 * through Shroudly, and nothing would work without it either. FAILURES
 * failures in a row, RETRY_MS apart, mean the way through the engine is
 * broken while the network is not; one is enough when the check was made
 * because apps get nothing back (a stall), which is evidence already, or
 * right after the service restarted everything for a broken way through
 * (oneStrike).
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
        // The network underneath does not work: the next check, unless one
        // is asked for (a network change asks), waits this long.
        const val NO_NETWORK_PAUSE_MS = 60_000L
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
    private var quietUntil = 0L
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
        if (now < quietUntil) return false
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

    /* The check under way says nothing (the phone slept in the middle of it,
     * its sockets were frozen): it counts neither way, and another is made
     * in a moment. */
    fun abandoned(now: Long) {
        checking = false
        stallCheck = false
        ask(now, retryMs)
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
            quietUntil = now + NO_NETWORK_PAUSE_MS
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
        quietUntil = 0
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

    /* The check under way says nothing (the phone slept in the middle of
     * it): no miss, and the next one is due at once. */
    fun abandoned() {
        checking = false
        lastAt = 0
    }

    fun reset(now: Long) {
        misses = 0
        lastAt = now
        checking = false
    }
}

/*
 * hev itself. The path check goes from this app to the engine, past the VPN
 * interface and hev, so it cannot see hev stuck while its thread runs.
 * hev answers every packet apps send it at once by itself: a TCP handshake,
 * a reset, a DNS answer. So packets going in (hev's tx count) with nothing
 * at all coming out (its rx count) for WINDOW_MS means hev is stuck. And
 * with the engine holding nearly as many connections as hev may open, for
 * CAP_MS, new connections are refused: the tunnel is full.
 */
class HevWatch(
    private val windowMs: Long = WINDOW_MS,
    private val minPackets: Long = MIN_PACKETS,
    private val capMs: Long = CAP_MS,
) {
    companion object {
        const val WINDOW_MS = 10_000L
        const val MIN_PACKETS = 20L
        const val CAP_MS = 60_000L
        // "Full" is this share of hev's session cap.
        const val CAP_SHARE = 0.95
    }

    private var lastRx = -1L
    private var rxMovedAt = 0L
    private var txAtRxMove = 0L
    private var fullSince = -1L

    /* hev's counters now; true when hev takes packets and gives none back. */
    fun stuck(now: Long, tx: Long, rx: Long): Boolean {
        if (tx < 0 || rx < 0) return false
        if (rx != lastRx || lastRx < 0) {
            lastRx = rx
            rxMovedAt = now
            txAtRxMove = tx
            return false
        }
        return tx - txAtRxMove >= minPackets && now - rxMovedAt >= windowMs
    }

    /* The engine's open connections against hev's cap; true when it has
     * been full for CAP_MS. */
    fun full(now: Long, active: Long, cap: Int): Boolean {
        if (active < 0 || active < cap * CAP_SHARE) {
            fullSince = -1
            return false
        }
        if (fullSince < 0) fullSince = now
        return now - fullSince >= capMs
    }

    fun reset() {
        lastRx = -1
        fullSince = -1
    }
}

/*
 * One path check, from this app (the service runs it on its `checks`
 * thread): through the engine; when nothing got through, the same hosts
 * directly, and Android's own check of the network. When the network turns
 * out to work after all, the engine is asked once more before the check
 * counts as failed: a network that was only coming back (the phone just
 * woke up, a handover) answers by then, and a broken way through does not.
 */
object PathCheck {
    class Outcome(val reached: String?, val direct: String?, val networkWorks: Boolean)

    fun run(
        reach: () -> String?,
        direct: () -> EngineProbe.Direct,
        underlyingWorks: () -> Boolean,
        recheckUnderlying: () -> Boolean,
    ): Outcome {
        var reached = reach()
        if (reached != null) return Outcome(reached, null, true)
        val d = direct()
        var directSaw = when {
            d.reached != null -> d.reached
            d.refusedBySystem -> "nothing, as Android refuses this app's connections"
            else -> null
        }
        val works = when {
            d.reached != null || d.refusedBySystem -> underlyingWorks()
            // Nothing answered this app either: down for everyone, or only
            // for this app (a per-app switch that drops silently)? Android's
            // own check of the network says.
            else -> recheckUnderlying().also { if (it) directSaw = "nothing for this app, while Android's own check passes" }
        }
        if (works) reached = reach()
        return Outcome(reached, directSaw, works)
    }
}

/*
 * The phone asleep. SystemClock.uptimeMillis (and System.nanoTime, and the
 * executor's timers) stop while it sleeps; elapsedRealtime runs on. What the
 * health checks measure in uptime is awake time, as it should be (an engine
 * cannot answer while the phone sleeps); what is "again soon after" for a
 * restart is real time (else ten minutes of uptime may span a night).
 */
object Sleep {
    /* Between two readings of both clocks, the phone slept for more than
     * toleranceMs: a check that spanned it saw frozen sockets. */
    fun slept(realStart: Long, upStart: Long, realEnd: Long, upEnd: Long, toleranceMs: Long = 1000L) =
        (realEnd - realStart) - (upEnd - upStart) > toleranceMs

    /* A second failure within windowMs of real time after the first one
     * (lastAt 0: none yet). */
    fun again(lastAt: Long, now: Long, windowMs: Long) = lastAt != 0L && now - lastAt in 0 until windowMs
}

/*
 * Under lockdown (Android blocks connections without the VPN), protection
 * does not end when the way through is broken: everything is tried again
 * after a while, a little longer each time. A retry planned because the
 * path check found nothing through the engine is called off once a path
 * check finds the way through working again, with the tunnel running: it
 * would tear down an engine and a tunnel that work, and every connection
 * apps hold. The path check goes from this app to the engine, never through
 * the tunnel, so it says nothing about a retry planned for anything else
 * (the tunnel stopped, the engine kept stopping): that one always runs.
 */
class LockdownHold(
    private val firstMs: Long,
    private val maxMs: Long,
    private val schedule: (Long, Runnable) -> Future<*>,
) {
    /* Why the retry is planned. */
    enum class Cause { PATH, OTHER }

    var backoff = 0L
        private set
    @Volatile private var pending: Future<*>? = null
    // Anything but the path, once, keeps the retry until it has run.
    @Volatile private var cause = Cause.PATH

    val planned get() = pending != null

    /* Plans the next retry; returns how long until it. */
    fun plan(cause: Cause, run: () -> Unit): Long {
        backoff = if (backoff == 0L) firstMs else minOf(backoff * 2, maxMs)
        this.cause = if (pending != null && this.cause == Cause.OTHER) Cause.OTHER else cause
        pending?.cancel(false)
        pending = schedule(backoff, Runnable { pending = null; run() })
        return backoff
    }

    /* A path check found the way through working; tunnelUp: hev runs. A
     * retry planned for the path is called off (true when it was), and the
     * next trouble starts from the first wait. Any other retry stays. */
    fun pathHealthy(tunnelUp: Boolean): Boolean {
        if (pending == null) {
            if (tunnelUp) backoff = 0
            return false
        }
        if (!tunnelUp || cause != Cause.PATH) return false
        cancel()
        return true
    }

    fun cancel() {
        pending?.cancel(false)
        pending = null
        backoff = 0
    }
}
