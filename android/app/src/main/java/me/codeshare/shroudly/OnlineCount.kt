package me.codeshare.shroudly

import android.content.Context
import android.content.res.Resources
import android.os.PowerManager
import android.util.Log
import java.io.ByteArrayInputStream
import java.io.IOException
import java.io.InputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.Socket
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.zip.GZIPInputStream
import java.util.zip.InflaterInputStream
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SNIHostName
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

/*
 * The live count ("Online now" on the desktop), backed by server/stats: the
 * phone is counted in the same total as the desktop, by the same rules
 * (electron/presence.js and syncPresence in electron/main.js), and nothing in
 * what it sends says it is a phone.
 *
 *   - Only while protection is on, and only with "Count me in the live total"
 *     on (About; on by default, like the desktop's setting).
 *   - A random id made fresh each time counting starts, never stored, sent as
 *     {"id":"<id>"} to /v1/ping and nothing else; again after the interval
 *     the server asks for (30 s to 15 min), after 30 s when a ping failed.
 *   - Through the engine, like the desktop's own requests while protection is
 *     on: whoever filters the network sees a protected connection, not a
 *     request to our domain in the clear. Never directly.
 *   - Stopping protection (the user's Stop) or switching the setting off
 *     sends /v1/leave, so the phone drops out at once; protection ending on
 *     its own sends nothing and the id expires on the server within minutes.
 *
 * It never wakes the phone: the timer is the service's own kind (time asleep
 * does not count), there is no alarm or wake lock, and nothing is sent while
 * the phone dozes, so a sleeping phone drops out of the count like a sleeping
 * computer. A failure is only retried; it never touches protection.
 */
class Pinger(
    /* POST path with body; returns the answer's text (null when it came back
     * but could not be read). Throws when the request failed. */
    private val post: (path: String, body: String, timeoutMs: Int) -> String?,
    private val scheduler: Scheduler,
    private val newId: () -> String = { UUID.randomUUID().toString() },
    /* The phone is in Doze: nothing is sent. */
    private val dozing: () -> Boolean = { false },
) {
    companion object {
        const val PING = "/v1/ping"
        const val LEAVE = "/v1/leave"
        // electron/presence.js
        const val MIN_INTERVAL_S = 30L
        const val MAX_INTERVAL_S = 900L
        const val RETRY_S = 30L
        const val DEFAULT_INTERVAL_S = 60L
        const val PING_TIMEOUT_MS = 10000
        const val LEAVE_TIMEOUT_MS = 1500

        /* Exactly what the desktop sends: JSON.stringify({ id }). */
        fun body(id: String) = "{\"id\":\"$id\"}"

        private val INTERVAL = Regex("\"interval\"\\s*:\\s*(-?[0-9]+(?:\\.[0-9]+)?)")

        /* Seconds to the next ping after an answer, as the desktop works it
         * out: the server's interval, 60 when it gives none, kept between 30
         * seconds and 15 minutes. Null: not an answer (a failure). */
        fun nextDelayS(answer: String): Long? {
            val t = answer.trim()
            if (!t.startsWith("{") || !t.endsWith("}")) return null
            val s = INTERVAL.find(t)?.groupValues?.get(1)?.toDoubleOrNull()
            val n = if (s == null || s == 0.0) DEFAULT_INTERVAL_S else s.toLong()
            return n.coerceIn(MIN_INTERVAL_S, MAX_INTERVAL_S)
        }
    }

    /* Runs a task later on the pinger's own thread; the function returned
     * cancels it if it has not started. */
    fun interface Scheduler {
        fun schedule(delayMs: Long, task: () -> Unit): () -> Unit
    }

    private var id: String? = null          // null: not counted
    private var generation = 0
    private var cancel: (() -> Unit)? = null
    private var lastDelayS = DEFAULT_INTERVAL_S

    val counting: Boolean get() = synchronized(this) { id != null }

    /* Counted exactly while both hold. Returns the id that has just stopped
     * being counted, to send a leave for, or null. */
    fun sync(shareOnlineCount: Boolean, protectionOn: Boolean): String? =
        if (shareOnlineCount && protectionOn) { start(); null } else stop()

    /* Counting begins with a fresh id: an earlier one was dropped, and nothing
     * links the two. */
    fun start() {
        synchronized(this) {
            if (id != null) return
            id = newId()
            generation++
            lastDelayS = DEFAULT_INTERVAL_S
            val g = generation
            cancel = scheduler.schedule(0) { ping(g) }
        }
    }

    /* No more pings; returns the id that was counted (null if none). */
    fun stop(): String? {
        synchronized(this) {
            val was = id ?: return null
            id = null
            generation++
            cancel?.invoke()
            cancel = null
            return was
        }
    }

    private fun ping(g: Int) {
        val current = synchronized(this) { if (g != generation) null else id } ?: return
        var next = RETRY_S
        if (dozing()) {
            next = lastDelayS
        } else {
            try {
                val answer = post(PING, body(current), PING_TIMEOUT_MS)
                // Counted. An answer in an encoding that cannot be read keeps
                // the pace; one that is not the server's (like the desktop's
                // failed JSON.parse) is a failure.
                val d = if (answer == null) lastDelayS else nextDelayS(answer)
                if (d != null) { next = d; lastDelayS = d }
            } catch (_: Exception) {
                // Offline or blocked: again soon.
            }
        }
        synchronized(this) {
            if (g != generation) return
            cancel = scheduler.schedule(next * 1000) { ping(g) }
        }
    }
}

