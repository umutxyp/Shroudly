package me.codeshare.shroudly

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.service.quicksettings.TileService
import android.util.Log
import java.io.File
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/*
 * Protection on Android: a VPN that carries every other app's connections to
 * the engine.
 *
 *   apps -> VPN interface -> hev-socks5-tunnel -> engine (SOCKS5 on 127.0.0.1)
 *        -> the network, with the engine's techniques
 *
 * hev and the engine both run inside this app's process, on threads of their
 * own (Tun2Socks, Engine). This app is left out of its own VPN
 * (addDisallowedApplication), so the engine's connections and the encrypted
 * DNS go straight to the network: no loop, and nothing to protect() socket by
 * socket.
 *
 * While the VPN is up every app depends on it, so it is watched (tick, and
 * Health.kt): a part that stops is restarted, and when that does not help,
 * protection ends with a notice and apps connect directly again. The phone is
 * never left "protected" with no way out.
 */
class ShroudlyVpnService : VpnService() {
    companion object {
        const val TAG = "Shroudly"
        const val ACTION_START = "me.codeshare.shroudly.START"
        const val ACTION_STOP = "me.codeshare.shroudly.STOP"
        /* Writes the current counters to the log (used by the smoke test). */
        const val ACTION_STATS = "me.codeshare.shroudly.STATS"
        /* Debug builds only (DebugControlActivity): what the emulator tests
         * use to make a part fail and watch protection deal with it. The
         * extra "what" says which: "engine-stop", "tunnel-stop", "path-check". */
        const val ACTION_TEST = "me.codeshare.shroudly.TEST"

        private const val CHANNEL = "protection"
        private const val ALERT_CHANNEL = "alerts"
        private const val NOTIFICATION_ID = 1
        private const val ALERT_ID = 2
        private const val MAX_RESTARTS = 5
        // A STATS left unanswered this long (in uptime, so time asleep does not
        // count) means the engine's command loop hangs. In the app's own
        // process an answer takes a millisecond.
        private const val HANG_TIMEOUT_MS = 30000L
        // How often the engine is asked for its counters when nobody is looking:
        // to know it still answers, and how much came back (PathWatch).
        private const val IDLE_PROBE_MS = 10000L
        // The tunnel is restarted once; stopping again within this time ends protection.
        private const val TUNNEL_RETRY_WINDOW_MS = 10L * 60 * 1000
        // The engine is restarted once when the way through it is broken; broken
        // again within this time ends protection.
        private const val PATH_RETRY_WINDOW_MS = 10L * 60 * 1000
        // A network change is acted on once it has been quiet this long: IPv6
        // often arrives a moment after the network itself.
        private const val NET_SETTLE_MS = 3000L
        // The first look at the way through the engine, after a start, a restart
        // or a network change: long enough for the encrypted DNS to warm up.
        private const val FIRST_PATH_CHECK_MS = 3000L
        private const val PREFS = "engine"
        private const val AUTH_FILE = "socks-auth"
        // Kept by 2.6.x, when the engine was a process of its own.
        private const val OLD_PID_KEY = "enginePid"
        // How many tunnels have been started: which stand-in range is next.
        private const val MAP_GENERATION = "mapGeneration"
        // When an always-on VPN last ended itself (wall clock).
        private const val SELF_STOP_AT = "selfStopAt"
        private const val SELF_STOP_QUIET_MS = 10L * 60 * 1000
        // Under lockdown, the pause before everything is tried again: from
        // the first, doubling up to the last.
        private const val HOLD_FIRST_MS = 15_000L
        private const val HOLD_MAX_MS = 300_000L
        // How long Android is given to check the network underneath again.
        // (its probes time out after 10 s each and there are several: 23 s seen).
        private const val RECHECK_MS = 35_000L
        // How long hev may take to stop.
        private const val TUNNEL_STOP_MS = 5_000L
        private const val LOG_FILE = "log.txt"

        /* Only once the user has allowed the VPN (VpnService.prepare() gives
         * nothing to ask): that consent is what lets the service run in the
         * foreground as systemExempted on Android 14 and later, and a service
         * started with startForegroundService() that cannot go foreground
         * crashes the app. False: not allowed, nothing started. */
        fun start(ctx: Context): Boolean {
            val allowed = try { prepare(ctx) == null } catch (e: Exception) { false }
            if (!allowed) {
                log("Not started: the VPN is not allowed yet")
                return false
            }
            ctx.startForegroundService(Intent(ctx, ShroudlyVpnService::class.java).setAction(ACTION_START))
            return true
        }

        fun stop(ctx: Context) {
            if (Protection.state == Protection.State.OFF) return
            ctx.startService(Intent(ctx, ShroudlyVpnService::class.java).setAction(ACTION_STOP))
        }

        /* The app's log (AppLog) keeps its lines in the app's files from here on. */
        fun attachLog(ctx: Context) {
            AppLog.attach(File(ctx.applicationContext.filesDir, LOG_FILE))
        }

        fun log(msg: String) {
            Log.i(TAG, msg)
            AppLog.add(msg)
        }

        /* Names of sites and what worked on them: in the system log of debug
         * builds only, so a release build's log never lists the sites someone
         * opened; in the app's own log in memory, for "Share logs". */
        private fun logSite(msg: String) {
            if (BuildConfig.DEBUG) Log.i(TAG, msg)
            AppLog.add(msg, site = true)
        }

        private fun logSite(msg: () -> String) = logSite(msg())

        /* Creates the channels, or renames them in the current language. The
         * user's own settings for them (importance, sound) are kept. */
        fun channels(ctx: Context) {
            val nm = ctx.getSystemService(NotificationManager::class.java) ?: return
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL, ctx.getString(R.string.navProtection), NotificationManager.IMPORTANCE_LOW).apply {
                    setShowBadge(false)
                },
            )
            nm.createNotificationChannel(
                NotificationChannel(ALERT_CHANNEL, ctx.getString(R.string.androidAlertsChannel), NotificationManager.IMPORTANCE_DEFAULT),
            )
        }

        /* The "protection stopped" notice is out of date once the user is back. */
        fun clearAlert(ctx: Context) {
            try { ctx.getSystemService(NotificationManager::class.java)?.cancel(ALERT_ID) } catch (_: Exception) {}
        }

        fun openApp(ctx: Context): PendingIntent = PendingIntent.getActivity(
            ctx, 0, Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }

    // Starts, stops and restarts run one at a time, in order.
    private val work: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "shroudly-service").apply { isDaemon = true }
    }
    // The health checks that wait on sockets, one at a time, off `work`.
    private val checks: ExecutorService = Executors.newSingleThreadExecutor { r ->
        Thread(r, "shroudly-check").apply { isDaemon = true }
    }
    /* For threads other than `work` (the engine's reader, network callbacks,
     * checks): once the service is being destroyed there is nothing left to do. */
    private fun later(block: () -> Unit) {
        try { work.execute(block) } catch (_: RejectedExecutionException) {}
    }

    private fun check(block: () -> Unit) {
        try { checks.execute(block) } catch (_: RejectedExecutionException) {}
    }

    private var poll: ScheduledFuture<*>? = null
    private var restartCredit: ScheduledFuture<*>? = null
    private var netCheck: ScheduledFuture<*>? = null
    // The network underneath as last seen (Network.toString(), its id) and
    // whether it had IPv6.
    private var underlyingId: String? = null
    private var underlyingV6 = false
    // Every network that could be underneath, as the callback reports them.
    private val networks = LinkedHashSet<Network>()

    private var engine: Engine? = null
    private var doh: DohForwarder? = null
    private var tun: ParcelFileDescriptor? = null
    private var tunnelRunning = false
    private var port = 0
    private var dohPort = 0
    private var restarts = 0
    private var auth: SocksAuth? = null
    private var authFile: File? = null
    private var v6Routed = false
    private var network: ConnectivityManager.NetworkCallback? = null
    // Uptime of the oldest STATS not answered yet (0: none), and of the last one sent.
    private var probeSentAt = 0L
    private var lastProbeAt = 0L
    private var tunnelRestartedAt = 0L
    // Tunnels started in this session (the first one, and any restart).
    private var tunnelStarts = 0
    private var pathRestartedAt = 0L
    // Under lockdown, how long until everything is tried again (0: not held).
    private var holdBackoff = 0L
    private var hold: ScheduledFuture<*>? = null
    private val hevWatch = HevWatch()
    private var hevRestartedAt = 0L
    // Started by Android (always-on VPN at boot, after a network change)
    // rather than by the user.
    private var startedBySystem = false
    // The notice that protection ended was posted moments ago: not again.
    private var quietNotice = false
    @Volatile private var active = false
    // Health: which engine the checks under way are about (a result about an
    // engine replaced meanwhile is dropped).
    private var healthEpoch = 0
    private val liveness = Liveness()
    private val pathWatch = PathWatch()
    // The engine would not stop: it holds the engine's state in this process,
    // which only a new process clears (see wedged()).
    private var restartProcess = false

    private lateinit var learned: Learned
    private val told = HashSet<String>()

    override fun onCreate() {
        super.onCreate()
        attachLog(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                // Asked to stop before it ever started: still owe startForeground.
                if (!active && Protection.state == Protection.State.OFF) {
                    stopSelf()
                    return START_NOT_STICKY
                }
                requestStop(0, null)
                return START_NOT_STICKY
            }
            ACTION_STATS -> {
                later { logStats() }
                if (!active && Protection.state == Protection.State.OFF) stopSelf()
                return START_NOT_STICKY
            }
            ACTION_TEST -> {
                if (BuildConfig.DEBUG) later { test(intent.getStringExtra("what")) }
                if (!active && Protection.state == Protection.State.OFF) stopSelf()
                return START_NOT_STICKY
            }
            // ACTION_START, the system's always-on VPN, or a restart after the
            // process was killed (START_STICKY): all mean "be on".
            else -> requestStart(bySystem = intent?.action != ACTION_START)
        }
        return START_STICKY
    }

    override fun onRevoke() {
        // Another VPN app took over, or the user switched this one off in Settings.
        log("VPN permission revoked")
        requestStop(R.string.androidVpnRevoked, null)
    }

    override fun onDestroy() {
        if (active || tun != null || engine != null) {
            try { work.execute { teardown() } } catch (_: RejectedExecutionException) {}
        }
        work.shutdown()
        try { work.awaitTermination(8, TimeUnit.SECONDS) } catch (_: InterruptedException) {}
        checks.shutdownNow()
        if (Protection.state != Protection.State.OFF) Protection.set(Protection.State.OFF)
        refreshTile()
        super.onDestroy()
    }

    private fun requestStart(bySystem: Boolean) {
        // Owed to startForegroundService() whatever happens next.
        val refused = goForeground(starting = Protection.state != Protection.State.ON)
        if (refused != null) {
            // Android 14+ runs a VPN in the foreground only once the user has
            // allowed it (the system's always-on VPN has been). Without that
            // there is nothing to run: no other foreground type is used.
            if (Protection.state == Protection.State.OFF) {
                Protection.fail(R.string.androidVpnDenied, refused)
                refreshTile()
                stopSelf()
            }
            return
        }
        // Starting or on already; or still stopping, and the window and tile
        // offer Start again once that is done.
        if (Protection.state != Protection.State.OFF) return
        Protection.set(Protection.State.STARTING)
        refreshTile()
        startedBySystem = bySystem
        work.execute { startAll() }
    }

    /* errorRes 0: the user asked. Anything else: protection ended on its own,
     * and a notification says so, since the window may not be open. */
    private fun requestStop(errorRes: Int, detail: String?) {
        if (Protection.state == Protection.State.OFF || Protection.state == Protection.State.STOPPING) return
        Protection.set(Protection.State.STOPPING)
        later {
            // Out of the live count first, through the engine while it still
            // runs; at the user's stop only (OnlineCount.stop).
            OnlineCount.stop(leave = errorRes == 0, port = port, auth = auth)
            teardown()
            Protection.set(Protection.State.OFF)
            if (errorRes != 0) {
                Protection.fail(errorRes, detail)
                notifyStopped(errorRes)
            }
            finish()
        }
    }

    private fun finish() {
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
        refreshTile()
        if (restartProcess || Engine.busy) endProcess()
    }

    /* An engine run that would not stop keeps the engine's state, and its
     * port, in this process: no engine can start here again. The VPN is down
     * by now and the notice posted, so the process ends; the next start (the
     * user's, or the system's always-on VPN) gets a clean one. */
    private fun endProcess() {
        log("An engine run did not stop; ending the app's process so the next start is clean")
        AppLog.flush()
        work.schedule({ android.os.Process.killProcess(android.os.Process.myPid()) }, 500, TimeUnit.MILLISECONDS)
    }

    /* ── start ─────────────────────────────────────────────────────────── */

    private fun startAll() {
        try {
            val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
            if (prefs.contains(OLD_PID_KEY)) prefs.edit().remove(OLD_PID_KEY).apply()
            learned = Learned(prefs.getString("learned", null))
            told.clear()
            restarts = 0
            tunnelRestartedAt = 0
            pathRestartedAt = 0
            pathWatch.oneStrike = false
            holdBackoff = 0
            hevRestartedAt = 0
            Protection.trouble(0)
            tunnelStarts = 0
            restartProcess = false

            EngineNative.loadError?.let { throw StartError("the engine library could not be loaded: $it") }
            // An engine from an earlier start that never stopped (see endProcess).
            if (Engine.busy) {
                restartProcess = true
                throw StartError("an earlier engine run has not stopped", R.string.androidProtectionLost)
            }

            // Encrypted DNS first, so the engine's first lookups have it. If it
            // cannot start, the engine falls back to plain DNS.
            val d = DohForwarder(::log, prefs.getString("dohRoute", null)) { id ->
                prefs.edit().putString("dohRoute", id).apply()
            }
            dohPort = try { d.start() } catch (e: Exception) { log("Encrypted DNS unavailable: ${e.message}"); 0 }
            doh = if (dohPort > 0) d else null

            port = spawnEngine()

            // Makes this app the prepared VPN when the user has already said
            // yes (the window asked); anything else means they have not.
            if (prepare(this) != null) throw StartError("VPN permission is missing", R.string.androidVpnDenied)
            val cm = getSystemService(ConnectivityManager::class.java)
            val under = underlying(cm)
            v6Routed = Net.hasIpv6(under?.second)
            underlyingId = under?.first?.toString()
            underlyingV6 = v6Routed
            val pfd = establish(v6Routed) ?: throw StartError("VPN permission is missing", R.string.androidVpnDenied)
            tun = pfd
            startTunnel()
            watchNetwork(cm)

            active = true
            Protection.startedAt = System.currentTimeMillis()
            Protection.set(Protection.State.ON)
            Protection.socksPort = port
            Protection.socksAuth = auth
            // The live count, as the desktop's: while protection is on (OnlineCount).
            OnlineCount.sync(this)
            clearAlert(this)
            goForeground(starting = false)
            refreshTile()
            probeSentAt = 0
            lastProbeAt = 0
            healthReset(FIRST_PATH_CHECK_MS)
            val selfStop = System.currentTimeMillis() - prefs.getLong(SELF_STOP_AT, 0)
            if (startedBySystem && alwaysOn() && !lockdown() && selfStop in 0 until SELF_STOP_QUIET_MS) {
                // Android started the always-on VPN again soon after it ended
                // itself: one failed check is enough this time.
                log("Started again by Android ${selfStop / 1000}s after protection ended itself; one failed check ends it again")
                pathWatch.oneStrike = true
                pathRestartedAt = SystemClock.uptimeMillis()
            }
            poll = work.scheduleWithFixedDelay({ tick() }, 1, 1, TimeUnit.SECONDS)
            log("Protection on: engine on 127.0.0.1:$port${if (auth != null) " (password)" else ""}, " +
                "encrypted DNS on ${if (dohPort > 0) "127.0.0.1:$dohPort" else "none"}, IPv6 ${if (v6Routed) "routed" else "off"}; " +
                "network: ${if (under == null) "none" else Net.describe(cm, under.first, under.second)}")
        } catch (e: Exception) {
            val detail = (e as? StartError)?.message ?: e.toString()
            val res = (e as? StartError)?.res ?: R.string.startFailed
            log("Could not start protection: $detail")
            teardown()
            Protection.set(Protection.State.OFF)
            Protection.fail(res, detail)
            notifyStopped(res)
            finish()
        }
    }

    private class StartError(msg: String, val res: Int = R.string.startFailed) : Exception(msg)

    /* Starts an engine and returns its port. A first start (and a restart
     * that cannot have its port back) gets a new password on a new free
     * port: whoever takes an old port meanwhile learns nothing that still
     * works. A restart of the engine (keep: true) asks for the port it had,
     * with the password it had, so the tunnel goes on as it was (see
     * restartEngine). Another free port is taken if the chosen one is gone
     * by the time the engine binds. */
    private fun spawnEngine(keep: Boolean = false): Int {
        val blockIps = blockIps()
        val wanted = if (keep && port > 0 && auth != null) port else 0
        if (wanted == 0) auth = SocksAuth.random()
        for (attempt in 0..3) {
            val p = if (attempt == 0 && wanted > 0) wanted else Engine.freePort()
            authFile = File(filesDir, AUTH_FILE).also { auth!!.writeTo(it) }
            val e = Engine(::log, ::logSite, ::onEngineEvent, ::onEngineExit)
            engine = e
            val ok = e.start(Engine.args(p, dohPort, blockIps, authFile, Engine.FAKE_NET))
            // Read once, at its start: the secret is not left lying in a file.
            authFile?.delete()
            if (ok) {
                doh?.socksAuth = auth
                doh?.socksPort = p
                probeSentAt = 0
                return p
            }
            engine = null
            val err = e.lastError ?: "engine failed to start"
            // A run that would not stop holds the engine's state: no other
            // can start in this process.
            if (e.running || Engine.busy) {
                restartProcess = true
                throw StartError("the engine did not stop after a failed start: $err", R.string.androidProtectionLost)
            }
            if (!err.contains("listen failed") || attempt == 3) throw StartError(err)
            if (p == wanted) {
                // Someone else has the old port now, and the tunnel may have
                // given them the password: the tunnel stops sending there, and
                // the engine gets a new port and a new password.
                log("Port $wanted is taken now; the engine gets another one")
                stopTunnel()
                auth = SocksAuth.random()
            }
        }
        throw StartError("engine failed to start")
    }

    private fun blockIps(): List<String> = try {
        assets.open("block-ips.txt").bufferedReader().readLines().map { it.trim() }.filter { it.isNotEmpty() && !it.startsWith("#") }
    } catch (_: Exception) {
        emptyList()
    }

    private fun establish(v6: Boolean): ParcelFileDescriptor? {
        val b = Builder()
            .setSession(getString(R.string.app_name))
            .setMtu(TunnelConfig.MTU)
            .addAddress(TunnelConfig.ADDRESS_V4, 32)
            .addRoute("0.0.0.0", 0)
            .addDnsServer(TunnelConfig.DNS_V4)
            .addDisallowedApplication(packageName)
            .setConfigureIntent(openApp(this))
        // Without an IPv6 address and route, Android answers apps' IPv6 with
        // "unreachable" at once, and they use IPv4.
        if (v6) b.addAddress(TunnelConfig.ADDRESS_V6, 128).addRoute("::", 0)
        // Metered exactly when the network underneath is. From Android 10 a
        // VPN counts as metered unless it says otherwise; saying it is not
        // makes Android take the metering of the network underneath
        // (setUnderlyingNetworks is not called: Android follows the default
        // network itself). Without it the VPN was metered on Wi-Fi too, and
        // apps held back updates, backups and video quality.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) b.setMetered(false)
        return b.establish()
    }

    private fun startTunnel() {
        val pfd = tun ?: throw StartError("no VPN interface")
        val conf = File(filesDir, "tunnel.yml")
        val a = auth
        // The next range of stand-in addresses (TunnelConfig): what apps kept
        // from an earlier tunnel is refused, never another site's.
        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        val generation = prefs.getInt(MAP_GENERATION, 0) + 1
        prefs.edit().putInt(MAP_GENERATION, generation).apply()
        val mapped = TunnelConfig.mappedNetwork(generation)
        conf.writeText(TunnelConfig.yaml(port, user = a?.user, pass = a?.pass, mapped = mapped, maxSessions = sessionCap()))
        if (!Tun2Socks.TProxyStartService(conf.absolutePath, pfd.fd)) throw StartError("tunnel failed to start")
        tunnelRunning = true
        // A bad setting ends its thread at once; better to know now than to
        // show "Protected" over a dead tunnel.
        Thread.sleep(200)
        if (!Tun2Socks.TProxyIsRunning()) {
            stopTunnel()
            throw StartError("tunnel stopped right after starting")
        }
        if (++tunnelStarts > 1) {
            log("Tunnel started again; stand-in addresses now from $mapped")
            // The Private DNS server's stand-in address was the old tunnel's.
            work.schedule({ if (active) revalidateIfStrict() }, 500, TimeUnit.MILLISECONDS)
        }
    }

    private fun sessionCap() = if (android.os.Process.is64Bit()) TunnelConfig.MAX_SESSIONS else TunnelConfig.MAX_SESSIONS_32

    /* Stops hev and waits for its thread. A hev that does not stop within
     * TUNNEL_STOP_MS (stuck) holds the VPN interface in this process: the
     * process has to end (endProcess). */
    private fun stopTunnel() {
        if (!tunnelRunning) return
        tunnelRunning = false
        hevWatch.reset()
        val done = java.util.concurrent.CountDownLatch(1)
        Thread({
            try { Tun2Socks.TProxyStopService() } catch (e: Throwable) { log("tunnel stop: $e") }
            done.countDown()
        }, "tunnel-stop").apply { isDaemon = true }.start()
        if (!done.await(TUNNEL_STOP_MS, TimeUnit.MILLISECONDS)) {
            log("The tunnel did not stop")
            restartProcess = true
        }
    }

    /* ── running ───────────────────────────────────────────────────────── */

    private fun tick() {
        if (!active) return
        if (tunnelRunning && !Tun2Socks.TProxyIsRunning()) {
            onTunnelStopped()
            return
        }
        val e = engine ?: return
        // Its run returned without its end being reported, for instance
        // between its start and protection being on.
        if (!e.running) {
            engineGone(e, "is no longer running")
            return
        }
        val now = SystemClock.uptimeMillis()
        if (probeSentAt > 0 && e.lastOutputAt < probeSentAt && now - probeSentAt > HANG_TIMEOUT_MS) {
            probeSentAt = 0
            engineGone(e, "stopped answering its commands")
            return
        }
        doh?.let { d ->
            if (!d.serving && dohPort > 0) {
                log("Encrypted DNS stopped; starting it again on 127.0.0.1:$dohPort")
                if (!d.restart(dohPort)) log("Encrypted DNS could not start again; the engine uses plain DNS")
            }
        }
        health(e, now)
        // Every second while the window or the tile is looking; otherwise only
        // now and then, to know the engine still answers.
        if (!Protection.hasListeners() && now - lastProbeAt < IDLE_PROBE_MS) return
        if (probeSentAt == 0L || e.lastOutputAt >= probeSentAt) probeSentAt = now
        lastProbeAt = now
        e.send("STATS")
    }

    /* The checks that wait on sockets run on `checks`; what they find comes
     * back here, on `work`. */
    private fun health(e: Engine, now: Long) {
        val epoch = healthEpoch
        val p = port
        val a = auth
        if (liveness.due(now)) {
            liveness.started(now)
            check {
                val ok = EngineProbe.answers(p, a)
                later {
                    if (epoch != healthEpoch || !active) return@later
                    if (liveness.result(ok)) engineGone(e, "does not accept connections on its port", freshPort = true)
                    else if (!ok) log("Engine did not answer on its port; looking again")
                }
            }
        }
        val hev = try { Tun2Socks.TProxyGetStats() } catch (_: Throwable) { null }
        val tx = hev?.getOrNull(0) ?: -1L
        val rx = hev?.getOrNull(2) ?: -1L
        if (hevWatch.stuck(now, tx, rx)) {
            tunnelTrouble("takes apps' packets and gives nothing back")
            return
        }
        if (hevWatch.full(now, Protection.stats?.connsActive ?: -1L, sessionCap())) {
            tunnelTrouble("has been full (${Protection.stats?.connsActive} connections) for a minute")
            return
        }
        pathWatch.traffic(now, tx, Protection.stats?.bytesDown ?: -1L)
        if (pathWatch.due(now)) {
            val why = if (pathWatch.stalled(now)) "apps get nothing back" else "routine"
            pathWatch.started(now)
            check {
                val t0 = SystemClock.uptimeMillis()
                val reached = EngineProbe.reachesAny(p, a)
                // Only when nothing got through: is the network itself down?
                var direct: String? = null
                var works = true
                if (reached == null) {
                    val d = EngineProbe.direct()
                    direct = when {
                        d.reached != null -> d.reached
                        d.refusedBySystem -> "nothing, as Android refuses this app's connections"
                        else -> null
                    }
                    works = when {
                        d.reached != null || d.refusedBySystem -> underlyingWorks()
                        // Nothing answered this app either: down for everyone,
                        // or only for this app (a per-app switch that drops
                        // silently)? Android's own check of the network says.
                        else -> recheckUnderlying().also { if (it) direct = "nothing for this app, while Android's own check passes" }
                    }
                }
                later {
                    if (epoch != healthEpoch || !active) return@later
                    onPath(reached, direct, works, why, SystemClock.uptimeMillis() - t0)
                }
            }
        }
    }

    private fun onPath(reached: String?, direct: String?, networkWorks: Boolean, why: String, ms: Long) {
        val now = SystemClock.uptimeMillis()
        when (pathWatch.result(now, reached != null, networkWorks)) {
            PathWatch.Verdict.HEALTHY -> {
                log("Path check ($why): through the engine to $reached in ${ms}ms")
                if (Protection.troubleRes != 0) {
                    log("The way through works again")
                    holdBackoff = 0
                    Protection.trouble(0)
                    clearAlert(this)
                }
            }
            PathWatch.Verdict.NO_NETWORK -> log("Path check ($why): nothing reached, " +
                (if (direct == null) "and nothing directly either: the network is down" else "and Android says the network has no internet"))
            PathWatch.Verdict.RETRY -> log("Path check ($why): nothing reached through the engine (${ms}ms); directly: $direct; looking again")
            PathWatch.Verdict.BROKEN -> {
                // Always once: a fresh engine and tunnel may do. Again soon
                // after: give up.
                if (pathRestartedAt == 0L || now - pathRestartedAt > PATH_RETRY_WINDOW_MS) {
                    pathRestartedAt = now
                    log("Nothing reached through the engine; directly: $direct; starting everything anew")
                    val e = engine ?: return
                    engineGone(e, "reaches nothing on a network that works", countsAsCrash = false, freshPort = true)
                    // healthReset (in the restart) keeps it: one more failure ends protection.
                    pathWatch.oneStrike = true
                } else {
                    giveUp(R.string.androidNoInternet,
                        "no connection through the engine reached the internet " +
                            "(${EngineProbe.TARGETS.joinToString { "${it.first}:${it.second}" }}) " +
                            "while Android's own check of the network passed (directly: $direct)")
                }
            }
        }
    }

    /* Asks Android to check the network underneath again now, and waits
     * for the result: false as soon as Android finds it has no internet,
     * true if it still says it has after RECHECK_MS. Called from `checks`. */
    private fun recheckUnderlying(): Boolean {
        val cm = getSystemService(ConnectivityManager::class.java)
        val net = try { underlying(cm)?.first } catch (_: Exception) { null } ?: return false
        try { cm.reportNetworkConnectivity(net, false) } catch (_: Exception) {}
        val end = SystemClock.uptimeMillis() + RECHECK_MS
        while (SystemClock.uptimeMillis() < end) {
            if (!underlyingWorks()) return false
            try { Thread.sleep(1000) } catch (_: InterruptedException) { return underlyingWorks() }
        }
        return underlyingWorks()
    }

    /* Android's own check of the network underneath (this app is outside its
     * VPN, so its default network is that one) has passed. */
    private fun underlyingWorks(): Boolean = try {
        val cm = getSystemService(ConnectivityManager::class.java)
        val caps = underlying(cm)?.let { cm.getNetworkCapabilities(it.first) }
        caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    } catch (_: Exception) {
        false
    }

    /* This app's VPN network, as Android lists it: the one with the VPN
     * interface's address. */
    @Suppress("DEPRECATION")
    private fun vpnNetwork(cm: ConnectivityManager): Network? = try {
        cm.allNetworks.firstOrNull { n ->
            val caps = cm.getNetworkCapabilities(n)
            caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) &&
                cm.getLinkProperties(n)?.linkAddresses?.any { it.address.hostAddress == TunnelConfig.ADDRESS_V4 } == true
        }
    } catch (_: Exception) {
        null
    }

    /* After the tunnel was started again under a VPN interface that stayed:
     * a Private DNS server set by name ("strict") was looked up through the
     * old tunnel, and Android keeps using the stand-in address it got, which
     * the new tunnel does not know. Every name then fails to resolve until
     * Android looks the server up again, which it does not do by itself. A
     * report that the network does not work makes it check the network
     * again, Private DNS included. */
    private fun revalidateIfStrict() {
        val cm = getSystemService(ConnectivityManager::class.java)
        val lp = vpnNetwork(cm)?.let { cm.getLinkProperties(it) } ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && lp.privateDnsServerName != null) revalidate()
    }

    private fun revalidate() {
        val cm = getSystemService(ConnectivityManager::class.java)
        val vpn = vpnNetwork(cm)
        val lp = vpn?.let { cm.getLinkProperties(it) }
        val strict = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && lp?.privateDnsServerName != null
        log("Asking Android to check the VPN network again (Private DNS ${if (strict) "strict" else "not strict"})")
        try {
            if (vpn != null) cm.reportNetworkConnectivity(vpn, false)
        } catch (e: Exception) {
            log("Could not ask Android to check the VPN network: $e")
        }
    }

    /* A new engine, tunnel or network: the checks start over, the next path
     * check in firstCheckMs. */
    private fun healthReset(firstCheckMs: Long) {
        val now = SystemClock.uptimeMillis()
        healthEpoch++
        liveness.reset(now)
        pathWatch.reset(now)
        pathWatch.ask(now, firstCheckMs)
    }

    /* hev's thread ended on its own: every app's traffic would go nowhere. */
    private fun onTunnelStopped() = tunnelTrouble("stopped unexpectedly")

    /* hev stopped, is stuck, or is full: it is started again once; again
     * within TUNNEL_RETRY_WINDOW_MS, protection is given up (giveUp). */
    private fun tunnelTrouble(why: String) {
        val now = SystemClock.uptimeMillis()
        if (tunnelRestartedAt != 0L && now - tunnelRestartedAt < TUNNEL_RETRY_WINDOW_MS) {
            log("Tunnel $why, again; giving up")
            stopTunnel()
            giveUp(R.string.androidProtectionLost, "the tunnel keeps failing: it $why")
            return
        }
        log("Tunnel $why; restarting it")
        tunnelRestartedAt = now
        stopTunnel()
        if (restartProcess) {
            wedged("the tunnel $why and did not stop")
            return
        }
        try {
            startTunnel()
            healthReset(FIRST_PATH_CHECK_MS)
        } catch (e: Exception) {
            log("Tunnel restart failed: ${e.message}")
            giveUp(R.string.androidProtectionLost, "the tunnel could not be restarted: ${e.message}")
        }
    }

    /* The network underneath: the default network of this app, which is
     * left out of its own VPN, so never the VPN itself. Android follows the
     * system's default network for the VPN on its own (setUnderlyingNetworks
     * is never called): the VPN is metered when that network is, and moves
     * with it from Wi-Fi to mobile data. Up to 2.6.1 the network a default
     * callback reported was passed to setUnderlyingNetworks, and that was
     * the VPN itself: the VPN became its own underlying network and kept the
     * first network's transport and metering, and its IPv6 was judged by the
     * VPN's own addresses. */
    private fun underlying(cm: ConnectivityManager): Pair<Network, LinkProperties>? {
        val candidates = listOfNotNull(cm.activeNetwork) + networks
        var best: Pair<Network, LinkProperties>? = null
        var bestRank = -1
        for ((i, n) in candidates.withIndex()) {
            val caps = cm.getNetworkCapabilities(n) ?: continue
            if (caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) continue
            if (!caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) continue
            val lp = cm.getLinkProperties(n) ?: continue
            // The app's default network first; else the best other one.
            if (i == 0 && n == cm.activeNetwork) return n to lp
            val rank = (if (caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) 4 else 0) +
                (if (caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)) 2 else 0)
            if (rank > bestRank) { best = n to lp; bestRank = rank }
        }
        return best
    }

    /* Every network that could be underneath (not a VPN, with internet):
     * any change in them is looked at once things have settled. */
    private fun watchNetwork(cm: ConnectivityManager) {
        val request = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)
            .build()
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(net: Network) = later { networks += net; onNetwork() }
            override fun onLinkPropertiesChanged(net: Network, lp: LinkProperties) = later { onNetwork() }
            override fun onLost(net: Network) = later { networks -= net; onNetwork() }
        }
        try {
            cm.registerNetworkCallback(request, cb)
            network = cb
        } catch (e: Exception) {
            log("Cannot follow network changes: ${e.message}")
        }
    }

    private fun onNetwork() {
        if (!active) return
        // Acted on once it has been quiet a moment: IPv6 often arrives a
        // moment after the network itself.
        netCheck?.cancel(false)
        netCheck = work.schedule({ onNetworkSettled() }, NET_SETTLE_MS, TimeUnit.MILLISECONDS)
    }

    private fun onNetworkSettled() {
        netCheck = null
        if (!active) return
        val cm = getSystemService(ConnectivityManager::class.java)
        val now = underlying(cm)
        val id = now?.first?.toString()
        val v6 = Net.hasIpv6(now?.second)
        if (id == underlyingId && v6 == underlyingV6) return
        underlyingId = id
        underlyingV6 = v6
        if (now == null) {
            log("Network: none")
            return
        }
        log("Network: ${Net.describe(cm, now.first, now.second)}")
        pathWatch.oneStrike = false
        healthReset(FIRST_PATH_CHECK_MS)
        // The interface carries IPv6 only where the network does.
        if (v6 == v6Routed) return
        log("IPv6 ${if (v6) "available" else "gone"} on this network; renewing the VPN interface")
        renewInterface(v6)
    }

    /* A new VPN interface (with IPv6 or without), and the tunnel on it. */
    private fun renewInterface(v6: Boolean) {
        val fresh = try { establish(v6) } catch (e: Exception) { log("establish: $e"); null }
        if (fresh == null) {
            requestStop(R.string.androidVpnRevoked, "the VPN interface could not be renewed")
            return
        }
        val old = tun
        stopTunnel()
        tun = fresh
        v6Routed = v6
        // While the engine is being restarted, the restart starts the tunnel.
        if (engine != null) {
            try {
                startTunnel()
            } catch (e: Exception) {
                log("Tunnel restart failed: ${e.message}")
                giveUp(R.string.androidProtectionLost, "the tunnel could not be restarted: ${e.message}")
            }
        }
        try { old?.close() } catch (_: Exception) {}
    }

    private fun onEngineEvent(ev: EngineEvent) {
        when (ev) {
            is EngineEvent.Ready -> {
                log("Engine listening on 127.0.0.1:${ev.port} (${ev.techniques} techniques)")
                val cmds = learned.commands(System.currentTimeMillis())
                if (cmds.isNotEmpty()) {
                    engine?.send(cmds.joinToString("\n"))
                    log("Techniques remembered for ${cmds.size} sites restored")
                }
                // A session that has been up a while has earned a fresh restart budget.
                later {
                    restartCredit?.cancel(false)
                    restartCredit = work.schedule({ restarts = 0 }, 120, TimeUnit.SECONDS)
                }
            }
            is EngineEvent.Stats -> {
                Protection.stats = ev
                Protection.changed()
            }
            is EngineEvent.Host -> onHost(ev)
            is EngineEvent.Error -> log("engine: ${ev.message}")
            else -> {}
        }
    }

    private fun onHost(ev: EngineEvent.Host) {
        val key = "${ev.kind} ${ev.host}"
        val first = synchronized(told) {
            if (told.size > 400) told.clear()
            told.add(key)
        }
        when (ev.kind) {
            "bypass" -> {
                synchronized(learned) {
                    learned.remember(ev.host, ev.strategy, System.currentTimeMillis())
                    getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString("learned", learned.encode()).apply()
                }
                if (first) logSite { "${ev.host}: blocked here, opened with ${ev.strategy} (${ev.attempts} tries, ${ev.family})" }
            }
            "blocked" -> if (first) logSite {
                when {
                    ev.alert -> "${ev.host}: the server refused the connection itself; not a block"
                    ev.note == "silent" -> "${ev.host}: no answer after ${ev.attempts} techniques (${ev.family})"
                    else -> "${ev.host}: still blocked after ${ev.attempts} techniques (${ev.family})"
                }
            }
            "unreachable" -> if (first) logSite { "${ev.host}: could not be reached (${if (ev.stage == "dns") "DNS" else "connection"})" }
            "cut" -> if (first) logSite { "${ev.host}: connects, then the network cuts it (${ev.strategy})" }
            else -> {}
        }
    }

    /* Called on the engine's reader thread. */
    private fun onEngineExit(e: Engine, code: Int) {
        later { engineGone(e, "stopped on its own (code $code)") }
    }

    /* The engine `e` stopped, hangs, or does not do its job. Runs on `work`,
     * so one at a time; `engine` is cleared at once, so a second report about
     * the same engine is ignored, and a restart is the only one in progress
     * until it has set a new engine. countsAsCrash: false for a restart that
     * is not the engine's own failing (PathWatch), which has its own limit.
     *
     * The tunnel stays up meanwhile: apps' connections to the engine fail at
     * once (nothing listens on its port) and are made again once the new
     * engine has the port back. freshPort: when the trouble may be the port
     * or the tunnel itself (the engine did not take connections, or nothing
     * got through it), everything starts anew instead: a new port, a new
     * password and a new tunnel. */
    private fun engineGone(e: Engine, why: String, countsAsCrash: Boolean = true, freshPort: Boolean = false) {
        if (!active || e !== engine) return
        engine = null
        healthEpoch++
        log("Engine $why")
        doh?.socksPort = 0
        Protection.socksPort = 0
        Protection.socksAuth = null
        if (!e.stop()) {
            wedged("the engine $why and did not stop when told to")
            return
        }
        if (freshPort) {
            stopTunnel()
            port = 0
        }
        if (countsAsCrash) scheduleRestart() else work.schedule({ restartEngine() }, 300, TimeUnit.MILLISECONDS)
    }

    /* A run that does not return holds the engine's state in this process:
     * no new engine can start beside it. Protection ends (apps connect
     * directly) and the process with it (finish). */
    private fun wedged(detail: String) {
        log("Stuck: $detail")
        restartProcess = true
        if (alwaysOn()) {
            // Android starts an always-on VPN again once its process is gone;
            // with lockdown, apps have no internet without it meanwhile anyway.
            log("Always-on VPN: ending the process, Android starts protection again")
            endProcess()
            return
        }
        requestStop(R.string.androidProtectionLost, detail)
    }

    /* ── giving up ─────────────────────────────────────────────────────── */

    /* Android 10+: the user made this the always-on VPN, and with
     * "Block connections without VPN" (lockdown). Earlier versions do not
     * say: false. */
    private fun alwaysOn(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && (try { isAlwaysOn } catch (_: Exception) { false })
    private fun lockdown(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && (try { isLockdownEnabled } catch (_: Exception) { false })

    /* Protection cannot carry traffic and was not brought back. Normally it
     * ends, and apps connect directly. Under lockdown that would leave them
     * with nothing at all, since Android lets nothing out without the VPN:
     * protection holds on instead, tries everything again with a growing
     * pause, and says honestly that apps are offline until it works. */
    private fun giveUp(res: Int, detail: String) {
        if (lockdown()) {
            holdOn(detail)
            return
        }
        // An always-on VPN that ended itself may be started again by Android
        // soon (a network change): that start then gives up at the first
        // failed check, and the notice is not posted again (see startAll).
        if (alwaysOn()) {
            val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
            val since = System.currentTimeMillis() - prefs.getLong(SELF_STOP_AT, 0)
            quietNotice = since in 0 until SELF_STOP_QUIET_MS
            prefs.edit().putLong(SELF_STOP_AT, System.currentTimeMillis()).apply()
        }
        log("Ending protection so apps connect directly: $detail")
        requestStop(res, detail)
    }

    private fun holdOn(detail: String) {
        holdBackoff = if (holdBackoff == 0L) HOLD_FIRST_MS else minOf(holdBackoff * 2, HOLD_MAX_MS)
        log("Lockdown (Android blocks connections without the VPN): staying on, trying everything again in ${holdBackoff / 1000}s: $detail")
        if (Protection.troubleRes == 0) {
            Protection.trouble(R.string.androidLockdownOffline)
            notifyStopped(R.string.androidLockdownOffline, title = R.string.app_name)
        }
        hold?.cancel(false)
        hold = work.schedule({ recoverAll() }, holdBackoff, TimeUnit.MILLISECONDS)
    }

    /* Under lockdown: a new engine on a new port, and a new tunnel. */
    private fun recoverAll() {
        hold = null
        if (!active) return
        log("Trying everything again")
        restarts = 0
        pathRestartedAt = 0
        tunnelRestartedAt = 0
        val e = engine
        if (e != null) {
            engine = null
            healthEpoch++
            doh?.socksPort = 0
            if (!e.stop()) {
                wedged("the engine did not stop to be started again")
                return
            }
        }
        stopTunnel()
        if (restartProcess) {
            wedged("the tunnel did not stop to be started again")
            return
        }
        port = 0
        restartEngine()
        // Judged at once: what was tried is checked again soon.
        pathWatch.oneStrike = true
    }

    private fun scheduleRestart() {
        if (restarts >= MAX_RESTARTS) {
            log("Engine keeps stopping; giving up")
            giveUp(R.string.androidProtectionLost, "the engine keeps stopping")
            return
        }
        restarts++
        val delay = minOf(500L * restarts, 4000L)
        log("Restarting engine in ${delay}ms (attempt $restarts/$MAX_RESTARTS)")
        work.schedule({ restartEngine() }, delay, TimeUnit.MILLISECONDS)
    }

    /* A new engine on the port the last one had, with the same password,
     * so hev goes on as it was: its table of names and stand-in addresses
     * stays, and the addresses apps were given stay valid. Only when the
     * port cannot be had back does the new engine get another port and a new
     * password, and the tunnel is started again with those (its stand-in
     * addresses then start over in the next range, see TunnelConfig). */
    private fun restartEngine() {
        if (!active || engine != null) return
        val before = port
        try {
            port = spawnEngine(keep = true)
        } catch (e: StartError) {
            log("Restart failed: ${e.message}")
            if (restartProcess) wedged(e.message ?: "the engine did not stop")
            else if (e.res == R.string.androidProtectionLost) giveUp(e.res, e.message ?: "")
            else scheduleRestart()
            return
        } catch (e: Exception) {
            log("Restart failed: $e")
            scheduleRestart()
            return
        }
        if (port != before || !tunnelRunning) {
            stopTunnel()
            try {
                startTunnel()
            } catch (e: Exception) {
                log("Tunnel restart failed: ${e.message}")
                giveUp(R.string.androidProtectionLost, "the tunnel could not be restarted: ${e.message}")
                return
            }
        }
        Protection.socksPort = port
        Protection.socksAuth = auth
        healthReset(FIRST_PATH_CHECK_MS)
        log(if (port == before) "Engine back on 127.0.0.1:$port; the tunnel went on" else "Engine back on 127.0.0.1:$port with a new password; tunnel renewed")
    }

    private fun logStats() {
        val s = Protection.stats
        if (s == null) {
            log("stats: ${Protection.state.name.lowercase()}, no counters yet")
        } else {
            log("stats: ${Protection.state.name.lowercase()}, connections ${s.connsTotal} total ${s.connsActive} active, " +
                "up ${s.bytesUp} B, down ${s.bytesDown} B, tls ${s.tls}, http ${s.http}, desync ${s.desync}")
        }
        doh?.summary()?.takeIf { it.isNotEmpty() }?.let { log("Encrypted DNS answering via $it") }
    }

    /* Debug builds: make one part fail as it might on a phone, for the
     * emulator tests (scripts/emulator-smoke.sh). */
    private fun test(what: String?) {
        if (!active) return
        val e = engine
        when (what) {
            // The engine's run returns, as if it had crashed or been ended.
            "engine-stop" -> { log("test: stopping the engine under the service"); e?.send("STOP") }
            // hev's thread ends.
            "tunnel-stop" -> { log("test: stopping the tunnel under the service"); try { Tun2Socks.TProxyStopService() } catch (_: Throwable) {} }
            // A path check now.
            "path-check" -> { log("test: path check"); pathWatch.ask(SystemClock.uptimeMillis(), 0) }
            // Ask Android to check the VPN network again (Private DNS).
            "revalidate" -> { log("test: revalidate"); revalidate() }
            // A new VPN interface, as when IPv6 comes or goes.
            "renew" -> { log("test: renewing the VPN interface"); renewInterface(v6Routed) }
            else -> log("test: unknown '$what'")
        }
    }

    /* ── stop ──────────────────────────────────────────────────────────── */

    /* Undoes whatever startAll did, in reverse: the tunnel first so apps stop
     * sending into it, then the interface, so traffic goes direct again. */
    private fun teardown() {
        val wasActive = active
        active = false
        OnlineCount.stop(leave = false)
        healthEpoch++
        poll?.cancel(false); poll = null
        restartCredit?.cancel(false); restartCredit = null
        hold?.cancel(false); hold = null
        Protection.trouble(0)
        netCheck?.cancel(false); netCheck = null
        underlyingId = null
        networks.clear()
        network?.let { cb ->
            try { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(cb) } catch (_: Exception) {}
        }
        network = null
        stopTunnel()
        try { tun?.close() } catch (_: Exception) {}
        tun = null
        val total = Protection.stats?.connsTotal
        engine?.let { e ->
            if (!e.stop()) {
                log("The engine did not stop")
                restartProcess = true
            }
        }
        engine = null
        doh?.stop(); doh = null
        dohPort = 0
        authFile?.delete()
        authFile = null
        auth = null
        if (wasActive) log("Protection off${if (total != null) "; $total connections relayed" else ""}")
    }

    /* ── notification and tile ─────────────────────────────────────────── */

    /* Null once the service is in the foreground; else why Android refused. */
    private fun goForeground(starting: Boolean): String? {
        channels(this)
        val stopIntent = PendingIntent.getService(
            this, 1, Intent(this, ShroudlyVpnService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val n = Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_shield)
            .setContentTitle(getString(if (starting) R.string.starting else R.string.protected_))
            .setContentText(getString(R.string.androidAllApps))
            .setContentIntent(openApp(this))
            .setOngoing(true)
            .setShowWhen(false)
            .setCategory(Notification.CATEGORY_SERVICE)
            .setColor(getColor(R.color.accent))
            .addAction(Notification.Action.Builder(null, getString(R.string.stop), stopIntent).build())
            .apply { if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE) }
            .build()
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                // The type for VPN apps the user has allowed (ACTIVATE_VPN).
                startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SYSTEM_EXEMPTED)
            } else {
                startForeground(NOTIFICATION_ID, n)
            }
        } catch (e: Exception) {
            log("Could not run in the foreground: $e")
            return "Android refused the foreground service: $e"
        }
        return null
    }

    /* Protection ended without the user asking: the ongoing notification goes
     * away with the service, so this one tells them their apps now connect
     * directly. Tapping it opens the window. */
    private fun notifyStopped(errorRes: Int, title: Int = R.string.protectionStopped) {
        // The open window shows the reason itself, unless the process is about
        // to end and the window with it.
        if (Protection.windowVisible && !restartProcess) return
        // Said once already, a moment ago (an always-on VPN that Android
        // started again and that ended itself again).
        if (quietNotice) return
        try {
            channels(this)
            val text = getString(errorRes)
            val n = Notification.Builder(this, ALERT_CHANNEL)
                .setSmallIcon(R.drawable.ic_shield)
                .setContentTitle(getString(title))
                .setContentText(text)
                .setStyle(Notification.BigTextStyle().bigText(text))
                .setContentIntent(openApp(this))
                .setAutoCancel(true)
                .setCategory(Notification.CATEGORY_ERROR)
                .setColor(getColor(R.color.danger))
                .build()
            getSystemService(NotificationManager::class.java).notify(ALERT_ID, n)
        } catch (e: Exception) {
            log("Could not post the notice: ${e.message}")
        }
    }

    private fun refreshTile() {
        try { TileService.requestListeningState(this, ComponentName(this, ShroudlyTileService::class.java)) } catch (_: Exception) {}
    }
}
