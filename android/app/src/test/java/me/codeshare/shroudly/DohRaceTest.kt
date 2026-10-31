package me.codeshare.shroudly

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.util.Collections
import java.util.concurrent.Executors

class DohRaceTest {
    /* Another network (DohForwarder.networkChanged): a route forgets the rest
     * it earned on the old one, and its new verifier keeps the old network's
     * pooled connections from being used again; its speed is kept. */
    @Test
    fun anotherNetworkStartsAfresh() {
        val r = DohRoute("t-1", "t", "192.0.2.1", listOf("dns.example"))
        val before = r.verifier
        r.succeeded(40)
        r.failed(1_000); r.failed(2_000); r.failed(3_000)
        assertTrue(r.fails == 3 && r.restUntil > 3_000)
        r.fresh()
        assertEquals(0, r.fails)
        assertEquals(0L, r.restUntil)
        assertEquals(40L, r.ewma)
        assertNotSame(before, r.verifier)
    }

    private val pool = Executors.newCachedThreadPool()
    private val fast = longArrayOf(40, 120, 80)

    private fun route(id: String, op: String = id, viaEngine: Boolean = false) =
        DohRoute(id, op, "192.0.2.1", listOf("x"), if (viaEngine) "x.example" else null)

    @Test
    fun planPutsTheRememberedRouteFirstAndMixesTheSecondWave() {
        val r = DohForwarder.routes()
        val plan = DohForwarder.plan(r, "google-1", 1000, engineReady = true)
        assertEquals("google-1", plan[0].id)
        assertTrue(plan[1].viaEngine)                        // the other kind
        assertTrue(plan[2].op != "google" && !plan[2].viaEngine) // another operator
        assertEquals(r.size, plan.size)
    }

    @Test
    fun planLeavesEngineRoutesOutUntilTheEngineIsUp() {
        val plan = DohForwarder.plan(DohForwarder.routes(), null, 1000, engineReady = false)
        assertTrue(plan.none { it.viaEngine })
        assertTrue(plan.isNotEmpty())
    }

    @Test
    fun planRestsFailingRoutesAndPrefersFastOnes() {
        val a = route("a"); val b = route("b"); val c = route("c")
        a.failed(1000)                                      // resting 2 s
        b.succeeded(300); c.succeeded(20)
        val plan = DohForwarder.plan(listOf(a, b, c), "a", 1500, engineReady = true)
        assertEquals(listOf("c", "b"), plan.map { it.id })
        // Everything resting: still the three that wake soonest.
        b.failed(1000); c.failed(1000); c.failed(1000)
        assertEquals(3, DohForwarder.plan(listOf(a, b, c), null, 1500, true).size)
        // After the rest, back in.
        assertEquals(setOf("a", "b"), DohForwarder.plan(listOf(a, b, c), null, 3100, true).map { it.id }.toSet())
    }

    @Test
    fun restGrowsAndIsCapped() {
        val r = route("r")
        r.failed(0); assertEquals(2000L, r.restUntil)
        r.failed(0); assertEquals(4000L, r.restUntil)
        repeat(30) { r.failed(0) }
        assertEquals(DohForwarder.REST_MAX_MS, r.restUntil)
        r.succeeded(50)
        assertEquals(0L, r.restUntil)
        assertEquals(0, r.fails)
    }

    @Test
    fun firstAnswerWins() {
        val plan = listOf(route("slow"), route("quick"), route("never"))
        val got = race(plan, pool, fast) { r ->
            when (r.id) {
                "slow" -> { Thread.sleep(600); byteArrayOf(1) }
                "quick" -> { Thread.sleep(10); byteArrayOf(2) }
                else -> throw IOException("down")
            }
        }
        assertEquals("quick", got!!.first.id)
    }

    @Test
    fun theBestRouteGoesAloneFirst() {
        val started = Collections.synchronizedList(ArrayList<String>())
        val plan = listOf(route("best"), route("b"), route("c"), route("d"))
        val got = race(plan, pool, fast) { r -> started += r.id; Thread.sleep(5); byteArrayOf(9) }
        assertEquals("best", got!!.first.id)
        assertEquals(listOf("best"), started.toList())
    }

    @Test
    fun aFastFailureStartsTheNextAtOnce() {
        val t0 = System.nanoTime()
        val plan = listOf(route("a"), route("b"))
        val got = race(plan, pool, longArrayOf(5000, 5000, 5000)) { r ->
            if (r.id == "a") throw IOException("refused") else byteArrayOf(1)
        }
        assertEquals("b", got!!.first.id)
        assertTrue((System.nanoTime() - t0) / 1_000_000 < 2000)
    }

    @Test
    fun endsWhenTheAskerStopsWaiting() {
        val t0 = System.nanoTime() / 1_000_000
        val plan = listOf(route("hangs"))
        val got = race(plan, pool, fast, answerBy = t0 + 150) { Thread.sleep(2000); byteArrayOf(1) }
        assertNull(got)
        assertTrue(System.nanoTime() / 1_000_000 - t0 < 1000)
    }

