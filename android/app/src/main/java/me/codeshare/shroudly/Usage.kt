package me.codeshare.shroudly

import android.content.Context

/*
 * What the window's cards go by, beyond what protection is doing now: on how
 * many days protection has worked (came on and carried traffic, not just
 * asked to start), when Android last ended it by itself, when the window was
 * last on screen, and how Android ran the VPN the last time it was on. Kept
 * with the settings, so it outlives the process and every update.
 */
object Usage {
    private const val PREFS = "settings"
    private const val KEY_LOCKDOWN = "lockdownSeen"
    private const val KEY_DAYS = "workedDays"
    private const val KEY_LAST_DAY = "workedLastDay"
    private const val KEY_ENDED = "endedByAndroidAt"
    private const val KEY_WINDOW = "windowSeenAt"

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /* The days counted so far and the last one (days since 1970, local
     * time), with today: today counts once. A clock set back to another day
     * counts that day too; it never takes one away. */
    fun countDay(days: Int, lastDay: Long, today: Long): Pair<Int, Long> =
        if (today == lastDay) days to lastDay else (days + 1) to today

    /* Protection carried traffic in this session (the services, once). */
    fun worked(ctx: Context) {
        val p = prefs(ctx)
        val today = java.time.LocalDate.now().toEpochDay()
        val (days, last) = countDay(p.getInt(KEY_DAYS, 0), p.getLong(KEY_LAST_DAY, Long.MIN_VALUE), today)
        if (last != p.getLong(KEY_LAST_DAY, Long.MIN_VALUE)) p.edit().putInt(KEY_DAYS, days).putLong(KEY_LAST_DAY, last).apply()
    }

    /* On how many days protection has worked. */
    fun days(ctx: Context): Int = prefs(ctx).getInt(KEY_DAYS, 0)

    /* Android (a battery saver, a cleaner, low memory) ended protection
     * while it was on (the services' onDestroy, and their restart by
     * START_STICKY). */
    fun endedByAndroid(ctx: Context) = prefs(ctx).edit().putLong(KEY_ENDED, System.currentTimeMillis()).apply()

    fun endedByAndroidAt(ctx: Context): Long = prefs(ctx).getLong(KEY_ENDED, 0)

    /* The window came on screen. */
    fun windowSeen(ctx: Context) = prefs(ctx).edit().putLong(KEY_WINDOW, System.currentTimeMillis()).apply()

    fun windowSeenAt(ctx: Context): Long = prefs(ctx).getLong(KEY_WINDOW, 0)

    /* When this app was first installed (an update keeps it). */
    fun installedAt(ctx: Context): Long = try {
        ctx.packageManager.getPackageInfo(ctx.packageName, 0).firstInstallTime
    } catch (_: Exception) {
        System.currentTimeMillis()
    }

    /* "Block connections without VPN" was on for Shroudly the last time the
     * VPN ran (ShroudlyVpnService; Android says it only to the running VPN).
     * Another VPN app taking over clears it: that one is Android's VPN now. */
    fun lockdown(ctx: Context): Boolean = prefs(ctx).getBoolean(KEY_LOCKDOWN, false)

    fun setLockdown(ctx: Context, on: Boolean) {
        if (lockdown(ctx) != on) prefs(ctx).edit().putBoolean(KEY_LOCKDOWN, on).apply()
    }
}
