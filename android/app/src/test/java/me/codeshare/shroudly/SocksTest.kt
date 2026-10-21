package me.codeshare.shroudly

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.DataInputStream
import java.io.File
import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket

class SocksAuthTest {
    @Test
    fun freshCredentialsEachTime() {
        val a = SocksAuth.random()
        val b = SocksAuth.random()
        assertTrue(SocksAuth.isToken(a.user) && SocksAuth.isToken(a.pass))
        assertEquals(16, a.user.length)
        assertEquals(32, a.pass.length)
        assertNotEquals(a.pass, b.pass)
        assertEquals("${a.user}:${a.pass}\n", a.line())
    }

    @Test(expected = IllegalArgumentException::class)
    fun refusesAColonOrNewline() {
        SocksAuth("user:x", "0123456789")
    }

    @Test
    fun engineArgsNameTheFileNotThePassword() {
        val f = File("/data/user/0/me.codeshare.shroudly/files/socks-auth")
        val a = Engine.args(4000, 5000, listOf("1.2.3.4"), f)
        val i = a.indexOf("--auth-file")
        assertEquals(f.path, a[i + 1])
        assertFalse(Engine.args(4000, 5000, emptyList()).contains("--auth-file"))
    }
}

class Socks5Test {
    @Test
    fun messages() {
        assertArrayEquals(byteArrayOf(5, 1, 0), Socks5.hello(null))
        assertArrayEquals(byteArrayOf(5, 1, 2), Socks5.hello(SocksAuth("abcdef01", "01234567")))
        assertArrayEquals(
            byteArrayOf(1, 8) + "abcdef01".toByteArray() + byteArrayOf(8) + "01234567".toByteArray(),
            Socks5.login(SocksAuth("abcdef01", "01234567")),
        )
        assertArrayEquals(byteArrayOf(5, 1, 0, 1, 1, 1, 1, 1, 1, (443 and 0xff).toByte()), Socks5.request("1.1.1.1", 443))
        val name = "api.github.com"
        assertArrayEquals(
            byteArrayOf(5, 1, 0, 3, name.length.toByte()) + name.toByteArray() + byteArrayOf(1, (443 and 0xff).toByte()),
            Socks5.request(name, 443),
        )
    }

    /* A server that wants the password, as the engine does with --auth-file. */
    private fun server(user: String, pass: String): Pair<ServerSocket, Thread> {
        val ss = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
        val t = Thread {
            ss.accept().use { c ->
                val i = DataInputStream(c.getInputStream())
                val o = c.getOutputStream()
                val n = i.readUnsignedByte().let { i.readUnsignedByte() }
                val methods = ByteArray(n).also { i.readFully(it) }
                if (!methods.contains(2)) { o.write(byteArrayOf(5, 0xff.toByte())); return@use }
                o.write(byteArrayOf(5, 2))
                i.readUnsignedByte()
                val u = String(ByteArray(i.readUnsignedByte()).also { i.readFully(it) })
                val p = String(ByteArray(i.readUnsignedByte()).also { i.readFully(it) })
                if (u != user || p != pass) { o.write(byteArrayOf(1, 1)); return@use }
                o.write(byteArrayOf(1, 0))
                val head = ByteArray(5).also { i.readFully(it) }
                i.readFully(ByteArray(head[4].toInt() + 2))
                o.write(byteArrayOf(5, 0, 0, 1, 127, 0, 0, 1, 0, 80))
            }
        }.apply { isDaemon = true; start() }
        return ss to t
    }

    @Test
    fun connectsWithThePassword() {
        val (ss, t) = server("abcdef01", "01234567")
        Socket("127.0.0.1", ss.localPort).use { Socks5.connect(it, "example.com", 443, SocksAuth("abcdef01", "01234567")) }
        t.join(2000)
        ss.close()
    }

    @Test(expected = IOException::class)
    fun aWrongPasswordFails() {
        val (ss, _) = server("abcdef01", "01234567")
        try {
            Socket("127.0.0.1", ss.localPort).use { Socks5.connect(it, "example.com", 443, SocksAuth("abcdef01", "99999999")) }
        } finally {
            ss.close()
        }
    }

    @Test(expected = IOException::class)
    fun noPasswordIsRefused() {
        val (ss, _) = server("abcdef01", "01234567")
        try {
            Socket("127.0.0.1", ss.localPort).use { Socks5.connect(it, "example.com", 443, null) }
        } finally {
            ss.close()
        }
    }
}

class NetTest {
    private fun a(s: String) = InetAddress.getByName(s)

    @Test
    fun ipv6OnlyWithAGlobalAddressAndADefaultRoute() {
        assertTrue(Net.hasIpv6(listOf(a("10.0.0.2"), a("2001:db8::5")), v6DefaultRoute = true))
        assertFalse(Net.hasIpv6(listOf(a("10.0.0.2"), a("2001:db8::5")), v6DefaultRoute = false))
        // Link-local, unique local and site-local addresses do not reach the internet.
        assertFalse(Net.hasIpv6(listOf(a("10.0.0.2"), a("fe80::1"), a("fd12::1"), a("fec0::15")), v6DefaultRoute = true))
        assertFalse(Net.hasIpv6(listOf(a("10.0.0.2")), v6DefaultRoute = true))
        assertFalse(Net.isGlobalV6(a("::1")))
        assertFalse(Net.isGlobalV6(a("8.8.8.8")))
        assertTrue(Net.isGlobalV6(a("2a00:1450::1")))
    }
}