/*
 * The request itself, made to look exactly like the desktop's: Electron's
 * net module (desktop 2.6.x, Electron 43) on Windows, the most common
 * desktop, sends these headers in this order and the body. Captured from
 * Electron 43.7.5 itself; only the system in the User-Agent is Windows's
 * where the capture was made on a Mac. The version is this app's, which is
 * the desktop's of the same release (package.json).
 *
 * Accept-Language is what Chromium sends for the system language: the
 * nearest of its own UI languages (chromiumLocale), as a computer set to the
 * same language would. HTTP/1.1 here where Chromium may use HTTP/2 to
 * Cloudflare; the server behind it sees the same either way.
 */
object OnlineHttp {
    const val HOST = "shroudly.codeshare.me"
    // The desktop's Electron (package.json) and its Chromium (process.versions.chrome).
    // OnlineCountTest fails when package.json moves to another Electron.
    const val ELECTRON = "43.7.6"
    const val CHROME = "150.0.7871.250"
    const val MAX_BODY = 4096

    fun userAgent(version: String) =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Shroudly/$version Chrome/$CHROME Electron/$ELECTRON Safari/537.36"

    fun request(path: String, body: String, version: String, acceptLanguage: String): ByteArray {
        val b = body.toByteArray(Charsets.UTF_8)
        val head = "POST $path HTTP/1.1\r\n" +
            "Host: $HOST\r\n" +
            "Connection: keep-alive\r\n" +
            "Content-Length: ${b.size}\r\n" +
            "content-type: application/json\r\n" +
            "Sec-Fetch-Site: none\r\n" +
            "Sec-Fetch-Mode: no-cors\r\n" +
            "Sec-Fetch-Dest: empty\r\n" +
            "User-Agent: ${userAgent(version)}\r\n" +
            "Accept-Encoding: gzip, deflate, br, zstd\r\n" +
            "Accept-Language: $acceptLanguage\r\n" +
            "\r\n"
        return head.toByteArray(Charsets.ISO_8859_1) + b
    }

