package me.codeshare.shroudly

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.IOException
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.atomic.AtomicInteger

/* The user's own DNS server (issue #34): what is typed, read or refused as on
 * the desktop; plain UDP and TCP answered by a server here, a kept TCP
 * connection used again and, once the server has closed it, a new one. */
class CustomDnsTest {
    private val lo = InetAddress.getByName("127.0.0.1")

    private fun answer(q: ByteArray, ip: String): ByteArray {
        val a = q.copyOf()
        a[2] = 0x81.toByte(); a[3] = 0x80.toByte()
        a[7] = 1
        val rr = byteArrayOf(0xc0.toByte(), 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4) + ip.split('.').map { it.toInt().toByte() }.toByteArray()
        return a + rr
    }

    private fun dns(spec: DnsSpec) = CustomDns(spec, { 0 }, { null }) { null }

    @Test
    fun readsWhatIsTyped() {
        assertEquals(DnsSpec("doh", "dns.google", 443, "/dns-query"), CustomDns.parse("doh", "https://dns.google/dns-query").first)
        assertEquals(DnsSpec("doh", "dns.example.com", 443, "/dns-query"), CustomDns.parse("doh", "dns.example.com").first)
        assertEquals(DnsSpec("doh", "1.1.1.1", 8443, "/q?x=1"), CustomDns.parse("doh", "https://1.1.1.1:8443/q?x=1").first)
        assertEquals(DnsSpec("dot", "1.1.1.1", 853), CustomDns.parse("dot", "tls://1.1.1.1").first)
        assertEquals(DnsSpec("dot", "dns.quad9.net", 8853), CustomDns.parse("dot", "dns.quad9.net:8853").first)
        assertEquals(DnsSpec("tcp", "8.8.8.8", 53), CustomDns.parse("tcp", " 8.8.8.8 ").first)
        assertEquals(DnsSpec("tcp", "2001:4860:4860::8888", 53), CustomDns.parse("tcp", "tcp://[2001:4860:4860::8888]:53").first)
        assertEquals(DnsSpec("udp", "9.9.9.9", 53), CustomDns.parse("udp", "udp://9.9.9.9").first)
        assertEquals(DnsSpec("udp", "2620:fe::fe", 53), CustomDns.parse("udp", "2620:fe::fe").first)
    }

    @Test
    fun refusesWithTheReason() {
        assertEquals("empty", CustomDns.parse("doh", "  ").second)
        assertEquals("url", CustomDns.parse("doh", "http://dns.google/dns-query").second)
        assertEquals("url", CustomDns.parse("dot", "https://x.y").second)
        assertEquals("port", CustomDns.parse("tcp", "8.8.8.8:99999").second)
        assertEquals("host", CustomDns.parse("udp", "not a host").second)
        assertEquals("kind", CustomDns.parse("ftp", "1.1.1.1").second)
        assertEquals("host", CustomDns.parse("udp", "300.1.1.1").second)
        assertEquals("host", CustomDns.parse("doh", "https://1.2.3/dns-query").second)
        assertEquals("host", CustomDns.parse("tcp", "2001:db8:::1").second)
    }

    @Test
    fun showsItAsTyped() {
        assertEquals("https://dns.google/dns-query", CustomDns.shown(CustomDns.parse("doh", "dns.google").first!!))
        assertEquals("tls://1.1.1.1:853", CustomDns.shown(CustomDns.parse("dot", "1.1.1.1").first!!))
        assertEquals("tcp://[::1]:53", CustomDns.shown(CustomDns.parse("tcp", "[::1]:53").first!!))
        assertTrue(CustomDns.isIp("::1") && CustomDns.isIp("::ffff:1.2.3.4") && CustomDns.isIp("2001:db8::1"))
        assertFalse(CustomDns.isIp("1.2.3") || CustomDns.isIp("2001:db8:::1") || CustomDns.isIp("dns.google"))
    }

    @Test
    fun plainUdpAnswers() {
        DatagramSocket(0, lo).use { srv ->
            Thread {
                val buf = ByteArray(512)
                val p = DatagramPacket(buf, buf.size)
                srv.receive(p)
                val a = answer(buf.copyOf(p.length), "93.184.215.14")
                srv.send(DatagramPacket(a, a.size, p.socketAddress))
            }.start()
            val q = Dns.buildQuery("example.com", Dns.TYPE_A, 0x4242)
            val a = dns(DnsSpec("udp", "127.0.0.1", srv.localPort)).query(q)
            assertEquals("93.184.215.14", Dns.firstA(a))
            assertEquals(0x42, a[0].toInt()); assertEquals(0x42, a[1].toInt())
        }
    }

