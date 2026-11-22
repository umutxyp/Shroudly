package me.codeshare.shroudly

import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.KeyFactory
import java.security.KeyStore
import java.security.MessageDigest
import java.security.cert.CertificateFactory
import java.security.spec.PKCS8EncodedKeySpec
import java.util.Base64
import java.util.Collections
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManagerFactory

/*
 * VLESS and Trojan for "Your own server" (Vless.kt), the Android side of
 * tests/net/vless.test.js: the same links read the same way, the kinds not
 * carried said to be so, the headers the desktop's bytes
 * (tests/net/fixtures/vless-vectors.json), WebSocket frames, and
 * connections through a server of each kind written here from the
 * protocols' descriptions: over TCP, a WebSocket and HTTPUpgrade, with TLS
 * and without, whole in both directions, a server that speaks first, a
 * wrong key, a certificate nobody vouches for.
 */
class VlessTest {
    private val id = "0f6c2c1e-7a53-4d0b-9c1d-5b8a3e2f4a67"
    private val idHex = id.replace("-", "")

    private fun fixture(name: String): File =
        listOf("../../tests/net/fixtures/$name", "tests/net/fixtures/$name").map(::File).first { it.exists() }

    private fun ByteArray.hex() = joinToString("") { "%02x".format(it.toInt() and 0xff) }

    @Test
    fun linksAreReadAsOnTheDesktop() {
        val p = Vless.parse("vless://$id@edge.example.net:443?path=%2Fd917409a2b69662b&security=tls&encryption=none&insecure=0&host=edge.example.net&type=ws&allowInsecure=0&sni=edge.example.net#Cloady").link!!
        assertEquals(Vless.Link("vless", "edge.example.net", 443, idHex, "", "ws", true, "edge.example.net", "edge.example.net", "/d917409a2b69662b", emptyList(), "Cloady"), p)
        assertEquals("VLESS edge.example.net:443 (WebSocket + TLS)", Vless.describe(p))
        val q = Vless.parse("vless://$id@1.2.3.4:80?type=ws&path=/ws%3Fed%3D2048&host=cdn.example.org#x%20y").link!!
        assertFalse(q.tls)
        assertEquals("/ws", q.path)
        assertEquals("cdn.example.org", q.wsHost)
        assertEquals("x y", q.name)
        assertEquals("/a?x=1", Vless.parse("vless://$id@host.example:443?type=ws&path=/a?x=1&ed=2560&security=tls").link!!.path)
        assertEquals("/a?x=1", Vless.parse("vless://$id@host.example:443?type=ws&path=%2Fa%3Fed%3D2560%26x%3D1&security=tls").link!!.path)
        val r = Vless.parse("vless://$id@[2001:db8::1]:8443?security=tls&sni=v.example.com&alpn=h2,http/1.1").link!!
        assertEquals("tcp", r.net)
        assertEquals("2001:db8::1", r.host)
        assertEquals(8443, r.port)
        assertEquals(listOf("h2", "http/1.1"), r.alpn)
        assertEquals("/", r.path)
        val h = Vless.parse("vless://$id@h.example:443?type=httpupgrade&security=tls&path=up&host=h.example").link!!
        assertEquals("httpupgrade", h.net)
        assertEquals("/up", h.path)
        val t = Vless.parse("trojan://p%40ss%3Aword@t.example:443?type=ws&path=/t&sni=t.example#T").link!!
        assertEquals("trojan", t.kind)
        assertEquals("p@ss:word", t.password)
        assertTrue(t.tls)
        assertNotNull(Vless.parse("  VLESS://${id.uppercase()}@H.example:443?TYPE=ws&Security=TLS  ").link)
    }

