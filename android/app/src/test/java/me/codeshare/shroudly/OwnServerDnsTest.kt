package me.codeshare.shroudly

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.io.IOException
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.Collections
import kotlin.concurrent.thread

/* Issue #67: with "Your own server", DNS went straight out to the resolvers
 * from the phone's own connection. Now every question goes through the
 * engine, and so through the server, as on the desktop:
 *   - the built-in routes: every IPv4 route through the engine, none at all
 *     before it is up, none straight out
 *   - a DNS server of the user's own: through the engine by name, plain DNS
 *     over TCP; not one UDP packet straight to it
 *   - the services turn it on with the server */
class OwnServerDnsTest {
    @Test
    fun builtInRoutesOnlyThroughTheEngine() {
        val all = DohForwarder.routes()
        assertTrue("before the engine is up: no route at all", DohForwarder.plan(all, null, 1000, engineReady = false, throughEngine = true).isEmpty())
        val plan = DohForwarder.plan(all, null, 1000, engineReady = true, throughEngine = true)
        assertTrue("the engine up: routes to ask", plan.isNotEmpty())
        assertTrue("IPv4 ones, which the engine's SOCKS5 port takes", plan.none { it.v6 })
        // Without a server of one's own: straight routes as before, before the engine too.
        assertTrue(DohForwarder.plan(all, null, 1000, engineReady = false).any { !it.viaEngine })
    }

    /* A DNS answer to `q`: one A record, 192.0.2.7. */
    private fun answer(q: ByteArray): ByteArray {
        val r = q.copyOf()
        r[2] = 0x81.toByte(); r[3] = 0x80.toByte(); r[6] = 0; r[7] = 1
        return r + byteArrayOf(0xc0.toByte(), 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 192.toByte(), 0, 2, 7)
    }

    @Test
    fun ownDnsServerThroughTheEngineOverTcp() {
        val loop = InetAddress.getByName("127.0.0.1")
        // The DNS server, standing in on both UDP and TCP.
        val udp = DatagramSocket(0, loop)
        val udpHits = Collections.synchronizedList(mutableListOf<Int>())
        thread(isDaemon = true) {
            val buf = ByteArray(4096)
            while (!udp.isClosed) {
                val p = DatagramPacket(buf, buf.size)
                try { udp.receive(p) } catch (_: IOException) { break }
                udpHits += p.length
                val a = answer(buf.copyOf(p.length))
                udp.send(DatagramPacket(a, a.size, p.address, p.port))
            }
        }
        val tcp = ServerSocket(udp.localPort, 8, loop)
        thread(isDaemon = true) {
            while (!tcp.isClosed) {
                val c = try { tcp.accept() } catch (_: IOException) { break }
                thread(isDaemon = true) {
                    try {
                        val i = DataInputStream(c.getInputStream()); val o = DataOutputStream(c.getOutputStream())
                        while (true) {
                            val q = ByteArray(i.readUnsignedShort()); i.readFully(q)
                            val a = answer(q); o.writeShort(a.size); o.write(a); o.flush()
                        }
                    } catch (_: IOException) {} finally { c.close() }
                }
            }
        }
        // The engine's SOCKS5 port, standing in: records each target and
        // sends a name it is given to the stand-in above.
        val targets = Collections.synchronizedList(mutableListOf<String>())
        val socks = ServerSocket(0, 8, loop)
        thread(isDaemon = true) {
            while (!socks.isClosed) {
                val c = try { socks.accept() } catch (_: IOException) { break }
                thread(isDaemon = true) {
                    try {
                        val i = DataInputStream(c.getInputStream()); val o = c.getOutputStream()
                        i.readUnsignedByte(); val n = i.readUnsignedByte(); i.readFully(ByteArray(n)); o.write(byteArrayOf(5, 0))
                        i.readUnsignedByte(); i.readUnsignedByte(); i.readUnsignedByte()
                        val host = when (i.readUnsignedByte()) {
                            1 -> ByteArray(4).also { i.readFully(it) }.joinToString(".") { (it.toInt() and 0xff).toString() }
                            3 -> String(ByteArray(i.readUnsignedByte()).also { i.readFully(it) })
                            else -> "?"
                        }
                        val port = i.readUnsignedShort()
                        targets += "$host:$port"
                        val up = Socket(loop, udp.localPort)
                        o.write(byteArrayOf(5, 0, 0, 1, 0, 0, 0, 0, 0, 0)); o.flush()
                        thread(isDaemon = true) { try { up.getInputStream().copyTo(o) } catch (_: IOException) {} finally { c.close() } }
                        i.copyTo(up.getOutputStream())
                    } catch (_: IOException) {} finally { c.close() }
                }
            }
        }
        try {
            val spec = CustomDns.parse("udp", "dns.example:${udp.localPort}").first!!
            var through = true
            val d = CustomDns(spec, { socks.localPort }, { null }, null, throughEngine = { through }) { "127.0.0.1" }
            val a = d.query(Dns.buildQuery("example.org", Dns.TYPE_A, 7))
            assertEquals("192.0.2.7", Dns.firstA(a))
            assertEquals("not one UDP packet straight to the server", 0, udpHits.size)
            assertEquals("through the engine, by name", listOf("dns.example:${udp.localPort}"), targets.toList())
            // The engine not up yet: nothing, rather than straight.
            val waiting = CustomDns(spec, { 0 }, { null }, null, throughEngine = { true }) { "127.0.0.1" }
            val err = runCatching { waiting.query(Dns.buildQuery("example.org", Dns.TYPE_A, 8)) }.exceptionOrNull()
            assertTrue(err?.message?.contains("waiting for the engine") == true)
            assertEquals(0, udpHits.size)
            // Without a server of one's own: plain DNS over UDP, as before.
            through = false
            val b = d.query(Dns.buildQuery("example.net", Dns.TYPE_A, 9))
            assertEquals("192.0.2.7", Dns.firstA(b))
            assertEquals(1, udpHits.size)
        } finally {
            socks.close(); tcp.close(); udp.close()
        }
    }

    @Test
    fun servicesTurnItOnWithTheServer() {
        for (f in listOf("ShroudlyVpnService.kt", "ShroudlyProxyService.kt")) {
            val src = File("src/main/java/me/codeshare/shroudly/$f").readText()
            assertTrue(f, src.contains("doh?.throughEngine = upstream != null"))
        }
    }
}
