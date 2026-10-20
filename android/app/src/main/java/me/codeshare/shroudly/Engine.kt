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
import java.util.concurrent.atomic.AtomicInteger

/*
 * Runs shroudly-core, the same engine the desktop app runs (core/), built for
 * Android as an executable and shipped as libshroudlycore.so so the system
 * extracts it where it may be executed (nativeLibraryDir).
 *
 * Commands go in on stdin (STATS, LEARN, STOP), JSON lines come out on stdout
 * (EngineEvent). When this app dies, stdin closes and the engine exits too.
 *
 * One Engine object is one run of the engine: start() it once, and make a new
 * one for a restart.
 */
class Engine(
    private val binary: File,
    private val log: (String) -> Unit,
    private val onEvent: (EngineEvent) -> Unit,
    /* The engine ended on its own after a successful start(). Not called for
     * a start that failed, nor after stop() or kill(). */
    private val onExit: (Engine, Int) -> Unit,
) {
    companion object {
        const val START_TIMEOUT_MS = 6000L
        // How long a SIGKILLed engine may take to be gone.
        const val KILL_WAIT_MS = 3000L
        const val NAME = "libshroudlycore.so"

        /* Addresses the engine refuses at once instead of trying to reach:
         * the tunnel's own range (TunnelConfig). An app that still holds a
         * stand-in address from before hev was restarted gets an error right
         * away, looks the name up again, and gets a fresh one. */
        const val FAKE_NET_OPTION = "--fake-net"
        const val FAKE_NET = "198.18.0.0/15"

        // States of one run, for deciding who reports its end.
        private const val STARTING = 0
        private const val UP = 1
        private const val OVER = 2

        /* The desktop's arguments (electron/engine-manager.js _args): auto mode,
         * encrypted DNS through the local forwarder, and every known block page;
         * the file with this session's SOCKS5 password, and the stand-in range,
         * when the engine takes them. */
        fun args(port: Int, dohPort: Int, blockIps: List<String>, authFile: File? = null, fakeNet: String? = null): List<String> {
            val a = mutableListOf("--listen", "127.0.0.1", "--port", port.toString(), "--strategy", "split(sni)", "--auto", "--doh")
            if (dohPort > 0) a += listOf("--doh-port", dohPort.toString())
            if (authFile != null) a += listOf(SocksAuth.OPTION, authFile.path)
            if (fakeNet != null) a += listOf(FAKE_NET_OPTION, fakeNet)
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

        /* Whether an engine binary takes `option`: its name is in the binary as
         * the string the argument parser compares with. Engines built before an
         * option existed ignore it, so it is given only to one that knows it. */
        fun knows(binary: File, option: String): Boolean = try {
            SocksAuth.contains(binary.readBytes(), option.toByteArray(Charsets.US_ASCII) + 0)
        } catch (_: Exception) {
            false
        }

        /* java.lang.Process has no pid() on Android; the implementation keeps
         * it in a private field. 0 when it cannot be read. */
        fun pidOf(p: Process): Int {
            var c: Class<*>? = p.javaClass
            while (c != null) {
                try {
                    val f = c.getDeclaredField("pid")
                    f.isAccessible = true
                    return (f.get(p) as? Number)?.toInt() ?: 0
                } catch (_: NoSuchFieldException) {
                    c = c.superclass
                } catch (_: Exception) {
                    return 0
                }
            }
            return 0
        }

        /* Process.destroyForcibly() sends SIGTERM on Android, which a hung or
         * stopped engine does not act on. */
        fun sigkill(pid: Int) {
            if (pid > 0) android.os.Process.sendSignal(pid, android.os.Process.SIGNAL_KILL)
        }

        /* Whether `pid` is an engine run by this app: what is left of an
         * earlier app process, to be ended before a new one starts. */
        fun isEngine(pid: Int): Boolean = pid > 0 && try {
            File("/proc/$pid/cmdline").readBytes().toString(Charsets.UTF_8).substringBefore('\u0000').endsWith("/$NAME")
        } catch (_: Exception) {
            false
        }
    }

    private val state = AtomicInteger(STARTING)
    @Volatile private var process: Process? = null
    @Volatile private var stdin: OutputStreamWriter? = null
    @Volatile var pid = 0
        private set
    @Volatile var lastError: String? = null
        private set
    /* When it last wrote anything, in uptime (SystemClock.uptimeMillis), which
     * stands still while the device sleeps: a sleep is not a hang. */
    @Volatile var lastOutputAt = 0L
        private set

    val running get() = process?.isAlive == true

    /* Starts the engine and waits for its ready line. false (with lastError)
     * if it did not come up; it is then ended for sure, or `pid` still names
     * it and the caller must not go on. `onSpawn` gets the pid as soon as it
     * is known, before anything can fail. */
    fun start(args: List<String>, onSpawn: (Int) -> Unit = {}): Boolean {
        check(process == null && state.get() == STARTING) { "one start per Engine" }
        lastError = null
        val shown = args.filterIndexed { i, x -> x != "--block-ip" && args.getOrNull(i - 1) != "--block-ip" }
        val blockIps = (args.size - shown.size) / 2
        log("Starting engine: ${shown.joinToString(" ")}${if (blockIps > 0) " (+$blockIps known block pages)" else ""}")
        val p = try {
            ProcessBuilder(listOf(binary.absolutePath) + args).start()
        } catch (e: IOException) {
            lastError = e.message
            state.set(OVER)
            return false
        }
        process = p
        pid = pidOf(p)
        onSpawn(pid)
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
                        is EngineEvent.Ready -> {
                            // The engine's own word for its pid, when it gives one.
                            if (ev.pid > 0) {
                                if (pid > 0 && pid != ev.pid) log("Engine reports pid ${ev.pid}, started as $pid")
                                pid = ev.pid
                                onSpawn(pid)
                            }
                            ready.countDown()
                        }
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
            }
            // Only an engine that had come up and was not ended on purpose is
            // reported; a start that failed is start()'s to report.
            if (state.getAndSet(OVER) == UP) onExit(this, code)
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
        // Up only if it is still running now: one that ended in between was
        // already seen by the reader as a failed start, and is not reported.
        if (came && state.compareAndSet(STARTING, UP)) return true
        if (lastError == null) lastError = if (p.isAlive) "engine start timeout" else "engine exited (code ${exitCode(p)})"
        end(p)
        return false
    }

    private fun exitCode(p: Process) = try { p.exitValue() } catch (_: IllegalThreadStateException) { -1 }

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

    /* Asks it to stop, and makes sure it has. false if it is somehow still there. */
    fun stop(): Boolean {
        state.set(OVER)
        val p = process ?: return true
        send("STOP")
        val gone = try {
            p.waitFor(2500, TimeUnit.MILLISECONDS) || run {
                p.destroy()
                p.waitFor(1000, TimeUnit.MILLISECONDS)
            }
        } catch (_: InterruptedException) {
            false
        }
        return gone || end(p)
    }

    /* Ends it now with SIGKILL, for a hung engine or one found gone; onExit is
     * not called. true once it is gone for sure. */
    fun kill(): Boolean {
        state.set(OVER)
        val p = process ?: return true
        return end(p)
    }

    private fun end(p: Process): Boolean {
        state.set(OVER)
        if (p.isAlive) {
            try {
                if (pid > 0) sigkill(pid) else p.destroyForcibly()
            } catch (e: Exception) {
                log("Could not signal the engine: ${e.message}")
            }
        }
        val gone = try { p.waitFor(KILL_WAIT_MS, TimeUnit.MILLISECONDS) } catch (_: InterruptedException) { !p.isAlive }
        if (gone && process === p) {
            process = null
            stdin = null
        }
        if (!gone) log("Engine (pid $pid) did not end after SIGKILL")
        return gone
    }
}
