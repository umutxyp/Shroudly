package me.codeshare.shroudly

import android.content.Context

/*
 * What the window goes by when protection is not running to say it: how
 * Android ran the VPN the last time it was on. Kept with the settings, so it
 * outlives the process (Protection's own copy goes with it).
 */
object Usage {
    private const val PREFS = "settings"
    private const val KEY_LOCKDOWN = "lockdownSeen"

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /* "Block connections without VPN" was on for Shroudly the last time the
     * VPN ran (ShroudlyVpnService; Android says it only to the running VPN).
     * Another VPN app taking over clears it: that one is Android's VPN now. */
    fun lockdown(ctx: Context): Boolean = prefs(ctx).getBoolean(KEY_LOCKDOWN, false)

    fun setLockdown(ctx: Context, on: Boolean) {
        if (lockdown(ctx) != on) prefs(ctx).edit().putBoolean(KEY_LOCKDOWN, on).apply()
    }
}
