package me.codeshare.shroudly

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.MessageDigest
import java.util.Base64

/* "Your own server" on Android (OwnServer, Shadowsocks):
 *   - the links the desktop takes, read the same; what cannot be used told
 *   - with a fixed salt, the bytes written are the desktop's
 *     (tests/net/fixtures/ss-vectors.json, which the desktop's are checked
 *     against, and the desktop's against shadowsocks-libev): Android speaks
 *     the same Shadowsocks
 *   - the client through a Shadowsocks server reaches a site; without its
 *     password another app is refused
 *   - the test of Settings says why a server does not work
 *   - the engine's flag and its "upstream" line */
class OwnServerTest {
    private fun hex(s: String) = s.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    private fun ByteArray.hex() = joinToString("") { "%02x".format(it) }

    @Test
    fun links() {
        val s = OwnServer.parse("socks5://u:p%40ss@1.2.3.4:1080").link!!
        assertEquals(listOf("socks5", "u", "p@ss", "1.2.3.4", "1080"), listOf(s.kind, s.user, s.pass, s.host, s.port.toString()))
        assertEquals("http", OwnServer.parse("http://proxy.ir:3128").link!!.kind)
        assertEquals("socks5", OwnServer.parse("1.2.3.4:1080").link!!.kind)
        assertEquals("2001:db8::1", OwnServer.parse("[2001:db8::1]:1080").link!!.host)
        val sip = "ss://" + Base64.getUrlEncoder().withoutPadding().encodeToString("chacha20-ietf-poly1305:p@ss:wörd".toByteArray()) + "@5.6.7.8:8388#Ali%27s"
        val p = OwnServer.parse(sip).link!!
        assertEquals(listOf("ss", "chacha20-ietf-poly1305", "p@ss:wörd", "5.6.7.8", "8388", "Ali's"), listOf(p.kind, p.method, p.password, p.host, p.port.toString(), p.name))
        val old = OwnServer.parse("ss://" + Base64.getEncoder().encodeToString("aes-256-gcm:secret@[2001:db8::2]:443".toByteArray()) + "#old").link!!
        assertEquals(listOf("aes-256-gcm", "secret", "2001:db8::2", "443"), listOf(old.method, old.password, old.host, old.port.toString()))
        assertEquals("empty", OwnServer.parse("").error)
        assertEquals("format", OwnServer.parse("ftp://x:1").error)
        assertEquals("user", OwnServer.parse("socks5://a%3Ab:c@h:1").error)
        assertEquals("format", OwnServer.parse("h:70000").error)
        val m = OwnServer.parse("ss://" + Base64.getEncoder().encodeToString("rc4-md5:x".toByteArray()) + "@h:1")
        assertEquals("method" to "rc4-md5", m.error to m.method)
        // What is shown has no password; the engine's line.
        assertEquals("Shadowsocks 5.6.7.8:8388", OwnServer.describe(p))
        assertEquals("socks5://u:p@ss@1.2.3.4:1080", OwnServer.engineLine(s))
        val auth = SocksAuth("0123456789abcdef", "00112233445566778899aabbccddeeff")
        assertEquals("socks5://0123456789abcdef:00112233445566778899aabbccddeeff@127.0.0.1:4242", OwnServer.engineLine(p, 4242, auth))
    }

