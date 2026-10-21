package me.codeshare.shroudly

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.DataInputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.atomic.AtomicInteger

class PathWatchTest {
    private fun watch() = PathWatch(intervalMs = 120_000, stallMs = 12_000, retryMs = 3_000, failuresToStop = 2)

    @Test
    fun checksSoonAfterAStartAndNotWhileIdle() {
        val w = watch()
        w.reset(1_000)
        w.ask(1_000, 3_000)
        assertFalse(w.due(3_999))
        assertTrue(w.due(4_000))
        w.started(4_000)
        assertFalse("one at a time", w.due(4_001))
        assertEquals(PathWatch.Verdict.HEALTHY, w.result(4_100, ok = true, networkWorks = true))
        // An idle phone (no packets from apps) is never checked again.
        for (t in 5_000L..1_000_000L step 1_000) {
            w.traffic(t, 50, 1_000)
            assertFalse("t=$t", w.due(t))
        }
    }

    @Test
    fun busyAppsAreCheckedNowAndThen() {
        val w = watch()
        w.reset(0)
        w.traffic(0, 100, 5_000)
        // Packets go out and bytes come back: no stall, only the routine check.
        var t = 0L
        var packets = 100L
        var down = 5_000L
        while (t < 119_000) {
            t += 1_000; packets += 5; down += 10_000
            w.traffic(t, packets, down)
            assertFalse("t=$t", w.due(t))
        }
        t += 1_000; packets += 5; down += 10_000
        w.traffic(t, packets, down)
        assertTrue(w.due(t))
    }

    @Test
    fun appsGettingNothingBackIsAStallAndOneFailureIsEnough() {
        val w = watch()
        w.reset(0)
        w.traffic(0, 100, 5_000)
        // Apps keep sending, nothing comes back.
        var t = 0L
        var packets = 100L
        while (!w.stalled(t)) {
            t += 1_000; packets += 10
            w.traffic(t, packets, 5_000)
            assertTrue(t <= 12_000)
        }
        assertEquals(12_000, t)
        assertTrue(w.due(t))
        w.started(t)
        assertEquals(PathWatch.Verdict.BROKEN, w.result(t + 10_000, ok = false, networkWorks = true))
    }

    @Test
    fun aFewPacketsWithNoAnswerAreNoStall() {
        val w = watch()
        w.reset(0)
        w.traffic(0, 100, 5_000)
        w.traffic(30_000, 100 + PathWatch.STALL_PACKETS - 1, 5_000)
        assertFalse(w.stalled(30_000))
        w.traffic(31_000, 100 + PathWatch.STALL_PACKETS, 5_000)
        assertTrue(w.stalled(31_000))
    }

    @Test
    fun routineFailuresNeedTwoInARowAndOnlyCountOnAWorkingNetwork() {
        val w = watch()
        w.reset(0)
        w.ask(0, 0)
        w.started(0)
        assertEquals(PathWatch.Verdict.RETRY, w.result(1_000, ok = false, networkWorks = true))
        // The retry comes RETRY_MS later.
        assertFalse(w.due(3_999))
        assertTrue(w.due(4_000))
        w.started(4_000)
        // No network underneath: not counted, and the count starts over.
        assertEquals(PathWatch.Verdict.NO_NETWORK, w.result(5_000, ok = false, networkWorks = false))
        w.ask(5_000, 0)
        w.started(5_000)
        assertEquals(PathWatch.Verdict.RETRY, w.result(6_000, ok = false, networkWorks = true))
        w.started(9_000)
        assertEquals(PathWatch.Verdict.BROKEN, w.result(10_000, ok = false, networkWorks = true))
    }

