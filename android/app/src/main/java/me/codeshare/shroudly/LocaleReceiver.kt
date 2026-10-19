package me.codeshare.shroudly

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/* The system language changed: the notification channels' names, shown in
 * the app's notification settings, follow it. */
class LocaleReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_LOCALE_CHANGED) ShroudlyVpnService.channels(context)
    }
}