    /* The answer's text: null when it is in an encoding Android cannot read
     * (Brotli, Zstandard), which Cloudflare has not been seen to use here. */
    fun text(resp: Http1.Response): String? {
        val enc = resp.headers["content-encoding"]?.trim()?.lowercase() ?: ""
        val input: InputStream = when (enc) {
            "", "identity" -> return resp.body.toString(Charsets.UTF_8)
            "gzip", "x-gzip" -> GZIPInputStream(ByteArrayInputStream(resp.body))
            "deflate" -> InflaterInputStream(ByteArrayInputStream(resp.body))
            else -> return null
        }
        return try {
            input.use { s ->
                val out = java.io.ByteArrayOutputStream()
                val buf = ByteArray(1024)
                while (true) {
                    val r = s.read(buf)
                    if (r < 0) break
                    out.write(buf, 0, r)
                    if (out.size() > MAX_BODY) return null
                }
                out.toString("UTF-8")
            }
        } catch (_: IOException) {
            null
        }
    }

    // Chromium's UI languages (Electron 43's locales), as it names them.
    private val CHROMIUM = setOf(
        "af", "am", "ar", "bg", "bn", "ca", "cs", "da", "de", "el", "en-GB", "en-US", "es", "es-419", "et", "fa",
        "fi", "fil", "fr", "gu", "he", "hi", "hr", "hu", "id", "it", "ja", "kn", "ko", "lt", "lv", "ml", "mr", "ms",
        "nb", "nl", "pl", "pt-BR", "pt-PT", "ro", "ru", "sk", "sl", "sr", "sv", "sw", "ta", "te", "th", "tr", "uk",
        "ur", "vi", "zh-CN", "zh-TW",
    )
    private val ALIAS = mapOf("iw" to "he", "in" to "id", "no" to "nb", "nn" to "nb", "tl" to "fil")

    /* The language Chromium would pick for these system languages (BCP 47
     * tags, most preferred first), as l10n_util does: its own name for the
     * language, else the language alone, else the next one; en-US when none
     * is among its languages. Checked against Electron 43 with --lang. */
    fun chromiumLocale(tags: List<String>): String {
        for (tag in tags) {
            val parts = tag.replace('_', '-').split('-').filter { it.isNotEmpty() }
            if (parts.isEmpty()) continue
            val lang = parts[0].lowercase().let { ALIAS[it] ?: it }
            val script = parts.drop(1).firstOrNull { it.length == 4 }?.lowercase()
            val region = parts.drop(1).firstOrNull { it.length == 2 || (it.length == 3 && it.all(Char::isDigit)) }?.uppercase()
            if (region != null && "$lang-$region" in CHROMIUM) return "$lang-$region"
            when (lang) {
                "zh" -> return if (script == "hant" || region == "TW" || region == "HK" || region == "MO") "zh-TW" else "zh-CN"
                "es" -> return if (region != null && region != "ES") "es-419" else "es"
                "pt" -> return if (region != null && region != "BR") "pt-PT" else "pt-BR"
                "en" -> return if (region in setOf("AU", "CA", "IN", "NZ", "ZA")) "en-GB" else "en-US"
            }
            if (lang in CHROMIUM) return lang
        }
        return "en-US"
    }

    /* One request through the engine's SOCKS5 port, by name, so the engine
     * resolves and splits it like any other site (as UpdateCheck does). */
    fun post(port: Int, auth: SocksAuth?, request: ByteArray, timeoutMs: Int): String? {
        if (port <= 0) throw IOException("protection is not on")
        val raw = Socket(Proxy.NO_PROXY)
        try {
            raw.connect(InetSocketAddress(InetAddress.getByName("127.0.0.1"), port), timeoutMs)
            raw.soTimeout = timeoutMs
            Socks5.connect(raw, HOST, 443, auth)
            val ssl = (SSLSocketFactory.getDefault() as SSLSocketFactory).createSocket(raw, HOST, 443, true) as SSLSocket
            ssl.sslParameters = ssl.sslParameters.apply { serverNames = listOf(SNIHostName(HOST)) }
            ssl.startHandshake()
            if (!HttpsURLConnection.getDefaultHostnameVerifier().verify(HOST, ssl.session)) {
                throw IOException("certificate does not belong to $HOST")
            }
            ssl.outputStream.apply { write(request); flush() }
            val resp = Http1.read(ssl.inputStream.buffered(), MAX_BODY)
            ssl.close()
            if (resp.status != 200) throw IOException("HTTP ${resp.status}")
            return text(resp)
        } finally {
            try { raw.close() } catch (_: IOException) {}
        }
    }
}

