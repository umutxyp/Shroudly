package me.codeshare.shroudly

import android.annotation.SuppressLint
import android.app.Activity
import android.app.ActivityManager
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import com.google.android.play.core.appupdate.AppUpdateInfo
import com.google.android.play.core.appupdate.AppUpdateManager
import com.google.android.play.core.appupdate.AppUpdateManagerFactory
import com.google.android.play.core.appupdate.AppUpdateOptions
import com.google.android.play.core.install.InstallException
import com.google.android.play.core.install.InstallStateUpdatedListener
import com.google.android.play.core.install.model.AppUpdateType
import com.google.android.play.core.install.model.InstallStatus
import com.google.android.play.core.install.model.UpdateAvailability
import me.codeshare.shroudly.PlayUpdatePolicy.Card
import me.codeshare.shroudly.PlayUpdatePolicy.Stage

/*
 * Updates from Google Play, inside the app: the build made for Play only (the
 * APK's PlayUpdates does nothing and has no Google code), and only for a copy
 * Play installed or updated (InstallSource.playUpdates). Play answers no
 * other copy; a phone or an emulator without Play answers with an error,
 * which is logged once, and nothing is shown.
 *   - A newer version on Play: the window's card, every time the window
 *     opens; Play's own dialog by itself at most once a day, the flexible
 *     update or, when PlayUpdatePolicy pushes it, the immediate one. A no
 *     holds for the day; Shroudly keeps working.
 *   - Downloading: the card with the percentage.
 *   - Downloaded: the card with "Restart now". Away from Shroudly with
 *     protection off, Play installs it at once, silently; with protection
 *     on, a notice, so the user picks the moment it ends
 *     (PlayUpdatePolicy.downloaded).
 *   - An immediate update left half way (Home, another app) is taken up
 *     again when the window comes back, as Play asks.
 * Installing ends the app and protection with it; KeepOn.updated turns it
 * back on.
 */
@SuppressLint("StaticFieldLeak")
object PlayUpdates {
    // UpdateCheck's file; the play* keys are this copy's.
    private const val PREFS = "update"
    // Its own notice, so it never replaces another one, nor is cancelled with
    // it (ShroudlyVpnService's are 1 to 3, the proxy's 4 and 6, automation's
    // 5, KeepOn's 7302; NoticesTest).
    private const val NOTICE_ID = 7303
    private const val NO_TYPE = -1

    private var manager: AppUpdateManager? = null
    // The application's context, never a window's: it lasts as the process does.
    private var app: Context? = null
    // The window's card, from resume to pause.
    private var show: ((Card?) -> Unit)? = null
    // The card last told (tell), also while the window is away: what it
    // shows at once when it is back while an update is on its way.
    private var last: Card? = null
    private var listening = false
    @Volatile private var failureLogged = false

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun manager(ctx: Context): AppUpdateManager {
        app = ctx.applicationContext
        return manager ?: AppUpdateManagerFactory.create(ctx.applicationContext).also { manager = it }
    }

    /* The window is up (MainActivity.onResume). mayAsk: nothing else is
     * going on in it, so Play's dialog may come up; asked when Play answers. */
    fun resume(activity: Activity, mayAsk: () -> Boolean, show: (Card?) -> Unit) {
        if (!InstallSource.playUpdates(activity)) { show(null); return }
        this.show = show
        val p = prefs(activity)
        var offered = p.getInt("playCode", 0)
        if (offered in 1..BuildConfig.VERSION_CODE) {
            // Installed since (in the app or by Play itself).
            p.edit().remove("playCode").remove("playType").remove("playPushed").apply()
            offered = 0
        }
        val onItsWay = offered > 0 && p.getInt("playType", NO_TYPE) != NO_TYPE
        // What was found last time, at once (as the APK's card does). While
        // an update is on its way, the card as it was (downloading, or
        // "Restart now"), not "available" with the wrong button until Play
        // answers; none yet in a process just started.
        val version = Versions.fromCode(offered)
        show(when {
            offered <= 0 -> null
            !onItsWay -> Card(version, Stage.AVAILABLE, p.getBoolean("playPushed", false))
            else -> last?.takeIf { it.version == version }
        })
        val now = System.currentTimeMillis()
        if (!onItsWay && !PlayUpdatePolicy.due(p.getLong("playCheckedAt", 0), now, PlayUpdatePolicy.CHECK_EVERY_MS)) return
        manager(activity).appUpdateInfo
            .addOnSuccessListener(activity) { info -> found(activity, info, mayAsk) }
            .addOnFailureListener(activity) { e ->
                // No Play Store (an emulator, a phone without Google), a copy
                // Play does not own, an old Play Store: nothing to offer.
                p.edit().putLong("playCheckedAt", now).apply()
                if (!failureLogged) {
                    failureLogged = true
                    ShroudlyVpnService.log("Google Play gave no update information (${(e as? InstallException)?.errorCode ?: e.message})")
                }
                tell(null)
            }
    }

