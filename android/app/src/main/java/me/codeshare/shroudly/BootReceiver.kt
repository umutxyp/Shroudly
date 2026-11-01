package me.codeshare.shroudly

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/*
 * "Start when the phone starts" (Settings): protection comes on after a
 * restart of the phone, if the user turned that on and, in VPN mode, has
 * already allowed the VPN (ShroudlyVpnService.start does nothing otherwise;
 * proxy only needs no consent, Protector). Android's own
 * Always-on VPN does the same from the system's settings; this is for those
 * who have not set it.
 *
 * Without that setting, protection still comes back if it was on when the
 * phone restarted (KeepOn.booted): a restart is not the user turning it off.
 *
 * And after an update of Shroudly itself (from Google Play, inside the app or
 * by itself, or a new APK over it), which ends the app and protection with
 * it: protection comes back if it was on (KeepOn.updated).
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED -> {
                if (!AppSettings.startAtBoot(context)) { KeepOn.booted(Lang.wrap(context)); return }
                ShroudlyVpnService.attachLog(context)
                if (Protector.start(context)) ShroudlyVpnService.log("Started when the phone started (Settings)")
            }
            Intent.ACTION_MY_PACKAGE_REPLACED -> KeepOn.updated(Lang.wrap(context))
        }
    }
}
