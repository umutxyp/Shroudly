package me.codeshare.shroudly

import android.content.Context

/*
 * The main window's card that asks for a rating on Google Play, in the copy
 * Google Play installed or updates only, and only while Shroudly is on Play
 * (Stores). Never a notification, never a dialog, never more than one
 * prompt a session, never beside a card that asks for something else
 * (MainActivity.showStoreCard), and at a good moment only: protection on and
 * working right now, the app installed for INSTALLED_DAYS and protection
 * having worked on RATE_DAYS different days (Usage). It asks nothing about
 * the user's opinion and offers nothing for a rating (Google Play's rules).
 *
 * A showing that ends without the button is a "no": the next one waits 14
 * days after the first, then 28, 56, 112... (each "no" doubles it). The
 * button opens Shroudly's Play page itself (not Play's in-app review, whose
 * quota may show nothing after a tap) and the card never comes back.
 */
object StoreCards {
    private const val DAY = 24L * 60 * 60 * 1000
    const val INSTALLED_DAYS = 3
    const val RATE_DAYS = 3
    const val RATE_FIRST_WAIT_DAYS = 14

    /* The copy Google Play installed or last updated (the APK from GitHub,
     * or one put on the phone any other way, is not). */
    fun fromPlay(installer: String?): Boolean = installer == InstallSource.PLAY_STORE

    /* A card's record: done (its button tapped: never again), how many
     * times it was shown, when last, and when it may come next. */
    data class State(val done: Boolean = false, val shown: Int = 0, val lastAt: Long = 0, val nextAt: Long = 0)

    /* A clock set back before the last showing: the wait starts over from
     * now, as long as it was, so it shows neither early nor never. */
    fun rebase(s: State, now: Long): State =
        if (s.lastAt > 0 && now < s.lastAt) s.copy(lastAt = now, nextAt = now + (s.nextAt - s.lastAt).coerceAtLeast(0)) else s

    /* The wait after the n-th "no": 14 days, doubled each time after. */
    fun rateWaitMs(noes: Int): Long = RATE_FIRST_WAIT_DAYS * DAY shl (noes.coerceIn(1, 16) - 1)

    fun rateDue(fromPlay: Boolean, live: Boolean, working: Boolean, installedAt: Long, workedDays: Int, s: State, now: Long): Boolean =
        fromPlay && live && working && !s.done && now - installedAt >= INSTALLED_DAYS * DAY && workedDays >= RATE_DAYS && now >= s.nextAt

    /* Shown: a "no" until the button is tapped (rateTapped). */
    fun rateShown(s: State, now: Long): State {
        val n = s.shown + 1
        return s.copy(shown = n, lastAt = now, nextAt = now + rateWaitMs(n))
    }

    /* At most one prompt in a run of the app. */
    @Volatile var promptedThisRun = false

    private fun prefs(ctx: Context) = ctx.getSharedPreferences("ui", Context.MODE_PRIVATE)

    fun load(ctx: Context, key: String, now: Long = System.currentTimeMillis()): State {
        val p = prefs(ctx)
        val s = State(p.getBoolean("${key}Done", false), p.getInt("${key}Shown", 0), p.getLong("${key}LastAt", 0), p.getLong("${key}NextAt", 0))
        val r = rebase(s, now)
        if (r != s) save(ctx, key, r)
        return r
    }

    fun save(ctx: Context, key: String, s: State) {
        prefs(ctx).edit().putBoolean("${key}Done", s.done).putInt("${key}Shown", s.shown)
            .putLong("${key}LastAt", s.lastAt).putLong("${key}NextAt", s.nextAt).apply()
    }

    const val RATE = "rate"
}
