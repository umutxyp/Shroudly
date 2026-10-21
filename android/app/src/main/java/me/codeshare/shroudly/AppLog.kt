package me.codeshare.shroudly

import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors

/*
 * The app's recent log, for "Share logs" (MainActivity): what a user sends us
 * when Shroudly does not work for them.
 *
 * Two kinds of line:
 *   - the app's own (starts, stops, the engine's health, network changes,
 *     errors): kept in memory and in a file in the app's private storage, so
 *     the log from before a crash or a kill is still there afterwards;
 *   - site lines (which site was blocked, opened, cut): in memory only,
 *     never written to storage, nor to the system log in release builds.
 *     They leave the device only in the text the user chooses to share.
 *
 * Each kind keeps its last CAPACITY lines, so a busy browsing session does
 * not push the app's own lines out.
 */
object AppLog {
    const val CAPACITY = 300

    private class Line(val seq: Long, val text: String)

    private val app = ArrayDeque<Line>()
    private val sites = ArrayDeque<Line>()
    private var seq = 0L
    private var file: File? = null
    // Lines appended to the file since it was last written whole: at
    // CAPACITY it is cut back to the last CAPACITY lines.
    private var appended = 0
    // One writer, in order, off the caller's thread.
    private val disk = Executors.newSingleThreadExecutor { r -> Thread(r, "app-log").apply { isDaemon = true } }
    private val stamp = object : ThreadLocal<SimpleDateFormat>() {
        override fun initialValue() = SimpleDateFormat("MM-dd HH:mm:ss.SSS", Locale.ROOT)
    }

    /* Takes what an earlier process of the app left in `f`, and keeps the
     * app's own lines there from now on. Once; later calls do nothing. */
    fun attach(f: File) {
        synchronized(this) {
            if (file != null) return
            file = f
            val old = try { if (f.isFile) f.readLines() else emptyList() } catch (_: Exception) { emptyList() }
            // The earlier lines go before whatever this process logged already.
            val mine = app.toList()
            app.clear()
            for (l in old.takeLast(CAPACITY)) keep(app, Line(seq++, l))
            for (l in mine) keep(app, Line(seq++, l.text))
            rewrite()
        }
    }

    fun add(msg: String, site: Boolean = false) {
        val line = "${stamp.get()!!.format(Date())} $msg"
        synchronized(this) {
            keep(if (site) sites else app, Line(seq++, line))
            if (site) return
            val f = file ?: return
            if (++appended >= CAPACITY) {
                rewrite()
            } else {
                disk.execute { try { f.appendText("$line\n") } catch (_: Exception) {} }
            }
        }
    }

    /* Every line, oldest first, site lines included: only for what the user
     * shares. */
    fun snapshot(): List<String> = synchronized(this) {
        (app + sites).sortedBy { it.seq }.map { it.text }
    }

    /* Waits for what has been handed to the writer (tests). */
    fun flush() {
        try { disk.submit {}.get() } catch (_: Exception) {}
    }

    private fun keep(q: ArrayDeque<Line>, l: Line) {
        q.addLast(l)
        while (q.size > CAPACITY) q.removeFirst()
    }

    /* The file as the app's lines in memory. Caller holds the lock. */
    private fun rewrite() {
        appended = 0
        val f = file ?: return
        val text = app.joinToString("") { "${it.text}\n" }
        disk.execute {
            try {
                val tmp = File(f.path + ".tmp")
                tmp.writeText(text)
                if (!tmp.renameTo(f)) f.writeText(text)
            } catch (_: Exception) {
            }
        }
    }
}
