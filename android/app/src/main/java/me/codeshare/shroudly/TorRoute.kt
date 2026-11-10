package me.codeshare.shroudly

import android.content.Context
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/*
 * The last way out (Settings, "When nothing else works: the Tor network"; on
 * unless the user turns it off), as on the desktop (electron/tor-route.js):
 * Tor, reached through Snowflake, for a connection that nothing else got
 * through. The engine tries every technique first; only a site none of them
 * opened, or whose addresses do not answer at all, goes through Tor
 * (core/src/engine.c, "the last way out", --fallback-file).
 *
 * Tor and lyrebird are the Tor Project's own Android builds (Tor Expert
 * Bundle), put in the app's native library folder at build time
 * (scripts/fetch-tor.js --android) as libtor.so and liblyrebird.so: the one
 * place Android lets an app run programs from. They run as this app, which
 * is left out of its own VPN, so their connections go straight out.
 *
 * Tor starts only when the engine first needs it and stops after IDLE_MS
 * without carrying anything (an idle Tor keeps a volunteer's Snowflake proxy
 * busy for nothing), and with protection.
 */
class TorRoute(private val ctx: Context, private val log: (String) -> Unit, private val onChange: () -> Unit = {}) {
    companion object {
        private const val STALL_MS = 90_000L
        private const val IDLE_MS = 15 * 60_000L
        /* Protection off: Tor is kept this long, so a quick Stop and Start
         * goes on with the Tor that took minutes to get through (an Iranian
         * report: a restart put it back at 10%). */
        const val LINGER_MS = 5 * 60_000L

        /* One Tor for the app, whichever service runs protection (the VPN
         * or proxy only), and kept past a service that stopped (linger). */
        @Volatile private var one: TorRoute? = null
        fun shared(ctx: Context): TorRoute = synchronized(this) {
            one ?: TorRoute(ctx.applicationContext, { ShroudlyVpnService.log(it) }) { Protection.changed() }.also { one = it }
        }
        private const val RETRY_MS = 10 * 60_000L
        private const val FILE = "tor-route.txt"
        private val TRANSPORTS = listOf("snowflake", "meek", "obfs4", "webtunnel")
        private val LINE = Regex("^[a-z_0-9]+ [^\\r\\n]+$")

        /* The bundle's bridges by transport, well-formed lines only. */
        fun bridgesOf(json: String): Map<String, List<String>> {
            val out = LinkedHashMap<String, List<String>>()
            val o = try { org.json.JSONObject(json).optJSONObject("bridges") } catch (_: Exception) { null } ?: return out
            for (k in TRANSPORTS) {
                val a = o.optJSONArray(k) ?: continue
                val lines = (0 until a.length()).mapNotNull { a.optString(it, null) }.filter { LINE.matches(it) && it.length < 2000 }
                if (lines.isNotEmpty()) out[k] = lines
            }
            return out
        }

        /* One Snowflake volunteer kept ready beside the one in use (max=2,
         * issue #73), as on the desktop (electron/tor-route.js withPeers). */
        const val SNOWFLAKE_PEERS = 2
        fun withPeers(line: String): String =
            if (line.startsWith("snowflake ") && !Regex(" max=\\d+").containsMatchIn(line)) "$line max=$SNOWFLAKE_PEERS" else line

        /* The country's bridges (the Tor Project's circumvention settings,
         * through shroudly.codeshare.me/v1/bridges) first, then the
         * bundle's: as the desktop (tor-route.js mergeBridges). Pure. */
        private val COUNTRY_ORDER = listOf("webtunnel", "obfs4", "snowflake", "meek")
        fun mergeBridges(country: Map<String, List<String>>?, bundled: Map<String, List<String>>): Map<String, List<String>> {
            val out = LinkedHashMap<String, List<String>>()
            for (k in COUNTRY_ORDER) {
                val theirs = (country?.get(k) ?: emptyList()).filter { it.startsWith("$k ") && it.length < 2000 && !it.contains('\n') && !it.contains('\r') }.take(8)
                val all = (theirs + (bundled[k] ?: emptyList())).distinct()
                if (all.isNotEmpty()) out[k] = all
            }
            return out
        }

        /* {"country": "RU", "bridges": {"webtunnel": [...], ...}}: the bridges. */
        fun countryBridgesOf(json: String): Map<String, List<String>> = try {
            val b = org.json.JSONObject(json).optJSONObject("bridges")
            val out = HashMap<String, List<String>>()
            if (b != null) for (k in COUNTRY_ORDER) {
                val a = b.optJSONArray(k) ?: continue
                out[k] = (0 until a.length()).map { a.optString(it) }.filter { it.isNotEmpty() }
            }
            out
        } catch (_: Exception) { emptyMap() }

        fun torrc(port: Int, dataDir: String, lyrebird: String, bridges: Map<String, List<String>>, stage: String, ownerPid: Int): String {
            val kinds = when (stage) { "snowflake" -> listOf("snowflake"); "country" -> COUNTRY_ORDER; else -> TRANSPORTS }
            val lines = kinds.flatMap { bridges[it] ?: emptyList() }.map(::withPeers)
            val transports = lines.map { it.substringBefore(' ') }.distinct()
            return (listOf(
                "SocksPort 127.0.0.1:$port",
                "DataDirectory $dataDir",
                "Log notice stdout",
                "AvoidDiskWrites 1",
                "ClientOnly 1",
                "__OwningControllerProcess $ownerPid",
                "UseBridges 1",
                "ClientTransportPlugin ${transports.joinToString(",")} exec $lyrebird",
            ) + lines.map { "Bridge $it" }).joinToString("\n") + "\n"
        }

        fun enabled(ctx: Context) = ctx.getSharedPreferences("settings", Context.MODE_PRIVATE).getBoolean("torLastResort", true)
        /* Turned on by hand in Settings: the user's yes to it too (issue
         * #77); off, it asks again once turned on. */
        fun setEnabled(ctx: Context, on: Boolean) =
            ctx.getSharedPreferences("settings", Context.MODE_PRIVATE).edit().putBoolean("torLastResort", on).putBoolean("torApproved", on).apply()

        /* The user said yes to Tor (TorAsk's card, or the toggle by hand):
         * until then a site that needs it asks instead of starting it. */
        fun approved(ctx: Context) = ctx.getSharedPreferences("settings", Context.MODE_PRIVATE).getBoolean("torApproved", false)
        fun setApproved(ctx: Context, yes: Boolean) =
            ctx.getSharedPreferences("settings", Context.MODE_PRIVATE).edit().putBoolean("torApproved", yes).apply()

        /* Tor is in this copy of the app (not in the lite APK). */
        fun bundled(ctx: Context): Boolean {
            val lib = File(ctx.applicationInfo.nativeLibraryDir)
            return File(lib, "libtor.so").exists() && File(lib, "liblyrebird.so").exists()
        }

        /* What the window shows: off, starting, ready, failed. */
        @Volatile var state = "off"
            private set
        @Volatile var progress = 0
            private set
    }