    @Test
    fun theDesktopsBytes() {
        val f = listOf("../../tests/net/fixtures/ss-vectors.json", "tests/net/fixtures/ss-vectors.json").map(::File).first { it.exists() }
        val json = f.readText()
        val password = Regex("\"password\": \"([^\"]+)\"").find(json)!!.groupValues[1]
        val plain = Regex("\"plaintext\": \\[\\s*\"([0-9a-f]+)\",\\s*\"([0-9a-f]+)\"").find(json)!!.groupValues.drop(1).map(::hex) +
            listOf(ByteArray(17000) { 0x61 })
        var n = 0
        for (method in Shadowsocks.METHODS.keys) {
            val v = Regex("\"$method\": \\{\\s*\"key\": \"([0-9a-f]+)\",\\s*\"salt\": \"([0-9a-f]+)\",\\s*\"wire\": \\[\\s*\"([0-9a-f]+)\",\\s*\"([0-9a-f]+)\",\\s*\\{\\s*\"sha256\": \"([0-9a-f]+)\",\\s*\"length\": (\\d+)")
                .find(json)!!.groupValues
            val key = Shadowsocks.masterKey(password, Shadowsocks.METHODS.getValue(method).keyLen)
            assertEquals(v[1], key.hex())
            val e = Shadowsocks.Encoder(method, key, hex(v[2]))
            val w = plain.map { e.encode(it) }
            assertEquals(method, v[3], w[0].hex())
            assertEquals(method, v[4], w[1].hex())
            assertEquals(method, v[5], MessageDigest.getInstance("SHA-256").digest(w[2]).hex())
            assertEquals(v[6].toInt(), w[2].size)
            // Read back, cut at any byte.
            val d = Shadowsocks.Decoder(method, key)
            val all = w.reduce { a, b -> a + b }
            var back = ByteArray(0)
            for (i in all.indices step 777) back += d.push(all, i, minOf(777, all.size - i))
            assertFalse(d.bad)
            assertArrayEquals(plain.reduce { a, b -> a + b }, back)
            // Another password: not authenticated, nothing passed on.
            val other = Shadowsocks.Decoder(method, Shadowsocks.masterKey("other", key.size))
            assertEquals(0, other.push(all).size)
            assertTrue(other.bad)
            n++
        }
        assertEquals(3, n)
    }

    private fun readN(i: InputStream, n: Int): ByteArray {
        val b = ByteArray(n)
        var got = 0
        while (got < n) { val r = i.read(b, got, n - got); if (r < 0) throw IOException("closed"); got += r }
        return b
    }

    /* A Shadowsocks server for the test, from the same Encoder and Decoder:
     * every target goes to `site`. */
    private fun ssServer(method: String, password: String, site: Int): ServerSocket {
        val key = Shadowsocks.masterKey(password, Shadowsocks.METHODS.getValue(method).keyLen)
        val srv = ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"))
        Thread {
            while (true) {
                val c = try { srv.accept() } catch (_: IOException) { break }
                Thread {
                    try {
                        val dec = Shadowsocks.Decoder(method, key)
                        val enc = Shadowsocks.Encoder(method, key)
                        val i = c.getInputStream()
                        var got = ByteArray(0)
                        val b = ByteArray(4096)
                        while (got.size < 4) { val r = i.read(b); if (r < 0) return@Thread; got += dec.push(b, 0, r); if (dec.bad) return@Thread }
                        val skip = when (got[0].toInt()) { 1 -> 7; 4 -> 19; else -> 4 + got[1] }
                        val up = Socket("127.0.0.1", site)
                        if (got.size > skip) up.getOutputStream().write(got, skip, got.size - skip)
                        Thread {
                            val bb = ByteArray(4096)
                            try { while (true) { val r = up.getInputStream().read(bb); if (r < 0) break; c.getOutputStream().write(enc.encode(bb, 0, r)) } } catch (_: IOException) {}
                            c.close()
                        }.start()
                        while (true) { val r = i.read(b); if (r < 0) break; up.getOutputStream().write(dec.push(b, 0, r)) }
                    } catch (_: IOException) {}
                }.start()
            }
        }.start()
        return srv
    }

