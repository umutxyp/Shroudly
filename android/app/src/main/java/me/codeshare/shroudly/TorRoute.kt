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

        fun torrc(port: Int, dataDir: String, lyrebird: String, bridges: Map<String, List<String>>, stage: String, ownerPid: Int): String {
            val kinds = if (stage == "snowflake") listOf("snowflake") else TRANSPORTS
            val lines = kinds.flatMap { bridges[it] ?: emptyList() }
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
        fun setEnabled(ctx: Context, on: Boolean) =
            ctx.getSharedPreferences("settings", Context.MODE_PRIVATE).edit().putBoolean("torLastResort", on).apply()

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
    private var failedAt = 0L
    private var used = 0L
    private var usedAt = 0L
    private var stall: ScheduledFuture<*>? = null
    private var idle: ScheduledFuture<*>? = null

    fun available() = tor.exists() && lyrebird.exists()

    /* Before each engine start: the file naming Tor's port to the engine;
     * Tor starts later, when first needed. null where this build has none. */
    fun portFile(): File? {
        if (!available()) return null
        synchronized(lock) { if (port == 0) port = Engine.freePort() }
        return File(ctx.filesDir, FILE).also { it.writeText("socks5://127.0.0.1:$port\n") }
    }

    /* The engine had a connection for it and nothing was listening. */
    fun need() = synchronized(lock) {
        if (proc != null || port == 0 || !available()) return@synchronized
        if (state == "failed" && System.currentTimeMillis() - failedAt < RETRY_MS) return@synchronized
        start("snowflake")
    }

    private fun start(s: String) {
        kill()
        val g = ++gen
        val bridges = try { bridgesOf(ctx.assets.open("tor/pt_config.json").bufferedReader().use { it.readText() }) } catch (_: Exception) { emptyMap() }
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
        log(if (stage == "snowflake") "The last way out: starting Tor through Snowflake, for sites nothing else opened"
            else "The last way out: Snowflake did not get through; trying Tor's other ways (meek, obfs4) with it")
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
                    log("The last way out is ready: Tor through ${if (stage == "snowflake") "Snowflake" else "its bridges"}")
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
                if (stage == "snowflake") start("all") else fail("Tor did not get through ($progress%)")
            }
        }, STALL_MS, TimeUnit.MILLISECONDS)
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
    fun stop() = synchronized(lock) { stopLocked() }

    /* The service is gone for good. */
    fun close() { stop(); timers.shutdownNow() }
}
