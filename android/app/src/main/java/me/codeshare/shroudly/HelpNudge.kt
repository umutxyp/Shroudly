package me.codeshare.shroudly

import android.content.Context
import java.util.TimeZone

/*
 * When the main screen asks whether the user would like to help people in
 * censored countries (the card; "Show me" opens the apps made for it,
 * HelpOthers), with the desktop's numbers (components/helpNudge.js): first
 * after a few days of use, then, after each "Not now", a week later, then
 * two weeks, four, eight: every refusal doubles the wait. Kept in the app's
 * own preferences, so an update keeps where it was.
 *
 * Not asked where Tor itself is blocked (the home country, NationalNet):
 * there the user is among the people who need the help, a helper there could
 * not reach Tor's or Psiphon's side anyway, and taking part could put them at
 * risk.
 */
object HelpNudge {
    const val DAY = 24 * 60 * 60 * 1000L
    const val FIRST_DAYS = 3
    const val WAIT_DAYS = 7
    // Past ten refusals the wait stops growing (about twenty years).
    const val MAX_DOUBLINGS = 10
    val NOT_FROM = setOf("BY", "CN", "IR", "MM", "RU", "TM")

    data class State(val first: Long, val next: Long, val refusals: Int, val accepted: Long = 0)

    fun begin(state: State?, now: Long): State = state ?: State(now, now + FIRST_DAYS * DAY, 0)

    /* Where Tor itself is blocked: helping others is not offered at all
     * (the card, the main screen's row, the Snowflake switch), and a
     * Snowflake proxy left on does not run. Pure, for the tests. */
    fun torBlocked(country: String?): Boolean = country != null && country.uppercase() in NOT_FROM

    /* The user's country is one of them (NationalNet.homeCountry). */
    fun torBlockedHere(ctx: Context): Boolean =
        torBlocked(NationalNet.homeCountry(AppSettings.homeCountry(ctx), TimeZone.getDefault().id))

    fun isDue(state: State?, now: Long, country: String?): Boolean {
        if (state == null) return false
        if (country != null && country.uppercase() in NOT_FROM) return false
        return now >= state.next
    }

    private fun wait(n: Int) = WAIT_DAYS * DAY * (1L shl n.coerceIn(0, MAX_DOUBLINGS))

    /* "Not now": a week after the first, twice as long after each next one. */
    fun refuse(state: State, now: Long): State {
        val refusals = state.refusals + 1
        return state.copy(refusals = refusals, next = now + wait(refusals - 1))
    }

    /* "Show me": asked again only once the next wait is over. */
    fun accept(state: State, now: Long): State = state.copy(accepted = now, next = now + wait(state.refusals))

    private const val PREFS = "help_nudge"

    fun load(ctx: Context): State? {
        val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (!p.contains("next")) return null
        return State(p.getLong("first", 0), p.getLong("next", 0), p.getInt("refusals", 0), p.getLong("accepted", 0))
    }

    fun save(ctx: Context, s: State) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putLong("first", s.first).putLong("next", s.next).putInt("refusals", s.refusals).putLong("accepted", s.accepted)
            .apply()
    }

    /* Due now, for this user; the first look starts the count. */
    fun due(ctx: Context, now: Long = System.currentTimeMillis()): Boolean {
        val kept = load(ctx)
        val s = begin(kept, now)
        if (kept == null) save(ctx, s)
        val country = NationalNet.homeCountry(AppSettings.homeCountry(ctx), TimeZone.getDefault().id)
        return isDue(s, now, country)
    }

    fun refused(ctx: Context, now: Long = System.currentTimeMillis()) = save(ctx, refuse(begin(load(ctx), now), now))

    fun accepted(ctx: Context, now: Long = System.currentTimeMillis()) = save(ctx, accept(begin(load(ctx), now), now))
}
