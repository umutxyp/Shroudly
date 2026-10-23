package me.codeshare.shroudly

import java.io.DataInputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.Socket
import java.net.SocketTimeoutException
import java.net.URI
import java.util.concurrent.ConcurrentLinkedDeque
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SNIHostName
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

/*
 * A DNS server of the user's own (Settings, "DNS server", issue #34), in place
 * of the built-in encrypted routes: the Android side of
 * electron/custom-dns.js.
 *
 *   doh   https://host:port/path   DNS over HTTPS, HTTP/1.1 (as the
 *                                  built-in routes: a server that speaks
 *                                  only HTTP/2 does not answer here)
 *   dot   host:port, 853 if none   DNS over TLS
 *   tcp   host:port, 53 if none    plain DNS over TCP, where a network
 *                                  blocks or forges UDP port 53
 *   udp   host:port, 53 if none    plain DNS
 *
 * The encrypted ones go through the engine when it is up (the name in the
 * handshake is split like any other site's), the plain ones straight out;
 * this app is left out of its own VPN. A server given by name is looked up
 * through the built-in encrypted routes (bootstrap), never the network's DNS.
 * Connections are kept for the next question, one question at a time on
 * each. Nothing is logged or stored.
 */
data class DnsSpec(val kind: String, val host: String, val port: Int, val path: String = "")

