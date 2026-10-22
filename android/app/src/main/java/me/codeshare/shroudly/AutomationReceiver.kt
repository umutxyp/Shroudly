package me.codeshare.shroudly

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings

/*
 * Automation apps (Tasker, MacroDroid and the like): protection on, off or
 * switched by a broadcast to this app (issue #32), for instance on when a
 * game opens and off when it closes:
 *
 *   package  me.codeshare.shroudly (Android delivers it only when named)
 *   action   me.codeshare.shroudly.action.START | STOP | TOGGLE
 *
 * Off by default: only once the user allows it in Settings ("Allow
 * automation apps") may another app on the phone do this, as WireGuard's
 * "Allow remote control apps". In the mode chosen in Settings.
 *
 * What Android may refuse is said in a notice that starts protection when
 * tapped: the VPN not allowed yet (its consent needs a window), or, in proxy
 * only, a start from the background (Android 12+ allows it to an app whose
 * VPN is allowed or whose battery use is unrestricted; the notice has a
 * button to that setting).
 */
class AutomationReceiver : BroadcastReceiver() {
    companion object {
        const val ACTION_START = "me.codeshare.shroudly.action.START"
        const val ACTION_STOP = "me.codeshare.shroudly.action.STOP"
        const val ACTION_TOGGLE = "me.codeshare.shroudly.action.TOGGLE"
        // Its own notice (ShroudlyVpnService's are 1 to 3, the proxy's 4).
        private const val NOTICE_ID = 5
    }

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action != ACTION_START && action != ACTION_STOP && action != ACTION_TOGGLE) return
        ShroudlyVpnService.attachLog(context)
        val what = action.substringAfterLast('.').lowercase()
        if (!AppSettings.remoteControl(context)) {
            ShroudlyVpnService.log("Automation: \"$what\" from another app ignored (Settings: automation apps are not allowed)")
            return
        }
        val on = when (action) {
            ACTION_START -> true
            ACTION_STOP -> false
            else -> Protection.state == Protection.State.OFF
        }
        if (!on) {
            if (Protection.state == Protection.State.OFF) return
            Protector.stop(context)
            ShroudlyVpnService.log("Automation: protection off, asked by another app")
            return
        }
        if (Protection.state != Protection.State.OFF) return
        val started = try {
            Protector.start(context)
        } catch (e: Exception) {
            // Android refused a start from the background (12+).
            ShroudlyVpnService.log("Automation: Android did not let protection start from another app (${e.javaClass.simpleName}); a notice offers it")
            notStarted(context, R.string.androidAutomationTapBattery, battery = true)
            return
        }
        if (started) {
            ShroudlyVpnService.log("Automation: protection on, asked by another app")
            try { context.getSystemService(NotificationManager::class.java).cancel(NOTICE_ID) } catch (_: Exception) {}
        } else {
            ShroudlyVpnService.log("Automation: not started, the VPN is not allowed yet; a notice offers it")
            notStarted(context, R.string.androidAutomationTapVpn, battery = false)
        }
    }

    /* Tapped, it opens the window and starts protection (asking for the VPN
     * when needed); `battery`: with a button to Shroudly's page in Android's
     * settings, where its battery use is set. */
    private fun notStarted(ctx: Context, text: Int, battery: Boolean) {
        try {
            ShroudlyVpnService.channels(ctx)
            val start = PendingIntent.getActivity(
                ctx, 5,
                Intent(ctx, MainActivity::class.java).putExtra(MainActivity.EXTRA_START, true)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            val body = ctx.getString(text)
            val n = Notification.Builder(ctx, ShroudlyVpnService.ALERT_CHANNEL)
                .setSmallIcon(R.drawable.ic_shield)
                .setContentTitle(ctx.getString(R.string.androidAutomationNotStarted))
                .setContentText(body)
                .setStyle(Notification.BigTextStyle().bigText(body))
                .setContentIntent(start)
                .setAutoCancel(true)
                .setColor(Accent.swatch(ctx))
            if (battery) {
                val page = PendingIntent.getActivity(
                    ctx, 6,
                    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", ctx.packageName, null))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                )
                n.addAction(Notification.Action.Builder(null, ctx.getString(R.string.androidAutomationBattery), page).build())
            }
            ctx.getSystemService(NotificationManager::class.java).notify(NOTICE_ID, n.build())
        } catch (e: Exception) {
            ShroudlyVpnService.log("Could not post the notice: ${e.message}")
        }
    }
}