    @Test
    fun whatCannotBeCarriedIsSaid() {
        fun no(link: String): String = Vless.parse(link).let { if (it.link != null) "ok" else "${it.error}${it.what?.let { w -> ":$w" } ?: ""}" }
        assertEquals("unsupported:reality", no("vless://$id@h.example:443?security=reality&pbk=abc&sid=01&fp=chrome&type=tcp&flow=xtls-rprx-vision"))
        assertEquals("unsupported:flow", no("vless://$id@h.example:443?security=tls&flow=xtls-rprx-vision"))
        assertEquals("unsupported:transport", no("vless://$id@h.example:443?security=tls&type=grpc&serviceName=x"))
        assertEquals("unsupported:transport", no("vless://$id@h.example:443?security=tls&type=xhttp&path=/x"))
        assertEquals("unsupported:transport", no("vless://$id@h.example:443?type=kcp"))
        assertEquals("unsupported:transport", no("vless://$id@h.example:80?type=tcp&headerType=http"))
        assertEquals("unsupported:encryption", no("vless://$id@h.example:443?security=tls&encryption=mlkem768x25519plus.native.0rtt.abc"))
        assertEquals("unsupported:security", no("vless://$id@h.example:443?security=xtls"))
        // On a phone a certificate that cannot be checked is not taken.
        assertEquals("unsupported:insecure", no("vless://$id@h.example:443?security=tls&allowInsecure=1"))
        assertEquals("unsupported:insecure", no("trojan://pw@h.example:443?insecure=true"))
        for (bad in listOf(
            "vless://not-a-uuid@h.example:443", "vless://$id@h.example", "vless://$id@h.example:0", "vless://$id@h.example:99999",
            "vless://@h.example:443", "trojan://@h.example:443", "vless://$id@h.example:443?type=ws&host=a%20b",
            "vless://$id@h.example:443?type=ws&path=/a%0d%0aX:1", "vless://$id@h.example:443?sni=a%0ab", "ss://abc", "",
        )) assertEquals(bad, "format", no(bad))
        // Every part has a name for the screen.
        for (w in listOf("reality", "flow", "transport", "encryption", "security", "insecure")) assertTrue(Vless.unsupportedName(w).isNotEmpty() && Vless.unsupportedName(w) != w)
    }

    @Test
    fun throughOwnServer() {
        val p = OwnServer.parse("vless://$id@edge.example.net:443?type=ws&security=tls&path=/x&host=edge.example.net")
        val l = p.link!!
        assertEquals("vless", l.kind)
        assertEquals("edge.example.net", l.host)
        assertEquals(443, l.port)
        assertTrue(OwnServer.localClient(l))
        assertEquals("VLESS edge.example.net:443 (WebSocket + TLS)", OwnServer.describe(l))
        assertFalse(OwnServer.describe(l).contains(idHex))
        assertEquals("socks5://0123456789abcdef:00112233445566778899aabbccddeeff@127.0.0.1:4242",
            OwnServer.engineLine(l, 4242, SocksAuth("0123456789abcdef", "00112233445566778899aabbccddeeff")))
        val bad = OwnServer.parse("vless://$id@h.example:443?security=reality&pbk=x")
        assertNull(bad.link)
        assertEquals("unsupported", bad.error)
        assertEquals("reality", bad.what)
        assertEquals("Trojan t.example:443 (TCP + TLS)", OwnServer.describe(OwnServer.parse("trojan://pw@t.example:443").link!!))
        assertNotNull(OwnServer.WHY_TEXT["cert"])
    }

    @Test
    fun theDesktopsBytes() {
        val v = JSONObject(fixture("vless-vectors.json").readText())
        val a = v.getJSONArray("vless")
        assertTrue(a.length() >= 7)
        for (i in 0 until a.length()) {
            val c = a.getJSONObject(i)
            assertEquals(c.getString("host"), c.getString("header"), Vless.vlessHeader(c.getString("id"), c.getString("host"), c.getInt("port")).hex())
        }
        val t = v.getJSONArray("trojan")
        for (i in 0 until t.length()) {
            val c = t.getJSONObject(i)
            assertEquals(c.getString("host"), c.getString("header"), Vless.trojanHeader(c.getString("password"), c.getString("host"), c.getInt("port")).hex())
        }
        // No lookup and no surprise for what is not an address.
        assertNull(Vless.ipv6Bytes("example.com"))
        assertNull(Vless.ipv6Bytes("1:2:3"))
        assertNull(Vless.ipv6Bytes("::g"))
        assertEquals("00000000000000000000000000000001", Vless.ipv6Bytes("::1")!!.hex())
    }

