package me.codeshare.shroudly

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.util.Collections
import java.util.concurrent.Executors

class DohRaceTest {
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
}
