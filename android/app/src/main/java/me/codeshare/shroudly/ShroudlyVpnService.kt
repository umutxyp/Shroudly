package me.codeshare.shroudly

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.service.quicksettings.TileService
import android.util.Log
import java.io.File
import java.util.concurrent.Executors
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
        private const val NOTIFICATION_ID = 1
        private const val MAX_RESTARTS = 5
        // No output at all for this long, although STATS is asked every second,
        // means the engine hangs: treat it like a crash.
        private const val HANG_TIMEOUT_MS = 60000L
        private const val PREFS = "engine"

        fun start(ctx: Context) {
            ctx.startForegroundService(Intent(ctx, ShroudlyVpnService::class.java).setAction(ACTION_START))
        }

        fun stop(ctx: Context) {
            if (Protection.state == Protection.State.OFF) return
            ctx.startService(Intent(ctx, ShroudlyVpnService::class.java).setAction(ACTION_STOP))
        }

        fun log(msg: String) { Log.i(TAG, msg) }
    }

    // Starts, stops and restarts run one at a time, in order.
    private val work: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "shroudly-service").apply { isDaemon = true }
    }
    private var poll: ScheduledFuture<*>? = null
    private var restartCredit: ScheduledFuture<*>? = null

    private var engine: Engine? = null
    private var doh: DohForwarder? = null
    private var tun: ParcelFileDescriptor? = null
    private var tunnelRunning = false
    private var port = 0
    private var dohPort = 0
    private var restarts = 0
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

    private fun requestStop(errorRes: Int, detail: String?) {
        if (Protection.state == Protection.State.OFF || Protection.state == Protection.State.STOPPING) return
        Protection.set(Protection.State.STOPPING)
        work.execute {
            teardown()
            Protection.set(Protection.State.OFF)
            if (errorRes != 0) Protection.fail(errorRes, detail)
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

            val bin = File(applicationInfo.nativeLibraryDir, "libshroudlycore.so")
            if (!bin.canExecute()) throw StartError("engine not found at ${bin.path}")

            // Encrypted DNS first, so the engine's first lookups have it. If it
            // cannot start, the engine falls back to plain DNS.
            val d = DohForwarder(::log, prefs.getString("dohRoute", null)) { id ->
                prefs.edit().putString("dohRoute", id).apply()
            }
            dohPort = try { d.start() } catch (e: Exception) { log("Encrypted DNS unavailable: ${e.message}"); 0 }
            doh = if (dohPort > 0) d else null

            port = spawnEngine(Engine.freePort())

            // Makes this app the prepared VPN when the user has already said
            // yes (the window asked); anything else means they have not.
            if (prepare(this) != null) throw StartError("VPN permission is missing")
            val pfd = establish() ?: throw StartError("VPN permission is missing")
            tun = pfd
            startTunnel()

            active = true
            Protection.socksPort = port
            Protection.startedAt = System.currentTimeMillis()
            Protection.set(Protection.State.ON)
            goForeground(starting = false)
            refreshTile()
            poll = work.scheduleWithFixedDelay({ tick() }, 1, 1, TimeUnit.SECONDS)
            log("Protection on: engine on 127.0.0.1:$port, encrypted DNS on ${if (dohPort > 0) "127.0.0.1:$dohPort" else "none"}")
        } catch (e: Exception) {
            val detail = (e as? StartError)?.message ?: e.toString()
            log("Could not start protection: $detail")
            teardown()
            Protection.set(Protection.State.OFF)
            Protection.fail(R.string.startFailed, detail)
            finish()
        }
    }

    private class StartError(msg: String) : Exception(msg)

    /* Starts the engine on `want`, or on another free port if that one is
     * taken by the time it binds. Returns the port it listens on. */
    private fun spawnEngine(want: Int): Int {
        val bin = File(applicationInfo.nativeLibraryDir, "libshroudlycore.so")
        val blockIps = blockIps()
        var p = want
        for (attempt in 0..3) {
            val e = Engine(bin, ::log, ::onEngineEvent, ::onEngineExit)
            engine = e
            if (e.start(Engine.args(p, dohPort, blockIps))) {
                doh?.socksPort = p
                return p
            }
            engine = null
            val err = e.lastError ?: "engine failed to start"
            if (!err.contains("listen failed") || attempt == 3) throw StartError(err)
            p = Engine.freePort()
        }
        throw StartError("engine failed to start")
    }

    private fun blockIps(): List<String> = try {
        assets.open("block-ips.txt").bufferedReader().readLines().map { it.trim() }.filter { it.isNotEmpty() && !it.startsWith("#") }
    } catch (_: Exception) {
        emptyList()
    }

    private fun establish(): ParcelFileDescriptor? {
        val b = Builder()
            .setSession(getString(R.string.app_name))
            .setMtu(TunnelConfig.MTU)
            .addAddress(TunnelConfig.ADDRESS_V4, 32)
            .addAddress(TunnelConfig.ADDRESS_V6, 128)
            .addRoute("0.0.0.0", 0)
            .addRoute("::", 0)
            .addDnsServer(TunnelConfig.DNS_V4)
            .addDisallowedApplication(packageName)
            .setConfigureIntent(openApp())
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) b.setMetered(false)
        return b.establish()
    }

    private fun startTunnel() {
        val pfd = tun ?: throw StartError("no VPN interface")
        val conf = File(filesDir, "tunnel.yml")
        conf.writeText(TunnelConfig.yaml(port))
        if (!Tun2Socks.TProxyStartService(conf.absolutePath, pfd.fd)) throw StartError("tunnel failed to start")
        tunnelRunning = true
    }

    private fun stopTunnel() {
        if (!tunnelRunning) return
        tunnelRunning = false
        try { Tun2Socks.TProxyStopService() } catch (e: Throwable) { log("tunnel stop: $e") }
    }

    /* ── running ───────────────────────────────────────────────────────── */

    private fun tick() {
        val e = engine ?: return
        if (!active) return
        if (System.currentTimeMillis() - e.lastOutputAt > HANG_TIMEOUT_MS) {
            log("Engine stopped responding; restarting it")
            e.kill()
            return
        }
        e.send("STATS")
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
                restartCredit?.cancel(false)
                restartCredit = work.schedule({ restarts = 0 }, 120, TimeUnit.SECONDS)
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
                if (first) log("${ev.host}: blocked here, opened with ${ev.strategy} (${ev.attempts} tries, ${ev.family})")
            }
            "blocked" -> if (first) log(
                when {
                    ev.alert -> "${ev.host}: the server refused the connection itself; not a block"
                    ev.note == "silent" -> "${ev.host}: no answer after ${ev.attempts} techniques (${ev.family})"
                    else -> "${ev.host}: still blocked after ${ev.attempts} techniques (${ev.family})"
                }
            )
            "unreachable" -> if (first) log("${ev.host}: could not be reached (${if (ev.stage == "dns") "DNS" else "connection"})")
            "cut" -> if (first) log("${ev.host}: connects, then the network cuts it (${ev.strategy})")
            else -> {}
        }
    }

    /* Called on the engine's reader thread. */
    private fun onEngineExit(code: Int) {
        if (!active) return
        log("Engine exited unexpectedly (code $code)")
        if (restarts >= MAX_RESTARTS) {
            log("Engine keeps crashing; giving up")
            requestStop(R.string.startFailed, "the engine keeps crashing")
            return
        }
        restarts++
        val delay = minOf(500L * restarts, 4000L)
        log("Restarting engine in ${delay}ms (attempt $restarts/$MAX_RESTARTS)")
        work.schedule({ restartEngine() }, delay, TimeUnit.MILLISECONDS)
    }

    private fun restartEngine() {
        if (!active) return
        try {
            val before = port
            port = spawnEngine(before)
            if (port != before) {
                // The tunnel still points at the old port.
                stopTunnel()
                startTunnel()
            }
            Protection.socksPort = port
        } catch (e: Exception) {
            log("Restart failed: ${e.message}")
            onEngineExit(-1)
        }
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
        stopTunnel()
        try { tun?.close() } catch (_: Exception) {}
        tun = null
        val total = Protection.stats?.connsTotal
        engine?.stop(); engine = null
        doh?.stop(); doh = null
        dohPort = 0
        if (wasActive) log("Protection off${if (total != null) "; $total connections relayed" else ""}")
    }

    /* ── notification and tile ─────────────────────────────────────────── */

    private fun openApp(): PendingIntent = PendingIntent.getActivity(
        this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun goForeground(starting: Boolean) {
        val nm = getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL, getString(R.string.navProtection), NotificationManager.IMPORTANCE_LOW).apply {
                    setShowBadge(false)
                },
            )
        }
        val stopIntent = PendingIntent.getService(
            this, 1, Intent(this, ShroudlyVpnService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val n = Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_shield)
            .setContentTitle(getString(if (starting) R.string.starting else R.string.protected_))
            .setContentText(getString(R.string.androidAllApps))
            .setContentIntent(openApp())
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

    private fun refreshTile() {
        try { TileService.requestListeningState(this, ComponentName(this, ShroudlyTileService::class.java)) } catch (_: Exception) {}
    }
}
