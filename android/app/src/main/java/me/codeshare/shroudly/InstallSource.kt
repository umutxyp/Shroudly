package me.codeshare.shroudly

import android.content.Context
import android.os.Build

/*
 * Who updates this copy of the app. The APK from GitHub checks GitHub for a
 * newer APK; a copy that Google Play installed, or has since updated over a
 * GitHub install (same package, same signing key), is updated by Play and must
 * not offer an APK or ask GitHub anything (Play's Device and Network Abuse
 * policy). The build made for Play (STORE_BUILD) never does either.
 */
object InstallSource {
    const val PLAY_STORE = "com.android.vending"

    /* The package that installed or last updated this app, if Android says. */
    fun installer(ctx: Context): String? = try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            ctx.packageManager.getInstallSourceInfo(ctx.packageName).installingPackageName
        } else {
            @Suppress("DEPRECATION")
            ctx.packageManager.getInstallerPackageName(ctx.packageName)
        }
    } catch (_: Exception) {
        null
    }

    /* Whether this copy looks for updates on GitHub. */
    fun githubUpdates(storeBuild: Boolean, installer: String?): Boolean =
        !storeBuild && installer != PLAY_STORE

    /* Asked again every time, never remembered: a GitHub install becomes
     * Play's once Play updates it. */
    fun githubUpdates(ctx: Context): Boolean = githubUpdates(BuildConfig.STORE_BUILD, installer(ctx))
}