    @Test
    fun attemptsStillQueuedWhenTheRaceEndsAreNotMade() {
        // The first attempt runs; the others wait in the queue until after the race.
        val held = Collections.synchronizedList(ArrayList<Runnable>())
        var first = true
        val exec = java.util.concurrent.Executor { r -> if (first) { first = false; Thread(r).start() } else held += r }
        val made = Collections.synchronizedList(ArrayList<String>())
        val plan = listOf(route("a"), route("b"), route("c"))
        val got = race(plan, exec, longArrayOf(0, 0, 0)) { r ->
            made += r.id
            Thread.sleep(50)
            byteArrayOf(1)
        }
        assertEquals("a", got!!.first.id)
        assertEquals(2, held.size)
        for (r in held.toList()) r.run()
        assertEquals(listOf("a"), made.toList())
    }

    /* A reply with this rcode in its header (only the header matters here). */
    private fun reply(rcode: Int) = ByteArray(12).also { it[2] = 0x81.toByte(); it[3] = (0x80 or rcode).toByte() }

    @Test
    fun oneOperatorsServerFailureDoesNotWin() {
        // Cloudflare by address and by name is one operator: its failure
        // twice is still one vote, and Google's answer comes after it.
        val vote = FailureVote()
        val plan = listOf(route("cloudflare-1", "cloudflare"), route("front", "cloudflare-front"), route("google-1", "google"))
        val got = race(plan, pool, fast) { r ->
            vote.take(r, if (r.op == "google") { Thread.sleep(60); reply(0) } else reply(2))
        }
        assertEquals("google-1", got!!.first.id)
        assertEquals(0, got.second[3].toInt() and 0x0f)
    }

    @Test
    fun twoOperatorsAgreeingOnAServerFailureIsTheAnswer() {
        val vote = FailureVote()
        val plan = listOf(route("a", "quad9"), route("b", "google"), route("c", "adguard"))
        val got = race(plan, pool, fast) { r -> if (r.id == "c") { Thread.sleep(2000); reply(0) } else vote.take(r, reply(2)) }
        assertEquals("b", got!!.first.id)
        assertTrue(Dns.serverFailed(got.second))
    }

    @Test
    fun aServerFailureIsKeptWhenNothingBetterCame() {
        val vote = FailureVote()
        val plan = listOf(route("a", "quad9"), route("b", "google"))
        val got = race(plan, pool, fast) { r -> if (r.id == "a") vote.take(r, reply(2)) else throw IOException("down") }
        assertNull(got)
        assertTrue(Dns.serverFailed(vote.held!!))
    }

    @Test
    fun eachRouteKeepsOneVerifier() {
        val r = DohForwarder.routes()[0]
        assertTrue(r.verifier === r.verifier)
    }

    @Test
    fun allFailingGivesNothing() {
        val plan = (1..7).map { route("r$it") }
        assertNull(race(plan, pool, fast) { throw IOException("down") })
        assertNull(race(emptyList(), pool, fast) { byteArrayOf(1) })
    }

    /* Takes `room` attempts and refuses the rest, as a pool with a full queue does. */
    private fun refusing(room: Int): java.util.concurrent.Executor {
        val left = java.util.concurrent.atomic.AtomicInteger(room)
        return java.util.concurrent.Executor { r ->
            if (left.getAndDecrement() <= 0) throw java.util.concurrent.RejectedExecutionException("full")
            pool.execute(r)
        }
    }

    @Test
    fun aRefusedAttemptIsNotWaitedFor() {
        // Nothing is taken: the race ends at once instead of at its deadline.
        val t0 = System.nanoTime()
        assertNull(race(listOf(route("a"), route("b")), refusing(0), longArrayOf(5000, 5000, 5000)) { byteArrayOf(1) })
        assertTrue((System.nanoTime() - t0) / 1_000_000 < 500)
    }

    @Test
    fun aRefusedAttemptLetsTheNextOneGo() {
        // The first attempt fails fast; the next is refused; the one after that still runs.
        val made = Collections.synchronizedList(ArrayList<String>())
        val exec = object : java.util.concurrent.Executor {
            var n = 0
            override fun execute(r: Runnable) {
                if (n++ == 1) throw java.util.concurrent.RejectedExecutionException("full")
                pool.execute(r)
            }
        }
        val t0 = System.nanoTime()
        val got = race(listOf(route("a"), route("b"), route("c")), exec, longArrayOf(5000, 5000, 5000)) { r ->
            made += r.id
            if (r.id == "a") throw IOException("refused") else byteArrayOf(3)
        }
        assertEquals("c", got!!.first.id)
        assertEquals(listOf("a", "c"), made.toList())
        assertTrue((System.nanoTime() - t0) / 1_000_000 < 2000)
    }

    @Test
    fun allRefusedAfterOneFailsEndsAtOnce() {
        val t0 = System.nanoTime()
        val got = race(listOf(route("a"), route("b"), route("c")), refusing(1), longArrayOf(5000, 5000, 5000)) { throw IOException("down") }
        assertNull(got)
        assertTrue((System.nanoTime() - t0) / 1_000_000 < 1000)
    }
}
