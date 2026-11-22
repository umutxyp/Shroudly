package me.codeshare.shroudly

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.net.URLDecoder
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLSession
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

/*
 * VLESS and Trojan for "Your own server": the Android side of
 * electron/vless.js, the same links and the same bytes (the tests of both
 * read tests/net/fixtures/vless-vectors.json).
 *
 * Both are a short header in front of the connection's own bytes:
 *   VLESS   0x00, the 16 bytes of the user's UUID, 0x00 (no additions),
 *           0x01 (TCP), the port, the address (1 IPv4, 2 a name with its
 *           length, 3 IPv6); the server answers 0x00, a length, that many
 *           bytes, then data.
 *   Trojan  the SHA-224 of the password in hex, CRLF, 0x01, the address as
 *           SOCKS5 writes it, the port, CRLF; only data comes back.
 * carried over plain TCP, a WebSocket (binary messages, masked on the way
 * up) or HTTPUpgrade (the WebSocket's opening request and answer, then the
 * bytes as they are), each with the system's TLS or without.
 *
 * Not carried: REALITY, the Vision flow, gRPC, XHTTP, mKCP, QUIC and VLESS's
 * own encryption (they need a TLS of their own making), and, on a phone,
 * allowInsecure: a server whose certificate cannot be checked is not used
 * here. A link that asks for one of these is told so (parse:
 * "unsupported" with what), never tried another way.
 */
object Vless {
    val NETS = listOf("tcp", "ws", "httpupgrade")
    private const val LINGER_MS = 10_000L
    private const val WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
    private const val WS_MAX_FRAME = 16 * 1024 * 1024

    data class Link(
        val kind: String, val host: String, val port: Int,
        val id: String = "", val password: String = "",
        val net: String = "tcp", val tls: Boolean = false,
        val sni: String = "", val wsHost: String = "", val path: String = "/",
        val alpn: List<String> = emptyList(), val name: String = "",
    )

    /* A link, or why not: "format", or "unsupported" with what (reality,
     * security, flow, encryption, transport, insecure). */
    data class Parsed(val link: Link?, val error: String? = null, val what: String? = null)

    private fun hostPort(text: String): Pair<String, Int>? {
        val m = Regex("^\\[([0-9a-fA-F:.]+)]:(\\d{1,5})$").matchEntire(text) ?: Regex("^([^\\s:/@\\[\\]]+):(\\d{1,5})$").matchEntire(text) ?: return null
        val port = m.groupValues[2].toInt()
        return if (port in 1..65535) m.groupValues[1] to port else null
    }

    private fun plainName(s: String) = Regex("^[A-Za-z0-9.\\-_:\\[\\]]{1,253}$").matches(s)

