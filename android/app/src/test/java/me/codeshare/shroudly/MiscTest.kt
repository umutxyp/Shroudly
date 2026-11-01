package me.codeshare.shroudly

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
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

    @Test
    fun picksTheApkItselfFromThisProjectOnly() {
        val dl = "https://github.com/umutxyp/Shroudly/releases/download/v2.6.0/"
        assertEquals(
            "${dl}Shroudly-2.6.0-Android.apk",
            Versions.apkUrl(listOf("Shroudly-2.6.0.dmg" to "${dl}Shroudly-2.6.0.dmg", "other.apk" to "${dl}other.apk",
                "Shroudly-2.6.0-Android.apk" to "${dl}Shroudly-2.6.0-Android.apk")),
        )
        assertEquals("${dl}x.apk", Versions.apkUrl(listOf("x.apk" to "${dl}x.apk")))
        assertNull(Versions.apkUrl(listOf("x-Android.apk" to "https://example.com/x-Android.apk")))
        assertNull(Versions.apkUrl(listOf("x.dmg" to "${dl}x.dmg")))
        assertNull(Versions.apkUrl(emptyList()))
    }

    @Test
    fun readsTheDownloadServersFeed() {
        // What the release's latest.yml looks like (electron-builder writes it).
        val yml = "version: 2.6.31\nfiles:\n  - url: Shroudly-2.6.31-Windows-x64-Setup.exe\n    sha512: abc==\n" +
            "path: Shroudly-2.6.31-Windows-x64-Setup.exe\nreleaseDate: '2026-10-25T19:58:01.000Z'\n"
        assertEquals("2.6.31", Versions.feedVersion(yml))
        assertEquals("2.6.32", Versions.feedVersion("version: '2.6.32'\r\n"))
        assertNull(Versions.feedVersion("files: []\n"))
        assertNull(Versions.feedVersion("version: <html>\n"))
        assertNull(Versions.feedVersion(""))
        assertEquals("/dl/Shroudly-2.6.31-Android.apk", Versions.mirrorApkPath("2.6.31"))
        assertEquals("/dl/Shroudly-2.6.31-Android.apk", Versions.mirrorApkPath("v2.6.31"))
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

    @Test
    fun aStoreOfItsOwnHasItsOwnCap() {
        // Raw techniques (per address) live in a store of their own with a
        // smaller cap, so they never push out sites' techniques.
        val raw = Learned(null, 100)
        for (i in 0 until 150) raw.remember("149.154.167.$i", "raw-split1", 100L + i)
        assertEquals(100, raw.commands(1000).size)
        assertTrue(raw.commands(1000).last().startsWith("LEARN 149.154.167.149 raw-split1"))
    }
}

class TunnelConfigTest {
    @Test
    fun configPointsHevAtTheEngine() {
        val y = TunnelConfig.yaml(41234)
        assertTrue(y.contains("socks5:\n  port: 41234\n  address: 127.0.0.1\n  udp: 'udp'\n"))
        assertTrue(y.contains("mapdns:\n  address: ${TunnelConfig.DNS_V4}\n  port: 53\n  network: 198.19.0.0\n  netmask: 255.255.192.0\n"))
        assertTrue(y.contains("tunnel:\n  mtu: 8500\n"))
        assertTrue(y.contains("  max-session-count: 1800\n"))
        // Quiet connections (a chat app waiting for a message, push) are not
        // ended after hev's own 5 minutes.
        assertTrue(y.contains("  tcp-read-write-timeout: 3600000\n  udp-read-write-timeout: 120000\n"))
        assertFalse(y.contains("username"))
        assertTrue(TunnelConfig.yaml(1, udp = false).contains("udp: 'tcp'"))
        // Every line is "key: value" or a section, two spaces deep at most.
        for (line in y.lines().filter { it.isNotEmpty() }) assertTrue(line, Regex("^( {2})?[a-z0-9-]+:( .+)?$").matches(line))
    }

    @Test
    fun configCarriesTheSessionPassword() {
        val y = TunnelConfig.yaml(41234, user = "0123456789abcdef", pass = "fedcba9876543210")
        assertTrue(y.contains("  udp: 'udp'\n  username: '0123456789abcdef'\n  password: 'fedcba9876543210'\nmapdns:\n"))
        for (line in y.lines().filter { it.isNotEmpty() }) assertTrue(line, Regex("^( {2})?[a-z0-9-]+:( .+)?$").matches(line))
    }

