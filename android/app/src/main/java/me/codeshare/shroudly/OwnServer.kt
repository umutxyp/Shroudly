package me.codeshare.shroudly

import android.system.Os
import android.system.OsConstants
import java.io.File
import java.io.FileDescriptor
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URLDecoder
import java.util.Base64
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLSession
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

/*
 * "Your own server" (Settings, Advanced): a server the user names, which
 * carries every connection to a name (the engine's --upstream-file). In a
 * shutdown, a server inside the country whose own connection to the world
 * still works is the way out. The Android side of electron/own-server.js,
 * the same links:
 *   socks5://user:password@host:port   (user and password optional)
 *   http://user:password@host:port     (CONNECT; the same)
 *   ss://BASE64URL(method:password)@host:port#name   (SIP002)
 *   ss://BASE64(method:password@host:port)#name      (the older form)
 *   host:port                          (SOCKS5)
 * Shadowsocks goes through Shroudly's own client (Shadowsocks.Client).
 */
object OwnServer {
    data class Link(
        val kind: String, val host: String, val port: Int,
        val user: String = "", val pass: String = "",
        val method: String = "", val password: String = "", val name: String = "",
    )

    /* A link, or the reason it cannot be used: empty, format, method, user. */
    data class Parsed(val link: Link?, val error: String? = null, val method: String? = null)

    private fun hostPort(text: String): Pair<String, Int>? {
        val m = Regex("^\\[([0-9a-fA-F:.]+)]:(\\d{1,5})$").matchEntire(text) ?: Regex("^([^\\s:/@\\[\\]]+):(\\d{1,5})$").matchEntire(text) ?: return null
        val port = m.groupValues[2].toInt()
        return if (port in 1..65535) m.groupValues[1] to port else null
    }

    private fun fromB64(s: String): String = try {
        String(Base64.getDecoder().decode(s.replace('-', '+').replace('_', '/').trimEnd('=')), Charsets.UTF_8)
    } catch (_: IllegalArgumentException) {
        ""
    }

    private fun decode(s: String): String? = try { URLDecoder.decode(s.replace("+", "%2B"), "UTF-8") } catch (_: Exception) { null }

    fun parse(input: String?): Parsed {
        val text = input?.trim().orEmpty()
        if (text.isEmpty()) return Parsed(null, "empty")
        Regex("^(socks5h?|socks|http)://(?:([^@/]*)@)?([^/?#]+)/?$", RegexOption.IGNORE_CASE).matchEntire(text)?.let { m ->
            val (host, port) = hostPort(m.groupValues[3]) ?: return Parsed(null, "format")
            var user = ""
            var pass = ""
            if (m.groups[2] != null) {
                val info = m.groupValues[2]
                val i = info.indexOf(':')
                user = decode(if (i < 0) info else info.substring(0, i)) ?: return Parsed(null, "format")
                pass = if (i < 0) "" else decode(info.substring(i + 1)) ?: return Parsed(null, "format")
                if (user.isEmpty() || user.any { it == ':' || it == '@' || it == '\r' || it == '\n' } || user.length > 255 || pass.length > 255 || pass.any { it == '\r' || it == '\n' }) {
                    return Parsed(null, "user")
                }
            }
            return Parsed(Link(if (m.groupValues[1].equals("http", true)) "http" else "socks5", host, port, user, pass))
        }
        Regex("^ss://([^#]+)(?:#(.*))?$", RegexOption.IGNORE_CASE).matchEntire(text)?.let { m ->
            val name = m.groups[2]?.value?.let { decode(it) } ?: ""
            val body = m.groupValues[1].replace(Regex("/?\\?.*$"), "").trimEnd('/')
            val at = body.lastIndexOf('@')
            val method: String
            val password: String
            val hp: Pair<String, Int>?
            if (at > 0) {
                val info = body.substring(0, at).let { decode(it) ?: it }
                val plain = if (info.contains(':')) info else fromB64(info)
                val i = plain.indexOf(':')
                if (i < 1) return Parsed(null, "format")
                method = plain.substring(0, i).lowercase()
                password = plain.substring(i + 1)
                hp = hostPort(body.substring(at + 1))
            } else {
                val mm = Regex("^([^:]+):(.*)@([^@]+)$").matchEntire(fromB64(body)) ?: return Parsed(null, "format")
                method = mm.groupValues[1].lowercase()
                password = mm.groupValues[2]
                hp = hostPort(mm.groupValues[3])
            }
            if (hp == null || password.isEmpty()) return Parsed(null, "format")
            if (method !in Shadowsocks.METHODS) return Parsed(null, "method", method)
            return Parsed(Link("ss", hp.first, hp.second, method = method, password = password, name = name))
        }
        val hp = hostPort(text) ?: return Parsed(null, "format")
        return Parsed(Link("socks5", hp.first, hp.second))
    }

