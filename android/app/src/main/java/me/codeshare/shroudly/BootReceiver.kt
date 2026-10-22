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
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        if (!AppSettings.startAtBoot(context)) return
        ShroudlyVpnService.attachLog(context)
        if (Protector.start(context)) ShroudlyVpnService.log("Started when the phone started (Settings)")
    }
}