    fun parse(input: String?): Parsed {
        val text = input?.trim().orEmpty()
        val m = Regex("^(vless|trojan)://([^@/?#]+)@([^/?#]+)/?(?:\\?([^#]*))?(?:#(.*))?$", RegexOption.IGNORE_CASE).matchEntire(text)
            ?: return Parsed(null, "format")
        val kind = m.groupValues[1].lowercase()
        val (host, port) = hostPort(m.groupValues[3]) ?: return Parsed(null, "format")
        // A "+" in the key is itself (as the desktop reads it), in a value a space.
        val secret = try { URLDecoder.decode(m.groupValues[2].replace("+", "%2B"), "UTF-8") } catch (_: Exception) { return Parsed(null, "format") }
        val name = m.groups[5]?.value?.let { try { URLDecoder.decode(it.replace("+", "%2B"), "UTF-8") } catch (_: Exception) { "" } } ?: ""
        val q = HashMap<String, String>()
        for (part in (m.groups[4]?.value ?: "").split('&')) {
            if (part.isEmpty()) continue
            val i = part.indexOf('=')
            val k = (if (i < 0) part else part.substring(0, i)).lowercase()
            val v = try { if (i < 0) "" else URLDecoder.decode(part.substring(i + 1), "UTF-8") } catch (_: Exception) { return Parsed(null, "format") }
            if (k !in q) q[k] = v
        }
        fun arg(vararg keys: String): String = keys.firstNotNullOfOrNull { q[it]?.takeIf { v -> v.isNotEmpty() } } ?: ""
        fun no(what: String) = Parsed(null, "unsupported", what)
        val net = arg("type", "net").ifEmpty { "tcp" }.lowercase()
        val security = arg("security").ifEmpty { if (kind == "trojan") "tls" else "none" }.lowercase()
        if (security == "reality") return no("reality")
        if (security != "tls" && security != "none") return no("security")
        if (arg("flow").isNotEmpty()) return no("flow")
        if (kind == "vless" && arg("encryption").isNotEmpty() && arg("encryption").lowercase() != "none") return no("encryption")
        if (net !in NETS) return no("transport")
        if (net == "tcp" && arg("headertype").isNotEmpty() && arg("headertype").lowercase() != "none") return no("transport")
        var id = ""
        var password = ""
        if (kind == "vless") {
            id = secret.replace("-", "").lowercase()
            if (!Regex("^[0-9a-f]{32}$").matches(id)) return Parsed(null, "format")
        } else {
            if (secret.isEmpty() || secret.length > 512 || secret.any { it == '\r' || it == '\n' }) return Parsed(null, "format")
            password = secret
        }
        val sni = arg("sni", "peer")
        val wsHost = arg("host")
        if ((sni.isNotEmpty() && !plainName(sni)) || (wsHost.isNotEmpty() && !plainName(wsHost))) return Parsed(null, "format")
        // The path as the server knows it: Xray's "?ed=2048" is its client's
        // own note (early data), not part of the path.
        var p = arg("path").ifEmpty { "/" }
        if (!p.startsWith("/")) p = "/$p"
        Regex("([?&])ed=\\d+(&|$)").find(p)?.let { e -> p = p.replaceRange(e.range, if (e.groupValues[2].isNotEmpty()) e.groupValues[1] else "") }
        p = p.replace(Regex("[?&]$"), "")
        if (p.any { it.isWhitespace() } || p.length > 1024) return Parsed(null, "format")
        if (p.isEmpty()) p = "/"
        val alpn = arg("alpn").split(',').map { it.trim() }.filter { Regex("^[A-Za-z0-9./-]{1,16}$").matches(it) }
        // A certificate that cannot be checked is not taken on a phone.
        if (arg("allowinsecure", "insecure").lowercase() in listOf("1", "true")) return no("insecure")
        return Parsed(Link(kind, host, port, id, password, net, security == "tls", sni, wsHost, p, alpn, name))
    }

    /* What the log and the screen show: never the key. */
    fun describe(l: Link): String {
        val where = if (l.host.contains(':')) "[${l.host}]:${l.port}" else "${l.host}:${l.port}"
        val how = (when (l.net) { "ws" -> "WebSocket"; "httpupgrade" -> "HTTPUpgrade"; else -> "TCP" }) + (if (l.tls) " + TLS" else "")
        return "${if (l.kind == "vless") "VLESS" else "Trojan"} $where ($how)"
    }

    /* The name a part of a link that is not carried goes by (the same in
     * every language). */
    fun unsupportedName(what: String?): String = when (what) {
        "reality" -> "REALITY"
        "flow" -> "XTLS Vision"
        "transport" -> "gRPC / XHTTP / mKCP"
        "encryption" -> "VLESS Encryption"
        "security" -> "XTLS"
        "insecure" -> "allowInsecure"
        else -> what ?: ""
    }

    // ── the headers ──

    private fun ipv4Bytes(host: String): ByteArray? {
        val m = Regex("^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$").matchEntire(host) ?: return null
        val o = m.groupValues.drop(1).map { it.toInt() }
        return if (o.all { it <= 255 }) ByteArray(4) { o[it].toByte() } else null
    }

    /* "::" filled in, a trailing IPv4 part taken as its two groups; null for
     * what is no IPv6 address. */
    internal fun ipv6Bytes(host: String): ByteArray? {
        if (!host.contains(':')) return null
        var h = host
        Regex("^(.*:)(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$").matchEntire(h)?.let { v4 ->
            val o = v4.groupValues.drop(2).map { it.toInt() }
            if (o.any { it > 255 }) return null
            h = "${v4.groupValues[1]}${((o[0] shl 8) or o[1]).toString(16)}:${((o[2] shl 8) or o[3]).toString(16)}"
        }
        val halves = h.split("::")
        if (halves.size > 2) return null
        val a = if (halves[0].isEmpty()) emptyList() else halves[0].split(':')
        val b = if (halves.size == 2 && halves[1].isNotEmpty()) halves[1].split(':') else emptyList()
        val fill = if (halves.size == 2) 8 - a.size - b.size else 0
        if (fill < 0 || (halves.size == 1 && a.size != 8)) return null
        val groups = a + List(fill) { "0" } + b
        if (groups.size != 8 || groups.any { !Regex("^[0-9a-fA-F]{1,4}$").matches(it) }) return null
        val out = ByteArray(16)
        groups.forEachIndexed { i, g -> val v = g.toInt(16); out[i * 2] = (v shr 8).toByte(); out[i * 2 + 1] = v.toByte() }
        return out
    }

