package me.codeshare.shroudly

import android.os.ParcelFileDescriptor
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
 * Runs shroudly-core, the same engine the desktop app runs (core/), inside
 * this app's process: EngineNative.run() on a thread of its own, for as long
 * as the engine runs.
 *
 * It is driven as the desktop drives the program: commands go in on one pipe
 * (STATS, LEARN, STOP), JSON lines come out on another (EngineEvent). The run
 * returns once the engine has stopped, on STOP or when the command pipe is
 * closed.
 *
 * Up to 2.6.1 it was a program of its own. Android ends such a "phantom
 * process" of an app when it sees fit (Android 12 and later, and phone
 * makers' battery managers), or freezes it, and the VPN then sent every app's
 * connections to a port nobody answered. In the app's own process it lives as
 * long as the VPN service does. The price: a run that hangs cannot be ended
 * from outside. stop() says whether it ended; one that did not keeps the
 * engine's state in this process (`busy`), and the service then ends
 * protection instead of starting another beside it (ShroudlyVpnService).
 *
 * One Engine object is one run: start() it once, and make a new one for a
 * restart.
 */
class Engine(
    private val log: (String) -> Unit,
    /* Lines that can name sites: kept out of release builds' system log. */
    private val logSite: (String) -> Unit,
    private val onEvent: (EngineEvent) -> Unit,
    /* The engine ended on its own after a successful start(). Not called for
     * a start that failed, nor after stop(). */
    private val onExit: (Engine, Int) -> Unit,
) {
    companion object {
        const val START_TIMEOUT_MS = 6000L
        // How long a run told to stop may take to return.
        const val STOP_WAIT_MS = 5000L

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
         * the file with this session's SOCKS5 password, and the stand-in range. */
        fun args(
            port: Int, dohPort: Int, blockIps: List<String>, authFile: File? = null, fakeNet: String? = null,
            adblock: File? = null, allow: List<String> = emptyList(),
            strategy: AppSettings.Strategy = AppSettings.STRATEGIES[0],
        ): List<String> {
            // The technique chosen in Settings: automatic (the engine looks for
            // what works per site and keeps it) or one for every site.
            val a = mutableListOf("--listen", "127.0.0.1", "--port", port.toString(), "--strategy", strategy.spec)
            if (strategy.auto) a += "--auto"
            a += "--doh"
            if (dohPort > 0) a += listOf("--doh-port", dohPort.toString())
            if (authFile != null) a += listOf(SocksAuth.OPTION, authFile.path)
            if (fakeNet != null) a += listOf(FAKE_NET_OPTION, fakeNet)
            for (ip in blockIps) a += listOf("--block-ip", ip)
            // "Block ads and trackers" (AdBlock): the list fetched, and the
            // user's exceptions.
            if (adblock != null) {
                a += listOf("--adblock", adblock.path)
                for (d in allow) a += listOf("--allow", d)
            }
            return a
        }

        /* A port free on 127.0.0.1 right now. The engine may still lose it to
         * someone else before it binds; the caller then tries another. */
        fun freePort(): Int = ServerSocket().use {
            it.reuseAddress = false
            it.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0))
            it.localPort
        }

        /* The thread of the run started last. */
        @Volatile private var lastRun: Thread? = null

        /* A run has not returned yet, though it was told to stop: the engine's
         * state in this process is its, and no other run can start. */
        val busy: Boolean get() = lastRun?.isAlive == true
    }

    private val state = AtomicInteger(STARTING)
    private val commandLock = Any()
    @Volatile private var commands: OutputStreamWriter? = null
    @Volatile private var runThread: Thread? = null
    @Volatile var lastError: String? = null
        private set
    /* What run() returned; null while it runs. */
    @Volatile var exitCode: Int? = null
        private set
    /* When it last wrote anything, in uptime (SystemClock.uptimeMillis), which
     * stands still while the device sleeps: a sleep is not a hang. */
    @Volatile var lastOutputAt = 0L
        private set

    /* The run has not returned. */
    val running get() = runThread?.isAlive == true

    /* Starts the engine and waits for its ready line. false (with lastError)
     * if it did not come up; it was then told to stop, and `running` says
     * whether it has (if not, nothing else can start in this process). */
    fun start(args: List<String>): Boolean {
        check(runThread == null && state.get() == STARTING) { "one start per Engine" }
        lastError = null
        EngineNative.loadError?.let {
            lastError = "engine library not loaded: $it"
            state.set(OVER)
            return false
        }
        if (busy) {
            lastError = "the engine started before has not stopped"
            state.set(OVER)
            return false
        }
        val shown = args.filterIndexed { i, x -> x != "--block-ip" && args.getOrNull(i - 1) != "--block-ip" }
        val blockIps = (args.size - shown.size) / 2
        log("Starting engine: ${shown.joinToString(" ")}${if (blockIps > 0) " (+$blockIps known block pages)" else ""}")

        val cmd: Array<ParcelFileDescriptor>
        val ev: Array<ParcelFileDescriptor>
        try {
            cmd = ParcelFileDescriptor.createPipe()
            ev = try {
                ParcelFileDescriptor.createPipe()
            } catch (e: IOException) {
                cmd.forEach { closeQuietly(it) }
                throw e
            }
        } catch (e: IOException) {
            lastError = "no pipe for the engine: ${e.message}"
            state.set(OVER)
            return false
        }
        // The engine's ends belong to the native side from here on.
        val cmdFd = cmd[0].detachFd()
        val evFd = ev[1].detachFd()
        commands = OutputStreamWriter(ParcelFileDescriptor.AutoCloseOutputStream(cmd[1]), Charsets.UTF_8)
        val events = ParcelFileDescriptor.AutoCloseInputStream(ev[0])
        lastOutputAt = SystemClock.uptimeMillis()
        val ready = CountDownLatch(1)
        val argv = args.toTypedArray()

        val run = Thread({
            val code = try {
                EngineNative.run(argv, cmdFd, evFd)
            } catch (e: UnsatisfiedLinkError) {
                // The native side never got the descriptors.
                closeFd(cmdFd)
                closeFd(evFd)
                lastError = "engine library: $e"
                -1
            }
            exitCode = code
            if (code == EngineNative.BUSY) lastError = "another engine run has not returned"
        }, "engine")
        runThread = run
        lastRun = run
        run.start()

        Thread({
            try {
                events.bufferedReader(Charsets.UTF_8).forEachLine { raw ->
                    lastOutputAt = SystemClock.uptimeMillis()
                    val line = raw.trim()
                    if (line.isEmpty()) return@forEachLine
                    val ev2 = EngineEvent.parse(line)
                    when (ev2) {
                        is EngineEvent.Ready -> ready.countDown()
                        is EngineEvent.Error -> lastError = ev2.message
                        // Free text can name sites.
                        is EngineEvent.Text -> logSite("engine: $line")
                        else -> {}
                    }
                    onEvent(ev2)
                }
            } catch (_: IOException) {
            } finally {
                closeQuietly(events)
            }
            // The event pipe closes when the run returns, a moment before the
            // thread itself ends.
            try { run.join(STOP_WAIT_MS) } catch (_: InterruptedException) {}
            ready.countDown()
            closeCommands()
            // Only an engine that had come up and was not stopped on purpose is
            // reported; a start that failed is start()'s to report.
            if (state.getAndSet(OVER) == UP) onExit(this, exitCode ?: -1)
        }, "engine-out").apply { isDaemon = true }.start()

        val came = ready.await(START_TIMEOUT_MS, TimeUnit.MILLISECONDS) && running
        // Up only if it is still running now: one that ended in between was
        // already seen by the reader as a failed start, and is not reported.
        if (came && state.compareAndSet(STARTING, UP)) return true
        if (lastError == null) lastError = if (running) "engine start timeout" else "engine exited (code ${exitCode ?: -1})"
        if (!stop()) lastError = "${lastError}; the engine did not stop either"
        return false
    }

    fun send(command: String) {
        synchronized(commandLock) {
            val w = commands ?: return
            try {
                w.write(command)
                w.write("\n")
                w.flush()
            } catch (_: IOException) {
            }
        }
    }

    /* Asks it to stop (STOP, then the end of the command pipe, which stops
     * it even if it cannot read STOP) and waits for the run to return. false
     * if it did not within waitMs. */
    fun stop(waitMs: Long = STOP_WAIT_MS): Boolean {
        state.set(OVER)
        send("STOP")
        closeCommands()
        val t = runThread ?: return true
        try {
            t.join(waitMs)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        }
        return !t.isAlive
    }

    private fun closeCommands() {
        synchronized(commandLock) {
            val w = commands ?: return
            commands = null
            try { w.close() } catch (_: IOException) {}
        }
    }

    private fun closeQuietly(c: java.io.Closeable) {
        try { c.close() } catch (_: IOException) {}
    }

    private fun closeFd(fd: Int) {
        try { ParcelFileDescriptor.adoptFd(fd).close() } catch (_: Exception) {}
    }
}
