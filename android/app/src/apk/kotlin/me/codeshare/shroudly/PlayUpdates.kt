package me.codeshare.shroudly

import android.app.Activity

/*
 * The APK from GitHub: Google Play does not update it inside the app (it
 * looks on GitHub, UpdateCheck), and Play's library is not in it. The build
 * made for Play has the real one (src/play/kotlin): the same calls, nothing
 * done here.
 */
@Suppress("UNUSED_PARAMETER")
object PlayUpdates {
    fun resume(activity: Activity, mayAsk: () -> Boolean, show: (PlayUpdatePolicy.Card?) -> Unit) {}
    fun pause() {}
    fun offer(activity: Activity) {}
    fun install(activity: Activity) {}
}
