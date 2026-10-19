package me.codeshare.shroudly

import android.os.Handler
import android.os.Looper
import java.util.concurrent.CopyOnWriteArraySet

/* What the service is doing, for the window, the tile and the notification. */
object Protection {
    enum class State { OFF, STARTING, ON, STOPPING }

    @Volatile var state = State.OFF
        private set
    /* Why the last start failed or protection ended on its own: a string
     * resource, and a detail in English for the log (may be null). */
    @Volatile var errorRes = 0
        private set
    @Volatile var errorDetail: String? = null
        private set
    @Volatile var stats: EngineEvent.Stats? = null
    @Volatile var startedAt = 0L
    /* The engine's SOCKS5 port while protection is on, 0 otherwise. */
    @Volatile var socksPort = 0

    private val listeners = CopyOnWriteArraySet<() -> Unit>()
    private val main = Handler(Looper.getMainLooper())

    fun set(s: State) {
        state = s
        if (s == State.STARTING) { errorRes = 0; errorDetail = null }
        if (s != State.ON) { socksPort = 0 }
        if (s == State.OFF) { stats = null; startedAt = 0 }
        changed()
    }

    fun fail(res: Int, detail: String?) {
        errorRes = res
        errorDetail = detail
        changed()
    }

    fun clearError() {
        errorRes = 0
        errorDetail = null
        changed()
    }

    fun changed() {
        main.post { for (l in listeners) l() }
    }

    fun listen(l: () -> Unit) { listeners += l }
    fun unlisten(l: () -> Unit) { listeners -= l }
}