    private fun where(l: Link) = if (l.host.contains(':')) "[${l.host}]:${l.port}" else "${l.host}:${l.port}"

    /* What the log and the screen show: never the password. */
    fun describe(l: Link): String = when (l.kind) {
        "ss" -> "Shadowsocks ${where(l)}"
        "http" -> "HTTP ${where(l)}"
        else -> "SOCKS5 ${where(l)}"
    }

    /* The engine's --upstream-file line: the server, or for Shadowsocks the
     * local client on `localPort` with its password. */
    fun engineLine(l: Link, localPort: Int = 0, auth: SocksAuth? = null): String =
        if (l.kind == "ss") "socks5://${auth?.let { "${it.user}:${it.pass}@" } ?: ""}127.0.0.1:$localPort"
        else "${l.kind}://${if (l.user.isNotEmpty()) "${l.user}${if (l.pass.isNotEmpty()) ":${l.pass}" else ""}@" else ""}${where(l)}"

    /* Written readable by this app alone, read by the engine at its start. */
    fun writeFile(f: File, line: String) {
        f.delete()
        val fd: FileDescriptor = Os.open(f.path, OsConstants.O_CREAT or OsConstants.O_EXCL or OsConstants.O_WRONLY, 384 /* 0600 */)
        FileOutputStream(fd).use { it.write("$line\n".toByteArray(Charsets.UTF_8)) }
    }

    /* Why a server could not be used, as the engine says it (engine.c,
     * upstream_report) and the test below finds it; the screen translates
     * the code. */
    private val WHY = mapOf(
        "does not answer" to "noAnswer",
        "refused the user name or password" to "auth",
        "asks for a user name and password" to "asks",
        "refused the connection" to "refused",
        "does not speak the protocol chosen" to "protocol",
    )
    val WHY_TEXT: Map<String, String> = WHY.entries.associate { (k, v) -> v to k } +
        mapOf("silent" to "nothing came back (the password or the method may be wrong)", "tls" to "it answers, but no site's certificate came through it")

    fun whyCode(text: String?): String = WHY[text] ?: "protocol"

    fun whyRes(code: String?): Int = when (code) {
        "noAnswer" -> R.string.ownServerWhyNoAnswer
        "auth" -> R.string.ownServerWhyAuth
        "asks" -> R.string.ownServerWhyAsks
        "refused" -> R.string.ownServerWhyRefused
        "silent" -> R.string.ownServerWhySilent
        "tls" -> R.string.ownServerWhyTls
        else -> R.string.ownServerWhyProtocol
    }

    class Why(val code: String) : IOException(code)

    private fun readN(i: InputStream, n: Int): ByteArray {
        val b = ByteArray(n)
        var got = 0
        while (got < n) {
            val r = i.read(b, got, n - got)
            if (r < 0) throw Why("protocol")
            got += r
        }
        return b
    }

    private fun socks5(s: Socket, user: String, pass: String, host: String, port: Int) {
        val i = s.getInputStream()
        val o = s.getOutputStream()
        o.write(if (user.isNotEmpty()) byteArrayOf(5, 2, 0, 2) else byteArrayOf(5, 1, 0))
        val m = readN(i, 2)[1].toInt() and 0xff
        if (m == 2) {
            if (user.isEmpty()) throw Why("asks")
            val u = user.toByteArray()
            val p = pass.toByteArray()
            o.write(byteArrayOf(1, u.size.toByte()) + u + byteArrayOf(p.size.toByte()) + p)
            if (readN(i, 2)[1].toInt() != 0) throw Why("auth")
        } else if (m != 0) {
            throw Why(if (m == 0xff && user.isEmpty()) "asks" else "protocol")
        }
        val h = host.toByteArray()
        o.write(byteArrayOf(5, 1, 0, 3, h.size.toByte()) + h + byteArrayOf((port shr 8).toByte(), port.toByte()))
        val rep = readN(i, 4)
        if (rep[0].toInt() != 5) throw Why("protocol")
        when (rep[3].toInt()) {
            1 -> readN(i, 6)
            4 -> readN(i, 18)
            3 -> readN(i, (readN(i, 1)[0].toInt() and 0xff) + 2)
            else -> throw Why("protocol")
        }
        if (rep[1].toInt() != 0) throw Why("refused")
    }

    private fun connectHttp(s: Socket, l: Link, host: String, port: Int) {
        val auth = if (l.user.isNotEmpty()) "Proxy-Authorization: Basic ${Base64.getEncoder().encodeToString("${l.user}:${l.pass}".toByteArray())}\r\n" else ""
        s.getOutputStream().write("CONNECT $host:$port HTTP/1.1\r\nHost: $host:$port\r\n$auth\r\n".toByteArray(Charsets.ISO_8859_1))
        val i = s.getInputStream()
        val head = StringBuilder()
        while (!head.endsWith("\r\n\r\n")) {
            val c = i.read()
            if (c < 0 || head.length > 8192) throw Why("protocol")
            head.append(c.toChar())
        }
        val code = Regex("^HTTP/1\\.[01] (\\d{3})").find(head)?.groupValues?.get(1)?.toInt() ?: throw Why("protocol")
        if (code == 407) throw Why(if (l.user.isNotEmpty()) "auth" else "asks")
        if (code != 200) throw Why("refused")
    }

