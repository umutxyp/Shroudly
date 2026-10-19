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
                // The VPN consent dialog needs the window; so does a start the
                // system does not allow from here.
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
        val intent = Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startActivityAndCollapse(PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_IMMUTABLE))
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