    private fun hexBytes(hex: String) = ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    /* VLESS: what goes first on the connection, for a TCP connection to host:port. */
    fun vlessHeader(idHex: String, host: String, port: Int): ByteArray {
        val o = ByteArrayOutputStream()
        o.write(0)
        o.write(hexBytes(idHex))
        o.write(byteArrayOf(0, 1, (port shr 8).toByte(), port.toByte()))
        val v4 = ipv4Bytes(host)
        val v6 = if (v4 == null) ipv6Bytes(host) else null
        when {
            v4 != null -> { o.write(1); o.write(v4) }
            v6 != null -> { o.write(3); o.write(v6) }
            else -> {
                val n = host.toByteArray(Charsets.UTF_8)
                if (n.isEmpty() || n.size > 255) throw IOException("a name too long for VLESS")
                o.write(2); o.write(n.size); o.write(n)
            }
        }
        return o.toByteArray()
    }

    fun trojanHeader(password: String, host: String, port: Int): ByteArray {
        val o = ByteArrayOutputStream()
        val hash = MessageDigest.getInstance("SHA-224").digest(password.toByteArray(Charsets.UTF_8))
        o.write(hash.joinToString("") { "%02x".format(it.toInt() and 0xff) }.toByteArray(Charsets.ISO_8859_1))
        o.write(byteArrayOf(13, 10, 1))
        val v4 = ipv4Bytes(host)
        val v6 = if (v4 == null) ipv6Bytes(host) else null
        when {
            v4 != null -> { o.write(1); o.write(v4) }
            v6 != null -> { o.write(4); o.write(v6) }
            else -> {
                val n = host.toByteArray(Charsets.UTF_8)
                if (n.isEmpty() || n.size > 255) throw IOException("a name too long for Trojan")
                o.write(3); o.write(n.size); o.write(n)
            }
        }
        o.write(byteArrayOf((port shr 8).toByte(), port.toByte(), 13, 10))
        return o.toByteArray()
    }

    // ── WebSocket, the little of it a tunnel needs ──

    private val random = SecureRandom()

    /* One binary message, masked (every client-to-server frame is). */
    fun wsFrame(data: ByteArray, off: Int = 0, len: Int = data.size, opcode: Int = 2): ByteArray {
        val head = when {
            len < 126 -> byteArrayOf((0x80 or opcode).toByte(), (0x80 or len).toByte())
            len < 65536 -> byteArrayOf((0x80 or opcode).toByte(), (0x80 or 126).toByte(), (len shr 8).toByte(), len.toByte())
            else -> byteArrayOf((0x80 or opcode).toByte(), (0x80 or 127).toByte(), 0, 0, 0, 0, (len ushr 24).toByte(), (len ushr 16).toByte(), (len ushr 8).toByte(), len.toByte())
        }
        val mask = ByteArray(4).also { random.nextBytes(it) }
        val out = ByteArray(head.size + 4 + len)
        System.arraycopy(head, 0, out, 0, head.size)
        System.arraycopy(mask, 0, out, head.size, 4)
        for (i in 0 until len) out[head.size + 4 + i] = (data[off + i].toInt() xor mask[i and 3].toInt()).toByte()
        return out
    }

    /* Takes the server's bytes, gives back the payloads of its data frames in
     * order; onPing for a ping, closed set by a close frame. Throws on what
     * no server sends (a masked frame, a length beyond WS_MAX_FRAME). */
    class WsReader(private val onPing: (ByteArray) -> Unit = {}) {
        private var buf = ByteArray(0)
        var closed = false
            private set