    @Test
    fun aSuccessInBetweenStartsTheCountOver() {
        val w = watch()
        w.reset(0)
        w.started(0)
        assertEquals(PathWatch.Verdict.RETRY, w.result(1_000, ok = false, networkWorks = true))
        w.started(4_000)
        assertEquals(PathWatch.Verdict.HEALTHY, w.result(4_100, ok = true, networkWorks = true))
        w.started(200_000)
        assertEquals(PathWatch.Verdict.RETRY, w.result(201_000, ok = false, networkWorks = true))
    }

    @Test
    fun afterARestartForABrokenWayOneFailureEndsIt() {
        val w = watch()
        w.reset(0)
        w.oneStrike = true
        // The restart resets the checks, not the strike.
        w.reset(1_000)
        assertTrue(w.oneStrike)
        w.ask(1_000, 3_000)
        assertTrue(w.due(4_000))
        w.started(4_000)
        assertEquals(PathWatch.Verdict.BROKEN, w.result(5_000, ok = false, networkWorks = true))
        // A success clears it.
        w.oneStrike = true
        w.started(6_000)
        assertEquals(PathWatch.Verdict.HEALTHY, w.result(6_100, ok = true, networkWorks = true))
        assertFalse(w.oneStrike)
    }

    @Test
    fun aResetForgetsACheckUnderWay() {
        val w = watch()
        w.reset(0)
        w.ask(0, 0)
        w.started(0)
        assertFalse(w.due(1))
        w.reset(10)
        w.ask(10, 0)
        assertTrue(w.due(10))
    }
}

class PathTargetsTest {
    @Test
    fun usesTheChecksThisAndroidWasGivenAndTheUsualOnes() {
        val t = EngineProbe.targets(listOf("https://check.example.net/gen_204", "http://probe.example.org:8080/x", null, "not a url"))
        assertEquals("check.example.net" to 443, t[0])
        assertEquals("probe.example.org" to 8080, t[1])
        assertTrue(t.containsAll(EngineProbe.TARGETS))
        assertEquals(EngineProbe.TARGETS, EngineProbe.targets(listOf(null, null)))
        // No host twice.
        assertEquals(EngineProbe.TARGETS, EngineProbe.targets(listOf("https://www.google.com/generate_204")))
    }
}

class LivenessTest {
    @Test
    fun twoMissesInARowMeanHung() {
        val l = Liveness(everyMs = 20_000, failuresToGiveUp = 2)
        l.reset(0)
        assertFalse(l.due(19_999))
        assertTrue(l.due(20_000))
        l.started(20_000)
        assertFalse("one at a time", l.due(60_000))
        assertFalse(l.result(false))
        l.started(40_000)
        assertFalse("an answer in between starts over", l.result(true))
        l.started(60_000)
        assertFalse(l.result(false))
        l.started(80_000)
        assertTrue(l.result(false))
    }
}

class EngineProbeTest {
    /* A SOCKS5 server on loopback that answers the greeting and the password,
     * then a CONNECT with `reply` (0: success). */
    private fun server(reply: Int, served: AtomicInteger = AtomicInteger()): ServerSocket {
        val ss = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
        Thread {
            while (!ss.isClosed) {
                val s = try { ss.accept() } catch (_: Exception) { return@Thread }
                Thread {
                    s.use {
                        val input = DataInputStream(it.getInputStream())
                        val out = it.getOutputStream()
                        val hello = ByteArray(3).also { b -> input.readFully(b) }
                        out.write(byteArrayOf(5, hello[2])); out.flush()
                        if (hello[2].toInt() == 2) {
                            input.readUnsignedByte()
                            input.readFully(ByteArray(input.readUnsignedByte()))
                            input.readFully(ByteArray(input.readUnsignedByte()))
                            out.write(byteArrayOf(1, 0)); out.flush()
                        }
                        served.incrementAndGet()
                        try {
                            val head = ByteArray(4).also { b -> input.readFully(b) }
                            when (head[3].toInt()) {
                                1 -> input.readFully(ByteArray(6))
                                3 -> input.readFully(ByteArray(input.readUnsignedByte() + 2))
                            }
                            out.write(byteArrayOf(5, reply.toByte(), 0, 1, 0, 0, 0, 0, 0, 0)); out.flush()
                        } catch (_: Exception) {
                        }
                    }
                }.start()
            }
        }.apply { isDaemon = true }.start()
        return ss
    }

