package me.codeshare.shroudly

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.IBinder
import android.os.SystemClock
import android.service.quicksettings.TileService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/*
 * "Proxy only" (Settings): the engine as a proxy on this phone, with no VPN,
 * so the VPN slot stays free for another VPN app (issue #31). It listens on
 * 127.0.0.1:<port> for SOCKS5 and HTTP CONNECT; apps set to use it (the
 * Wi-Fi network's proxy, a browser's or an app's own proxy setting, a VPN
 * app that takes an upstream proxy) go through Shroudly, the rest connect as
 * they would without it.
 *
 * VpnService is never touched here: preparing it would make Shroudly the
 * phone's VPN app and end the other one. The engine, encrypted DNS, the ad
 * blocker, the technique and the live count are the VPN mode's own.
 *
 * Like the desktop's port, this one takes no password: any app on this phone
 * can use it, none from outside (it listens on 127.0.0.1 only).
 */
class ShroudlyProxyService : Service() {
    companion object {
        const val ACTION_START = "me.codeshare.shroudly.PROXY_START"
        const val ACTION_STOP = "me.codeshare.shroudly.PROXY_STOP"
        // Its own notice: never the VPN's (ShroudlyVpnService.NOTIFICATION_ID),
        // so taking this one away never takes that one too.
        private const val NOTIFICATION_ID = 4
        // The reminder that a network's proxy still points here (6: 5 is the
        // automation apps' notice).
        private const val WIFI_NOTICE_ID = 6
        // Ended by itself, while no window said so (notifyStopped).
        private const val STOPPED_NOTICE_ID = 8

        fun start(ctx: Context) {
            ctx.startForegroundService(Intent(ctx, ShroudlyProxyService::class.java).setAction(ACTION_START))
        }

        fun stop(ctx: Context) {
            if (Protection.state == Protection.State.OFF) return
            ctx.startService(Intent(ctx, ShroudlyProxyService::class.java).setAction(ACTION_STOP))
        }

        /* The window is open, or protection on again: the notice that it
         * ended by itself has been seen to. */
        fun clearAlert(ctx: Context) {
            try { ctx.getSystemService(android.app.NotificationManager::class.java)?.cancel(STOPPED_NOTICE_ID) } catch (_: Exception) {}
        }
    }