    /* The window is going (MainActivity.onPause). */
    fun pause() {
        show = null
    }

    private fun tell(card: Card?) {
        last = card
        show?.invoke(card)
    }

    private fun found(activity: Activity, info: AppUpdateInfo, mayAsk: () -> Boolean) {
        val p = prefs(activity)
        val now = System.currentTimeMillis()
        val code = info.availableVersionCode()
        val version = Versions.fromCode(code)
        p.edit().putLong("playCheckedAt", now).apply()
        when {
            info.installStatus() == InstallStatus.DOWNLOADED -> {
                p.edit().putInt("playCode", code).apply()
                tell(Card(version, Stage.READY))
            }
            info.updateAvailability() == UpdateAvailability.DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS &&
                p.getInt("playType", NO_TYPE) == AppUpdateType.IMMEDIATE -> {
                // The full-screen update the user left half way: back to it
                // (they can still say no there).
                if (show != null) start(activity, info, AppUpdateType.IMMEDIATE)
            }
            info.updateAvailability() == UpdateAvailability.DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS ||
                info.installStatus() == InstallStatus.PENDING || info.installStatus() == InstallStatus.DOWNLOADING -> {
                // A flexible download under way.
                p.edit().putInt("playCode", code).apply()
                listen(activity)
                tell(Card(version, Stage.DOWNLOADING, percent = PlayUpdatePolicy.percent(info.bytesDownloaded(), info.totalBytesToDownload())))
            }
            info.updateAvailability() == UpdateAvailability.UPDATE_AVAILABLE && code > BuildConfig.VERSION_CODE -> {
                // When this copy first heard of an update (its own count of
                // days waited, PlayUpdatePolicy.staleDays).
                if (p.getInt("playSeenFor", 0) != BuildConfig.VERSION_CODE) {
                    p.edit().putInt("playSeenFor", BuildConfig.VERSION_CODE).putLong("playSeenAt", now).apply()
                }
                val stale = PlayUpdatePolicy.staleDays(info.clientVersionStalenessDays(), p.getLong("playSeenAt", now), now)
                val pushed = PlayUpdatePolicy.pushed(BuildConfig.VERSION_CODE, code, info.updatePriority(), stale)
                val type = PlayUpdatePolicy.type(pushed, allowed(info, AppUpdateType.FLEXIBLE), allowed(info, AppUpdateType.IMMEDIATE))
                if (type == PlayUpdatePolicy.Type.NONE) {
                    p.edit().remove("playCode").remove("playType").apply()
                    tell(null)
                    return
                }
                p.edit().putInt("playCode", code).putBoolean("playPushed", pushed).remove("playType").apply()
                tell(Card(version, Stage.AVAILABLE, pushed))
                // Play's own dialog by itself: at most once a day, only while
                // the window is still in front with nothing else going on, and
                // the full screen only for an update that is pushed (otherwise
                // the card's button starts it).
                if (show != null && mayAsk() && PlayUpdatePolicy.byItself(type, pushed) &&
                    PlayUpdatePolicy.due(p.getLong("playAskedAt", 0), now, PlayUpdatePolicy.ASK_EVERY_MS)) {
                    p.edit().putLong("playAskedAt", now).apply()
                    ShroudlyVpnService.log("Google Play has version $version${if (pushed) " (pushed: priority ${info.updatePriority()}, $stale days)" else ""}; asking")
                    start(activity, info, type.flow())
                }
            }
            else -> {
                p.edit().remove("playCode").remove("playType").remove("playPushed").apply()
                tell(null)
            }
        }
    }

