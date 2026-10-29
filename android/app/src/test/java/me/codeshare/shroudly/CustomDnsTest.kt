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

    /* The proxy typed for the DNS server (#58), read as on the desktop. */
    @Test
    fun readsTheProxy() {
        assertEquals(null to null, CustomDns.parseProxy("  "))
        assertEquals(DnsProxy("socks5", "127.0.0.1", 1080), CustomDns.parseProxy("socks5://127.0.0.1:1080").first)
        assertEquals(DnsProxy("socks5", "proxy.example", 9050), CustomDns.parseProxy("socks5h://proxy.example:9050").first)
        assertEquals("::1", CustomDns.parseProxy("socks://[::1]:1080").first?.host)
        assertEquals(DnsProxy("http", "10.0.0.2", 8080, "user", "p@ss"), CustomDns.parseProxy("http://user:p%40ss@10.0.0.2:8080").first)
        for (bad in listOf("socks5://127.0.0.1", "ftp://1.2.3.4:21", "socks5://127.0.0.1:99999", "127.0.0.1:1080", "socks5://bad host:1", "http://300.1.1.1:80", "http://u:%zz@1.2.3.4:80"))
            assertEquals(bad, "proxy", CustomDns.parseProxy(bad).second)
        assertEquals("socks5://127.0.0.1:1080", CustomDns.shownProxy(CustomDns.parseProxy("socks5://me:secret@127.0.0.1:1080").first!!))
    }

    /* A TCP DNS server here answering every question with `ip`. */
    private fun tcpDns(srv: ServerSocket, ip: String) = Thread {
        try {
            while (true) {
                val s = srv.accept()
                Thread {
                    try {
                        s.use {
                            val input = DataInputStream(it.getInputStream())
                            val out = DataOutputStream(it.getOutputStream())
                            while (true) {
                                val q = ByteArray(input.readUnsignedShort()).also { b -> input.readFully(b) }
                                val a = answer(q, ip)
                                out.writeShort(a.size); out.write(a); out.flush()
                            }
                        }
                    } catch (_: IOException) {}
                }.start()
            }
        } catch (_: IOException) {}
    }.apply { isDaemon = true; start() }

    private fun pipe(a: java.net.Socket, b: java.net.Socket) {
        Thread { try { a.getInputStream().copyTo(b.getOutputStream()) } catch (_: IOException) {} finally { try { b.shutdownOutput() } catch (_: IOException) {} } }.apply { isDaemon = true; start() }
        Thread { try { b.getInputStream().copyTo(a.getOutputStream()) } catch (_: IOException) {} finally { try { a.shutdownOutput() } catch (_: IOException) {} } }.apply { isDaemon = true; start() }
    }

    /* A SOCKS5 proxy (no login, or a user name and password) that resolves
     * test.local itself; `asked` gets each target. */
    private fun socksProxy(srv: ServerSocket, asked: MutableList<String>, login: Pair<String, String>? = null) = Thread {
        try {
            while (true) {
                val c = srv.accept()
                Thread {
                    try {
                        val input = DataInputStream(c.getInputStream())
                        val out = c.getOutputStream()
                        input.readUnsignedByte()
                        val methods = ByteArray(input.readUnsignedByte()).also { input.readFully(it) }
                        if (login != null) {
                            if (2.toByte() !in methods) { out.write(byteArrayOf(5, 0xff.toByte())); c.close(); return@Thread }
                            out.write(byteArrayOf(5, 2))
                            input.readUnsignedByte()
                            val u = String(ByteArray(input.readUnsignedByte()).also { input.readFully(it) })
                            val p = String(ByteArray(input.readUnsignedByte()).also { input.readFully(it) })
                            if (u to p != login) { out.write(byteArrayOf(1, 1)); c.close(); return@Thread }
                            out.write(byteArrayOf(1, 0))
                        } else out.write(byteArrayOf(5, 0))
                        val head = ByteArray(4).also { input.readFully(it) }
                        val host = when (head[3].toInt()) {
                            1 -> ByteArray(4).also { input.readFully(it) }.joinToString(".") { (it.toInt() and 0xff).toString() }
                            3 -> String(ByteArray(input.readUnsignedByte()).also { input.readFully(it) })
                            else -> { c.close(); return@Thread }
                        }
                        val port = input.readUnsignedShort()
                        asked += "$host:$port"
                        val up = java.net.Socket(if (host == "test.local") "127.0.0.1" else host, port)
                        out.write(byteArrayOf(5, 0, 0, 1, 127, 0, 0, 1, 0, 0)); out.flush()
                        pipe(c, up)
                    } catch (_: IOException) {}
                }.start()
            }
        } catch (_: IOException) {}
    }.apply { isDaemon = true; start() }

    /* An HTTP proxy that takes CONNECT. */
    private fun httpProxy(srv: ServerSocket, asked: MutableList<String>) = Thread {
        try {
            while (true) {
                val c = srv.accept()
                Thread {
                    try {
                        val input = c.getInputStream()
                        val head = StringBuilder()
                        while (!head.endsWith("\r\n\r\n")) head.append(input.read().also { if (it < 0) throw IOException("closed") }.toChar())
                        val m = Regex("^CONNECT (\\S+):(\\d+) HTTP/1\\.1").find(head)!!
                        asked += "${m.groupValues[1]}:${m.groupValues[2]}"
                        val up = java.net.Socket(if (m.groupValues[1] == "test.local") "127.0.0.1" else m.groupValues[1], m.groupValues[2].toInt())
                        c.getOutputStream().apply { write("HTTP/1.1 200 Connection established\r\n\r\n".toByteArray()); flush() }
                        pipe(c, up)
                    } catch (_: IOException) {}
                }.start()
            }
        } catch (_: IOException) {}
    }.apply { isDaemon = true; start() }

    /* Through the user's proxy (#58): the server's name goes to the proxy,
     * nothing is looked up here (the bootstrap would fail the test). */
    @Test
    fun throughTheUsersProxy() {
        ServerSocket(0, 5, lo).use { dnsSrv ->
            tcpDns(dnsSrv, "93.184.215.30")
            val noBoot: (String) -> String? = { throw AssertionError("looked up here: $it") }
            ServerSocket(0, 5, lo).use { s5 ->
                val asked = java.util.Collections.synchronizedList(ArrayList<String>())
                socksProxy(s5, asked)
                val d = CustomDns(DnsSpec("tcp", "test.local", dnsSrv.localPort), { 0 }, { null }, DnsProxy("socks5", "127.0.0.1", s5.localPort), noBoot)
                assertEquals("93.184.215.30", Dns.firstA(d.query(Dns.buildQuery("example.com", Dns.TYPE_A, 1))))
                assertTrue(asked.contains("test.local:${dnsSrv.localPort}"))
                d.close()
            }
            ServerSocket(0, 5, lo).use { locked ->
                socksProxy(locked, java.util.Collections.synchronizedList(ArrayList<String>()), "me" to "s3cret")
                val ok = CustomDns(DnsSpec("tcp", "127.0.0.1", dnsSrv.localPort), { 0 }, { null }, DnsProxy("socks5", "127.0.0.1", locked.localPort, "me", "s3cret"), noBoot)
                assertEquals("93.184.215.30", Dns.firstA(ok.query(Dns.buildQuery("example.com", Dns.TYPE_A, 2))))
                val wrong = CustomDns(DnsSpec("tcp", "127.0.0.1", dnsSrv.localPort), { 0 }, { null }, DnsProxy("socks5", "127.0.0.1", locked.localPort, "me", "nope"), noBoot)
                assertTrue(runCatching { wrong.query(Dns.buildQuery("example.com", Dns.TYPE_A, 3)) }.isFailure)
                ok.close(); wrong.close()
            }
            ServerSocket(0, 5, lo).use { hp ->
                val asked = java.util.Collections.synchronizedList(ArrayList<String>())
                httpProxy(hp, asked)
                val d = CustomDns(DnsSpec("tcp", "test.local", dnsSrv.localPort), { 0 }, { null }, DnsProxy("http", "127.0.0.1", hp.localPort), noBoot)
                assertEquals("93.184.215.30", Dns.firstA(d.query(Dns.buildQuery("example.com", Dns.TYPE_A, 4))))
                assertTrue(asked.contains("test.local:${dnsSrv.localPort}"))
                d.close()
            }
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