    @Test
    fun plainUdpAsksAgainWhenTheFirstIsLost() {
        DatagramSocket(0, lo).use { srv ->
            val seen = AtomicInteger()
            Thread {
                val buf = ByteArray(512)
                repeat(2) {
                    val p = DatagramPacket(buf, buf.size)
                    srv.receive(p)
                    // The first question is lost on the way.
                    if (seen.incrementAndGet() == 2) {
                        val a = answer(buf.copyOf(p.length), "93.184.215.21")
                        srv.send(DatagramPacket(a, a.size, p.socketAddress))
                    }
                }
            }.start()
            val t0 = System.nanoTime()
            val a = dns(DnsSpec("udp", "127.0.0.1", srv.localPort)).query(Dns.buildQuery("example.com", Dns.TYPE_A, 7))
            assertEquals("93.184.215.21", Dns.firstA(a))
            assertEquals(2, seen.get())
            assertTrue((System.nanoTime() - t0) / 1_000_000 < 2000)
        }
    }

    @Test
    fun plainTcpKeepsItsConnection() {
        val conns = AtomicInteger()
        ServerSocket(0, 5, lo).use { srv ->
            Thread {
                try {
                    while (true) {
                        val s = srv.accept()
                        val n = conns.incrementAndGet()
                        Thread {
                            s.use {
                                val input = DataInputStream(it.getInputStream())
                                val out = DataOutputStream(it.getOutputStream())
                                // The first connection answers two questions, then closes.
                                repeat(if (n == 1) 2 else 10) {
                                    val q = ByteArray(input.readUnsignedShort()).also { b -> input.readFully(b) }
                                    val a = answer(q, "93.184.215.15")
                                    out.writeShort(a.size); out.write(a); out.flush()
                                }
                            }
                        }.start()
                    }
                } catch (_: IOException) {}
            }.start()
            val d = dns(DnsSpec("tcp", "127.0.0.1", srv.localPort))
            for (i in 1..3) assertEquals("93.184.215.15", Dns.firstA(d.query(Dns.buildQuery("n$i.example", Dns.TYPE_A, i))))
            // Two on the first connection; the third found it closed and was asked again on a new one.
            assertEquals(2, conns.get())
            d.close()
        }
    }

    @Test
    fun aServerThatIsNotThereFails() {
        val port = ServerSocket(0, 1, lo).use { it.localPort }
        val d = dns(DnsSpec("tcp", "127.0.0.1", port))
        assertTrue(runCatching { d.query(Dns.buildQuery("example.com", Dns.TYPE_A, 1)) }.isFailure)
        val named = CustomDns(DnsSpec("dot", "dns.invalid", 853), { 0 }, { null }) { null }
        val e = runCatching { named.query(Dns.buildQuery("example.com", Dns.TYPE_A, 1)) }.exceptionOrNull()
        assertTrue(e?.message?.contains("could not be looked up") == true)
    }

    /* "Only this server" (issue #34): when it does not answer, nothing else
     * is asked, the log says so, and the engine gets "server failure" at
     * once rather than waiting and then asking plain DNS. */
    @Test
    fun onlyThisServerFailsWithNothingElseAsked() {
        val port = ServerSocket(0, 1, lo).use { it.localPort }
        val logs = java.util.Collections.synchronizedList(ArrayList<String>())
        val f = DohForwarder({ logs += it }, null) {}
        f.setCustom(DnsSpec("tcp", "127.0.0.1", port), strict = true)
        assertTrue(f.usingCustom())
        val q = Dns.buildQuery("example.com", Dns.TYPE_A, 0x0b0b)
        assertNull(f.resolve(q))
        assertTrue(logs.any { it.endsWith("it is the only one used, so lookups fail until it answers") })
        val fp = f.start()
        try {
            DatagramSocket(0, lo).use { c ->
                c.soTimeout = 3000
                c.send(DatagramPacket(q, q.size, lo, fp))
                val buf = ByteArray(512)
                val p = DatagramPacket(buf, buf.size)
                c.receive(p)
                val a = buf.copyOf(p.length)
                assertTrue(Dns.serverFailed(a))
                assertTrue(Dns.matchAnswer(q, a) != null)
            }
        } finally {
            f.stop()
        }
    }
}
