package me.codeshare.shroudly

import android.app.Activity
import android.content.Intent
import android.os.Bundle

/*
 * Debug builds only (src/debug). adb cannot start a VPN service itself, so
 * scripts/emulator-smoke.sh starts this instead:
 *
 *   am start -n me.codeshare.shroudly/.DebugControlActivity --es cmd start|stop|stats
 *   am start -n me.codeshare.shroudly/.DebugControlActivity --es cmd test --es what engine-stop|tunnel-stop|path-check
 *
 * The VPN consent has to be granted first (appops ACTIVATE_VPN allow). "test"
 * makes one part fail while protection is on (ShroudlyVpnService.ACTION_TEST).
 */
class DebugControlActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        when (intent.getStringExtra("cmd")) {
            "start" -> ShroudlyVpnService.start(this)
            "stop" -> ShroudlyVpnService.stop(this)
            "stats" -> startService(Intent(this, ShroudlyVpnService::class.java).setAction(ShroudlyVpnService.ACTION_STATS))
            "test" -> startService(
                Intent(this, ShroudlyVpnService::class.java).setAction(ShroudlyVpnService.ACTION_TEST)
                    .putExtra("what", intent.getStringExtra("what")),
            )
            else -> ShroudlyVpnService.log("debug control: unknown command")
        }
        finish()
    }
}