/* The app's one pinger, the setting, and when it runs. */
object OnlineCount {
    private const val PREFS = "settings"
    private const val KEY = "shareOnlineCount"

    @Volatile private var power: PowerManager? = null

    private val pinger: Pinger by lazy {
        // One thread, ended while nothing is scheduled.
        val pool = ScheduledThreadPoolExecutor(1) { r -> Thread(r, "shroudly-online").apply { isDaemon = true } }.apply {
            removeOnCancelPolicy = true
            setKeepAliveTime(10, TimeUnit.SECONDS)
            allowCoreThreadTimeOut(true)
        }
        Pinger(
            post = { path, body, timeoutMs -> send(path, body, timeoutMs, Protection.socksPort, Protection.socksAuth) },
            scheduler = { delayMs, task ->
                val f = pool.schedule({ task() }, delayMs, TimeUnit.MILLISECONDS)
                val cancel: () -> Unit = { f.cancel(false) }
                cancel
            },
            dozing = {
                try { power?.isDeviceIdleMode == true } catch (_: Exception) { false }
            },
        )
    }

    private fun send(path: String, body: String, timeoutMs: Int, port: Int, auth: SocksAuth?): String? {
        val tags = try {
            val list = Resources.getSystem().configuration.locales
            (0 until list.size()).map { list[it].toLanguageTag() }
        } catch (_: Exception) {
            listOf(Locale.getDefault().toLanguageTag())
        }
        val req = OnlineHttp.request(path, body, BuildConfig.VERSION_NAME, OnlineHttp.chromiumLocale(tags))
        // In the system log of debug builds only (the emulator tests).
        if (!BuildConfig.DEBUG) return OnlineHttp.post(port, auth, req, timeoutMs)
        return try {
            OnlineHttp.post(port, auth, req, timeoutMs).also { Log.i(ShroudlyVpnService.TAG, "Live count: $path answered $it") }
        } catch (e: Exception) {
            Log.i(ShroudlyVpnService.TAG, "Live count: $path failed: $e")
            throw e
        }
    }

    fun enabled(ctx: Context): Boolean =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY, true)

    /* The switch under About: takes effect at once. */
    fun setEnabled(ctx: Context, on: Boolean) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY, on).apply()
        sync(ctx)
    }

    /* Counted while protection is on and the setting is on. Called by the
     * service once protection is on, and by the switch. The leave for an id
     * dropped here goes on a thread of its own: this may be the main thread. */
    fun sync(ctx: Context) {
        if (power == null) power = ctx.applicationContext.getSystemService(PowerManager::class.java)
        val port = Protection.socksPort
        val auth = Protection.socksAuth
        val dropped = pinger.sync(enabled(ctx), Protection.state == Protection.State.ON) ?: return
        if (port > 0) leave(dropped, port, auth)
    }

    /* Protection is ending; `port` and `auth`: the engine's, still running.
     * The user's stop (leave = true) takes the phone out of the count at
     * once, waiting up to the desktop's 1.5 s for that; protection ending on
     * its own sends nothing (the id expires on the server). Never throws. */
    fun stop(leave: Boolean, port: Int = 0, auth: SocksAuth? = null) {
        val dropped = try { pinger.stop() } catch (_: Exception) { null } ?: return
        if (!leave || port <= 0) return
        try { leave(dropped, port, auth).join(Pinger.LEAVE_TIMEOUT_MS.toLong()) } catch (_: InterruptedException) {}
    }

    private fun leave(id: String, port: Int, auth: SocksAuth?): Thread = Thread({
        try { send(Pinger.LEAVE, Pinger.body(id), Pinger.LEAVE_TIMEOUT_MS, port, auth) } catch (_: Exception) {}
    }, "shroudly-online-leave").apply { isDaemon = true; start() }
}
