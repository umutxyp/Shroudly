package me.codeshare.shroudly

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Locale

class VersionsTest {
    @Test
    fun compares() {
        assertTrue(Versions.isNewer("v2.5.15", "2.5.14"))
        assertTrue(Versions.isNewer("2.10.0", "2.9.9"))
        assertTrue(Versions.isNewer("v3", "2.99.99"))
        assertFalse(Versions.isNewer("v2.5.14", "2.5.14"))
        assertFalse(Versions.isNewer("2.5.13", "2.5.14"))
        assertEquals(0, Versions.compare("2.5", "2.5.0"))
        assertFalse(Versions.isNewer("v2.6.0-beta.1", "2.6.0"))
        assertFalse(Versions.isNewer("nightly", "2.5.14"))
        assertEquals(listOf(2, 5, 14), Versions.parse(" V2.5.14 "))
        assertEquals(null, Versions.parse("2.x"))
    }

    @Test
    fun offersOnlyNewerReleasesWithAnApk() {
        assertTrue(Versions.offers("v2.6.0", listOf("Shroudly-2.6.0.dmg", "Shroudly-2.6.0.apk"), "2.5.14"))
        assertFalse(Versions.offers("v2.6.0", listOf("Shroudly-2.6.0.dmg", "Shroudly-Setup.exe"), "2.5.14"))
        assertFalse(Versions.offers("v2.5.14", listOf("Shroudly-2.5.14.apk"), "2.5.14"))
        assertEquals("2.6.0", Versions.display("v2.6.0"))
    }
}

class LearnedTest {
    private val day = 24L * 60 * 60 * 1000

    @Test
    fun keepsWhatWorkedAndSendsItsAge() {
        val l = Learned(null)
        l.remember("discord.com", "split(sni)", 1_000_000)
        l.remember("x.com", "disorder", 1_010_000)
        assertEquals(listOf("LEARN discord.com split(sni) 20", "LEARN x.com disorder 10"), l.commands(1_020_000))
        val back = Learned(l.encode())
        assertEquals(l.commands(1_020_000), back.commands(1_020_000))
    }

    @Test
    fun newerWinsAndOldOnesExpire() {
        val l = Learned(null)
        l.remember("a.example", "one", 0)
        l.remember("a.example", "two", 5)
        assertEquals(listOf("LEARN a.example two 0"), l.commands(5))
        assertEquals(emptyList<String>(), l.commands(31 * day))
    }

    @Test
    fun refusesJunkAndCapsTheList() {
        val l = Learned("bad host name x 1\nok.example tech 10\nevil.example rm;-rf 10\nshort line")
        assertEquals(listOf("LEARN ok.example tech 0"), l.commands(10))
        l.remember("a b", "x", 11)
        l.remember("c.example", "bad technique", 11)
        assertEquals(1, l.commands(11).size)
        for (i in 0 until 400) l.remember("h$i.example", "t", 100L + i)
        assertEquals(Learned.MAX, l.commands(1000).size)
        assertTrue(l.commands(1000).last().startsWith("LEARN h399.example"))
    }
}

class TunnelConfigTest {
    @Test
    fun configPointsHevAtTheEngine() {
        val y = TunnelConfig.yaml(41234)
        assertTrue(y.contains("socks5:\n  port: 41234\n  address: 127.0.0.1\n  udp: 'udp'\n"))
        assertTrue(y.contains("mapdns:\n  address: ${TunnelConfig.DNS_V4}\n  port: 53\n  network: 100.64.0.0\n  netmask: 255.192.0.0\n"))
        assertTrue(y.contains("tunnel:\n  mtu: 8500\n"))
        assertTrue(TunnelConfig.yaml(1, udp = false).contains("udp: 'tcp'"))
        // Every line is "key: value" or a section, two spaces deep at most.
        for (line in y.lines().filter { it.isNotEmpty() }) assertTrue(line, Regex("^( {2})?[a-z0-9-]+:( .+)?$").matches(line))
    }

    @Test(expected = IllegalArgumentException::class)
    fun refusesABadPort() {
        TunnelConfig.yaml(0)
    }

    @Test
    fun fakeDnsIsOutsideTheMappedRange() {
        // 198.18.0.0/15 for the interface and the DNS, 100.64.0.0/10 for mapped names.
        assertTrue(TunnelConfig.DNS_V4.startsWith("198.18."))
        assertTrue(TunnelConfig.ADDRESS_V4.startsWith("198.18."))
    }
}

class FormatTest {
    @Test
    fun formats() {
        assertEquals("512 B", Format.bytes(512, Locale.ROOT))
        assertEquals("1.5 KB", Format.bytes(1536, Locale.ROOT))
        assertEquals("12 MB", Format.bytes(12L * 1024 * 1024, Locale.ROOT))
        assertEquals("2.0 GB", Format.bytes(2L * 1024 * 1024 * 1024, Locale.ROOT))
        assertEquals("0:05", Format.duration(5_400))
        assertEquals("1:02:03", Format.duration(3_723_000))
    }
}
