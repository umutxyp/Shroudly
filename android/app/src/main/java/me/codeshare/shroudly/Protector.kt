package me.codeshare.shroudly

import android.content.Context
import android.content.Intent

/*
 * On and off for the window, the tile and the phone's start, in the mode
 * chosen in Settings: the VPN (ShroudlyVpnService, which needs the user's
 * VPN consent) or proxy only (ShroudlyProxyService, which never touches the
 * VPN and needs none).
 */
object Protector {
    /* The VPN's consent is asked for before a start (MainActivity). */
    fun needsVpnConsent(ctx: Context) = !AppSettings.proxyOnly(ctx)

    /* False: not started (the VPN is not allowed yet). */
    fun start(ctx: Context): Boolean {
        if (AppSettings.proxyOnly(ctx)) {
            ShroudlyProxyService.start(ctx)
            return true
        }
        return ShroudlyVpnService.start(ctx)
    }

    /* Stops whichever is running. */
    fun stop(ctx: Context) {
        if (Protection.proxyOnly) ShroudlyProxyService.stop(ctx) else ShroudlyVpnService.stop(ctx)
    }

    /* A setting for the running protection (ShroudlyVpnService.ACTION_ADBLOCK,
     * ACTION_SETTINGS): to whichever runs it. Nothing while off. */
    fun tell(ctx: Context, action: String, what: String? = null) {
        if (Protection.state == Protection.State.OFF) return
        val cls = if (Protection.proxyOnly) ShroudlyProxyService::class.java else ShroudlyVpnService::class.java
        try {
            ctx.startService(Intent(ctx, cls).setAction(action).apply { if (what != null) putExtra("what", what) })
        } catch (_: Exception) {
        }
    }
}