class CustomDns(
    val spec: DnsSpec,
    private val socksPort: () -> Int,
    private val socksAuth: () -> SocksAuth?,
    /* The server's IPv4 address through the built-in routes, or null. */
    private val bootstrap: (String) -> String?,
) {
    companion object {
        val KINDS = listOf("doh", "dot", "tcp", "udp")
        private val PORTS = mapOf("doh" to 443, "dot" to 853, "tcp" to 53, "udp" to 53)
        const val TIMEOUT_MS = 2500
        // Plain DNS over UDP: sent again this long after, once, as any
        // resolver's client does, so a lost packet costs a moment.
        const val UDP_RESEND_MS = 800
        private const val KEEP = 4
        private val HOST = Regex("^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", RegexOption.IGNORE_CASE)
        private val V4 = Regex("^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$")

        /* An IPv4 or IPv6 address as typed (no lookup is made). */
        fun isIp(h: String): Boolean {
            val s = h.removePrefix("[").removeSuffix("]")
            V4.matchEntire(s)?.let { m -> return m.groupValues.drop(1).all { it.toInt() <= 255 } }
            if (!s.contains(':') || !Regex("^[0-9a-fA-F:.]+$").matches(s) || s.split("::").size > 2 || s.contains(":::")) return false
            if ((s.startsWith(":") && !s.startsWith("::")) || (s.endsWith(":") && !s.endsWith("::"))) return false
            val tail = s.substringAfterLast(':')
            val v4tail = tail.contains('.')
            if (v4tail && !isIp(tail)) return false
            val groups = s.split(':').filter { it.isNotEmpty() }.let { if (v4tail) it.dropLast(1) else it }
            if (groups.any { it.length > 4 }) return false
            val n = groups.size + if (v4tail) 2 else 0
            return if (s.contains("::")) n <= 7 else n == 8
        }

        /* An address, or a name (not one of digits only: "300.1.1.1" is a
         * mistyped address, not a name). */
        private fun hostOk(h: String) = isIp(h) || (HOST.matches(h) && !Regex("^[0-9.]+$").matches(h))

        /* What the user typed for `kind`: the server, or what is wrong ("kind",
         * "empty", "url", "host", "port"), as on the desktop. */
        fun parse(kind: String, text: String): Pair<DnsSpec?, String?> {
            if (kind !in KINDS) return null to "kind"
            var s = text.trim()
            if (s.isEmpty()) return null to "empty"
            if (kind == "doh") {
                val u = try { URI(if (Regex("^[a-z]+://", RegexOption.IGNORE_CASE).containsMatchIn(s)) s else "https://$s") } catch (_: Exception) { return null to "url" }
                if (!u.scheme.equals("https", true) || u.rawUserInfo != null) return null to "url"
                val host = (u.host ?: return null to "host").removePrefix("[").removeSuffix("]")
                if (!hostOk(host)) return null to "host"
                val port = if (u.port == -1) 443 else u.port
                if (port !in 1..65535) return null to "port"
                val path = (u.rawPath?.takeIf { it.isNotEmpty() && it != "/" } ?: "/dns-query") + (u.rawQuery?.let { "?$it" } ?: "")
                return DnsSpec(kind, host, port, path) to null
            }
            val scheme = mapOf("dot" to "^(tls|dot)://", "tcp" to "^tcp://", "udp" to "^(udp|dns)://")[kind]!!
            s = s.replace(Regex(scheme, RegexOption.IGNORE_CASE), "").trimEnd('/')
            if (Regex("^[a-z]+://", RegexOption.IGNORE_CASE).containsMatchIn(s)) return null to "url"
            var host = s
            var port = PORTS[kind]!!
            val v6 = Regex("^\\[([^\\]]+)\\](?::(\\d+))?$").matchEntire(s)
            if (v6 != null) {
                host = v6.groupValues[1]
                if (v6.groupValues[2].isNotEmpty()) port = v6.groupValues[2].toIntOrNull() ?: -1
            } else if (s.count { it == ':' } == 1) {
                host = s.substringBefore(':')
                port = s.substringAfter(':').toIntOrNull() ?: -1
            }
            if (port !in 1..65535) return null to "port"
            if (!hostOk(host)) return null to "host"
            return DnsSpec(kind, host, port) to null
        }

        /* As the user sees it: "https://dns.google/dns-query", "tls://1.1.1.1:853". */
        fun shown(spec: DnsSpec): String {
            val h = if (spec.host.contains(':')) "[${spec.host}]" else spec.host
            if (spec.kind == "doh") return "https://$h${if (spec.port == 443) "" else ":${spec.port}"}${spec.path}"
            return "${mapOf("dot" to "tls", "tcp" to "tcp", "udp" to "udp")[spec.kind]}://$h:${spec.port}"
        }
    }

    private class Conn(val sock: Socket, val input: InputStream, val output: OutputStream)

    @Volatile private var ip: String? = if (isIp(spec.host)) spec.host else null
    @Volatile private var ipAt = 0L
    private val idle = ConcurrentLinkedDeque<Conn>()
    @Volatile private var closed = false
    @Volatile var ewma = 0L
    // Not answering twice in a row: the built-in routes answer until
    // restUntil (DohForwarder.resolve); toldAt: when the log last said so.
    @Volatile var fails = 0
    @Volatile var restUntil = 0L
    @Volatile var toldAt = 0L
    // Used alone ("Only this server"): no fallback when it does not answer.
    @Volatile var strict = false

    private val verifier = HttpsURLConnection.getDefaultHostnameVerifier()
    private val name: String? = if (isIp(spec.host)) null else spec.host

    private fun address(): String {
        if (isIp(spec.host)) return spec.host.removePrefix("[").removeSuffix("]")
        val now = System.currentTimeMillis()
        ip?.let { if (now - ipAt < 10 * 60_000L) return it }
        val got = bootstrap(spec.host) ?: throw IOException("${spec.host} could not be looked up")
        ip = got
        ipAt = now
        return got
    }

    /* A new connection: through the engine for DoT and DoH (an IPv4 address,
     * the engine up), else straight; TLS checked against the server's name,
     * or the address it was given by. */
    private fun open(): Conn {
        val addr = address()
        val engine = if (spec.kind == "tcp") 0 else socksPort()
        val raw = Socket(Proxy.NO_PROXY)
        try {
            if (engine > 0 && !addr.contains(':')) {
                raw.connect(InetSocketAddress(InetAddress.getByName("127.0.0.1"), engine), TIMEOUT_MS)
                raw.soTimeout = TIMEOUT_MS
                Socks5.connect(raw, addr, spec.port, socksAuth())
            } else {
                raw.connect(InetSocketAddress(InetAddress.getByName(addr), spec.port), TIMEOUT_MS)
                raw.soTimeout = TIMEOUT_MS
            }
            if (spec.kind == "tcp") return Conn(raw, raw.getInputStream().buffered(), raw.getOutputStream())
            val ssl = (SSLSocketFactory.getDefault() as SSLSocketFactory).createSocket(raw, name ?: addr, spec.port, true) as SSLSocket
            if (name != null) ssl.sslParameters = ssl.sslParameters.apply { serverNames = listOf(SNIHostName(name)) }
            ssl.soTimeout = TIMEOUT_MS
            ssl.startHandshake()
            val who = name ?: addr
            if (!verifier.verify(who, ssl.session)) throw IOException("certificate does not belong to $who")
            return Conn(ssl, ssl.inputStream.buffered(), ssl.outputStream)
        } catch (e: Exception) {
            try { raw.close() } catch (_: IOException) {}
            throw e
        }
    }

    private fun close(c: Conn) { try { c.sock.close() } catch (_: IOException) {} }

    /* One question on a connection: the answer, and whether the connection
     * may be used again. Throws on anything else. */
    private fun exchange(c: Conn, msg: ByteArray): Pair<ByteArray, Boolean> {
        if (spec.kind == "doh") {
            val h = if (spec.host.contains(':')) "[${spec.host}]" else spec.host
            val head = "POST ${spec.path} HTTP/1.1\r\nHost: $h\r\nContent-Type: application/dns-message\r\n" +
                "Accept: application/dns-message\r\nContent-Length: ${msg.size}\r\n\r\n"
            c.output.write(head.toByteArray(Charsets.ISO_8859_1) + msg)
            c.output.flush()
            val r = Http1.read(c.input)
            if (r.status != 200) throw IOException("HTTP ${r.status}")
            val a = Dns.matchAnswer(msg, r.body) ?: throw IOException("not an answer to the query")
            val keep = r.headers["connection"]?.lowercase()?.contains("close") != true &&
                (r.headers["content-length"] != null || r.headers["transfer-encoding"] != null)
            return a to keep
        }
        val out = ByteArray(2 + msg.size)
        out[0] = (msg.size shr 8).toByte(); out[1] = msg.size.toByte()
        msg.copyInto(out, 2)
        c.output.write(out)
        c.output.flush()
        val input = DataInputStream(c.input)
        // An answer to an earlier question that timed out may come first.
        while (true) {
            val len = input.readUnsignedShort()
            val body = ByteArray(len)
            input.readFully(body)
            Dns.matchAnswer(msg, body)?.let { return it to true }
        }
    }

    private fun udp(msg: ByteArray): ByteArray {
        val to = InetSocketAddress(InetAddress.getByName(address()), spec.port)
        DatagramSocket().use { s ->
            s.send(DatagramPacket(msg, msg.size, to))
            val buf = ByteArray(4096)
            val start = System.nanoTime() / 1_000_000
            val until = start + TIMEOUT_MS
            var resent = false
            while (true) {
                val now = System.nanoTime() / 1_000_000
                if (now >= until) throw SocketTimeoutException("timeout")
                if (!resent && now - start >= UDP_RESEND_MS) { resent = true; s.send(DatagramPacket(msg, msg.size, to)) }
                val wait = if (resent) until - now else minOf(until, start + UDP_RESEND_MS) - now
                s.soTimeout = wait.coerceAtLeast(1).toInt()
                val p = DatagramPacket(buf, buf.size)
                try { s.receive(p) } catch (_: SocketTimeoutException) { continue }
                if (p.address != to.address) continue
                Dns.matchAnswer(msg, buf.copyOf(p.length))?.let { return it }
            }
        }
    }

    /* The server's answer to one query, under the query's id. A kept
     * connection the server has closed meanwhile is tried once more on a
     * new one. */
    fun query(msg: ByteArray): ByteArray {
        if (closed) throw IOException("closed")
        val t0 = System.nanoTime()
        val answer = if (spec.kind == "udp") udp(msg) else {
            val kept = idle.pollFirst()
            try {
                once(kept ?: open(), msg)
            } catch (e: Exception) {
                if (kept == null) throw e
                once(open(), msg)
            }
        }
        val ms = (System.nanoTime() - t0) / 1_000_000
        ewma = if (ewma == 0L) ms else (ewma * 7 + ms * 3) / 10
        return answer
    }

    private fun once(c: Conn, msg: ByteArray): ByteArray {
        try {
            val (a, keep) = exchange(c, msg)
            if (keep && !closed && idle.size < KEEP) idle.addFirst(c) else close(c)
            return a
        } catch (e: Exception) {
            close(c)
            throw e
        }
    }

    /* The kept connections closed (the network changed, protection stopped). */
    fun drop() { while (true) close(idle.pollFirst() ?: return) }

    fun close() { closed = true; drop() }
}
