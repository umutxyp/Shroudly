package me.codeshare.shroudly

import android.app.Activity
import android.content.Context

/*
 * The copy for Google Play: Play alone updates it (PlayUpdates), and Play's
 * policy allows no other way, so this build has nothing that downloads or
 * installs an APK, nor the permission for it. The APK from GitHub has the
 * real one (src/apk/kotlin): the same calls, nothing done here.
 */
@Suppress("UNUSED_PARAMETER")
object ApkUpdates {
    enum class Stage { DOWNLOADING, WAITING, FAILED }

    data class Now(val version: String, val stage: Stage, val percent: Int = 0, val failed: Int = 0)

    val now: Now? get() = null

    fun available(ctx: Context): Boolean = false
    fun seen(ctx: Context, version: String) {}
    fun start(activity: Activity, version: String, url: String, variant: String = "") {}
    fun startFull(activity: Activity) {}
    fun resume(activity: Activity) {}
    fun look(ctx: Context, port: Int, auth: SocksAuth?) {}
}