    private val lib = File(ctx.applicationInfo.nativeLibraryDir)
    private val tor = File(lib, "libtor.so")
    private val lyrebird = File(lib, "liblyrebird.so")
    private val timers = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "tor-route").apply { isDaemon = true } }
    private val lock = Any()
    private var proc: Process? = null
    private var gen = 0
    private var port = 0
    private var stage = "snowflake"
    /* The bridges the Tor Project gives out for this country: the bundle's
     * are all blocked in Russia, where Tor never got through; Tor Browser
     * gets these there. Asked once the bundle's did not get through (kept
     * six hours); once they have, the next start goes to them at once. */
    private var country: Map<String, List<String>>? = null
    private var countryAt = 0L
    private var countryWorked = false
    private var failedAt = 0L
    private var used = 0L
    private var usedAt = 0L
    private var stall: ScheduledFuture<*>? = null
    private var idle: ScheduledFuture<*>? = null
    private var linger: ScheduledFuture<*>? = null

    fun available() = tor.exists() && lyrebird.exists()

    /* Before each engine start: the file naming Tor's port to the engine;
     * Tor starts later, when first needed. null where this build has none. */
    fun portFile(): File? {
        if (!available()) return null
        // A Tor kept from a moment ago goes on, on the same port.
        synchronized(lock) { linger?.cancel(false); linger = null; if (port == 0) port = Engine.freePort() }
        return File(ctx.filesDir, FILE).also { it.writeText("socks5://127.0.0.1:$port\n") }
    }

    /* The engine had a connection for it and nothing was listening. */
    fun need() = synchronized(lock) {
        if (proc != null || port == 0 || !available()) return@synchronized
        if (state == "failed" && System.currentTimeMillis() - failedAt < RETRY_MS) return@synchronized
        start(if (countryWorked && country != null) "country" else "snowflake")
    }

    private fun start(s: String) {
        kill()
        val g = ++gen
        val bundled = try { bridgesOf(ctx.assets.open("tor/pt_config.json").bufferedReader().use { it.readText() }) } catch (_: Exception) { emptyMap() }
        val bridges = if (s == "country") mergeBridges(country, bundled) else bundled
        stage = if (s == "snowflake" && bridges["snowflake"] == null) "all" else s
        val data = File(ctx.filesDir, "tor").apply { mkdirs(); setReadable(false, false); setReadable(true, true); setExecutable(false, false); setExecutable(true, true); setWritable(false, false); setWritable(true, true) }
        val rc = File(ctx.filesDir, "torrc").apply { writeText(torrc(port, data.path, lyrebird.path, bridges, stage, android.os.Process.myPid())) }
        val none = File(ctx.filesDir, "torrc-defaults-none").apply { writeText("") }
        val p = try {
            ProcessBuilder(tor.path, "-f", rc.path, "--defaults-torrc", none.path)
                .directory(lib).redirectErrorStream(true)
                .apply { environment()["TOR_PT_STATE_LOCATION"] = File(data, "pt_state").path; environment()["HOME"] = ctx.filesDir.path }
                .start()
        } catch (e: Exception) { fail("Tor could not start: ${e.message}"); return }
        proc = p
        state = "starting"; progress = 0
        log(when (stage) {
            "snowflake" -> "The last way out: starting Tor through Snowflake, for sites nothing else opened"
            "country" -> "The last way out: Tor through the bridges the Tor Project gives for this country (${bridges.keys.joinToString(", ")})"
            else -> "The last way out: Snowflake did not get through; trying Tor's other ways (meek, obfs4) with it"
        })
        onChange()
        Thread({
            try { p.inputStream.bufferedReader().forEachLine { line(it, g) } } catch (_: Exception) {}
            val code = try { p.waitFor() } catch (_: Exception) { -1 }
            synchronized(lock) { if (g == gen && state != "off") { proc = null; fail("Tor ended ($code)") } }
        }, "tor-out").apply { isDaemon = true }.start()
        armStall(g)
    }

    private fun line(l: String, g: Int) = synchronized(lock) {
        if (g != gen) return@synchronized
        val m = Regex("Bootstrapped (\\d+)%").find(l)
        if (m != null) {
            val pct = m.groupValues[1].toInt()
            if (pct > progress) {
                progress = pct
                armStall(g)
                if (pct >= 100 && state != "ready") {
                    state = "ready"
                    stall?.cancel(false)
                    usedAt = System.currentTimeMillis()
                    armIdle()
                    if (stage == "country") countryWorked = true
                    log("The last way out is ready: Tor through ${when (stage) { "snowflake" -> "Snowflake"; "country" -> "this country's bridges"; else -> "its bridges" }}")
                    // What the user sends through Tor and opened while it
                    // started: connected again, through it (a browser keeps a
                    // connection made the usual way for minutes).
                    if (Conns.torEntries(ctx).isNotEmpty()) Protector.tell(ctx, ShroudlyVpnService.ACTION_CONNS, Conns.TOR_AGAIN)
                }
                onChange()
            }
        } else if (l.contains("Could not bind to") || l.contains("Failed to bind one of the listener ports")) {
            port = 0
            fail("Tor could not open its port")
        }
    }

    private fun armStall(g: Int) {
        stall?.cancel(false)
        stall = timers.schedule({
            synchronized(lock) {
                if (g != gen || state != "starting") return@synchronized
                when (stage) {
                    "snowflake" -> start("all")
                    "all" -> tryCountry(g)
                    else -> { countryWorked = false; fail("Tor did not get through ($progress%)") }
                }
            }
        }, STALL_MS, TimeUnit.MILLISECONDS)
    }

    /* The bundle's bridges did not get through: the country's, asked now
     * through the engine (off the lock: it is a request), and Tor again with
     * them. None to be had: failed as before. */
    private fun tryCountry(g: Int) {
        val pct = progress
        val fresh = country != null && System.currentTimeMillis() - countryAt < 6 * 3600 * 1000L
        Thread({
            if (!fresh) {
                val got = try {
                    val req = ("GET /v1/bridges HTTP/1.1\r\nHost: ${OnlineHttp.HOST}\r\nConnection: close\r\n" +
                        "User-Agent: Shroudly/${BuildConfig.VERSION_NAME} (Android)\r\nAccept-Encoding: identity\r\n\r\n").toByteArray(Charsets.ISO_8859_1)
                    OnlineHttp.post(Protection.socksPort, Protection.socksAuth, req, 20_000)?.let { countryBridgesOf(it) }
                } catch (_: Exception) { null }
                synchronized(lock) { if (got != null && got.isNotEmpty()) { country = got; countryAt = System.currentTimeMillis() } }
            }
            synchronized(lock) {
                if (g != gen || state != "starting") return@synchronized
                if (mergeBridges(country, emptyMap()).isEmpty()) fail("Tor did not get through ($pct%)") else start("country")
            }
        }, "tor-country").apply { isDaemon = true }.start()
    }

    /* The engine's count of connections it carried (its stats line). */
    fun noteUse(count: Long) = synchronized(lock) {
        if (count > used) { used = count; usedAt = System.currentTimeMillis() } else if (count < used) used = count
    }

    private fun armIdle() {
        idle?.cancel(false)
        idle = timers.scheduleWithFixedDelay({
            synchronized(lock) {
                if (state == "ready" && System.currentTimeMillis() - usedAt >= IDLE_MS) {
                    log("The last way out: nothing has needed Tor for a while; stopped until a site needs it again")
                    stopLocked()
                }
            }
        }, 60, 60, TimeUnit.SECONDS)
    }

    private fun fail(why: String) {
        kill()
        state = "failed"
        failedAt = System.currentTimeMillis()
        log("The last way out: $why; tried again when a site needs it, in ${RETRY_MS / 60000} minutes at the earliest")
        onChange()
    }

    private fun kill() {
        gen++
        stall?.cancel(false)
        idle?.cancel(false)
        val p = proc
        proc = null
        p?.destroy()
    }

    private fun stopLocked() {
        val was = state != "off"
        kill()
        state = "off"; progress = 0; used = 0
        if (was) onChange()
    }

    /* With protection: Tor too. The port is kept for the next start. */
    fun stop() = synchronized(lock) { linger?.cancel(false); linger = null; stopLocked() }

    /* Protection off: Tor stopped in LINGER_MS unless protection starts
     * again first (portFile). One not running, or failed, stops at once. */
    fun linger() = synchronized(lock) {
        if (proc == null || state == "off" || state == "failed") { stopLocked(); return@synchronized }
        linger?.cancel(false)
        linger = timers.schedule({
            synchronized(lock) {
                linger = null
                if (proc != null) log("The last way out: protection stayed off; Tor stopped")
                stopLocked()
            }
        }, LINGER_MS, TimeUnit.MILLISECONDS)
    }

    /* The service is gone: Tor lingers a moment (one Tor for the app). */
    fun close() = linger()
}