    private fun serverFrame(data: ByteArray, opcode: Int = 2): ByteArray {
        val n = data.size
        val head = when {
            n < 126 -> byteArrayOf((0x80 or opcode).toByte(), n.toByte())
            n < 65536 -> byteArrayOf((0x80 or opcode).toByte(), 126, (n shr 8).toByte(), n.toByte())
            else -> byteArrayOf((0x80 or opcode).toByte(), 127, 0, 0, 0, 0, (n ushr 24).toByte(), (n ushr 16).toByte(), (n ushr 8).toByte(), n.toByte())
        }
        return head + data
    }

    @Test
    fun webSocketFrames() {
        val rnd = java.util.Random(7)
        for (n in listOf(0, 1, 125, 126, 127, 65535, 65536, 200000)) {
            val data = ByteArray(n).also { rnd.nextBytes(it) }
            val f = Vless.wsFrame(data)
            assertEquals(0x82, f[0].toInt() and 0x8f)
            assertTrue(f[1].toInt() and 0x80 != 0)
            var len = f[1].toInt() and 0x7f
            var at = 2
            if (len == 126) { len = ((f[2].toInt() and 0xff) shl 8) or (f[3].toInt() and 0xff); at = 4 } else if (len == 127) {
                len = ((f[6].toInt() and 0xff) shl 24) or ((f[7].toInt() and 0xff) shl 16) or ((f[8].toInt() and 0xff) shl 8) or (f[9].toInt() and 0xff); at = 10
            }
            assertEquals(n, len)
            val body = ByteArray(n) { (f[at + 4 + it].toInt() xor f[at + (it and 3)].toInt()).toByte() }
            assertArrayEquals(data, body)
        }
        val pings = ArrayList<String>()
        val rd = Vless.WsReader { pings.add(String(it)) }
        val parts = listOf(ByteArray(5), ByteArray(300), ByteArray(70000)).onEach { rnd.nextBytes(it) }
        val stream = serverFrame(parts[0]) + serverFrame("p1".toByteArray(), 9) + serverFrame(parts[1]) + serverFrame(parts[2]) + serverFrame(ByteArray(0), 10)
        val got = ByteArrayOutputStream()
        for (i in stream.indices step 777) got.write(rd.push(stream, i, minOf(777, stream.size - i)))
        assertArrayEquals(parts.reduce { a, b -> a + b }, got.toByteArray())
        assertEquals(listOf("p1"), pings)
        assertFalse(rd.closed)
        rd.push(serverFrame(ByteArray(0), 8))
        assertTrue(rd.closed)
        var threw = 0
        try { Vless.WsReader().push(Vless.wsFrame("x".toByteArray())) } catch (_: IOException) { threw++ }
        try { Vless.WsReader().push(byteArrayOf(0x82.toByte(), 127, 0, 0, 0, 1, 0, 0, 0, 0)) } catch (_: IOException) { threw++ }
        try { Vless.WsReader().push(byteArrayOf(0x82.toByte(), 127, 0, 0, 0, 0, 0x7f, -1, -1, -1)) } catch (_: IOException) { threw++ }
        assertEquals(3, threw)
    }

    // ── a server of each kind, for these tests only ──

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

    private fun pemBody(text: String, what: String): ByteArray =
        Base64.getMimeDecoder().decode(text.substringAfter("-----BEGIN $what-----").substringBefore("-----END $what-----"))

    private val cert by lazy { CertificateFactory.getInstance("X.509").generateCertificate(fixture("test-only-cert.pem").inputStream()) }