    @Test(expected = IllegalArgumentException::class)
    fun refusesACredentialThatCouldBreakTheFile() {
        TunnelConfig.yaml(41234, user = "abcdefgh'\n", pass = "0123456789")
    }

    @Test(expected = IllegalArgumentException::class)
    fun refusesABadPort() {
        TunnelConfig.yaml(0)
    }

    /* An address as a number, for the ranges' arithmetic. */
    private fun v4(a: String): Long = a.split('.').fold(0L) { n, p -> n * 256 + p.toLong() }

    @Test
    fun everyAddressIsInBenchmarkSpace() {
        // 198.18.0.0/18 for the interface and the DNS, the rest of
        // 198.18.0.0/15 for mapped names: apart, and none of it a real host's
        // (as carrier NAT space would be).
        val first = v4("198.18.0.0")
        for (a in listOf(TunnelConfig.DNS_V4, TunnelConfig.ADDRESS_V4)) assertTrue(a, v4(a) - first in 0 until 16384)
        assertEquals("198.19.0.0", TunnelConfig.MAPPED_NETWORK)
        assertEquals("255.255.192.0", TunnelConfig.MAPPED_NETMASK)
        for (r in TunnelConfig.MAPPED_RANGES) assertTrue(r, v4(r) - first in 16384 until 131072)
    }

    @Test
    fun eachTunnelGetsTheNextStandInRange() {
        // Seven /18s, apart from each other and from the interface's, each
        // with room for the whole cache: an address an app kept from any of
        // the last six tunnels is in none of the new one's names.
        val ranges = (0 until 7).map { TunnelConfig.mappedNetwork(it) }
        assertEquals(TunnelConfig.MAPPED_RANGES, ranges)
        assertEquals(7, ranges.toSet().size)
        assertEquals("198.19.0.0", ranges[0])
        for (r in ranges) assertEquals(r, 0L, v4(r) % 16384)
        assertEquals(TunnelConfig.mappedNetwork(0), TunnelConfig.mappedNetwork(7))
        assertEquals(TunnelConfig.mappedNetwork(6), TunnelConfig.mappedNetwork(-1))
        assertTrue(TunnelConfig.CACHE_SIZE < 16384)
        for (i in 0 until 7) {
            val y = TunnelConfig.yaml(41234, mapped = TunnelConfig.mappedNetwork(i))
            assertTrue(y, y.contains("  network: ${ranges[i]}\n  netmask: 255.255.192.0\n  cache-size: ${TunnelConfig.CACHE_SIZE}\n"))
        }
    }

    @Test(expected = IllegalArgumentException::class)
    fun refusesARangeOutsideTheStandInSpace() {
        TunnelConfig.yaml(41234, mapped = "10.0.0.0")
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

/* Each of Shroudly's notices has an ID of its own. Two with the same one
 * replace each other, and cancelling one takes the other away too: the
 * update from Google Play once had the Wi-Fi proxy reminder's. */
class NoticesTest {
    @Test
    fun everyNoticeHasItsOwnId() {
        val shown = Regex("""\b(?:notify|startForeground)\(\s*(\w+)""")
        val constant = Regex("""\bval (\w+) = (\d+)$""", RegexOption.MULTILINE)
        val ids = HashMap<Int, String>()
        for (dir in listOf("src/main", "src/play", "src/apk", "src/debug")) {
            File(dir).walkTopDown().filter { it.isFile && it.extension == "kt" }.forEach { file ->
                val text = file.readText()
                val constants = constant.findAll(text).associate { it.groupValues[1] to it.groupValues[2].toInt() }
                for (name in shown.findAll(text).map { it.groupValues[1] }.toSet()) {
                    val id = name.toIntOrNull() ?: constants[name]
                        ?: throw AssertionError("${file.name}: a notice with $name, not a number or a constant of the file")
                    val who = "${file.name} $name"
                    val other = ids.put(id, who)
                    assertTrue("$who and $other are both notice $id", other == null || other == who)
                }
            }
        }
        // All found: the VPN's three, the proxy's two, automation's, KeepOn's
        // and the update's (the Play build's; src/play is read either way).
        assertTrue(ids.keys.toString(), ids.size >= 8)
    }
}
