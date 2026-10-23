package me.codeshare.shroudly

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EngineEventTest {
    @Test
    fun ready() {
        assertEquals(EngineEvent.Ready(41234, 27), EngineEvent.parse("""{"type":"ready","port":41234,"techniques":27}"""))
        // Newer engines also give their pid.
        assertEquals(EngineEvent.Ready(41234, 27, 9911), EngineEvent.parse("""{"type":"ready","port":41234,"techniques":27,"pid":9911}"""))
    }

    @Test
    fun stats() {
        val ev = EngineEvent.parse(
            """{"type":"stats","conns_total":12,"conns_active":3,"bytes_up":4096,"bytes_down":1048576,""" +
                """"desync":2,"tls":9,"http":1,"probe_ok":0,"probe_fail":0}""",
        )
        assertEquals(EngineEvent.Stats(12, 3, 4096, 1048576, 2, 9, 1, 0, 0), ev)
    }

    @Test
    fun hostEvents() {
        val b = EngineEvent.parse("""{"type":"bypass","host":"example.com","strategy":"split(sni)","attempts":2,"family":"ipv4"}""")
        assertEquals(EngineEvent.Host("bypass", "example.com", "split(sni)", 2, "ipv4", null, null, false, false), b)
        val c = EngineEvent.parse("""{"type":"cut","host":"a.example","strategy":"stall","attempts":64,"family":"ipv6","note":"site_ok"}""")
        assertEquals("site_ok", (c as EngineEvent.Host).note)
        assertEquals("ipv6", c.family)
        val u = EngineEvent.parse("""{"type":"unreachable","host":"gone.example","stage":"dns"}""") as EngineEvent.Host
        assertEquals("dns", u.stage)
        val bl = EngineEvent.parse("""{"type":"blocked","host":"x.example","attempts":9,"family":"ipv4","alert":true,"site_ok":true}""") as EngineEvent.Host
        assertTrue(bl.alert && bl.siteOk)
        // a stream that is not TLS or HTTP: marked, with its port
        val r = EngineEvent.parse("""{"type":"unreachable","host":"149.154.167.50","stage":"connect","ips":1,"raw":true,"port":443,"cport":50123}""") as EngineEvent.Host
        assertTrue(r.raw && r.port == 443 && r.host == "149.154.167.50")
        assertTrue(!bl.raw && bl.port == 0)
    }

    @Test
    fun errorsAndStop() {
        assertEquals(EngineEvent.Error("listen failed", -3), EngineEvent.parse("""{"type":"error","code":-3,"msg":"listen failed"}"""))
        assertEquals(EngineEvent.Error("code 7", 7), EngineEvent.parse("""{"type":"error","code":7}"""))
        assertEquals(EngineEvent.Stopped, EngineEvent.parse("""{"type":"stopped"}"""))
        assertEquals(EngineEvent.Other("raw_stats"), EngineEvent.parse("""{"type":"raw_stats","n":1}"""))
    }

    @Test
    fun notJson() {
        assertEquals(EngineEvent.Text("hello"), EngineEvent.parse("hello"))
        assertEquals(EngineEvent.Text("""{"type":"ready""""), EngineEvent.parse("""{"type":"ready""""))
        assertEquals(EngineEvent.Text("""{"port":1}"""), EngineEvent.parse("""{"port":1}"""))
        assertEquals(EngineEvent.Text("""{"type":"x"} trailing"""), EngineEvent.parse("""{"type":"x"} trailing"""))
    }

    @Test
    fun flatJsonValues() {
        val m = FlatJson.parse("""{ "s": "a\"b\\cé\n", "n": -12, "d": 1.5, "t": true, "f": false, "z": null, "e": {} }""")
        assertNull(m) // nested objects are not engine lines
        val ok = FlatJson.parse("""{ "s": "a\"b\\cé\n", "n": -12, "d": 1.5, "t": true, "f": false, "z": null }""")!!
        assertEquals("a\"b\\cé\n", ok["s"])
        assertEquals(-12L, ok["n"])
        assertEquals(1.5, ok["d"])
        assertEquals(true, ok["t"])
        assertEquals(false, ok["f"])
        assertTrue(ok.containsKey("z") && ok["z"] == null)
        assertEquals(emptyMap<String, Any?>(), FlatJson.parse("{}"))
    }

    @Test
    fun engineArgs() {
        assertEquals(
            listOf("--listen", "127.0.0.1", "--port", "4000", "--strategy", "split(sni)", "--auto", "--doh",
                "--doh-port", "5353", "--block-ip", "10.10.34.34", "--block-ip", "1.2.3.4"),
            Engine.args(4000, 5353, listOf("10.10.34.34", "1.2.3.4")),
        )
        assertEquals(listOf("--listen", "127.0.0.1", "--port", "4000", "--strategy", "split(sni)", "--auto", "--doh"), Engine.args(4000, 0, emptyList()))
    }

    @Test
    fun engineArgsWithTheStandInRange() {
        val a = Engine.args(4000, 0, listOf("1.2.3.4"), fakeNet = Engine.FAKE_NET)
        assertEquals("198.18.0.0/15", a[a.indexOf("--fake-net") + 1])
        assertTrue("--fake-net" !in Engine.args(4000, 0, emptyList()))
    }

    @Test
    fun theStandInRangeCoversTheTunnelsAddresses() {
        // 198.18.0.0/15 is 198.18.0.0 to 198.19.255.255.
        for (a in listOf(TunnelConfig.ADDRESS_V4, TunnelConfig.DNS_V4, TunnelConfig.MAPPED_NETWORK)) {
            val first = a.split('.').map { it.toInt() }
            assertTrue(a, first[0] == 198 && first[1] in 18..19)
        }
    }

    /* A site connected where the network's own DNS says (issue #37): parsed,
     * and logged as the desktop logs it. */
    @Test
    fun netDns() {
        val e = EngineEvent.parse("{\"type\":\"netdns\",\"host\":\"googlevideo.com\",\"addr\":\"5.160.12.34\",\"stage\":\"try\"}")
        assertEquals(EngineEvent.NetDns("googlevideo.com", "5.160.12.34", "try"), e)
        assertEquals("googlevideo.com: the addresses encrypted DNS gives get nowhere here; trying the one this network's DNS gives (5.160.12.34)", NetDnsText.line(e as EngineEvent.NetDns))
        assertEquals("googlevideo.com: opened at the address this network's DNS gives (5.160.12.34)", NetDnsText.line(e.copy(stage = "ok")))
        assertEquals("googlevideo.com: the address this network's DNS gives (5.160.12.34) gets nowhere either", NetDnsText.line(e.copy(stage = "bad")))
        assertEquals("googlevideo.com: this network's DNS gives the same addresses (5.160.12.34); they get nowhere here", NetDnsText.line(e.copy(stage = "same")))
    }
}
