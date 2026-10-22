package me.codeshare.shroudly

import android.app.Activity
import android.content.Intent
import android.os.Bundle

/*
 * Debug builds only (src/debug). adb cannot start a VPN service itself, so
 * scripts/emulator-smoke.sh starts this instead:
 *
 *   am start -n me.codeshare.shroudly/.DebugControlActivity --es cmd start|stop|stats|report
 *   am start -n me.codeshare.shroudly/.DebugControlActivity --es cmd test --es what engine-stop|tunnel-stop|path-check
 *
 * The VPN consent has to be granted first (appops ACTIVATE_VPN allow). "test"
 * makes one part fail while protection is on (ShroudlyVpnService.ACTION_TEST).
 * "report" writes the head of what "Share logs" sends to logcat.
 * "adblock-on" / "adblock-off" set "Block ads and trackers".
 * "exclude" (extra "pkg", empty for none) sets "Apps that skip Shroudly".
 */
class DebugControlActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        when (intent.getStringExtra("cmd")) {
            "start" -> Protector.start(this)
            "stop" -> Protector.stop(this)
            // VPN or proxy only, as Settings sets it (extra "mode": "vpn" or "proxy").
            "mode" -> AppSettings.setProxyOnly(this, intent.getStringExtra("mode") == "proxy")
            // "Allow automation apps", as Settings sets it (extra "on": "true" or "false").
            "remote" -> AppSettings.setRemoteControl(this, intent.getStringExtra("on") == "true")
            "stats" -> Protector.tell(this, ShroudlyVpnService.ACTION_STATS)
            "test" -> Protector.tell(this, ShroudlyVpnService.ACTION_TEST, intent.getStringExtra("what"))
            // "Block ads and trackers" on or off, as the switch under About does.
            "adblock-on", "adblock-off" -> {
                AdBlock.setEnabled(this, intent.getStringExtra("cmd") == "adblock-on")
                Protector.tell(this, ShroudlyVpnService.ACTION_ADBLOCK)
            }
            // "Apps that skip Shroudly", as Settings sets it: one package, or none.
            "exclude" -> {
                val pkg = intent.getStringExtra("pkg")
                AppSettings.setExcluded(this, if (pkg.isNullOrEmpty()) emptySet() else setOf(pkg))
                startService(Intent(this, ShroudlyVpnService::class.java).setAction(ShroudlyVpnService.ACTION_SETTINGS).putExtra("what", "apps"))
            }
            "report" -> Diagnostics.report(this).lineSequence().takeWhile { it.isNotEmpty() }
                .forEach { android.util.Log.i("Shroudly", "report: $it") }
            else -> ShroudlyVpnService.log("debug control: unknown command")
        }
        finish()
    }
}