    private fun serverTls(): SSLContext {
        val key = KeyFactory.getInstance("RSA").generatePrivate(PKCS8EncodedKeySpec(pemBody(fixture("test-only-key.pem").readText(), "PRIVATE KEY")))
        val ks = KeyStore.getInstance(KeyStore.getDefaultType()).apply { load(null); setKeyEntry("k", key, CharArray(0), arrayOf(cert)) }
        val kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply { init(ks, CharArray(0)) }
        return SSLContext.getInstance("TLS").apply { init(kmf.keyManagers, null, null) }
    }

    /* A factory that vouches for the test's own certificate, and nothing else. */
    private fun trusting(): SSLSocketFactory {
        val ks = KeyStore.getInstance(KeyStore.getDefaultType()).apply { load(null); setCertificateEntry("c", cert) }
        val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(ks) }
        return SSLContext.getInstance("TLS").apply { init(null, tmf.trustManagers, null) }.socketFactory
    }

    private inner class Server(val kind: String, val net: String, tls: Boolean, val targets: Map<String, Int>) {
        val listen: ServerSocket = if (tls) serverTls().serverSocketFactory.createServerSocket(0, 64, InetAddress.getByName("127.0.0.1")) else ServerSocket(0, 64, InetAddress.getByName("127.0.0.1"))
        val port: Int get() = listen.localPort
        val requests: MutableList<String> = Collections.synchronizedList(ArrayList())
        val heads: MutableList<String> = Collections.synchronizedList(ArrayList())
        @Volatile var badAuth = 0
        @Volatile var unmasked = 0

        init {
            Thread {
                while (true) {
                    val s = try { listen.accept() } catch (_: IOException) { break }
                    Thread { try { serve(s) } catch (_: Exception) {} finally { try { s.close() } catch (_: IOException) {} } }.apply { isDaemon = true }.start()
                }
            }.apply { isDaemon = true }.start()
        }

        fun close() { try { listen.close() } catch (_: IOException) {} }

        /* The client's bytes, out of its frames where there are any. */
        private inner class In(val i: InputStream, val ws: Boolean) {
            private var buf = ByteArray(0)
            fun read(): ByteArray? {
                if (!ws) { val b = ByteArray(32768); val n = i.read(b); return if (n < 0) null else b.copyOfRange(0, n) }
                while (true) {
                    val h = try { readN(i, 2) } catch (_: IOException) { return null }
                    val opcode = h[0].toInt() and 0x0f
                    val masked = h[1].toInt() and 0x80 != 0
                    if (!masked) unmasked++
                    var n = h[1].toInt() and 0x7f
                    if (n == 126) { val e = readN(i, 2); n = ((e[0].toInt() and 0xff) shl 8) or (e[1].toInt() and 0xff) } else if (n == 127) {
                        val e = readN(i, 8); n = ((e[4].toInt() and 0xff) shl 24) or ((e[5].toInt() and 0xff) shl 16) or ((e[6].toInt() and 0xff) shl 8) or (e[7].toInt() and 0xff)
                    }
                    val mask = if (masked) readN(i, 4) else ByteArray(4)
                    val body = readN(i, n)
                    for (k in body.indices) body[k] = (body[k].toInt() xor mask[k and 3].toInt()).toByte()
                    if (opcode == 8) return null
                    if (opcode == 0 || opcode == 2) return body
                }
            }
            fun exactly(n: Int): ByteArray {
                while (buf.size < n) buf += read() ?: throw IOException("closed")
                val out = buf.copyOfRange(0, n)
                buf = buf.copyOfRange(n, buf.size)
                return out
            }
            fun rest(): ByteArray = buf.also { buf = ByteArray(0) }
        }

        private fun serve(s: Socket) {
            val si = s.getInputStream()
            val so = s.getOutputStream()
            if (net != "tcp") {
                val head = StringBuilder()
                while (!head.endsWith("\r\n\r\n")) { val c = si.read(); if (c < 0) return; head.append(c.toChar()) }
                heads.add(head.toString())
                val key = Regex("(?im)^sec-websocket-key:\\s*(\\S+)").find(head)?.groupValues?.get(1)
                if (!head.startsWith("GET /tunnel HTTP/1.1\r\n") || (net == "ws" && key == null)) {
                    so.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray()); so.flush(); return
                }
                val accept = if (net == "ws") "Sec-WebSocket-Accept: ${Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-1").digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").toByteArray()))}\r\n" else ""
                so.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n$accept\r\n".toByteArray()); so.flush()
            }
            val ws = net == "ws"
            val input = In(si, ws)
            val host: String
            val port: Int
            if (kind == "vless") {
                val h = input.exactly(18)
                if (h[0].toInt() != 0 || h.copyOfRange(1, 17).hex() != idHex) { badAuth++; return }
                input.exactly(h[17].toInt() and 0xff)
                val c = input.exactly(4)
                if (c[0].toInt() != 1) return
                port = ((c[1].toInt() and 0xff) shl 8) or (c[2].toInt() and 0xff)
                host = when (c[3].toInt()) {
                    1 -> input.exactly(4).joinToString(".") { (it.toInt() and 0xff).toString() }
                    2 -> String(input.exactly(input.exactly(1)[0].toInt() and 0xff))
                    else -> input.exactly(16).hex()
                }
            } else {
                val h = input.exactly(58)
                val want = MessageDigest.getInstance("SHA-224").digest("the pass word".toByteArray()).hex()
                if (String(h, 0, 56, Charsets.ISO_8859_1) != want || h[56].toInt() != 13 || h[57].toInt() != 10) { badAuth++; return }
                val c = input.exactly(2)
                if (c[0].toInt() != 1) return
                host = when (c[1].toInt()) {
                    1 -> input.exactly(4).joinToString(".") { (it.toInt() and 0xff).toString() }
                    3 -> String(input.exactly(input.exactly(1)[0].toInt() and 0xff))
                    else -> input.exactly(16).hex()
                }
                val pb = input.exactly(4)
                port = ((pb[0].toInt() and 0xff) shl 8) or (pb[1].toInt() and 0xff)
            }
            requests.add("$host:$port")
            val up = Socket("127.0.0.1", targets[host] ?: return)
            val lock = Any()
            fun send(d: ByteArray) = synchronized(lock) {
                if (ws) { for (i in d.indices step 1000) so.write(serverFrame(d.copyOfRange(i, minOf(i + 1000, d.size)))) } else so.write(d)
                so.flush()
            }
            val back = Thread {
                try {
                    // VLESS answers with its version, a length, and that many bytes.
                    var first = if (kind == "vless") byteArrayOf(0, 3, 1, 2, 3) else ByteArray(0)
                    if (ws) synchronized(lock) { so.write(serverFrame("hi".toByteArray(), 9)); so.flush() }
                    val b = ByteArray(32768)
                    val ui = up.getInputStream()
                    while (true) {
                        val n = ui.read(b)
                        if (n < 0) break
                        send(first + b.copyOfRange(0, n))
                        first = ByteArray(0)
                    }
                } catch (_: IOException) {} finally { try { s.close() } catch (_: IOException) {} }
            }.apply { isDaemon = true }
            back.start()
            try {
                val uo = up.getOutputStream()
                val rest = input.rest()
                if (rest.isNotEmpty()) { uo.write(rest); uo.flush() }
                while (true) { val d = input.read() ?: break; uo.write(d); uo.flush() }
                up.shutdownOutput()
                back.join(5000)
            } catch (_: IOException) {} finally { try { up.close() } catch (_: IOException) {} }
        }
    }

    private fun socks(port: Int, host: String, dport: Int, user: String = "", pass: String = ""): Socket {
        val s = Socket()
        s.soTimeout = 15_000
        s.connect(InetSocketAddress("127.0.0.1", port), 5000)
        val o = s.getOutputStream()
        val i = s.getInputStream()
        o.write(if (user.isEmpty()) byteArrayOf(5, 1, 0) else byteArrayOf(5, 1, 2)); o.flush()
        val m = readN(i, 2)
        if (m[1].toInt() == 2) {
            o.write(byteArrayOf(1, user.length.toByte()) + user.toByteArray() + byteArrayOf(pass.length.toByte()) + pass.toByteArray()); o.flush()
            if (readN(i, 2)[1].toInt() != 0) { s.close(); throw IOException("auth refused") }
        } else if (m[1].toInt() != 0) { s.close(); throw IOException("no method") }
        val name = host.toByteArray()
        o.write(byteArrayOf(5, 1, 0, 3, name.size.toByte()) + name + byteArrayOf((dport shr 8).toByte(), dport.toByte())); o.flush()
        val r = readN(i, 10)
        if (r[1].toInt() != 0) { s.close(); throw IOException("socks ${r[1]}") }
        return s
    }

    @Test
    fun throughAServerOfEachKind() {
        val rnd = java.util.Random(11)
        val blob = ByteArray(2 * 1024 * 1024).also { rnd.nextBytes(it) }
        val echo = ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"))
        val giver = ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"))
        val banner = ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"))
        fun accept(srv: ServerSocket, f: (Socket) -> Unit) = Thread {
            while (true) {
                val c = try { srv.accept() } catch (_: IOException) { break }
                Thread { try { f(c) } catch (_: Exception) {} finally { try { c.close() } catch (_: IOException) {} } }.apply { isDaemon = true }.start()
            }
        }.apply { isDaemon = true }.start()
        accept(echo) { c -> val b = ByteArray(32768); while (true) { val n = c.getInputStream().read(b); if (n < 0) break; c.getOutputStream().write(b, 0, n); c.getOutputStream().flush() } }
        accept(giver) { c -> c.getInputStream().read(ByteArray(64)); c.getOutputStream().write(blob); c.getOutputStream().flush() }
        accept(banner) { c -> c.getOutputStream().write("220 hello\r\n".toByteArray()); c.getOutputStream().flush(); val n = c.getInputStream().read(ByteArray(64)); c.getOutputStream().write("got $n\r\n".toByteArray()); c.getOutputStream().flush() }
        val targets = mapOf("echo.test" to echo.localPort, "giver.test" to giver.localPort, "banner.test" to banner.localPort)
        val trust = trusting()
        try {
            for (kind in listOf("vless", "trojan")) for (net in listOf("tcp", "ws", "httpupgrade")) for (tls in listOf(true, false)) {
                val label = "$kind over $net${if (tls) " + TLS" else ""}"
                val srv = Server(kind, net, tls, targets)
                val secret = if (kind == "vless") id else "the%20pass%20word"
                val link = Vless.parse("$kind://$secret@127.0.0.1:${srv.port}?type=$net&security=${if (tls) "tls" else "none"}&path=%2Ftunnel%3Fed%3D2048&host=front.example&sni=test.local#t").link!!
                val errors = Collections.synchronizedList(ArrayList<String>())
                val client = Vless.Client(link, "u1", "p-secret", trust, { _, _ -> true }) { errors.add(it) }
                try {
                    // An echo: what goes up comes back.
                    var s = socks(client.port, "echo.test", 7, "u1", "p-secret")
                    val up = ByteArray(300_000).also { rnd.nextBytes(it) }
                    val writer = Thread { try { val o = s.getOutputStream(); for (i in up.indices step 40_000) { o.write(up, i, minOf(40_000, up.size - i)); o.flush() } } catch (_: IOException) {} }
                    writer.start()
                    assertArrayEquals(label, up, readN(s.getInputStream(), up.size))
                    writer.join()
                    s.close()
                    // 2 MB down, whole.
                    s = socks(client.port, "giver.test", 80, "u1", "p-secret")
                    s.getOutputStream().write("GET / HTTP/1.1\r\n\r\n".toByteArray()); s.getOutputStream().flush()
                    assertArrayEquals(label, blob, readN(s.getInputStream(), blob.size))
                    s.close()
                    // A server that speaks first: the header goes by itself.
                    s = socks(client.port, "banner.test", 25, "u1", "p-secret")
                    assertEquals(label, "220 hello\r\n", String(readN(s.getInputStream(), 11)))
                    s.getOutputStream().write("EHLO x\r\n".toByteArray()); s.getOutputStream().flush()
                    assertEquals(label, "got 8\r\n", String(readN(s.getInputStream(), 7)))
                    s.close()
                    assertEquals(label, listOf("echo.test:7", "giver.test:80", "banner.test:25"), srv.requests.toList())
                    assertEquals(label, 0, srv.badAuth)
                    assertTrue(label, errors.isEmpty())
                    if (net != "tcp") {
                        assertTrue(label, srv.heads.all { it.startsWith("GET /tunnel HTTP/1.1\r\n") && it.contains("\r\nHost: front.example\r\n") && it.contains("Mozilla/5.0") })
                    }
                    if (net == "ws") assertEquals(label, 0, srv.unmasked)
                    // Another app without the client's own password gets nothing.
                    var refused = 0
                    try { socks(client.port, "echo.test", 7, "u1", "wrong").close() } catch (_: IOException) { refused++ }
                    try { socks(client.port, "echo.test", 7).close() } catch (_: IOException) { refused++ }
                    assertEquals(label, 2, refused)
                    assertEquals(label, 3, srv.requests.size)
                } finally { client.close() }

                // A wrong key: closed by the server, nothing relayed.
                val bad = if (kind == "vless") link.copy(id = "00112233445566778899aabbccddeeff") else link.copy(password = "not it")
                val c2 = Vless.Client(bad, tls = trust, nameOk = { _, _ -> true })
                try {
                    val s = socks(c2.port, "echo.test", 7)
                    s.getOutputStream().write("hello".toByteArray()); s.getOutputStream().flush()
                    s.soTimeout = 8000
                    assertEquals(label, -1, s.getInputStream().read())
                    s.close()
                    assertEquals(label, 1, srv.badAuth)
                } finally { c2.close() }

                if (tls) {
                    // A certificate nobody vouches for (the system's own trust): refused, said as "tls".
                    val why = Collections.synchronizedList(ArrayList<String>())
                    val c3 = Vless.Client(link) { why.add(it) }
                    try {
                        var failed = false
                        try { socks(c3.port, "echo.test", 7).close() } catch (_: IOException) { failed = true }
                        assertTrue(label, failed)
                        assertEquals(label, listOf("tls"), why.toList())
                    } finally { c3.close() }
                    // A certificate for another name: refused too.
                    val c4 = Vless.Client(link, tls = trust, nameOk = { _, _ -> false }) { why.add(it) }
                    try {
                        var failed = false
                        try { socks(c4.port, "echo.test", 7).close() } catch (_: IOException) { failed = true }
                        assertTrue(label, failed)
                        assertEquals(label, listOf("tls", "tls"), why.toList())
                    } finally { c4.close() }
                }
                if (net != "tcp") {
                    // A path the server does not know (its 404): "does not speak the protocol".
                    val why = Collections.synchronizedList(ArrayList<String>())
                    val c5 = Vless.Client(link.copy(path = "/elsewhere"), tls = trust, nameOk = { _, _ -> true }) { why.add(it) }
                    try {
                        var failed = false
                        try { socks(c5.port, "echo.test", 7).close() } catch (_: IOException) { failed = true }
                        assertTrue(label, failed)
                        assertEquals(label, listOf("protocol"), why.toList())
                    } finally { c5.close() }
                }
                srv.close()
            }
            // A server that is not there.
            val dead = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")).let { val p = it.localPort; it.close(); p }
            val why = Collections.synchronizedList(ArrayList<String>())
            val c = Vless.Client(Vless.parse("vless://$id@127.0.0.1:$dead?type=ws&security=tls").link!!) { why.add(it) }
            try {
                var failed = false
                try { socks(c.port, "echo.test", 7).close() } catch (_: IOException) { failed = true }
                assertTrue(failed)
                assertEquals(listOf("noAnswer"), why.toList())
            } finally { c.close() }
        } finally {
            echo.close(); giver.close(); banner.close()
        }
    }
}