    // Starts, stops and restarts one at a time, in order.
    private val work = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "proxy-service").apply { isDaemon = true } }
    private var engine: Engine? = null
    private var doh: DohForwarder? = null
    // "Your own server" for this session (OwnServer).
    private val ownServer by lazy { OwnServer.Session(filesDir, ::log) }
    private var port = 0
    private var dohPort = 0
    private var restarts = 0
    private var poll: ScheduledFuture<*>? = null
    private var restartCredit: ScheduledFuture<*>? = null
    // The last STATS sent (uptime) while unanswered, and the last one at all.
    private var probeSentAt = 0L
    private var lastProbeAt = 0L
    // What worked per site, shared with the VPN mode (the same "engine" prefs).
    private lateinit var learned: Learned
    private lateinit var learnedRaw: Learned
    private val told = HashSet<String>()
    private val adblockCheck = java.util.concurrent.atomic.AtomicReference<java.util.concurrent.CompletableFuture<EngineEvent.AdblockCheck>?>(null)
    private val adblockFetching = java.util.concurrent.atomic.AtomicBoolean(false)
    @Volatile private var active = false
    // This session has been counted as a day protection worked (Usage).
    @Volatile private var workedToday = false
    // When the services last looked at the store flag and notice (uptime).
    private var storeLookAt = 0L
    // The networks underneath (with internet, not a VPN): when the last one
    // goes, KeepOn waits for one to bring protection back (issue #39), as in
    // VPN mode. And the phone's network as last looked at, with those it
    // moved on from while apps' connections still worked there (Handover).
    private var network: NetWatch? = null
    private val networks = HashSet<Network>()
    private var current: Network? = null
    private val kept = HashSet<Network>()
    private var netCheck: ScheduledFuture<*>? = null

    override fun onBind(intent: Intent?): IBinder? = null

    // In the language chosen in Settings (Lang; before Android 13).
    override fun attachBaseContext(base: Context) = super.attachBaseContext(Lang.wrap(base))

    override fun onCreate() {
        super.onCreate()
        ShroudlyVpnService.attachLog(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> { work.execute { stopAll(byUser = true) }; return START_NOT_STICKY }
            // The ad blocker's switch or its exceptions (MainActivity), as in VPN mode.
            ShroudlyVpnService.ACTION_ADBLOCK -> {
                work.execute { if (active) { applyAdblock(); refreshAdblockSoon() } }
                if (!active && Protection.state == Protection.State.OFF) stopSelf()
                return if (active) START_STICKY else START_NOT_STICKY
            }
            // The counters in the app's log (debug control, the emulator tests).
            ShroudlyVpnService.ACTION_STATS -> {
                work.execute { if (active) { engine?.send("STATS"); work.schedule({ logStats() }, 500, TimeUnit.MILLISECONDS) } }
                if (!active && Protection.state == Protection.State.OFF) stopSelf()
                return if (active) START_STICKY else START_NOT_STICKY
            }
            // Debug builds: the engine's run returns, as if it had crashed.
            ShroudlyVpnService.ACTION_TEST -> {
                if (BuildConfig.DEBUG && intent.getStringExtra("what") == "engine-stop") work.execute {
                    if (active) { log("test: stopping the engine under the service"); engine?.send("STOP") }
                }
                if (!active && Protection.state == Protection.State.OFF) stopSelf()
                return if (active) START_STICKY else START_NOT_STICKY
            }
            // A new technique (Settings): the engine again, on the same port.
            ShroudlyVpnService.ACTION_SETTINGS -> {
                if (intent.getStringExtra("what") == "strategy") work.execute { restartEngine("restarted with the technique chosen in Settings") }
                if (intent.getStringExtra("what") == "network") work.execute { restartEngine("restarted with the network settings chosen in Settings") }
                if (intent.getStringExtra("what") == "ownServer") work.execute { restartEngine("restarted with the server chosen in Settings") }
                // Another DNS server: from the next lookup on, nothing restarted.
                if (intent.getStringExtra("what") == "dns") work.execute { if (active) { doh?.let { AppSettings.applyDns(this, it) }; engine?.send(if (AppSettings.customDnsStrict(this)) "DNS-STRICT 1" else "DNS-STRICT 0"); engine?.send("DNS-CLEAR") } }
                if (!active && Protection.state == Protection.State.OFF) stopSelf()
                return if (active) START_STICKY else START_NOT_STICKY
            }
        }
        // Android started it again after it ended the app (low on memory, a
        // cleaner; START_STICKY below): on again only if the user has not
        // turned it off, nor chosen the VPN, since. A network's proxy that
        // points here reaches nothing while it is off, so apps that use it
        // would have no connection at all.
        val again = intent == null
        if (again && (!KeepOn.wanted(this) || !AppSettings.proxyOnly(this) || active)) {
            if (!active) stopSelf()
            return if (active) START_STICKY else START_NOT_STICKY
        }
        if (again) { log("Android started Proxy only again after it ended the app"); Usage.endedByAndroid(this) }
        // A start owes Android the foreground at once (a second start while
        // on keeps the notice as it is).
        if (goForeground(starting = !active) != null) {
            // From the background Android may refuse it (Android 12+, unless
            // the app's battery use is unrestricted): a notice offers it.
            if (again) KeepOn.offer(this)
            else Protection.fail(R.string.androidProxyOnlyNotStarted, "Android refused the foreground service")
            stopSelf()
            return START_NOT_STICKY
        }
        work.execute { startAll() }
        return START_STICKY
    }

    private fun log(msg: String) = ShroudlyVpnService.log(msg)

    private fun startAll() {
        if (active) return
        // The VPN mode runs (the mode was changed in Settings while on): it
        // stays as it is; this one leaves the foreground it was owed.
        if (Protection.state != Protection.State.OFF && !Protection.proxyOnly) {
            log("Proxy only: not started, the VPN is on")
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return
        }
        Protection.set(Protection.State.STARTING)
        Protection.proxyOnly = true
        Protection.trouble(0)
        try {
            EngineNative.loadError?.let { throw IllegalStateException("the engine library could not be loaded: $it") }
            if (Engine.busy) throw IllegalStateException("an earlier engine run has not stopped")
            val prefs = getSharedPreferences("engine", Context.MODE_PRIVATE)
            learned = Learned(prefs.getString("learned", null))
            learnedRaw = Learned(prefs.getString("learnedRaw", null), ShroudlyVpnService.LEARNED_RAW_MAX)
            synchronized(told) { told.clear() }
            workedToday = false
            val d = DohForwarder(::log, prefs.getString("dohRoute", null)) { id -> prefs.edit().putString("dohRoute", id).apply() }
            AppSettings.applyDns(this, d)
            dohPort = try { d.start() } catch (e: Exception) { log("Encrypted DNS unavailable: ${e.message}"); 0 }
            doh = if (dohPort > 0) d else null
            val wanted = ProxyPort.remembered(this)
            port = spawn(wanted)
            ProxyPort.remember(this, port)
            active = true
            restarts = 0
            poll = work.scheduleWithFixedDelay({ tick() }, 1, 1, TimeUnit.SECONDS)
            Protection.startedAt = SystemClock.elapsedRealtime()
            Protection.set(Protection.State.ON)
            KeepOn.on(this)
            clearAlert(this)
            Protection.proxyOnly = true
            Protection.socksPort = port
            Protection.socksAuth = null
            Protection.proxyPortTaken = if (port != wanted) wanted else 0
            watchNetwork()
            if (current == null) Protection.trouble(R.string.androidNoNetwork)
            log("Proxy only: Shroudly listens on 127.0.0.1:$port (SOCKS5 and HTTP); the VPN slot is left free")
            OnlineCount.sync(this)
            goForeground(starting = false)
            refreshTile()
            refreshAdblockSoon()
        } catch (e: Exception) {
            log("Proxy only: could not start: ${e.message}")
            cleanup()
            Protection.set(Protection.State.OFF)
            Protection.fail(R.string.androidProxyOnlyNotStarted, e.message)
            notifyStopped(R.string.androidProxyOnlyNotStarted, R.string.startFailed)
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            refreshTile()
        }
    }

    /* The engine on `first` (the port apps are set to: the one used last,
     * or the one it had before a restart), or on the next free one close by
     * when another app holds it (ProxyPort), or any free one at last. */
    private fun spawn(first: Int): Int {
        val blockIps = try {
            assets.open("block-ips.txt").bufferedReader().readLines().map { it.trim() }.filter { it.isNotEmpty() && !it.startsWith("#") }
        } catch (_: Exception) { emptyList() }
        val ports = ProxyPort.candidates(first).asSequence().filter { ProxyPort.free(it) } + generateSequence { Engine.freePort() }.take(2)
        val p = ProxyPort.listenOn(ports) { at ->
            val e = Engine(::log, ShroudlyVpnService::logSite, ::onEvent, ::onExit)
            engine = e
            val upstream = ownServer.fileFor(AppSettings.ownServer(this))
            // No password and no stand-in range: apps reach it by name or address.
            val started = e.start(Engine.args(at, dohPort, blockIps, null, null, AdBlock.listFile(this), AdBlock.allow(this), AppSettings.strategy(this), AppSettings.customDnsStrict(this), AppSettings.quicOff(this), AppSettings.ipv6Off(this), upstream, AppSettings.decoyNames(this)))
            upstream?.delete()
            if (started) {
                doh?.socksPort = at
                doh?.socksAuth = null
                // Working through the user's own server: the address sites see.
                if (upstream != null) ownServer.watchExit(at, null) else ownServer.stopExit()
                ProxyPort.Tried(ok = true)
            } else {
                engine = null
                // A run that would not stop holds the engine's state: no other can start.
                ProxyPort.Tried(ok = false, stillRunning = e.running || Engine.busy, error = e.lastError)
            }
        }
        if (p != first) log("Port $first is taken by another app; Shroudly listens on 127.0.0.1:$p instead")
        return p
    }

    private fun onEvent(ev: EngineEvent) {
        when (ev) {
            is EngineEvent.Ready -> {
                // What worked on sites before, as the VPN mode restores it.
                val now = System.currentTimeMillis()
                val cmds = synchronized(learnedRaw) { learnedRaw.commands(now) } + synchronized(learned) { learned.commands(now) }
                if (cmds.isNotEmpty()) {
                    engine?.send(cmds.joinToString("\n"))
                    log("Techniques remembered for ${cmds.size} sites restored")
                }
                // A session that has been up a while has earned a fresh restart budget.
                try {
                    work.execute {
                        restartCredit?.cancel(false)
                        restartCredit = work.schedule({ restarts = 0 }, 120, TimeUnit.SECONDS)
                    }
                } catch (_: RejectedExecutionException) {}
            }
            is EngineEvent.Host -> onHost(ev)
            is EngineEvent.NetDns -> ShroudlyVpnService.logSite(NetDnsText.line(ev))
            is EngineEvent.UdpFull -> log(ev.line)
            is EngineEvent.Stats -> {
                // Carried traffic: a day protection worked (Usage), once a session.
                if (ev.bytesDown > 0 && !workedToday && active && Protection.troubleRes == 0) { workedToday = true; Usage.worked(this) }
                Protection.stats = ev
                Protection.changed()
            }
            is EngineEvent.Adblock -> when {
                ev.error != null -> log("Ad blocking: the list could not be used (${ev.error})")
                ev.on -> log("Ad blocking: a list of ${ev.entries} names in use")
            }
            is EngineEvent.AdblockCheck -> adblockCheck.getAndSet(null)?.complete(ev)
            is EngineEvent.Error -> log("engine: ${ev.message}")
            is EngineEvent.Upstream -> if (!ev.ok) ownServer.down(OwnServer.whyCode(ev.why))
            else -> {}
        }
    }

    /* A technique that opened a site is kept (and used again after a
     * restart, in either mode); what did not work goes to the app's log, once
     * per site, as in the VPN mode. */
    private fun onHost(ev: EngineEvent.Host) {
        val first = synchronized(told) {
            if (told.size > 400) told.clear()
            told.add("${ev.kind} ${ev.host}")
        }
        when (ev.kind) {
            "bypass" -> {
                val raw = ev.strategy.startsWith("raw-")
                val store = if (raw) learnedRaw else learned
                synchronized(store) {
                    store.remember(ev.host, ev.strategy, System.currentTimeMillis())
                    getSharedPreferences("engine", Context.MODE_PRIVATE).edit().putString(if (raw) "learnedRaw" else "learned", store.encode()).apply()
                }
                if (first) ShroudlyVpnService.logSite("${ev.host}: blocked here, opened with ${ev.strategy} (${ev.attempts} tries, ${ev.family})")
            }
            "blocked" -> if (first) ShroudlyVpnService.logSite(when {
                ev.alert -> "${ev.host}: the server refused the connection itself; not a block"
                ev.note == "silent" -> "${ev.host}: no answer after ${ev.attempts} techniques (${ev.family})"
                else -> "${ev.host}: still blocked after ${ev.attempts} techniques (${ev.family})"
            })
            "unreachable" -> if (first) ShroudlyVpnService.logSite("${ev.host}: could not be reached (${if (ev.stage == "dns") "DNS" else "connection"})")
            "cut" -> if (first) ShroudlyVpnService.logSite("${ev.host}: connects, then the network cuts it (${ev.strategy})")
            else -> {}
        }
    }

    private fun onExit(e: Engine, code: Int) {
        try { work.execute { engineGone(e, "stopped on its own (code $code)") } } catch (_: RejectedExecutionException) {}
    }

    /* Every second: the engine still runs and answers, encrypted DNS still
     * serves, and the counters while the window or the tile is looking (now
     * and then otherwise), as the VPN mode's tick does. */
    private fun tick() {
        if (!active) return
        // Now and then: Google Play's flag and the suggestion's notice
        // (StoreCards), and the APK's update looked for (ApkUpdates).
        val up = SystemClock.uptimeMillis()
        if (storeLookAt == 0L || up - storeLookAt >= StoreCards.LOOK_EVERY_MS) { storeLookAt = up; StoreCards.look(this, port, null); ApkUpdates.look(this, port, null) }
        val e = engine ?: return
        if (!e.running) { engineGone(e, "is no longer running"); return }
        val now = SystemClock.uptimeMillis()
        if (probeSentAt > 0 && e.lastOutputAt < probeSentAt && now - probeSentAt > ShroudlyVpnService.HANG_TIMEOUT_MS) {
            engineGone(e, "stopped answering its commands")
            return
        }
        doh?.let { d ->
            if (!d.serving && dohPort > 0) {
                log("Encrypted DNS stopped; starting it again on 127.0.0.1:$dohPort")
                if (!d.restart(dohPort)) log("Encrypted DNS could not start again; the engine uses plain DNS")
            }
        }
        if (!Protection.hasListeners() && now - lastProbeAt < ShroudlyVpnService.IDLE_PROBE_MS) return
        if (probeSentAt == 0L || e.lastOutputAt >= probeSentAt) probeSentAt = now
        lastProbeAt = now
        e.send("STATS")
    }

    /* The engine ended or stopped answering: started again on the port apps
     * are set to, a few times with a growing pause; then protection ends and
     * says so. */
    private fun engineGone(e: Engine, why: String) {
        if (!active || e !== engine) return
        engine = null
        probeSentAt = 0
        log("Engine $why")
        if (!e.stop()) { stopAll(byUser = false, why = "the engine $why and did not stop when told to"); return }
        if (restarts >= ShroudlyVpnService.MAX_RESTARTS) {
            log("Engine keeps stopping; giving up")
            stopAll(byUser = false, why = "the engine keeps stopping")
            return
        }
        restarts++
        val delay = minOf(500L * restarts, 4000L)
        log("Restarting engine in ${delay}ms (attempt $restarts/${ShroudlyVpnService.MAX_RESTARTS})")
        work.schedule({ respawn() }, delay, TimeUnit.MILLISECONDS)
    }

    private fun respawn() {
        if (!active || engine != null) return
        val before = port
        try {
            port = spawn(before)
            Protection.socksPort = port
            // Taken meanwhile by another app (spawn said which port it is on now).
            if (port != before) {
                ProxyPort.remember(this, port)
                Protection.proxyPortTaken = before
                Protection.changed()
                goForeground(starting = false)
            }
        } catch (x: Exception) {
            log("Restart failed: ${x.message}")
            stopAll(byUser = false, why = "the engine could not start again: ${x.message}")
        }
    }

    private fun stopAll(byUser: Boolean, why: String? = null) {
        // Not running (a failed start already said so): nothing of the VPN's is touched.
        if (!active) { stopSelf(); return }
        val was = port
        Protection.set(Protection.State.STOPPING)
        if (byUser) KeepOn.stoppedByUser(this) else KeepOn.endedByItself(this)
        OnlineCount.stop(leave = byUser, port = port, auth = null)
        cleanup()
        Protection.set(Protection.State.OFF)
        if (!byUser) Protection.fail(R.string.androidProxyOnlyLost, why ?: "the engine kept stopping")
        log("Proxy only: off")
        stopForeground(STOP_FOREGROUND_REMOVE)
        if (byUser) remindNetworkProxy(was) else notifyStopped()
        stopSelf()
        refreshTile()
    }

    /* Turned off by the user while a network's proxy still points at the
     * port Shroudly listened on (the Wi-Fi's, set for Proxy only): nothing
     * listens there now, and apps that use it reach nothing until the user
     * sets it back to None, which only they can. Said in a notice that opens
     * the Wi-Fi settings. */
    private fun remindNetworkProxy(was: Int) {
        val addr = listOf(was, ProxyPort.remembered(this), ProxyPort.DEFAULT).filter { it > 0 }.distinct().firstNotNullOfOrNull { ProxyCheck.pointsAt(this, it) } ?: return
        log("Proxy only is off, and a network's proxy still points at $addr")
        try {
            ShroudlyVpnService.channels(this)
            val open = PendingIntent.getActivity(
                this, 7, Intent(android.provider.Settings.ACTION_WIFI_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            val body = text(R.string.androidProxyOnlyOffWifi, "addr" to addr)
            val n = Notification.Builder(this, ShroudlyVpnService.ALERT_CHANNEL)
                .setSmallIcon(R.drawable.ic_shield)
                .setContentTitle(getString(R.string.androidWifiProxyDeadTitle))
                .setContentText(body)
                .setStyle(Notification.BigTextStyle().bigText(body))
                .setContentIntent(open)
                .setAutoCancel(true)
                .setColor(Accent.swatch(this))
                .build()
            getSystemService(android.app.NotificationManager::class.java).notify(WIFI_NOTICE_ID, n)
        } catch (e: Exception) {
            log("Could not post the notice: ${e.message}")
        }
    }

    /* Ended by itself (an engine that kept stopping, a start that failed):
     * apps set to use it now reach nothing, unlike the VPN's, which then
     * connect directly. Said in a notice, since the window may not be open;
     * a tap opens it, where Start turns it on again. */
    private fun notifyStopped(res: Int = R.string.androidProxyOnlyLost, title: Int = R.string.protectionStopped) {
        if (Protection.windowVisible) return
        try {
            ShroudlyVpnService.channels(this)
            val body = getString(res)
            val n = Notification.Builder(this, ShroudlyVpnService.ALERT_CHANNEL)
                .setSmallIcon(R.drawable.ic_shield)
                .setContentTitle(getString(title))
                .setContentText(body)
                .setStyle(Notification.BigTextStyle().bigText(body))
                .setContentIntent(ShroudlyVpnService.openApp(this))
                .setAutoCancel(true)
                .setCategory(Notification.CATEGORY_ERROR)
                .setColor(getColor(R.color.danger))
                .build()
            getSystemService(android.app.NotificationManager::class.java).notify(STOPPED_NOTICE_ID, n)
        } catch (e: Exception) {
            log("Could not post the notice: ${e.message}")
        }
    }

    private fun cleanup() {
        active = false
        Protection.trouble(0)
        network?.stop(getSystemService(ConnectivityManager::class.java))
        network = null
        networks.clear()
        current = null
        kept.clear()
        netCheck?.cancel(false); netCheck = null
        poll?.cancel(false); poll = null
        restartCredit?.cancel(false); restartCredit = null
        probeSentAt = 0
        doh?.let { d -> d.summary().takeIf { it.isNotEmpty() }?.let { log(if (d.usingCustom()) "Your DNS server is answering: $it" else "Encrypted DNS answering via $it") } }
        engine?.let { if (!it.stop()) log("The engine did not stop in time") }
        engine = null
        ownServer.close()
        doh?.stop(); doh = null
        port = 0
    }

    /* A phone that turns Wi-Fi and mobile data off at lock may end apps then
     * too: should it end this one, KeepOn's job brings it back with the
     * network. And the phone moving to another network (NetWatch, Handover),
     * looked at once things have settled. Kept to the service's own thread. */
    private fun watchNetwork() {
        val cm = getSystemService(ConnectivityManager::class.java)
        current = try { cm.activeNetwork } catch (_: Exception) { null }
        val w = NetWatch(::later, {
            networks += it
            if (Protection.troubleRes == R.string.androidNoNetwork) Protection.trouble(0)
        }, { net ->
            networks -= net
            if (active && networks.isEmpty()) {
                log("Network: none")
                KeepOn.networkGone(this@ShroudlyProxyService)
                // Said in the window, so no one takes it for Shroudly's doing.
                if (Protection.troubleRes == 0) Protection.trouble(R.string.androidNoNetwork)
            }
        }, ::onNetwork)
        network = w
        w.start(cm)?.let { log("Cannot follow network changes: $it") }
    }

    private fun onNetwork() {
        if (!active) return
        netCheck?.cancel(false)
        netCheck = try { work.schedule({ onNetworkSettled() }, ShroudlyVpnService.NET_SETTLE_MS, TimeUnit.MILLISECONDS) } catch (_: RejectedExecutionException) { null }
    }

    /* The phone's network (this app's default one: the network itself, or
     * another VPN app's, which then carries the engine's connections and
     * follows the network itself). On another, encrypted DNS opens new
     * connections (DohForwarder.networkChanged), and what apps opened
     * through the engine over the old one is ended, as in VPN mode, unless
     * it still works there (Handover): the engine starts again on its port,
     * which ends them, and apps connect again. */
    private fun onNetworkSettled() {
        netCheck = null
        if (!active) return
        val cm = getSystemService(ConnectivityManager::class.java)
        val now = try { cm.activeNetwork } catch (_: Exception) { null }
        val keptGone = kept.any { Handover.keptEnds(Handover.look(cm, it)) }
        if (now == current) {
            if (keptGone) endOldConnections("The network apps' connections were kept on has gone or no longer reaches the internet")
            return
        }
        val old = current
        current = now
        if (now == null) { kept.clear(); return }
        log("Network: ${Net.describe(cm, now)}")
        doh?.networkChanged()
        if (!keptGone && old != null && !Handover.endsOld(Handover.look(cm, old), Handover.look(cm, now))) {
            kept += old
            log("The network before (${Net.describe(cm, old)}) still works: apps' connections over it are kept until it goes")
            return
        }
        endOldConnections("Network changed: apps' connections over the old one are ended, so they connect again")
    }

    private fun endOldConnections(line: String) {
        kept.clear()
        log(line)
        restartEngine("restarted on its port, so apps' connections end")
    }

    private fun later(f: () -> Unit) {
        try { work.execute(f) } catch (_: RejectedExecutionException) {}
    }

    /* The ad and tracker list, as in VPN mode: fetched through the engine,
     * checked by it (ADBLOCK-CHECK), then put to use without a restart. */
    private fun refreshAdblockSoon() {
        if (!AdBlock.enabled(this) || !AdBlock.due(this)) return
        if (!adblockFetching.compareAndSet(false, true)) return
        Thread({
            try {
                Thread.sleep(5000)
                val e = engine
                if (e != null && active) {
                    log("Ad blocking: fetching the list")
                    val tmp = AdBlock.fetch(this, port, null)
                    val f = java.util.concurrent.CompletableFuture<EngineEvent.AdblockCheck>()
                    adblockCheck.set(f)
                    e.send("ADBLOCK-CHECK ${tmp.path}")
                    val v = try { f.get(30, TimeUnit.SECONDS) } catch (_: Exception) { null } finally { adblockCheck.compareAndSet(f, null) }
                    if (v == null || !v.ok) {
                        AdBlock.discard(tmp)
                        log("Ad blocking: the list fetched is not one to use (${v?.error ?: "no answer"})")
                    } else {
                        AdBlock.adopt(this, tmp)
                        if (active) engine?.send(AdBlock.commands(this).joinToString("\n"))
                    }
                }
            } catch (_: InterruptedException) {
            } catch (x: Exception) {
                log("Ad blocking: the list could not be fetched (${x.message ?: x.javaClass.simpleName}); Shroudly tries again later")
            } finally {
                adblockFetching.set(false)
            }
        }, "adblock").apply { isDaemon = true }.start()
    }

    private fun logStats() {
        val s = Protection.stats
        if (s == null) log("stats: ${Protection.state.name.lowercase()}, no counters yet")
        else log("stats: ${Protection.state.name.lowercase()}, connections ${s.connsTotal} total ${s.connsActive} active, " +
            "up ${s.bytesUp} B, down ${s.bytesDown} B, tls ${s.tls}, http ${s.http}, desync ${s.desync}")
    }

    private fun applyAdblock() { if (active) engine?.send(AdBlock.commands(this).joinToString("\n")) }

    private fun restartEngine(why: String) {
        if (!active) return
        val e = engine ?: return
        engine = null
        probeSentAt = 0
        if (!e.stop()) { stopAll(byUser = false, why = "the engine did not stop when told to"); return }
        log("Engine $why")
        respawn()
    }

    /* Null once in the foreground; else why Android refused. */
    private fun goForeground(starting: Boolean): String? {
        ShroudlyVpnService.channels(this)
        val stopIntent = PendingIntent.getService(
            this, 2, Intent(this, ShroudlyProxyService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val text = if (starting) getString(R.string.starting) else ProxyPort.onText(this, if (port > 0) port else ProxyPort.remembered(this))
        val n = Notification.Builder(this, ShroudlyVpnService.CHANNEL)
            .setSmallIcon(R.drawable.ic_shield)
            .setContentTitle(getString(if (starting) R.string.starting else R.string.protected_))
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setContentIntent(ShroudlyVpnService.openApp(this))
            .setOngoing(true)
            .setShowWhen(false)
            .setCategory(Notification.CATEGORY_SERVICE)
            .setColor(Accent.swatch(this))
            .addAction(Notification.Action.Builder(null, getString(R.string.stop), stopIntent).build())
            .apply { if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE) }
            .build()
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                // Not the VPN's type (systemExempted): this mode has no VPN.
                startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
            } else {
                startForeground(NOTIFICATION_ID, n)
            }
            null
        } catch (e: Exception) {
            log("Could not run in the foreground: $e")
            "Android refused the foreground service: $e"
        }
    }

    private fun refreshTile() {
        try { TileService.requestListeningState(this, ComponentName(this, ShroudlyTileService::class.java)) } catch (_: Exception) {}
    }

    /* Android ended the service: the engine with it, and the window and the
     * tile say protection is off, as the VPN's onDestroy does. */
    override fun onDestroy() {
        if (active || engine != null) {
            try { work.execute { OnlineCount.stop(leave = false); cleanup() } } catch (_: RejectedExecutionException) {}
        }
        work.shutdown()
        try { work.awaitTermination(8, TimeUnit.SECONDS) } catch (_: InterruptedException) {}
        // Ended by Android while on (not through a stop): back once a network is there.
        if (Protection.proxyOnly && (Protection.state == Protection.State.ON || Protection.state == Protection.State.STARTING)) {
            KeepOn.networkGone(this)
            Usage.endedByAndroid(this)
        }
        if (Protection.proxyOnly && Protection.state != Protection.State.OFF) Protection.set(Protection.State.OFF)
        refreshTile()
        super.onDestroy()
    }
}
