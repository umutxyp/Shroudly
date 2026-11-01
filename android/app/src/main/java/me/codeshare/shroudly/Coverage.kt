package me.codeshare.shroudly

import android.content.Context
import android.content.pm.PackageManager
import android.os.UserManager

/*
 * What protection covers in VPN mode, as the window and the notification say
 * it under "Protected": every app, only the apps chosen, or every app but
 * the ones chosen to skip it (Settings, #60), as the VPN interface is built
 * (ShroudlyVpnService.establish: chosen apps no longer installed count for
 * nothing, and with none of "only these" left every app goes through). Apps
 * in a work profile have the profile's own VPN, never this one. And with the
 * technique set to Off, nothing is got past: only DNS is encrypted. Up to
 * 2.6.44 the line said "every app on this device" whatever was set.
 */
object Coverage {
    enum class Apps { ALL, ONLY, SKIP }

    /* Which apps go through, and how many were chosen (installed ones). The
     * interface's own order: "only these" while one of them is installed,
     * else the apps chosen to skip it. */
    fun apps(appsOnly: Boolean, included: Int, excluded: Int): Pair<Apps, Int> = when {
        appsOnly && included > 0 -> Apps.ONLY to included
        excluded > 0 -> Apps.SKIP to excluded
        else -> Apps.ALL to 0
    }

    /* The lines, as string resources with their count (0: none): the apps,
     * then the work profile's (not with "only these"), then the technique. */
    fun lines(apps: Pair<Apps, Int>, workProfile: Boolean, bypassOff: Boolean): List<Pair<Int, Int>> {
        val out = ArrayList<Pair<Int, Int>>()
        out += when (apps.first) {
            Apps.ALL -> R.string.androidAllApps to 0
            Apps.ONLY -> R.string.androidSomeApps to apps.second
            Apps.SKIP -> R.string.androidAppsSkipping to apps.second
        }
        if (workProfile && apps.first != Apps.ONLY) out += R.string.androidWorkApps to 0
        if (bypassOff) out += R.string.androidBypassOff to 0
        return out
    }

    /* The text, from the settings as they are now (they reach a running
     * protection at once). Asks the package manager: not every second. */
    fun text(ctx: Context): String {
        val installed = { pkg: String ->
            try { ctx.packageManager.getApplicationInfo(pkg, 0); true } catch (_: PackageManager.NameNotFoundException) { false }
        }
        val only = AppSettings.appsOnly(ctx)
        val apps = apps(only, if (only) AppSettings.included(ctx).count(installed) else 0, AppSettings.excluded(ctx).count(installed))
        val work = try { (ctx.getSystemService(UserManager::class.java)?.userProfiles?.size ?: 1) > 1 } catch (_: Exception) { false }
        return lines(apps, work, AppSettings.strategy(ctx).id == "none")
            .joinToString("\n") { (res, n) -> if (n > 0) ctx.text(res, "count" to n) else ctx.getString(res) }
    }
}
