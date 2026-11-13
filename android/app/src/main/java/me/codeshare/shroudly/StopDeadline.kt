package me.codeshare.shroudly

import android.os.Handler
import android.os.Looper
import java.util.concurrent.atomic.AtomicInteger

/*
 * A stop always ends: whatever holds the work thread up, protection that is
 * still "stopping" STOP_DEADLINE_MS after a stop began ends the app's
 * process, and the VPN interface, which belongs to it, with it. Never
 * "stopping" for good.
 *
 * Each stop has its own deadline. Until 2.6.75 the check only asked whether
 * protection was stopping when the time was up, so the deadline of a stop
 * that had ended long before ended the process in the first moments of the
 * next one: a stop, then the mode changed in Settings 15 s later ("Stopping
 * took more than 15 s", 0.3 s after that second stop was asked for).
 */
object StopDeadline {
    private val seq = AtomicInteger(0)

    /* Whether the deadline of stop `mine` is to end the process: protection
     * is still stopping, and no stop began after it. Pure, for the tests. */
    fun due(mine: Int, latest: Int, stopping: Boolean): Boolean = stopping && mine == latest

    /* A stop begins (Protection is STOPPING already). */
    fun arm(log: (String) -> Unit) {
        val mine = seq.incrementAndGet()
        Handler(Looper.getMainLooper()).postDelayed({
            if (due(mine, seq.get(), Protection.state == Protection.State.STOPPING)) {
                log("Stopping took more than ${ShroudlyVpnService.STOP_DEADLINE_MS / 1000} s; ending the app's process so protection is off")
                AppLog.flush()
                android.os.Process.killProcess(android.os.Process.myPid())
            }
        }, ShroudlyVpnService.STOP_DEADLINE_MS)
    }
}
