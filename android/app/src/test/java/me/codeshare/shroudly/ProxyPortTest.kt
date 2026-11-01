package me.codeshare.shroudly

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket

/* Proxy only's port (ProxyPort): another app on it (v2rayNG's own default is
 * 10808 too) moves Shroudly to the next free one instead of ending the start,
 * and the port it is on is the one shown everywhere. */
class ProxyPortTest {
    private fun listenFailed(p: Int) = ProxyPort.Tried(ok = false, error = "listen failed (port $p)")

    @Test
    fun aTakenPortMovesItToTheNextOne() {
        val tried = ArrayList<Int>()
        val p = ProxyPort.listenOn(ProxyPort.candidates(10808).asSequence()) { port ->
            tried += port
            if (port < 10810) listenFailed(port) else ProxyPort.Tried(ok = true)
        }
        assertEquals(10810, p)
        assertEquals(listOf(10808, 10809, 10810), tried)
    }

    /* Up to 2.6.43 the first failure ended the start: the engine stops after
     * a failed start, and the check read that as "not taken". */
    @Test
    fun onlyATakenPortIsTriedAgain() {
        val tried = ArrayList<Int>()
        try {
            ProxyPort.listenOn(sequenceOf(1, 2)) { tried += it; ProxyPort.Tried(ok = false, error = "engine library not loaded") }
            fail("a failure other than a taken port went on to another port")
        } catch (e: IllegalStateException) {
            assertEquals("engine library not loaded", e.message)
        }
        assertEquals(listOf(1), tried)
        // An engine that did not stop holds the engine's state: no other start.
        try {
            ProxyPort.listenOn(sequenceOf(1, 2)) { ProxyPort.Tried(ok = false, stillRunning = true, error = "listen failed") }
            fail("went on while an engine run had not stopped")
        } catch (e: IllegalStateException) {
            assertTrue(e.message!!.startsWith("the engine did not stop after a failed start"))
        }
        // Every one taken.
        try {
            ProxyPort.listenOn(sequenceOf(1, 2)) { listenFailed(it) }
            fail("no port, and yet a start")
        } catch (e: IllegalStateException) {
            assertEquals("no port for the engine", e.message)
        }
    }

    @Test
    fun theNextPortsCloseBy() {
        assertEquals((10808..10828).toList(), ProxyPort.candidates(10808))
        assertEquals(listOf(65530, 65531, 65532, 65533, 65534, 65535), ProxyPort.candidates(65530))
    }

    @Test
    fun aPortAnotherAppListensOnIsNotFree() {
        val held = ServerSocket()
        held.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0))
        val port = held.localPort
        try {
            assertFalse(ProxyPort.free(port))
        } finally {
            held.close()
        }
        assertTrue(ProxyPort.free(port))
    }

    /* Wired in: the service starts on the port used last and keeps the one it
     * got; the window, the notice and Settings show that one, and the old
     * constant is gone. */
    @Test
    fun theRealPortIsShownEverywhere() {
        val src = File("src/main/java/me/codeshare/shroudly")
        val proxy = File(src, "ShroudlyProxyService.kt").readText()
        assertTrue(proxy.contains("val wanted = ProxyPort.remembered(this)\n            port = spawn(wanted)\n            ProxyPort.remember(this, port)"))
        assertTrue(proxy.contains("Protection.proxyPortTaken = if (port != wanted) wanted else 0"))
        assertTrue(proxy.contains("ProxyPort.listenOn(ports)"))
        assertTrue(proxy.contains("ProxyPort.onText(this, if (port > 0) port else ProxyPort.remembered(this))"))
        assertFalse(proxy.contains("const val PORT"))
        assertTrue(File(src, "MainActivity.kt").readText().contains("Protection.proxyOnly -> ProxyPort.onText(this, Protection.socksPort)"))
        assertTrue(File(src, "SettingsActivity.kt").readText().contains("text(R.string.androidModeProxyDesc, \"port\" to ProxyPort.shown(this))"))
    }

    /* Ended by itself, Proxy only says what it means for its own users (apps
     * set to use it reach nothing), in the window and in a notice; and a
     * network's proxy set to it while it is off is no leftover: the window
     * offers to start it. */
    @Test
    fun proxyOnlySaysWhatItsStopMeans() {
        val src = File("src/main/java/me/codeshare/shroudly")
        val proxy = File(src, "ShroudlyProxyService.kt").readText()
        assertFalse(proxy.contains("R.string.androidProtectionLost"))
        assertTrue(proxy.contains("if (byUser) remindNetworkProxy(was) else notifyStopped()"))
        // A start that failed: "could not start", in the window and a notice.
        assertTrue(Regex("""Protection\.fail\(R\.string\.androidProxyOnlyNotStarted, e\.message\)\s*\n\s*notifyStopped\(R\.string\.androidProxyOnlyNotStarted, R\.string\.startFailed\)""").containsMatchIn(proxy))
        assertTrue(proxy.contains("Protection.fail(R.string.androidProxyOnlyLost, why ?: \"the engine kept stopping\")"))
        val main = File(src, "MainActivity.kt").readText()
        assertTrue(main.contains("val ours = AppSettings.proxyOnly(this) && ProxyPort.ours(this, dead.substringAfterLast(':').toIntOrNull() ?: 0)"))
        assertTrue(main.contains(".setMessage(text(R.string.androidWifiProxyShroudlyOff, \"addr\" to dead))\n                                .setPositiveButton(R.string.start)"))
        assertTrue(main.contains("ShroudlyProxyService.clearAlert(this)"))
    }
}