        fun push(chunk: ByteArray, off: Int = 0, len: Int = chunk.size): ByteArray {
            buf = if (buf.isEmpty()) chunk.copyOfRange(off, off + len) else buf + chunk.copyOfRange(off, off + len)
            val out = ByteArrayOutputStream()
            var at = 0
            while (!closed) {
                val left = buf.size - at
                if (left < 2) break
                val opcode = buf[at].toInt() and 0x0f
                if (buf[at + 1].toInt() and 0x80 != 0) throw IOException("a masked frame from the server")
                var n = buf[at + 1].toInt() and 0x7f
                var head = 2
                if (n == 126) {
                    if (left < 4) break
                    n = ((buf[at + 2].toInt() and 0xff) shl 8) or (buf[at + 3].toInt() and 0xff)
                    head = 4
                } else if (n == 127) {
                    if (left < 10) break
                    for (i in 2..5) if (buf[at + i].toInt() != 0) throw IOException("a frame too long")
                    if (buf[at + 6].toInt() and 0x80 != 0) throw IOException("a frame too long")
                    n = ((buf[at + 6].toInt() and 0xff) shl 24) or ((buf[at + 7].toInt() and 0xff) shl 16) or ((buf[at + 8].toInt() and 0xff) shl 8) or (buf[at + 9].toInt() and 0xff)
                    head = 10
                }
                if (n > WS_MAX_FRAME) throw IOException("a frame too long")
                if (left < head + n) break
                val from = at + head
                when (opcode) {
                    0, 1, 2 -> out.write(buf, from, n)
                    9 -> onPing(buf.copyOfRange(from, from + n))
                    8 -> closed = true
                }
                at = from + n
            }
            buf = if (at >= buf.size) ByteArray(0) else buf.copyOfRange(at, buf.size)
            return out.toByteArray()
        }
    }

    // ── the local client ──