    /* The card's button: Play's flow now. Each AppUpdateInfo starts one flow
     * only, so a fresh one is asked for. */
    fun offer(activity: Activity) {
        if (!InstallSource.playUpdates(activity)) return
        manager(activity).appUpdateInfo
            .addOnSuccessListener(activity) { info ->
                if (info.installStatus() == InstallStatus.DOWNLOADED) { install(activity); return@addOnSuccessListener }
                val busy = info.installStatus() == InstallStatus.PENDING || info.installStatus() == InstallStatus.DOWNLOADING
                if (busy || info.updateAvailability() != UpdateAvailability.UPDATE_AVAILABLE) {
                    // Already on its way, or gone: the card follows Play.
                    found(activity, info) { false }
                    return@addOnSuccessListener
                }
                val pushed = prefs(activity).getBoolean("playPushed", false)
                val type = PlayUpdatePolicy.type(pushed, allowed(info, AppUpdateType.FLEXIBLE), allowed(info, AppUpdateType.IMMEDIATE))
                if (type != PlayUpdatePolicy.Type.NONE) start(activity, info, type.flow())
            }
            .addOnFailureListener(activity) { e -> ShroudlyVpnService.log("Google Play gave no update information: ${e.message}") }
    }

    private fun start(activity: Activity, info: AppUpdateInfo, type: Int) {
        val p = prefs(activity)
        val version = Versions.fromCode(info.availableVersionCode())
        p.edit().putInt("playType", type).putInt("playCode", info.availableVersionCode()).apply()
        if (type == AppUpdateType.FLEXIBLE) listen(activity)
        // Play's dialog (flexible) or its full screen (immediate) over the
        // window. The answer comes back here: the window is a plain Activity
        // and its onActivityResult stays the VPN consent's.
        manager(activity).startUpdateFlow(info, activity, AppUpdateOptions.defaultOptions(type))
            .addOnSuccessListener { result ->
                if (result == Activity.RESULT_OK) {
                    ShroudlyVpnService.log("Google Play is updating Shroudly to $version")
                    return@addOnSuccessListener
                }
                // RESULT_CANCELED (a no: Shroudly keeps working, asked again
                // tomorrow) or ActivityResult.RESULT_IN_APP_UPDATE_FAILED.
                p.edit().remove("playType").apply()
                unlisten()
                ShroudlyVpnService.log(if (result == Activity.RESULT_CANCELED) "The update to $version was declined; asked again in a day" else "Google Play could not update to $version")
            }
            .addOnFailureListener { e ->
                p.edit().remove("playType").apply()
                unlisten()
                ShroudlyVpnService.log("Google Play's update did not start: ${e.message}")
            }
    }

    // Kept while the app runs, not only while the window is up: protection
    // keeps the process, so a download that ends with the window closed is
    // still told (downloaded).
    private val onState = InstallStateUpdatedListener { st ->
        val ctx = app ?: return@InstallStateUpdatedListener
        val p = prefs(ctx)
        val version = Versions.fromCode(p.getInt("playCode", 0))
        when (st.installStatus()) {
            InstallStatus.PENDING, InstallStatus.DOWNLOADING ->
                tell(Card(version, Stage.DOWNLOADING, percent = PlayUpdatePolicy.percent(st.bytesDownloaded(), st.totalBytesToDownload())))
            InstallStatus.DOWNLOADED -> downloaded(ctx, version)
            InstallStatus.FAILED, InstallStatus.CANCELED -> {
                ShroudlyVpnService.log("Google Play stopped the update to $version (error ${st.installErrorCode()})")
                p.edit().remove("playType").apply()
                unlisten()
                tell(Card(version, Stage.AVAILABLE, p.getBoolean("playPushed", false)))
            }
            else -> {}
        }
    }

