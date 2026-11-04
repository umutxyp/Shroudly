package me.codeshare.shroudly

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.widget.RemoteViews

/*
 * The home-screen widget: whether protection is on, and a tap that switches
 * it, as the Quick Settings tile does (ShroudlyTileService). Where the VPN has
 * not been allowed yet, or "Block connections without VPN" asks for a
 * confirmation the widget cannot show, the tap opens the app instead. The
 * services call updateAll whenever protection changes.
 */
class ShroudlyWidget : AppWidgetProvider() {
    companion object {
        const val ACTION_TOGGLE = "me.codeshare.shroudly.WIDGET_TOGGLE"

        fun updateAll(ctx: Context) {
            try {
                val m = AppWidgetManager.getInstance(ctx) ?: return
                val ids = m.getAppWidgetIds(ComponentName(ctx, ShroudlyWidget::class.java))
                if (ids.isNotEmpty()) m.updateAppWidget(ids, views(Lang.wrap(ctx)))
            } catch (_: Exception) {
            }
        }

        private fun views(ctx: Context): RemoteViews {
            val on = Protection.state == Protection.State.ON || Protection.state == Protection.State.STARTING
            val v = RemoteViews(ctx.packageName, R.layout.widget)
            v.setTextViewText(
                R.id.widgetStatus,
                ctx.getString(
                    when (Protection.state) {
                        Protection.State.ON -> R.string.protected_
                        Protection.State.STARTING -> R.string.starting
                        Protection.State.STOPPING -> R.string.stopping
                        Protection.State.OFF -> R.string.notProtected
                    },
                ),
            )
            v.setInt(R.id.widgetIcon, "setColorFilter", if (on) Accent.swatch(ctx) else 0xFF8A8F98.toInt())
            v.setImageViewResource(R.id.widgetIcon, R.drawable.ic_power)
            val tap = Intent(ctx, ShroudlyWidget::class.java).setAction(ACTION_TOGGLE)
            v.setOnClickPendingIntent(
                R.id.widgetRoot,
                PendingIntent.getBroadcast(ctx, 7, tap, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT),
            )
            return v
        }
    }

    override fun onUpdate(ctx: Context, manager: AppWidgetManager, ids: IntArray) {
        manager.updateAppWidget(ids, views(Lang.wrap(ctx)))
    }

    override fun onReceive(ctx: Context, intent: Intent) {
        super.onReceive(ctx, intent)
        if (intent.action != ACTION_TOGGLE) return
        when (Protection.state) {
            Protection.State.ON ->
                if (Protection.lockdown && !Protection.proxyOnly) openApp(ctx, start = false) else Protector.stop(ctx)
            Protection.State.OFF -> {
                val allowed = try { Protector.start(ctx) } catch (_: Exception) { false }
                if (!allowed) openApp(ctx, start = true)
            }
            else -> {}
        }
        updateAll(ctx)
    }

    private fun openApp(ctx: Context, start: Boolean) {
        val i = Intent(ctx, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        if (start) i.putExtra(MainActivity.EXTRA_START, true)
        try { ctx.startActivity(i) } catch (_: Exception) {}
    }
}
