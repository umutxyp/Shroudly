package me.codeshare.shroudly

/*
 * When a copy Google Play updates is told about a new version, and how hard
 * (PlayUpdates; the build made for Play only). Every newer version is
 * required (the owner's word, 2026-11-13): it is pushed with Play's
 * immediate update (full screen; Play installs it and opens Shroudly
 * again), whenever the window opens, ASK_EVERY_MS apart at the least so a
 * "no" still lets the user reach the window for a moment. Protection is
 * never stopped for it: on a censored network the update itself may need
 * Shroudly. Where Play allows only the flexible flow (a release just out,
 * a phone short of space), that one. Pure, for the tests.
 */
object PlayUpdatePolicy {
    enum class Type { NONE, FLEXIBLE, IMMEDIATE }
    enum class Stage { AVAILABLE, DOWNLOADING, READY }

    /* What the window's card shows (MainActivity.showPlayUpdate). */
    data class Card(val version: String, val stage: Stage, val urgent: Boolean = false, val percent: Int = 0)

    /* A download Play has finished: what happens next. */
    enum class Downloaded { CARD, INSTALL, LATER, NOTICE }

    // Play's inAppUpdatePriority (0 to 5, set per release with the Play
    // Developer API, PLAY_STORE.md) from which an update is pushed.
    const val URGENT_PRIORITY = 4
    // Version numbers behind (Versions.behind) from which it is pushed.
    // Desktop-only releases share the numbers, and one uploaded to Play by
    // hand is often ten ahead by itself: twenty is a copy left for weeks.
    const val FAR_BEHIND = 20
    // Days an update has waited from which it is pushed.
    const val STALE_DAYS = 7
    // Play is asked at most this often, unless an update is on its way.
    const val CHECK_EVERY_MS = 60L * 60 * 1000
    // Play's update screen comes up by itself at most this often: each time
    // the window opens, but not again at once after a "no".
    const val ASK_EVERY_MS = 2L * 60 * 1000
    private const val DAY_MS = 24L * 60 * 60 * 1000

    /* Every newer version is required. (priority, staleDays: what Play
     * says, kept for the log.) */
    @Suppress("UNUSED_PARAMETER")
    fun pushed(installedCode: Int, availableCode: Int, priority: Int, staleDays: Int): Boolean =
        availableCode > installedCode

    /* The flow to start, from what Play allows: the immediate one only when
     * pushed, or when it is the only one allowed. */
    fun type(pushed: Boolean, flexibleAllowed: Boolean, immediateAllowed: Boolean): Type = when {
        pushed && immediateAllowed -> Type.IMMEDIATE
        flexibleAllowed -> Type.FLEXIBLE
        immediateAllowed -> Type.IMMEDIATE
        else -> Type.NONE
    }

    /* Play's dialog may come up by itself (once a day) for this flow. The
     * full screen only for an update that is pushed: one Play allows only
     * that way (it refuses the flexible one, for a release just out or a
     * phone short of space) waits on the card until the user taps it. */
    fun byItself(type: Type, pushed: Boolean): Boolean =
        type == Type.FLEXIBLE || (type == Type.IMMEDIATE && pushed)

    /* Due again (a time in the future, the clock set back, counts as long ago). */
    fun due(at: Long, now: Long, every: Long): Boolean = now - at > every || at > now

    /* Days an update has waited: Play's count, or this copy's own from the
     * first time it heard of one, whichever is more. */
    fun staleDays(play: Int?, firstSeen: Long, now: Long): Int =
        maxOf(play ?: 0, if (firstSeen in 1..now) ((now - firstSeen) / DAY_MS).toInt() else 0)

    /* Downloaded. In the window, its card says so. Away from Shroudly with
     * protection off, nothing is interrupted: Play installs it at once,
     * silently. In another of Shroudly's windows (Settings) with protection
     * off, installing would take over the screen: the window's card says so
     * when the user is back. With protection on, a notice, so the user picks
     * the moment: installing ends protection for a moment. */
    fun downloaded(windowVisible: Boolean, appInFront: Boolean, protectionOff: Boolean): Downloaded = when {
        windowVisible -> Downloaded.CARD
        protectionOff && !appInFront -> Downloaded.INSTALL
        protectionOff -> Downloaded.LATER
        else -> Downloaded.NOTICE
    }

    fun percent(done: Long, total: Long): Int = if (total > 0) (done * 100 / total).toInt().coerceIn(0, 100) else 0
}
