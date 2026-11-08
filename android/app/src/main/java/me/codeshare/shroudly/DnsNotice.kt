package me.codeshare.shroudly

import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.widget.Toast

/*
 * Apps' name lookups go around Shroudly (the engine's "dns_around": their
 * connections keep coming by address, none by name): Android's Private DNS
 * set to a server's name, or a DNS app. Blocked apps then get that server's
 * answers. Said once while protection is on: a notification on a phone or
 * tablet that opens Android's network settings, a message on the screen on a
 * TV, which shows no notifications from apps.
 */
object DnsNotice {
    // 10 and 11 are the APK's update notices, 12 TorNotice's.
    private const val ID = 13

    fun around(ctx: Context) {
        Protection.dnsAround = true
        val text = ctx.getString(R.string.dnsAroundAndroid)
        if (Tv.isTv(ctx)) {
            Handler(Looper.getMainLooper()).post {
                try { Toast.makeText(ctx.applicationContext, text, Toast.LENGTH_LONG).show() } catch (_: Exception) {}
            }
            return
        }
        try {
            ShroudlyVpnService.channels(ctx)
            val open = android.app.PendingIntent.getActivity(
                ctx, 13, Intent(android.provider.Settings.ACTION_WIRELESS_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                android.app.PendingIntent.FLAG_IMMUTABLE or android.app.PendingIntent.FLAG_UPDATE_CURRENT,
            )
            val n = Notification.Builder(ctx, ShroudlyVpnService.ALERT_CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_logo)
                .setContentTitle(ctx.getString(R.string.app_name))
                .setContentText(text)
                .setStyle(Notification.BigTextStyle().bigText(text))
                .setContentIntent(open)
                .setAutoCancel(true)
                .setColor(Accent.swatch(ctx))
                .build()
            ctx.getSystemService(NotificationManager::class.java).notify(ID, n)
        } catch (_: Exception) {}
    }
}