    @Test
    fun theClient() {
        // A site that answers anything with "ok".
        val site = ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"))
        Thread { while (true) { val c = try { site.accept() } catch (_: IOException) { break }; Thread { try { c.getInputStream().read(ByteArray(100)); c.getOutputStream().write("HTTP/1.1 200 OK\r\n\r\nok".toByteArray()); c.close() } catch (_: IOException) {} }.start() } }.start()
        for (method in Shadowsocks.METHODS.keys) {
            val ss = ssServer(method, "friends", site.localPort)
            val client = Shadowsocks.Client("127.0.0.1", ss.localPort, method, "friends", "e1e1e1e1", "f2f2f2f2")
            // Another app, without the password: refused.
            Socket("127.0.0.1", client.port).use { s ->
                s.soTimeout = 3000
                s.getOutputStream().write(byteArrayOf(5, 1, 0))
                assertEquals(0xff, readN(s.getInputStream(), 2)[1].toInt() and 0xff)
            }
            // The engine, with it: the site, through the server, by name.
            Socket("127.0.0.1", client.port).use { s ->
                s.soTimeout = 5000
                val o = s.getOutputStream()
                val i = s.getInputStream()
                o.write(byteArrayOf(5, 1, 2))
                assertEquals(2, readN(i, 2)[1].toInt())
                o.write(byteArrayOf(1, 8) + "e1e1e1e1".toByteArray() + byteArrayOf(8) + "f2f2f2f2".toByteArray())
                assertEquals(0, readN(i, 2)[1].toInt())
                val name = "some.site.example".toByteArray()
                o.write(byteArrayOf(5, 1, 0, 3, name.size.toByte()) + name + byteArrayOf(1, 0xbb.toByte()))
                assertEquals(0, readN(i, 10)[1].toInt())
                o.write("GET / HTTP/1.1\r\n\r\n".toByteArray())
                assertEquals("HTTP/1.1 200 OK\r\n\r\nok", String(i.readBytes()))
            }
            client.close()
            ss.close()
        }
        site.close()
    }

    @Test
    fun whyNot() {
        // Nothing listening there.
        val dead = ServerSocket(0).let { val p = it.localPort; it.close(); p }
        assertEquals("noAnswer", OwnServer.test(OwnServer.parse("socks5://127.0.0.1:$dead").link!!, timeoutMs = 2000))
        // A SOCKS5 server that asks for a password: none given, then a wrong one.
        val srv = ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"))
        Thread {
            while (true) {
                val c = try { srv.accept() } catch (_: IOException) { break }
                Thread {
                    try {
                        val i = c.getInputStream(); val o = c.getOutputStream()
                        val h = readN(i, 2); val m = readN(i, h[1].toInt())
                        if (2 !in m.map { it.toInt() }) { o.write(byteArrayOf(5, 0xff.toByte())); c.close(); return@Thread }
                        o.write(byteArrayOf(5, 2)); readN(i, 1)
                        readN(i, readN(i, 1)[0].toInt()); readN(i, readN(i, 1)[0].toInt())
                        o.write(byteArrayOf(1, 1)); c.close()
                    } catch (_: IOException) {}
                }.start()
            }
        }.start()
        assertEquals("asks", OwnServer.test(OwnServer.parse("127.0.0.1:${srv.localPort}").link!!, timeoutMs = 2000))
        assertEquals("auth", OwnServer.test(OwnServer.parse("socks5://a:b@127.0.0.1:${srv.localPort}").link!!, timeoutMs = 2000))
        srv.close()
        assertEquals("noAnswer", OwnServer.whyCode("does not answer"))
        assertEquals("protocol", OwnServer.whyCode("something else"))
    }

    @Test
    fun theEngine() {
        val a = Engine.args(1080, 0, emptyList(), upstream = File("/data/own-server"))
        assertEquals("/data/own-server", a[a.indexOf("--upstream-file") + 1])
        assertFalse(Engine.args(1080, 0, emptyList()).contains("--upstream-file"))
        assertEquals(EngineEvent.Upstream(false, "does not answer"), EngineEvent.parse("{\"type\":\"upstream\",\"ok\":0,\"why\":\"does not answer\"}"))
    }
}