    /* Does the server carry a connection to a site? One through it to `host`
     * and the site's certificate checked (a server that only answers, or a
     * network that hands back something else, is not taken for one):
     * null when it works, or why not (WHY codes, plus silent and tls). Off
     * the main thread; `tls` stands in for the system's in tests. */
    fun test(
        l: Link, host: String = "cloudflare.com", port: Int = 443, timeoutMs: Int = 12_000,
        tls: SSLSocketFactory = SSLSocketFactory.getDefault() as SSLSocketFactory,
        nameOk: (String, SSLSession) -> Boolean = { h, session -> HttpsURLConnection.getDefaultHostnameVerifier().verify(h, session) },
    ): String? {
        var client: Shadowsocks.Client? = null
        var clientError: IOException? = null
        var s: Socket? = null
        try {
            if (l.kind == "ss") {
                client = Shadowsocks.Client(l.host, l.port, l.method, l.password) { e, _ -> clientError = e }
                s = Socket().apply { soTimeout = timeoutMs; connect(InetSocketAddress("127.0.0.1", client.port), timeoutMs) }
                try {
                    socks5(s, "", "", host, port)
                } catch (_: IOException) {
                    return if (clientError?.message?.contains("authenticate") == true) "silent" else "noAnswer"
                }
            } else {
                s = Socket().apply { soTimeout = timeoutMs }
                try { s.connect(InetSocketAddress(l.host, l.port), timeoutMs) } catch (_: IOException) { return "noAnswer" }
                try {
                    if (l.kind == "http") connectHttp(s, l, host, port) else socks5(s, l.user, l.pass, host, port)
                } catch (e: Why) {
                    return e.code
                } catch (_: IOException) {
                    return "silent"
                }
            }
            return try {
                val t = tls.createSocket(s, host, port, false) as SSLSocket
                t.startHandshake()
                if (!nameOk(host, t.session)) "tls" else null
            } catch (_: IOException) {
                if (l.kind == "ss") (if (clientError != null && clientError?.message?.contains("authenticate") != true) "noAnswer" else "silent") else "tls"
            }
        } catch (_: IOException) {
            return "noAnswer"
        } finally {
            try { s?.close() } catch (_: IOException) {}
            client?.close()
        }
    }

    const val FILE = "own-server"

    /*
     * For one protection session (either service): the file naming the
     * server to the engine, Shroudly's Shadowsocks client kept while the
     * server stays the same (an engine restart keeps it), and the server's
     * trouble told: in the log now and then, on the main screen until a
     * minute and a half passes without it.
     */
    class Session(private val dir: File, private val log: (String) -> Unit) {
        private var client: Shadowsocks.Client? = null
        private var clientKey: String? = null
        private var auth: SocksAuth? = null
        @Volatile private var shown = ""
        @Volatile private var downAt = 0L
        private val told = HashMap<String, Long>()
        private val main = android.os.Handler(android.os.Looper.getMainLooper())

        /* Before each engine start: the file, which the engine reads at its
         * start and the caller then deletes; null for none. */
        @Synchronized
        fun fileFor(l: Link?): File? {
            val key = l?.takeIf { it.kind == "ss" }?.let { "${it.host} ${it.port} ${it.method} ${it.password}" }
            if (client != null && clientKey != key) close()
            if (l == null) return null
            if (key != null && client == null) {
                val a = SocksAuth.random()
                client = Shadowsocks.Client(l.host, l.port, l.method, l.password, a.user, a.pass) { _, bad -> down(if (bad) "protocol" else "noAnswer") }
                clientKey = key
                auth = a
            }
            shown = describe(l)
            val f = File(dir, FILE)
            writeFile(f, engineLine(l, client?.port ?: 0, auth))
            return f
        }

        /* The server would not carry a connection (the engine's "upstream"
         * line, or the Shadowsocks client). */
        fun down(why: String) {
            val now = android.os.SystemClock.elapsedRealtime()
            downAt = now
            val first = synchronized(told) {
                val at = told[why]
                if (at == null || now - at > 30 * 60_000L) { told[why] = now; true } else false
            }
            if (first) log("Your own server ($shown) could not be used: ${WHY_TEXT[why] ?: why}")
            Protection.ownServerDown(shown to why)
            main.postDelayed({ if (android.os.SystemClock.elapsedRealtime() - downAt >= 89_000) Protection.ownServerDown(null) }, 90_000)
        }

        @Synchronized
        fun close() {
            client?.close()
            client = null
            clientKey = null
            auth = null
            Protection.ownServerDown(null)
        }
    }
}