    /*
     * A SOCKS5 server on 127.0.0.1 that sends every connection through the
     * server, as Shadowsocks.Client does: the engine is pointed at it with
     * `user` and `pass`, made fresh for each client, so no other app can use
     * the user's server through it. onError(why): the server could not be
     * used, with "noAnswer" (not reached), "tls" (reached, its TLS or its
     * certificate refused) or "protocol" (its answer is not this
     * protocol's). `tls` and `nameOk` stand in for the system's in tests.
     * This app is left out of its own VPN, so the connections to the server
     * go straight out.
     */
    class Client(
        private val l: Link,
        private val user: String = "",
        private val pass: String = "",
        private val tls: SSLSocketFactory = SSLSocketFactory.getDefault() as SSLSocketFactory,
        private val nameOk: (String, SSLSession) -> Boolean = { h, session -> HttpsURLConnection.getDefaultHostnameVerifier().verify(h, session) },
        private val onError: (String) -> Unit = {},
    ) {
        private val listen = ServerSocket(0, 64, InetAddress.getByName("127.0.0.1"))
        private val closed = AtomicBoolean(false)
        val port: Int get() = listen.localPort

        init {
            Thread({
                while (!closed.get()) {
                    val c = try { listen.accept() } catch (_: IOException) { break }
                    Thread({ serve(c) }, "vless-conn").apply { isDaemon = true }.start()
                }
            }, "vless-client").apply { isDaemon = true }.start()
        }

        fun close() {
            closed.set(true)
            try { listen.close() } catch (_: IOException) {}
        }

        private fun readN(i: InputStream, n: Int): ByteArray {
            val b = ByteArray(n)
            var got = 0
            while (got < n) {
                val r = i.read(b, got, n - got)
                if (r < 0) throw IOException("closed")
                got += r
            }
            return b
        }

        private class Refused(val why: String) : IOException(why)

        /* The connection to the server itself: TCP, then TLS where the link
         * says so, its certificate checked for its name. */
        private fun dial(): Socket {
            val raw = Socket()
            try {
                raw.connect(InetSocketAddress(l.host, l.port), 10_000)
            } catch (_: IOException) {
                try { raw.close() } catch (_: IOException) {}
                throw Refused("noAnswer")
            }
            raw.tcpNoDelay = true
            if (!l.tls) return raw
            try {
                raw.soTimeout = 15_000
                val servername = l.sni.ifEmpty { l.wsHost.ifEmpty { l.host } }
                val t = tls.createSocket(raw, servername, l.port, true) as SSLSocket
                val alpn = if (l.net == "tcp") l.alpn else listOf("http/1.1")
                if (alpn.isNotEmpty()) {
                    // Android 10 and later have it (looked up by name: it is
                    // not there on 8 and 9); before that TLS goes without
                    // ALPN, which every such server takes as HTTP/1.1.
                    try {
                        val params = t.sslParameters
                        javax.net.ssl.SSLParameters::class.java.getMethod("setApplicationProtocols", Array<String>::class.java).invoke(params, alpn.toTypedArray())
                        t.sslParameters = params
                    } catch (_: Throwable) {}
                }
                t.startHandshake()
                if (!nameOk(servername, t.session)) throw IOException("the certificate is not for $servername")
                raw.soTimeout = 0
                return t
            } catch (_: Exception) {
                try { raw.close() } catch (_: IOException) {}
                throw Refused("tls")
            }
        }

        /* The opening request of a WebSocket (ws) or of a plain upgrade
         * (httpupgrade), and its answer; what came right behind the answer
         * is given back. */
        private fun upgrade(s: Socket): ByteArray {
            val keyBytes = ByteArray(16).also { SecureRandom().nextBytes(it) }
            val key = Base64.getEncoder().encodeToString(keyBytes)
            val hostHeader = l.wsHost.ifEmpty { l.sni.ifEmpty { if (l.host.contains(':')) "[${l.host}]" else l.host } }
            val req = StringBuilder()
            req.append("GET ${l.path} HTTP/1.1\r\nHost: $hostHeader\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n")
            if (l.net == "ws") req.append("Sec-WebSocket-Key: $key\r\nSec-WebSocket-Version: 13\r\n")
            req.append("User-Agent: Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36\r\n\r\n")
            s.soTimeout = 15_000
            val o = s.getOutputStream()
            o.write(req.toString().toByteArray(Charsets.ISO_8859_1))
            o.flush()
            val i = s.getInputStream()
            val got = ByteArrayOutputStream()
            val b = ByteArray(4096)
            var end = -1
            while (end < 0) {
                val n = try { i.read(b) } catch (_: IOException) { -1 }
                if (n < 0) throw Refused("protocol")
                got.write(b, 0, n)
                val all = got.toByteArray()
                for (k in 0..all.size - 4) {
                    if (all[k].toInt() == 13 && all[k + 1].toInt() == 10 && all[k + 2].toInt() == 13 && all[k + 3].toInt() == 10) { end = k; break }
                }
                if (end < 0 && all.size > 65536) throw Refused("protocol")
            }
            val all = got.toByteArray()
            val head = String(all, 0, end, Charsets.ISO_8859_1)
            if (!Regex("^HTTP/1\\.1 101\\b").containsMatchIn(head)) throw Refused("protocol")
            if (l.net == "ws") {
                val accept = Regex("(?im)^sec-websocket-accept:\\s*(\\S+)").find(head)?.groupValues?.get(1)
                val want = Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-1").digest((key + WS_GUID).toByteArray(Charsets.ISO_8859_1)))
                if (accept != want) throw Refused("protocol")
            }
            s.soTimeout = 0
            return all.copyOfRange(end + 4, all.size)
        }

        private fun serve(c: Socket) {
            var up: Socket? = null
            try {
                c.tcpNoDelay = true
                c.soTimeout = 30_000
                val ci = c.getInputStream()
                val co = c.getOutputStream()
                val hello = readN(ci, 2)
                val offered = readN(ci, hello[1].toInt() and 0xff).map { it.toInt() and 0xff }
                if (hello[0].toInt() != 5) return
                if (user.isEmpty()) {
                    co.write(byteArrayOf(5, 0))
                } else {
                    if (2 !in offered) { co.write(byteArrayOf(5, 0xff.toByte())); return }
                    co.write(byteArrayOf(5, 2))
                    readN(ci, 1)
                    val u = String(readN(ci, readN(ci, 1)[0].toInt() and 0xff))
                    val p = String(readN(ci, readN(ci, 1)[0].toInt() and 0xff))
                    if (!MessageDigest.isEqual(u.toByteArray(), user.toByteArray()) || !MessageDigest.isEqual(p.toByteArray(), pass.toByteArray())) { co.write(byteArrayOf(1, 1)); return }
                    co.write(byteArrayOf(1, 0))
                }
                val req = readN(ci, 4)
                if (req[1].toInt() != 1) { co.write(byteArrayOf(5, 7, 0, 1, 0, 0, 0, 0, 0, 0)); return }
                val host = when (req[3].toInt()) {
                    1 -> readN(ci, 4).joinToString(".") { (it.toInt() and 0xff).toString() }
                    3 -> String(readN(ci, readN(ci, 1)[0].toInt() and 0xff), Charsets.UTF_8)
                    4 -> readN(ci, 16).let { a -> (0 until 8).joinToString(":") { g -> (((a[g * 2].toInt() and 0xff) shl 8) or (a[g * 2 + 1].toInt() and 0xff)).toString(16) } }
                    else -> { co.write(byteArrayOf(5, 8, 0, 1, 0, 0, 0, 0, 0, 0)); return }
                }
                val pb = readN(ci, 2)
                val port = ((pb[0].toInt() and 0xff) shl 8) or (pb[1].toInt() and 0xff)
                val s: Socket
                val rest: ByteArray
                try {
                    s = dial()
                    up = s
                    rest = if (l.net != "tcp") upgrade(s) else ByteArray(0)
                } catch (e: Refused) {
                    onError(e.why)
                    co.write(byteArrayOf(5, 5, 0, 1, 0, 0, 0, 0, 0, 0))
                    return
                }
                val ws = l.net == "ws"
                val so = s.getOutputStream()
                val lock = Any()
                fun send(b: ByteArray, off: Int = 0, len: Int = b.size) {
                    synchronized(lock) { if (ws) so.write(wsFrame(b, off, len)) else so.write(b, off, len); so.flush() }
                }
                co.write(byteArrayOf(5, 0, 0, 1, 0, 0, 0, 0, 0, 0))
                co.flush()
                val header = if (l.kind == "vless") vlessHeader(l.id, host, port) else trojanHeader(l.password, host, port)
                val back = Thread({ pumpBack(s, co, c, ws, rest) { d -> synchronized(lock) { so.write(wsFrame(d, 0, d.size, 10)); so.flush() } } }, "vless-back").apply { isDaemon = true }
                back.start()
                // The header goes out with the app's first bytes; an app that
                // waits for the server to speak first never sends, and the
                // header then goes by itself.
                val b = ByteArray(16 * 1024)
                c.soTimeout = 300
                var n = try { ci.read(b) } catch (_: SocketTimeoutException) { 0 }
                c.soTimeout = 0
                if (n > 0) send(header + b.copyOfRange(0, n)) else send(header)
                try {
                    while (n >= 0) {
                        n = ci.read(b)
                        if (n > 0) send(b, 0, n)
                    }
                } catch (_: IOException) {}
                // The app is done sending: said to the server where the
                // transport can say it, and its last bytes waited for.
                if (!ws) try { s.shutdownOutput() } catch (_: Exception) {}
                back.join(LINGER_MS)
            } catch (_: Exception) {
                // An I/O error: the connection ends.
            } finally {
                try { up?.close() } catch (_: IOException) {}
                try { c.close() } catch (_: IOException) {}
            }
        }

        private fun pumpBack(s: Socket, o: OutputStream, c: Socket, ws: Boolean, rest: ByteArray, pong: (ByteArray) -> Unit) {
            val reader = if (ws) WsReader { d -> try { pong(d) } catch (_: IOException) {} } else null
            // VLESS's answer starts with two bytes and its additions: taken off.
            var skip = if (l.kind == "vless") -1 else 0
            var pre = ByteArray(0)
            fun hand(d: ByteArray): Boolean {
                var data = d
                if (data.isEmpty()) return true
                if (skip != 0) {
                    pre += data
                    if (skip < 0) {
                        if (pre.size < 2) return true
                        if (pre[0].toInt() != 0) { onError("protocol"); return false }
                        skip = 2 + (pre[1].toInt() and 0xff)
                    }
                    if (pre.size < skip) return true
                    data = pre.copyOfRange(skip, pre.size)
                    pre = ByteArray(0)
                    skip = 0
                    if (data.isEmpty()) return true
                }
                o.write(data)
                o.flush()
                return true
            }
            val b = ByteArray(32 * 1024)
            try {
                if (rest.isNotEmpty() && !hand(if (reader != null) reader.push(rest) else rest)) return
                val i = s.getInputStream()
                while (reader?.closed != true) {
                    val n = i.read(b)
                    if (n < 0) break
                    if (!hand(if (reader != null) reader.push(b, 0, n) else b.copyOfRange(0, n))) break
                }
            } catch (_: IOException) {
            } finally {
                try { c.shutdownOutput() } catch (_: IOException) {}
                try { s.close() } catch (_: IOException) {}
            }
        }
    }
}
