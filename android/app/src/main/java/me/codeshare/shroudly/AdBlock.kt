package me.codeshare.shroudly

import android.content.Context
import java.io.File
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.Socket
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SNIHostName
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

/*
 * "Block ads and trackers" (off by default), as on the desktop
 * (electron/adblock.js). The blocking is the engine's (core/src/adblock.c):
 * a lookup of a listed name gets 0.0.0.0 / ::, a connection to one is ended
 * before anything reaches the network. Here is only the switch, the user's
 * exceptions and the list: a public hosts list (StevenBlack/hosts, MIT
 * licence) fetched through the engine, checked by the engine (ADBLOCK-CHECK)
 * before it replaces the one in use, refreshed once a week. A failed or
 * wrong download changes nothing.
 */
object AdBlock {
    const val HOST = "raw.githubusercontent.com"
    const val PATH = "/StevenBlack/hosts/master/hosts"
    const val MAX_BYTES = 16 * 1024 * 1024        // the engine's ADB_MAX_FILE
    const val REFRESH_MS = 7L * 24 * 60 * 60 * 1000
    const val RETRY_MS = 30L * 60 * 1000
    private const val TIMEOUT_MS = 60_000
    private const val PREFS = "settings"
    private const val KEY_ON = "adBlock"
    private const val KEY_ALLOW = "adBlockAllow"
    private const val FILE = "adblock-list.txt"
    private const val NEW_FILE = "adblock-list.new"
    const val ALLOW_MAX = 512                      // the engine's ADBLOCK_ALLOW_MAX

    private val DOMAIN = Regex("^[a-z0-9_-]+(\\.[a-z0-9_-]+)+$")

    /* When a fetch was last tried, wall clock; not again within RETRY_MS. */
    @Volatile private var lastTry = 0L

    fun enabled(ctx: Context): Boolean =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_ON, false)

    fun setEnabled(ctx: Context, on: Boolean) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY_ON, on).apply()
    }

    fun allow(ctx: Context): List<String> =
        clean((ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_ALLOW, "") ?: "").split('\n'))

    /* The exceptions as typed: kept cleaned, and returned so. */
    fun setAllow(ctx: Context, text: String): List<String> {
        val list = clean(text.split(Regex("[\\s,]+")))
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_ALLOW, list.joinToString("\n")).apply()
        return list
    }

    /* One domain each, any case; a scheme, "*.", a path or port, a trailing
     * dot left out; what is not a domain is dropped (as cleanAllow). */
    fun clean(raw: List<String>): List<String> {
        val out = LinkedHashSet<String>()
        for (r in raw) {
            var d = r.trim().lowercase()
            d = d.replace(Regex("^[a-z]+://"), "").removePrefix("*.")
            val cut = d.indexOfFirst { it == '/' || it == ':' || it == '?' || it == '#' }
            if (cut != -1) d = d.substring(0, cut)
            d = d.removeSuffix(".")
            if (d.length > 253 || !DOMAIN.matches(d)) continue
            out += d
            if (out.size == ALLOW_MAX) break
        }
        return out.toList()
    }

    fun file(ctx: Context) = File(ctx.filesDir, FILE)

    /* The list to give the engine: on, and one has been fetched. */
    fun listFile(ctx: Context): File? = file(ctx).takeIf { enabled(ctx) && it.length() > 0 }

    /* Time to fetch it (again): none yet, or a week old; not twice in half an
     * hour after a failure. */
    fun due(ctx: Context, now: Long = System.currentTimeMillis()): Boolean = due(file(ctx), now)

    internal fun due(f: File, now: Long): Boolean {
        if (lastTry != 0L && now - lastTry in 0 until RETRY_MS) return false
        return f.length() == 0L || now - f.lastModified() >= REFRESH_MS
    }

    /* Fetch the list through the engine at port into a file beside the one
     * in use; the caller has the engine check it, then adopt()s it. */
    fun fetch(ctx: Context, port: Int, auth: SocksAuth?): File {
        lastTry = System.currentTimeMillis()
        val raw = Socket(Proxy.NO_PROXY)
        try {
            raw.connect(InetSocketAddress(InetAddress.getByName("127.0.0.1"), port), TIMEOUT_MS)
            raw.soTimeout = TIMEOUT_MS
            Socks5.connect(raw, HOST, 443, auth)
            val ssl = (SSLSocketFactory.getDefault() as SSLSocketFactory).createSocket(raw, HOST, 443, true) as SSLSocket
            ssl.sslParameters = ssl.sslParameters.apply { serverNames = listOf(SNIHostName(HOST)) }
            ssl.startHandshake()
            if (!HttpsURLConnection.getDefaultHostnameVerifier().verify(HOST, ssl.session)) {
                throw IOException("certificate does not belong to $HOST")
            }
            val head = "GET $PATH HTTP/1.1\r\nHost: $HOST\r\nUser-Agent: Shroudly\r\n" +
                "Accept-Encoding: identity\r\nConnection: close\r\n\r\n"
            ssl.outputStream.apply { write(head.toByteArray(Charsets.ISO_8859_1)); flush() }
            val resp = Http1.read(ssl.inputStream.buffered(), MAX_BYTES)
            if (resp.status != 200) throw IOException("HTTP ${resp.status}")
            if (resp.body.isEmpty()) throw IOException("not a list")
            ssl.close()
            val tmp = File(ctx.filesDir, NEW_FILE)
            tmp.writeBytes(resp.body)
            return tmp
        } finally {
            try { raw.close() } catch (_: IOException) {}
        }
    }

    /* The fetched file, checked by the engine, becomes the list in use. */
    fun adopt(ctx: Context, tmp: File) {
        if (!tmp.renameTo(file(ctx))) throw IOException("could not keep the list")
    }

    fun discard(tmp: File) {
        tmp.delete()
    }

    /* What the running engine is told for the setting as it is now: no
     * restart, nothing dropped. */
    fun commands(ctx: Context): List<String> {
        val list = listFile(ctx) ?: return listOf("ADBLOCK OFF")
        return listOf("ALLOW-CLEAR") + allow(ctx).map { "ALLOW $it" } + "ADBLOCK ${list.path}"
    }
}