    private fun listen(ctx: Context) {
        if (listening) return
        manager(ctx).registerListener(onState)
        listening = true
    }

    private fun unlisten() {
        if (!listening) return
        manager?.unregisterListener(onState)
        listening = false
    }

    private fun downloaded(ctx: Context, version: String) {
        // "Restart now" on the card: now, or when the window is back.
        val ready = Card(version, Stage.READY)
        last = ready
        when (PlayUpdatePolicy.downloaded(Protection.windowVisible, appInFront(), Protection.state == Protection.State.OFF)) {
            PlayUpdatePolicy.Downloaded.CARD -> tell(ready)
            PlayUpdatePolicy.Downloaded.INSTALL -> {
                ShroudlyVpnService.log("Version $version downloaded from Google Play; installed now (protection is off, Shroudly is not in use)")
                unlisten()
                manager(ctx).completeUpdate()
            }
            PlayUpdatePolicy.Downloaded.LATER -> ShroudlyVpnService.log("Version $version downloaded from Google Play; the window offers to install it")
            PlayUpdatePolicy.Downloaded.NOTICE -> notice(ctx, version)
        }
    }

    /* "Restart now", or the notice: Play installs the download; Shroudly ends
     * and opens again by itself, and protection, if it was on, comes back
     * (KeepOn.updated). */
    fun install(activity: Activity) {
        if (!InstallSource.playUpdates(activity)) return
        cancelNotice(activity)
        unlisten()
        ShroudlyVpnService.log("Installing the update from Google Play; Shroudly restarts")
        manager(activity).completeUpdate()
            .addOnFailureListener { e -> ShroudlyVpnService.log("Google Play could not install the update: ${e.message}") }
    }

    /* Any of Shroudly's windows on screen (Settings too), where installing
     * now would take it over. */
    private fun appInFront(): Boolean = try {
        val me = ActivityManager.RunningAppProcessInfo()
        ActivityManager.getMyMemoryState(me)
        me.importance <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_VISIBLE
    } catch (_: Exception) {
        true
    }

    /* One tap installs it (MainActivity.EXTRA_INSTALL_UPDATE). */
    private fun notice(ctx: Context, version: String) {
        try {
            val l = Lang.wrap(ctx)
            ShroudlyVpnService.channels(ctx)
            val open = PendingIntent.getActivity(
                ctx, NOTICE_ID,
                Intent(ctx, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                    .putExtra(MainActivity.EXTRA_INSTALL_UPDATE, true),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            val body = l.getString(R.string.androidUpdateReadyTap)
            val n = Notification.Builder(ctx, ShroudlyVpnService.ALERT_CHANNEL)
                .setSmallIcon(R.drawable.ic_download)
                .setContentTitle(l.text(R.string.updReady, "version" to version))
                .setContentText(body)
                .setStyle(Notification.BigTextStyle().bigText(body))
                .setContentIntent(open)
                .setAutoCancel(true)
                .build()
            ctx.getSystemService(NotificationManager::class.java)?.notify(NOTICE_ID, n)
            ShroudlyVpnService.log("Version $version downloaded from Google Play; a notice installs it")
        } catch (e: Exception) {
            ShroudlyVpnService.log("Could not post the update notice: ${e.message}")
        }
    }

    private fun cancelNotice(ctx: Context) {
        try { ctx.getSystemService(NotificationManager::class.java)?.cancel(NOTICE_ID) } catch (_: Exception) {}
    }

    private fun allowed(info: AppUpdateInfo, type: Int) = info.isUpdateTypeAllowed(AppUpdateOptions.defaultOptions(type))

    private fun PlayUpdatePolicy.Type.flow() = if (this == PlayUpdatePolicy.Type.IMMEDIATE) AppUpdateType.IMMEDIATE else AppUpdateType.FLEXIBLE
}
