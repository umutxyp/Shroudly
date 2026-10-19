package me.codeshare.shroudly

import android.os.SystemClock
import java.io.File
import java.io.IOException
import java.io.OutputStreamWriter
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/*
 * Runs shroudly-core, the same engine the desktop app runs (core/), built for
 * Android as an executable and shipped as libshroudlycore.so so the system
 * extracts it where it may be executed (nativeLibraryDir).
 *
 * Commands go in on stdin (STATS, LEARN, STOP), JSON lines come out on stdout
 * (EngineEvent). When this app dies, stdin closes and the engine exits too.
 */
class Engine(
    private val binary: File,
    private val log: (String) -> Unit,
    private val onEvent: (EngineEvent) -> Unit,
    /* The engine ended without being asked to. */
    private val onExit: (Int) -> Unit,
) {
    companion object {
        const val START_TIMEOUT_MS = 6000L

        /* The desktop's arguments (electron/engine-manager.js _args): auto mode,
         * encrypted DNS through the local forwarder, and every known block page;
         * and the file with this session's SOCKS5 password, when there is one. */
        fun args(port: Int, dohPort: Int, blockIps: List<String>, authFile: File? = null): List<String> {
            val a = mutableListOf("--listen", "127.0.0.1", "--port", port.toString(), "--strategy", "split(sni)", "--auto", "--doh")
            if (dohPort > 0) a += listOf("--doh-port", dohPort.toString())
            if (authFile != null) a += listOf(SocksAuth.OPTION, authFile.path)
            for (ip in blockIps) a += listOf("--block-ip", ip)
            return a
        }

        /* A port free on 127.0.0.1 right now. The engine may still lose it to
         * someone else before it binds; the caller then tries another. */
        fun freePort(): Int = ServerSocket().use {
            it.reuseAddress = false
            it.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0))
            it.localPort
        }
    }

    @Volatile private var process: Process? = null
    @Volatile private var stdin: OutputStreamWriter? = null
    @Volatile private var stopping = false
    @Volatile var lastError: String? = null
        private set
    /* When it last wrote anything, in uptime (SystemClock.uptimeMillis), which
     * stands still while the device sleeps: a sleep is not a hang. */
    @Volatile var lastOutputAt = 0L
        private set

    val running get() = process?.isAlive == true

    /* Starts the engine and waits for its ready line. false (with lastError) if it did not come up. */
    fun start(args: List<String>): Boolean {
        stopping = false
        lastError = null
        val shown = args.filterIndexed { i, x -> x != "--block-ip" && args.getOrNull(i - 1) != "--block-ip" }
        val blockIps = (args.size - shown.size) / 2
        log("Starting engine: ${shown.joinToString(" ")}${if (blockIps > 0) " (+$blockIps known block pages)" else ""}")
        val p = try {
            ProcessBuilder(listOf(binary.absolutePath) + args).start()
        } catch (e: IOException) {
            lastError = e.message
            return false
        }
        process = p
        stdin = OutputStreamWriter(p.outputStream, Charsets.UTF_8)
        lastOutputAt = SystemClock.uptimeMillis()
        val ready = CountDownLatch(1)

        Thread({
            try {
                p.inputStream.bufferedReader(Charsets.UTF_8).forEachLine { raw ->
                    lastOutputAt = SystemClock.uptimeMillis()
                    val line = raw.trim()
                    if (line.isEmpty()) return@forEachLine
                    val ev = EngineEvent.parse(line)
                    when (ev) {
                        is EngineEvent.Ready -> ready.countDown()
                        is EngineEvent.Error -> lastError = ev.message
                        // Free text can name sites: kept out of release builds' log.
                        is EngineEvent.Text -> if (BuildConfig.DEBUG) log("engine: $line")
                        else -> {}
                    }
                    onEvent(ev)
                }
            } catch (_: IOException) {
            }
            val code = try { p.waitFor() } catch (_: InterruptedException) { -1 }
            ready.countDown()
            if (process === p) {
                process = null
                stdin = null
                if (!stopping) onExit(code)
            }
        }, "engine-out").apply { isDaemon = true }.start()

        Thread({
            try {
                p.errorStream.bufferedReader(Charsets.UTF_8).forEachLine { line ->
                    if (line.isNotBlank()) {
                        lastError = line.trim()
                        if (BuildConfig.DEBUG) log("engine: ${line.trim()}")
                    }
                }
            } catch (_: IOException) {
            }
        }, "engine-err").apply { isDaemon = true }.start()

        val came = ready.await(START_TIMEOUT_MS, TimeUnit.MILLISECONDS) && p.isAlive
        if (!came) {
            if (lastError == null) lastError = if (p.isAlive) "engine start timeout" else "engine exited (code ${p.exitValue()})"
            stopping = true
            p.destroy()
            if (process === p) { process = null; stdin = null }
            return false
        }
        return true
    }

    fun send(command: String) {
        val w = stdin ?: return
        try {
            synchronized(w) {
                w.write(command)
                w.write("\n")
                w.flush()
            }
        } catch (_: IOException) {
        }
    }

    /* Asks it to stop, and makes sure it has. */
    fun stop() {
        stopping = true
        val p = process ?: return
        send("STOP")
        try {
            if (!p.waitFor(2500, TimeUnit.MILLISECONDS)) {
                p.destroy()
                if (!p.waitFor(1000, TimeUnit.MILLISECONDS)) p.destroyForcibly()
            }
        } catch (_: InterruptedException) {
            p.destroyForcibly()
        }
        process = null
        stdin = null
    }

    /* For a hung engine: end it now; onExit then restarts it. */
    fun kill() {
        process?.destroyForcibly()
    }
}
