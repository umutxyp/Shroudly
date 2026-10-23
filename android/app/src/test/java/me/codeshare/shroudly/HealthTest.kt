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

    /* A locked phone whose network is off (issue #39): with nothing
     * underneath, the next check waits a minute instead of coming every few
     * seconds; a network that comes back asks for one at once. */
    @Test
    fun noNetworkUnderneathPausesTheChecks() {
        val w = watch()
        w.traffic(0, 0, 0)
        w.traffic(1_000, 100, 0)
        assertTrue(w.due(13_000))                                  // apps get nothing back
        w.started(13_000)
        assertEquals(PathWatch.Verdict.NO_NETWORK, w.result(14_000, ok = false, networkWorks = false))
        w.traffic(15_000, 200, 0)
        assertFalse(w.due(17_000))
        assertFalse(w.due(14_000 + PathWatch.NO_NETWORK_PAUSE_MS - 1))
        assertTrue(w.due(14_000 + PathWatch.NO_NETWORK_PAUSE_MS))
        // A network back (the service asks): at once.
        w.ask(20_000, 0)
        assertTrue(w.due(20_000))
        // And a new start forgets the pause.
        w.started(20_000)
        assertEquals(PathWatch.Verdict.NO_NETWORK, w.result(21_000, ok = false, networkWorks = false))
        w.reset(22_000)
        w.traffic(22_000, 300, 0)
        w.traffic(23_000, 400, 0)
        assertTrue(w.due(22_000 + 12_000))
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
    fun genericHostsOnly() {
        val hosts = EngineProbe.TARGETS.map { it.first }
        assertTrue("www.google.com" in hosts && "captive.apple.com" in hosts && "www.msftconnecttest.com" in hosts)
        assertFalse(hosts.any { it.contains("miui") })
        assertEquals(hosts.size, hosts.toSet().size)
    }

    @Test
    fun directProbeTellsAnOutageFromABrokenWayThrough() {
        ServerSocket(0, 50, InetAddress.getByName("127.0.0.1")).use { ss ->
            assertEquals("127.0.0.1:${ss.localPort}", EngineProbe.directAny(listOf("127.0.0.1" to ss.localPort), 2_000))
        }
        val closed = ServerSocket(0).let { val p = it.localPort; it.close(); p }
        assertNull(EngineProbe.directAny(listOf("127.0.0.1" to closed), 2_000))
        assertFalse(EngineProbe.direct(listOf("127.0.0.1" to closed), 2_000).refusedBySystem)
    }

    @Test
    fun aRefusalBySystemIsToldFromANetworkFailure() {
        assertTrue(EngineProbe.refusedBySystem(java.net.SocketException("connect failed: EPERM (Operation not permitted)")))
        assertTrue(EngineProbe.refusedBySystem(java.io.IOException("x", java.net.SocketException("Permission denied"))))
        assertFalse(EngineProbe.refusedBySystem(java.net.ConnectException("failed to connect: ECONNREFUSED (Connection refused)")))
        assertFalse(EngineProbe.refusedBySystem(java.net.SocketTimeoutException("timeout")))
        assertFalse(EngineProbe.refusedBySystem(java.net.NoRouteToHostException("ENETUNREACH (Network is unreachable)")))
    }
}

class HevWatchTest {
    @Test
    fun packetsInWithNothingOutIsStuck() {
        val h = HevWatch(windowMs = 10_000, minPackets = 20, capMs = 60_000)
        assertFalse(h.stuck(0, 100, 50))
        // Packets in and out: working.
        for (t in 1..30) assertFalse(h.stuck(t * 1_000L, 100L + t * 5, 50L + t))
        // Packets in, none out.
        var t = 31_000L
        var tx = 300L
        var stuck = false
        while (t < 50_000 && !stuck) { t += 1_000; tx += 5; stuck = h.stuck(t, tx, 80) }
        assertTrue(stuck)
        // Not before the window has passed since packets last came out (30 s).
        assertEquals(40_000, t)
    }

    @Test
    fun anIdlePhoneIsNotStuck() {
        val h = HevWatch(windowMs = 10_000, minPackets = 20, capMs = 60_000)
        h.stuck(0, 100, 50)
        // A few packets (keep-alives) with no answer for a long time: not enough.
        assertFalse(h.stuck(600_000, 119, 50))
        assertTrue(h.stuck(600_001, 120, 50))
        h.reset()
        assertFalse(h.stuck(600_002, 500, 50))
    }