    @Test
    fun answersWhenTheGreetingAndPasswordAreTaken() {
        val auth = SocksAuth.random()
        server(0).use { ss ->
            assertTrue(EngineProbe.answers(ss.localPort, auth))
            assertTrue(EngineProbe.answers(ss.localPort, null))
        }
        val closed = ServerSocket(0).let { val p = it.localPort; it.close(); p }
        assertFalse(EngineProbe.answers(closed, auth, timeoutMs = 500))
    }

    @Test
    fun reachesOnlyWhenTheEngineConnected() {
        val auth = SocksAuth.random()
        server(0).use { ss ->
            assertEquals("a.example:443", EngineProbe.reachesAny(ss.localPort, auth, listOf("a.example" to 443), 3_000))
        }
        // 4: host unreachable, for every target.
        server(4).use { ss ->
            assertNull(EngineProbe.reachesAny(ss.localPort, auth, listOf("a.example" to 443, "b.example" to 80), 3_000))
        }
    }

    @Test
    fun anyOneTargetIsEnoughAndTheyAreTriedTogether() {
        val auth = SocksAuth.random()
        val served = AtomicInteger()
        server(0, served).use { ss ->
            val t0 = System.nanoTime()
            assertTrue(EngineProbe.reachesAny(ss.localPort, auth, EngineProbe.TARGETS, 3_000) != null)
            assertTrue((System.nanoTime() - t0) / 1_000_000 < 3_000)
        }
    }

    @Test
    fun aSilentEngineIsGivenUpOnAtTheDeadline() {
        // Accepts connections and never answers.
        ServerSocket(0, 50, InetAddress.getByName("127.0.0.1")).use { ss ->
            val t0 = System.nanoTime()
            assertNull(EngineProbe.reachesAny(ss.localPort, null, listOf("a.example" to 443), 700))
            val ms = (System.nanoTime() - t0) / 1_000_000
            assertTrue("took $ms ms", ms in 600..2_500)
        }
    }
}

class AppLogTest {
    @Test
    fun keepsTheAppsLinesInTheFileAndSiteLinesOnlyInMemory() {
        val dir = java.nio.file.Files.createTempDirectory("log").toFile()
        try {
            val f = java.io.File(dir, "log.txt")
            f.writeText("10-01 00:00:00.000 from an earlier run\n")
            AppLog.attach(f)
            AppLog.add("Protection on")
            AppLog.add("example.com: blocked here, opened with tlsrec", site = true)
            AppLog.flush()
            val disk = f.readText()
            assertTrue(disk, disk.contains("from an earlier run"))
            assertTrue(disk, disk.contains("Protection on"))
            assertFalse(disk, disk.contains("example.com"))
            val all = AppLog.snapshot()
            assertTrue(all.indexOfFirst { it.contains("earlier run") } < all.indexOfFirst { it.contains("Protection on") })
            assertTrue(all.indexOfFirst { it.contains("Protection on") } < all.indexOfFirst { it.contains("example.com") })
            // Each kind keeps its own last CAPACITY lines.
            repeat(AppLog.CAPACITY + 50) { AppLog.add("site $it", site = true) }
            val after = AppLog.snapshot()
            assertTrue(after.any { it.contains("Protection on") })
            assertEquals(AppLog.CAPACITY, after.count { it.contains(" site ") || it.contains("example.com") })
            repeat(AppLog.CAPACITY * 2) { AppLog.add("app $it") }
            AppLog.flush()
            val lines = f.readLines()
            assertTrue("the file is cut back: ${lines.size}", lines.size <= AppLog.CAPACITY * 2)
            assertTrue(lines.last().endsWith("app ${AppLog.CAPACITY * 2 - 1}"))
            assertEquals(AppLog.CAPACITY, AppLog.snapshot().count { it.contains(" app ") })
        } finally {
            dir.deleteRecursively()
        }
    }
}

