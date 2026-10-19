package me.codeshare.shroudly

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Intent
import android.net.VpnService
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService

/* A Quick Settings tile that switches protection on and off. */
class ShroudlyTileService : TileService() {
    private val onChange: () -> Unit = { refresh() }

    override fun onStartListening() {
        Protection.listen(onChange)
        refresh()
    }

    override fun onStopListening() {
        Protection.unlisten(onChange)
    }

    override fun onClick() {
        when (Protection.state) {
            Protection.State.ON -> ShroudlyVpnService.stop(this)
            Protection.State.OFF -> {
                // With the VPN allowed already, protection starts from here.
                // Otherwise the window opens and asks at once (the consent
                // dialog needs it); so it does when the system does not allow
                // a start from here.
                val allowed = VpnService.prepare(this) == null && try {
                    ShroudlyVpnService.start(this)
                    true
                } catch (_: Exception) {
                    false
                }
                if (!allowed) openApp()
            }
            else -> {}
        }
    }

    @SuppressLint("StartActivityAndCollapseDeprecated")
    private fun openApp() {
        val intent = Intent(this, MainActivity::class.java)
            .putExtra(MainActivity.EXTRA_START, true)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            // Its own request code, so the notification's intent (no extra) is not reused.
            startActivityAndCollapse(
                PendingIntent.getActivity(this, 3, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT),
            )
        } else {
            @Suppress("DEPRECATION")
            startActivityAndCollapse(intent)
        }
    }

    private fun refresh() {
        val tile = qsTile ?: return
        tile.state = when (Protection.state) {
            Protection.State.ON -> Tile.STATE_ACTIVE
            Protection.State.OFF -> Tile.STATE_INACTIVE
            else -> Tile.STATE_UNAVAILABLE
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            tile.subtitle = getString(
                when (Protection.state) {
                    Protection.State.ON -> R.string.protected_
                    Protection.State.STARTING -> R.string.starting
                    Protection.State.STOPPING -> R.string.stopping
                    Protection.State.OFF -> R.string.notProtected
                },
            )
        }
        tile.updateTile()
    }
}