    @Test
    fun fullForAMinute() {
        val h = HevWatch(windowMs = 10_000, minPackets = 20, capMs = 60_000)
        assertFalse(h.full(0, 1_790, 1_800))
        assertFalse(h.full(59_999, 1_790, 1_800))
        assertTrue(h.full(60_000, 1_790, 1_800))
        // A dip below starts over.
        assertFalse(h.full(61_000, 100, 1_800))
        assertFalse(h.full(62_000, 1_800, 1_800))
        assertFalse(h.full(0, -1, 1_800))
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

class DnsNameMaskTest {
    @Test
    fun hidesWhatCanNameTheUser() {
        assertEquals("*.dns.nextdns.io", Net.maskDnsName("abc123.dns.nextdns.io"))
        assertEquals("*.d.adguard-dns.com", Net.maskDnsName("xyz.d.adguard-dns.com"))
        assertEquals("*.dns.controld.com", Net.maskDnsName("p2abc.dns.controld.com."))
        assertEquals("dns.google", Net.maskDnsName("dns.google"))
        assertEquals("one.one.one.one", Net.maskDnsName("One.One.One.One"))
        assertEquals("1dot1dot1dot1.cloudflare-dns.com", Net.maskDnsName("1dot1dot1dot1.cloudflare-dns.com"))
        assertEquals("my-resolver.net", Net.maskDnsName("my-resolver.net"))
        assertEquals("*.example.net", Net.maskDnsName("home.example.net"))
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

/* A phone asleep, a clock set back, a network coming back after a wake: the
 * health checks do not take any of them for a broken way through. */
class SleepAndWakeTest {
    @Test
    fun aCheckThatSpannedASleepIsToldApart() {
        // 30 s of real time, 2 s of it awake: the phone slept in the middle.
        assertTrue(Sleep.slept(realStart = 1_000, upStart = 500, realEnd = 31_000, upEnd = 2_500))
        // Awake all along (a slow check, nothing more).
        assertFalse(Sleep.slept(realStart = 1_000, upStart = 500, realEnd = 11_000, upEnd = 10_400))
    }

    @Test
    fun againSoonAfterIsRealTime() {
        val window = 10L * 60 * 1000
        // A restart in the evening; the next trouble eight hours later (the
        // phone asleep nearly all of it, so little uptime went by): not "again".
        assertFalse(Sleep.again(lastAt = 1_000, now = 1_000 + 8 * 3600 * 1000L, windowMs = window))
        assertTrue(Sleep.again(lastAt = 1_000, now = 1_000 + 9 * 60 * 1000L, windowMs = window))
        assertFalse("none before", Sleep.again(lastAt = 0, now = 5_000, windowMs = window))
    }

    @Test
    fun aPathCheckThatSleptCountsNeitherWay() {
        val w = PathWatch(intervalMs = 120_000, stallMs = 12_000, retryMs = 3_000, failuresToStop = 2)
        w.reset(0)
        w.ask(0, 0)
        w.started(0)
        w.abandoned(10_000)
        assertFalse("looked at again in a moment, not at once", w.due(10_000))
        assertTrue(w.due(13_000))
        w.started(13_000)
        // One real failure after it is the first, not the second.
        assertEquals(PathWatch.Verdict.RETRY, w.result(13_500, ok = false, networkWorks = true))
    }

    @Test
    fun aLivenessCheckThatSleptIsNoMiss() {
        val l = Liveness(everyMs = 20_000, failuresToGiveUp = 2)
        l.reset(0)
        l.started(20_000)
        assertFalse(l.result(false))
        l.started(40_000)
        l.abandoned()
        assertTrue("due again at once", l.due(40_001))
        l.started(40_001)
        assertFalse("still one miss", l.result(true))
    }

    @Test
    fun aNetworkComingBackIsAskedAgainBeforeItCounts() {
        // Just woken up: the engine reaches nothing, this app reaches nothing
        // directly, Android's check then passes (the Wi-Fi is back): the
        // engine is asked once more, and gets through.
        var tries = 0
        val o = PathCheck.run({ if (tries++ == 0) null else "connectivitycheck.gstatic.com:80" },
            { EngineProbe.Direct(null, false) }, { true }, { true })
        assertEquals("connectivitycheck.gstatic.com:80", o.reached)
        assertEquals(2, tries)
        // A broken way through: still nothing the second time; it counts.
        var n = 0
        val b = PathCheck.run({ n++; null }, { EngineProbe.Direct("1.1.1.1:443", false) }, { true }, { true })
        assertNull(b.reached)
        assertEquals("1.1.1.1:443", b.direct)
        assertTrue(b.networkWorks)
        assertEquals(2, n)
        // The network really down: the engine is not asked again.
        var m = 0
        val d = PathCheck.run({ m++; null }, { EngineProbe.Direct(null, false) }, { false }, { false })
        assertNull(d.reached)
        assertFalse(d.networkWorks)
        assertEquals(1, m)
        // Through at once: nothing else is asked.
        var directAsked = false
        val ok = PathCheck.run({ "x:443" }, { directAsked = true; EngineProbe.Direct(null, false) }, { true }, { true })
        assertEquals("x:443", ok.reached)
        assertFalse(directAsked)
    }

    @Test
    fun aRestStartedBeforeTheClockWentBackEndsOnTime() {
        val all = DohForwarder.routes()
        val r = all.first()
        // Failed "an hour from now": the clock was set back an hour since.
        r.failed(3_600_000 + 1_000)
        val plan = DohForwarder.plan(all, null, 1_000, true)
        assertTrue("rests at most the longest rest from now: ${r.restUntil}", r.restUntil <= 1_000 + DohForwarder.REST_MAX_MS)
        assertFalse(plan.first() === r)
    }
}

class ShareLogsTest {
    @Test
    fun saysHowProtectionRuns() {
        assertEquals("Protection: on for 62 min; always-on VPN yes, lockdown no; IPv6 routed",
            Diagnostics.protectionLine("on", null, 62 * 60_000L + 5_000, alwaysOn = true, lockdown = false, ipv6 = true, offline = false))
        assertEquals("Protection: on for 0 min; always-on VPN yes, lockdown yes; IPv6 off; holding on offline",
            Diagnostics.protectionLine("on", null, 10_000, alwaysOn = true, lockdown = true, ipv6 = false, offline = true))
        assertEquals("Protection: off; last error: VPN permission is missing",
            Diagnostics.protectionLine("off", "VPN permission is missing", -1, alwaysOn = false, lockdown = false, ipv6 = false, offline = false))
    }
}

class LockdownHoldTest {
    private fun <T> withExecutor(block: (java.util.concurrent.ScheduledExecutorService) -> T): T {
        val ex = java.util.concurrent.Executors.newSingleThreadScheduledExecutor()
        try { return block(ex) } finally { ex.shutdownNow() }
    }

    @Test
    fun aRetryPlannedForThePathIsCalledOffOnceTheWayThroughWorks() = withExecutor { ex ->
        val ran = AtomicInteger()
        val h = LockdownHold(200, 1_000) { ms, r -> ex.schedule(r, ms, java.util.concurrent.TimeUnit.MILLISECONDS) }
        assertEquals(200L, h.plan(LockdownHold.Cause.PATH) { ran.incrementAndGet() })
        assertEquals("longer each time", 400L, h.plan(LockdownHold.Cause.PATH) { ran.incrementAndGet() })
        // The phone woke up, the network is back, a path check passes, hev runs.
        assertTrue("a retry was planned for the path, and is called off", h.pathHealthy(tunnelUp = true))
        Thread.sleep(700)
        assertEquals("no retry tears down what works", 0, ran.get())
        assertFalse("nothing planned any more", h.planned)
        assertEquals("the next trouble starts from the first wait", 200L, h.plan(LockdownHold.Cause.PATH) { ran.incrementAndGet() })
        Thread.sleep(500)
        assertEquals("a retry still due runs", 1, ran.get())
    }

    @Test
    fun aRetryForTheTunnelIsNeverCalledOffByAPathCheck() = withExecutor { ex ->
        val ran = AtomicInteger()
        val h = LockdownHold(200, 1_000) { ms, r -> ex.schedule(r, ms, java.util.concurrent.TimeUnit.MILLISECONDS) }
        // hev stopped and could not be started again: the path check (app to
        // engine, never through the tunnel) passes all the same.
        h.plan(LockdownHold.Cause.OTHER) { ran.incrementAndGet() }
        assertFalse(h.pathHealthy(tunnelUp = true))
        // Planned again for the path meanwhile: still kept for the tunnel.
        h.plan(LockdownHold.Cause.PATH) { ran.incrementAndGet() }
        assertFalse(h.pathHealthy(tunnelUp = true))
        Thread.sleep(700)
        assertEquals("the retry runs, and the tunnel with everything else is started again", 1, ran.get())
        // Planned for the path, but hev is not running: not called off either.
        h.plan(LockdownHold.Cause.PATH) { ran.incrementAndGet() }
        assertFalse(h.pathHealthy(tunnelUp = false))
        Thread.sleep(1_200)
        assertEquals(2, ran.get())
    }
}
