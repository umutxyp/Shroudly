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
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.service.quicksettings.TileService
import android.util.Log
import java.io.File
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
 * This app is left out of its own VPN (addDisallowedApplication), so the
 * engine's connections and the encrypted DNS go straight to the network: no
 * loop, and nothing to protect() socket by socket.
 */
class ShroudlyVpnService : VpnService() {
    companion object {
        const val TAG = "Shroudly"
        const val ACTION_START = "me.codeshare.shroudly.START"
        const val ACTION_STOP = "me.codeshare.shroudly.STOP"
        /* Writes the current counters to the log (used by the smoke test). */
        const val ACTION_STATS = "me.codeshare.shroudly.STATS"

        private const val CHANNEL = "protection"
        private const val ALERT_CHANNEL = "alerts"
        private const val NOTIFICATION_ID = 1
        private const val ALERT_ID = 2
        private const val MAX_RESTARTS = 5
        // A STATS left unanswered this long (in uptime, so time asleep does not
        // count) means the engine hangs: treat it like a crash.
        private const val HANG_TIMEOUT_MS = 60000L
        // How often the engine is asked for its counters when nobody is looking:
        // only to know it still answers.
        // With HANG_TIMEOUT_MS, a hung engine is replaced within 70 s.
        private const val IDLE_PROBE_MS = 10000L
        // The tunnel is restarted once; stopping again within this time ends protection.
        private const val TUNNEL_RETRY_WINDOW_MS = 10L * 60 * 1000
        // A network change is acted on once it has been quiet this long: IPv6
        // often arrives a moment after the network itself.
        private const val NET_SETTLE_MS = 3000L
        private const val PREFS = "engine"
        private const val AUTH_FILE = "socks-auth"
        // The pid of the engine last started, so one left over by an earlier
        // app process can be ended before a new one starts.
        private const val PID_KEY = "enginePid"

        fun start(ctx: Context) {
            ctx.startForegroundService(Intent(ctx, ShroudlyVpnService::class.java).setAction(ACTION_START))
        }

        fun stop(ctx: Context) {
            if (Protection.state == Protection.State.OFF) return
            ctx.startService(Intent(ctx, ShroudlyVpnService::class.java).setAction(ACTION_STOP))
        }

        fun log(msg: String) { Log.i(TAG, msg) }

        /* Names of sites and what worked on them: debug builds only, so a
         * release build's log never lists the sites someone opened. */
        private fun logSite(msg: () -> String) { if (BuildConfig.DEBUG) Log.i(TAG, msg()) }

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
    /* For threads other than `work` (the engine's reader, network callbacks):
     * once the service is being destroyed there is nothing left to do. */
    private fun later(block: () -> Unit) {
        try { work.execute(block) } catch (_: RejectedExecutionException) {}
    }

    private var poll: ScheduledFuture<*>? = null
    private var restartCredit: ScheduledFuture<*>? = null
    private var netCheck: ScheduledFuture<*>? = null
    private var pendingLink: LinkProperties? = null

    private var engine: Engine? = null
    private var doh: DohForwarder? = null
    private var tun: ParcelFileDescriptor? = null
    private var tunnelRunning = false
    private var port = 0
    private var dohPort = 0
    private var restarts = 0
    private var auth: SocksAuth? = null
    private var authFile: File? = null
    private var takesAuth = false
    private var takesFakeNet = false
    private var v6Routed = false
    private var network: ConnectivityManager.NetworkCallback? = null
    // Uptime of the oldest STATS not answered yet (0: none), and of the last one sent.
    private var probeSentAt = 0L
    private var lastProbeAt = 0L
    private var tunnelRestartedAt = 0L
    @Volatile private var active = false

    private lateinit var learned: Learned
    private val told = HashSet<String>()

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
                logStats()
                if (!active && Protection.state == Protection.State.OFF) stopSelf()
                return START_NOT_STICKY
            }
            // ACTION_START, the system's always-on VPN, or a restart after the
            // process was killed (START_STICKY): all mean "be on".
            else -> requestStart()
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
            work.execute { teardown() }
        }
        work.shutdown()
        try { work.awaitTermination(5, TimeUnit.SECONDS) } catch (_: InterruptedException) {}
        if (Protection.state != Protection.State.OFF) Protection.set(Protection.State.OFF)
        refreshTile()
        super.onDestroy()
    }

    private fun requestStart() {
        // Owed to startForegroundService() whatever happens next.
        goForeground(starting = Protection.state != Protection.State.ON)
        // Starting or on already; or still stopping, and the window and tile
        // offer Start again once that is done.
        if (Protection.state != Protection.State.OFF) return
        Protection.set(Protection.State.STARTING)
        refreshTile()
        work.execute { startAll() }
    }

    /* errorRes 0: the user asked. Anything else: protection ended on its own,
     * and a notification says so, since the window may not be open. */
    private fun requestStop(errorRes: Int, detail: String?) {
        if (Protection.state == Protection.State.OFF || Protection.state == Protection.State.STOPPING) return
        Protection.set(Protection.State.STOPPING)
        later {
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
    }

    /* ── start ─────────────────────────────────────────────────────────── */

    private fun startAll() {
        try {
            val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
            learned = Learned(prefs.getString("learned", null))
            told.clear()
            restarts = 0
            tunnelRestartedAt = 0

            val bin = File(applicationInfo.nativeLibraryDir, Engine.NAME)
            if (!bin.canExecute()) throw StartError("engine not found at ${bin.path}")
            endLeftover()

            takesAuth = SocksAuth.supports(bin)
            takesFakeNet = Engine.knows(bin, Engine.FAKE_NET_OPTION)
            if (!takesAuth) log("This engine takes no SOCKS5 password; its port is open to other apps")

            // Encrypted DNS first, so the engine's first lookups have it. If it
            // cannot start, the engine falls back to plain DNS.
            val d = DohForwarder(::log, prefs.getString("dohRoute", null)) { id ->
                prefs.edit().putString("dohRoute", id).apply()
            }
            d.socksAuth = auth
            dohPort = try { d.start() } catch (e: Exception) { log("Encrypted DNS unavailable: ${e.message}"); 0 }
            doh = if (dohPort > 0) d else null

            port = spawnEngine()

            // Makes this app the prepared VPN when the user has already said
            // yes (the window asked); anything else means they have not.
            if (prepare(this) != null) throw StartError("VPN permission is missing", R.string.androidVpnDenied)
            val cm = getSystemService(ConnectivityManager::class.java)
            v6Routed = Net.hasIpv6(cm.getLinkProperties(cm.activeNetwork))
            val pfd = establish(v6Routed) ?: throw StartError("VPN permission is missing", R.string.androidVpnDenied)
            tun = pfd
            startTunnel()
            watchNetwork(cm)

            active = true
            Protection.startedAt = System.currentTimeMillis()
            Protection.set(Protection.State.ON)
            Protection.socksPort = port
            Protection.socksAuth = auth
            clearAlert(this)
            goForeground(starting = false)
            refreshTile()
            probeSentAt = 0
            lastProbeAt = 0
            poll = work.scheduleWithFixedDelay({ tick() }, 1, 1, TimeUnit.SECONDS)
            log("Protection on: engine on 127.0.0.1:$port${if (auth != null) " (password)" else ""}, " +
                "encrypted DNS on ${if (dohPort > 0) "127.0.0.1:$dohPort" else "none"}, IPv6 ${if (v6Routed) "routed" else "off"}")
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

    /* Starts an engine with a new password on a new free port, and returns
     * the port. Every start, restarts included, gets both new: whoever takes
     * an old port meanwhile learns nothing that still works. Another free
     * port is taken if the chosen one is gone by the time the engine binds. */
    private fun spawnEngine(): Int {
        val bin = File(applicationInfo.nativeLibraryDir, Engine.NAME)
        val blockIps = blockIps()
        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        auth = if (takesAuth) SocksAuth.random() else null
        authFile = auth?.let { a -> File(filesDir, AUTH_FILE).also { a.writeTo(it) } }
        val fakeNet = if (takesFakeNet) Engine.FAKE_NET else null
        for (attempt in 0..3) {
            val p = Engine.freePort()
            val e = Engine(bin, ::log, ::onEngineEvent, ::onEngineExit)
            engine = e
            val ok = e.start(Engine.args(p, dohPort, blockIps, authFile, fakeNet)) { pid ->
                prefs.edit().putInt(PID_KEY, pid).apply()
            }
            if (ok) {
                doh?.socksAuth = auth
                doh?.socksPort = p
                probeSentAt = 0
                return p
            }
            engine = null
            val err = e.lastError ?: "engine failed to start"
            // start() ends a failed engine itself; one that would not end must
            // not be joined by another.
            if (e.running) throw StartError("the engine (pid ${e.pid}) could not be ended: $err", R.string.androidProtectionLost)
            if (!err.contains("listen failed") || attempt == 3) throw StartError(err)
        }
        throw StartError("engine failed to start")
    }

    /* An engine left by an earlier process of this app (it ends by itself when
     * its stdin closes, but not if it hangs). */
    private fun endLeftover() {
        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        val pid = prefs.getInt(PID_KEY, 0)
        if (pid > 0 && Engine.isEngine(pid)) {
            log("Ending an engine left running (pid $pid)")
            try { Engine.sigkill(pid) } catch (e: Exception) { log("Could not end it: ${e.message}") }
        }
        prefs.edit().remove(PID_KEY).apply()
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
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) b.setMetered(false)
        return b.establish()
    }

    private fun startTunnel() {
        val pfd = tun ?: throw StartError("no VPN interface")
        val conf = File(filesDir, "tunnel.yml")
        val a = auth
        conf.writeText(TunnelConfig.yaml(port, user = a?.user, pass = a?.pass))
        if (!Tun2Socks.TProxyStartService(conf.absolutePath, pfd.fd)) throw StartError("tunnel failed to start")
        tunnelRunning = true
        // A bad setting ends its thread at once; better to know now than to
        // show "Protected" over a dead tunnel.
        Thread.sleep(200)
        if (!Tun2Socks.TProxyIsRunning()) {
            stopTunnel()
            throw StartError("tunnel stopped right after starting")
        }
    }

    private fun stopTunnel() {
        if (!tunnelRunning) return
        tunnelRunning = false
        try { Tun2Socks.TProxyStopService() } catch (e: Throwable) { log("tunnel stop: $e") }
    }

    /* ── running ───────────────────────────────────────────────────────── */

    private fun tick() {
        if (!active) return
        if (tunnelRunning && !Tun2Socks.TProxyIsRunning()) {
            onTunnelStopped()
            return
        }
        val e = engine ?: return
        // Ended without its exit being reported, for instance between its
        // start and protection being on.
        if (!e.running) {
            engineGone(e, "is no longer running")
            return
        }
        val now = SystemClock.uptimeMillis()
        if (probeSentAt > 0 && e.lastOutputAt < probeSentAt && now - probeSentAt > HANG_TIMEOUT_MS) {
            probeSentAt = 0
            engineGone(e, "stopped responding")
            return
        }
        // Every second while the window or the tile is looking; otherwise only
        // now and then, to know the engine still answers.
        if (!Protection.hasListeners() && now - lastProbeAt < IDLE_PROBE_MS) return
        if (probeSentAt == 0L || e.lastOutputAt >= probeSentAt) probeSentAt = now
        lastProbeAt = now
        e.send("STATS")
    }

    /* hev's thread ended on its own: every app's traffic would go nowhere. */
    private fun onTunnelStopped() {
        val now = SystemClock.uptimeMillis()
        if (tunnelRestartedAt != 0L && now - tunnelRestartedAt < TUNNEL_RETRY_WINDOW_MS) {
            log("Tunnel stopped again; giving up")
            stopTunnel()
            requestStop(R.string.androidProtectionLost, "the tunnel keeps stopping")
            return
        }
        log("Tunnel stopped unexpectedly; restarting it")
        tunnelRestartedAt = now
        stopTunnel()
        try {
            startTunnel()
        } catch (e: Exception) {
            log("Tunnel restart failed: ${e.message}")
            requestStop(R.string.androidProtectionLost, "the tunnel could not be restarted: ${e.message}")
        }
    }

    /* IPv6 comes and goes with the network (Wi-Fi with it, mobile data
     * without): the interface follows. */
    private fun watchNetwork(cm: ConnectivityManager) {
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onLinkPropertiesChanged(net: Network, lp: LinkProperties) {
                later { onNetwork(net, lp) }
            }

            override fun onLost(net: Network) {
                later {
                    if (!active) return@later
                    setUnderlyingNetworks(null)
                    netCheck?.cancel(false); netCheck = null
                }
            }
        }
        try {
            cm.registerDefaultNetworkCallback(cb)
            network = cb
        } catch (e: Exception) {
            log("Cannot follow network changes: ${e.message}")
        }
    }

    private fun onNetwork(net: Network, lp: LinkProperties) {
        if (!active) return
        setUnderlyingNetworks(arrayOf(net))
        // Rebuilt only once the network has settled, and only if whether IPv6
        // goes into the tunnel has changed by then.
        pendingLink = lp
        netCheck?.cancel(false)
        netCheck = work.schedule({ onNetworkSettled() }, NET_SETTLE_MS, TimeUnit.MILLISECONDS)
    }

    private fun onNetworkSettled() {
        netCheck = null
        val lp = pendingLink ?: return
        pendingLink = null
        if (!active) return
        val v6 = Net.hasIpv6(lp)
        if (v6 == v6Routed) return
        log("IPv6 ${if (v6) "available" else "gone"} on this network; renewing the VPN interface")
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
                requestStop(R.string.androidProtectionLost, "the tunnel could not be restarted: ${e.message}")
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
        later { engineGone(e, "exited unexpectedly (code $code)") }
    }

    /* The engine `e` crashed, hung or vanished. Runs on `work`, so one at a
     * time; `engine` is cleared at once, so a second report about the same
     * engine is ignored, and a restart is the only one in progress until it
     * has set a new engine. */
    private fun engineGone(e: Engine, why: String) {
        if (!active || e !== engine) return
        engine = null
        log("Engine $why")
        // Nothing goes to the old port while it may belong to someone else:
        // the tunnel pauses (apps' connections wait) until the new engine is up.
        stopTunnel()
        doh?.socksPort = 0
        Protection.socksPort = 0
        Protection.socksAuth = null
        if (!e.kill()) {
            requestStop(R.string.androidProtectionLost, "the engine (pid ${e.pid}) could not be ended")
            return
        }
        scheduleRestart()
    }

    private fun scheduleRestart() {
        if (restarts >= MAX_RESTARTS) {
            log("Engine keeps crashing; giving up")
            requestStop(R.string.androidProtectionLost, "the engine keeps crashing")
            return
        }
        restarts++
        val delay = minOf(500L * restarts, 4000L)
        log("Restarting engine in ${delay}ms (attempt $restarts/$MAX_RESTARTS)")
        work.schedule({ restartEngine() }, delay, TimeUnit.MILLISECONDS)
    }

    /* A new engine on a new port with a new password, then the tunnel again
     * with those. hev's name table starts over, so apps' stand-in addresses
     * from before go stale: the engine refuses them at once (--fake-net),
     * and apps look the names up again. */
    private fun restartEngine() {
        if (!active || engine != null) return
        try {
            port = spawnEngine()
        } catch (e: StartError) {
            log("Restart failed: ${e.message}")
            if (e.res == R.string.androidProtectionLost) requestStop(e.res, e.message) else scheduleRestart()
            return
        } catch (e: Exception) {
            log("Restart failed: $e")
            scheduleRestart()
            return
        }
        try {
            startTunnel()
        } catch (e: Exception) {
            log("Tunnel restart failed: ${e.message}")
            requestStop(R.string.androidProtectionLost, "the tunnel could not be restarted: ${e.message}")
            return
        }
        Protection.socksPort = port
        Protection.socksAuth = auth
        log("Engine back on 127.0.0.1:$port${if (auth != null) " with a new password" else ""}; tunnel renewed")
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

    /* ── stop ──────────────────────────────────────────────────────────── */

    /* Undoes whatever startAll did, in reverse: the tunnel first so apps stop
     * sending into it, then the interface, so traffic goes direct again. */
    private fun teardown() {
        val wasActive = active
        active = false
        poll?.cancel(false); poll = null
        restartCredit?.cancel(false); restartCredit = null
        netCheck?.cancel(false); netCheck = null
        pendingLink = null
        network?.let { cb ->
            try { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(cb) } catch (_: Exception) {}
        }
        network = null
        stopTunnel()
        try { tun?.close() } catch (_: Exception) {}
        tun = null
        val total = Protection.stats?.connsTotal
        engine?.let { e ->
            if (e.stop()) getSharedPreferences(PREFS, MODE_PRIVATE).edit().remove(PID_KEY).apply()
            else log("The engine (pid ${e.pid}) could not be ended")
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

    private fun goForeground(starting: Boolean) {
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
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            try {
                startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SYSTEM_EXEMPTED)
            } catch (e: Exception) {
                // Not eligible on this device: the declared special use (a VPN).
                startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
            }
        } else {
            startForeground(NOTIFICATION_ID, n)
        }
    }

    /* Protection ended without the user asking: the ongoing notification goes
     * away with the service, so this one tells them their apps now connect
     * directly. Tapping it opens the window. */
    private fun notifyStopped(errorRes: Int) {
        // The open window shows the reason itself.
        if (Protection.windowVisible) return
        try {
            channels(this)
            val text = getString(errorRes)
            val n = Notification.Builder(this, ALERT_CHANNEL)
                .setSmallIcon(R.drawable.ic_shield)
                .setContentTitle(getString(R.string.protectionStopped))
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