class DiagnosticsTest {
    @Test
    fun asksForBatterySettingsWhereTheyStopApps() {
        val restricted = Diagnostics.Battery(unrestricted = false, backgroundRestricted = true, saver = false)
        val optimized = Diagnostics.Battery(unrestricted = false, backgroundRestricted = false, saver = false)
        val free = Diagnostics.Battery(unrestricted = true, backgroundRestricted = false, saver = true)
        assertTrue(Diagnostics.batteryHint(restricted, "Google", "google"))
        assertTrue(Diagnostics.batteryHint(optimized, "Xiaomi", "Redmi"))
        assertTrue(Diagnostics.batteryHint(optimized, "unknown", "POCO"))
        assertTrue(Diagnostics.batteryHint(optimized, "samsung", "samsung"))
        assertFalse(Diagnostics.batteryHint(optimized, "Google", "google"))
        assertFalse(Diagnostics.batteryHint(free, "Xiaomi", "Redmi"))
        assertTrue(Diagnostics.batteryHint(free.copy(backgroundRestricted = true), "Xiaomi", "Redmi"))
        assertFalse(Diagnostics.batteryHint(optimized, null, null))
    }

    @Test
    fun saysWhatTheBatterySettingsAre() {
        assertEquals("optimization on, background restricted, battery saver off",
            Diagnostics.Battery(unrestricted = false, backgroundRestricted = true, saver = false).toString())
        assertEquals("optimization off for Shroudly, background allowed, battery saver on",
            Diagnostics.Battery(unrestricted = true, backgroundRestricted = false, saver = true).toString())
    }
}

class NetSummaryTest {
    @Test
    fun describesTheNetworkWithoutAddresses() {
        val s = Net.Summary("mobile data", true, ipv4 = false, ipv6 = true, nat64 = true,
            privateDns = "strict (dns.google)", metered = true, mtu = 1440)
        assertEquals("mobile data, validated, IPv4 no, IPv6 yes, 464XLAT yes, Private DNS strict (dns.google), metered, MTU 1440", s.toString())
        assertEquals("none", Net.Summary("none", false, false, false, null, null, false, 0).toString())
        assertEquals("Wi-Fi, not validated, IPv4 yes, IPv6 no",
            Net.Summary("Wi-Fi", false, ipv4 = true, ipv6 = false, nat64 = null, privateDns = null, metered = false, mtu = 0).toString())
    }
}

class DohRoutesV6Test {
    @Test
    fun everyOperatorHasAnIpv6RouteWrittenForAUrl() {
        val all = DohForwarder.routes()
        val direct = all.filter { !it.viaEngine }
        for (op in direct.map { it.op }.toSet() - "dnssb") {
            assertTrue(op, direct.any { it.op == op && it.v6 })
        }
        val v6 = direct.first { it.v6 }
        assertTrue(v6.urlHost, v6.urlHost.startsWith("[") && v6.urlHost.endsWith("]"))
        assertEquals("1.1.1.1", direct.first { it.id == "cloudflare-1" }.urlHost)
        // Unique ids; the engine's routes stay IPv4 (Cloudflare's front end).
        assertEquals(all.size, all.map { it.id }.toSet().size)
        assertTrue(all.filter { it.viaEngine }.none { it.v6 })
    }

    @Test
    fun anIpv6RouteThatFailsRestsLikeAnyOther() {
        val r = DohForwarder.routes().first { it.v6 }
        r.failed(1_000)
        val plan = DohForwarder.plan(DohForwarder.routes().map { if (it.id == r.id) r else it }, null, 1_500, true)
        assertFalse(plan.any { it.id == r.id })
        assertEquals(DohForwarder.routes().size - 1, plan.size)
    }
}
