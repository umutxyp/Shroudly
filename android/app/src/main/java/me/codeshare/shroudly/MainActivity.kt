package me.codeshare.shroudly

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.net.Uri
import android.net.VpnService
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.View
import android.view.WindowInsets
import android.widget.ImageView
import android.widget.ScrollView
import android.widget.TextView
import java.text.NumberFormat

/* The one window: a switch, what it is doing, live counters, and About. */
class MainActivity : Activity() {
    companion object {
        private const val REQUEST_VPN = 1
        private const val REQUEST_NOTIFICATIONS = 2
        /* Start protection as soon as the window is up (from the tile). */
        const val EXTRA_START = "start"
    }

    private lateinit var toggle: View
    private lateinit var orb: Orb
    private lateinit var status: TextView
    private lateinit var detail: TextView
    private lateinit var detailMore: TextView
    private lateinit var hint: View
    private lateinit var hintLabel: TextView
    private lateinit var connections: TextView
    private lateinit var connectionsTotal: TextView
    private lateinit var upload: TextView
    private lateinit var download: TextView
    private lateinit var uptime: TextView
    private lateinit var statsHint: View
    private lateinit var update: View
    private lateinit var updateText: TextView
    private lateinit var releases: View
    private lateinit var releasesLabel: TextView
    private lateinit var releasesIcon: ImageView
    private lateinit var battery: View

    private val main = Handler(Looper.getMainLooper())
    private val onChange: () -> Unit = { render() }
    private val ticker = object : Runnable {
        override fun run() {
            render()
            main.postDelayed(this, 1000)
        }
    }
    private var updateUrl: String? = null
    private var vpnDenied = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        ShroudlyVpnService.attachLog(this)
        setContentView(R.layout.activity_main)
        edgeToEdge()

        toggle = findViewById(R.id.toggle)
        orb = Orb(findViewById(R.id.halo), findViewById(R.id.ring), findViewById(R.id.toggleIcon))
        status = findViewById(R.id.status)
        detail = findViewById(R.id.detail)
        detailMore = findViewById(R.id.detailMore)
        hint = findViewById(R.id.hint)
        hintLabel = findViewById(R.id.hintLabel)
        connections = findViewById(R.id.connections)
        connectionsTotal = findViewById(R.id.connectionsTotal)
        upload = findViewById(R.id.upload)
        download = findViewById(R.id.download)
        uptime = findViewById(R.id.uptime)
        statsHint = findViewById(R.id.statsHint)
        update = findViewById(R.id.update)
        updateText = findViewById(R.id.updateText)
        releases = findViewById(R.id.releases)
        releasesLabel = findViewById(R.id.releasesLabel)
        releasesIcon = findViewById(R.id.releasesIcon)
        battery = findViewById(R.id.battery)
        // The rows' ripples stay inside the card's rounded corners.
        findViewById<View>(R.id.about).clipToOutline = true

        // The logo's circle is the switch, the one control for on and off.
        toggle.setOnClickListener { onToggle() }
        findViewById<TextView>(R.id.version).text = text(R.string.versionLabel, "version" to BuildConfig.VERSION_NAME)
        findViewById<View>(R.id.notices).setOnClickListener { showNotices() }
        findViewById<View>(R.id.privacy).setOnClickListener { open(UpdateCheck.PRIVACY_URL) }
        findViewById<View>(R.id.shareLogs).setOnClickListener { shareLogs() }
        findViewById<View>(R.id.batteryOpen).setOnClickListener { openBatterySettings() }
        findViewById<View>(R.id.updateOpen).setOnClickListener { updateUrl?.let { open(it) } }
        detailMore.setOnClickListener { showDetail() }
        // The channels' names follow the language, also after a per-app
        // language change (which recreates this window).
        ShroudlyVpnService.channels(this)
        if (savedInstanceState == null) handleStart(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleStart(intent)
    }

    private fun handleStart(intent: Intent?) {
        if (intent?.getBooleanExtra(EXTRA_START, false) != true) return
        intent.removeExtra(EXTRA_START)
        // Reopened from Recents (Android 8 to 11 hand back the tile's original
        // intent, extra included): the user did not ask to start again.
        if (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return
        if (Protection.state == Protection.State.OFF) onToggle()
    }

    override fun onStart() {
        super.onStart()
        Protection.windowVisible = true
        ShroudlyVpnService.clearAlert(this)
        Protection.listen(onChange)
        orb.resume()
        main.post(ticker)
        showBatteryHint()
        // The APK from GitHub links its releases and looks for a newer one
        // there; a copy Google Play updates links the source code instead and
        // asks GitHub nothing (InstallSource).
        val github = InstallSource.githubUpdates(this)
        if (BuildConfig.DEBUG) ShroudlyVpnService.log("Updates: ${if (github) "GitHub" else "Google Play"}")
        releasesLabel.setText(if (github) R.string.linkReleases else R.string.linkSourceCode)
        releasesIcon.setImageResource(if (github) R.drawable.ic_file_text else R.drawable.ic_code)
        releases.setOnClickListener { open(if (github) UpdateCheck.RELEASES_URL else UpdateCheck.REPO_URL) }
        if (github) {
            showUpdate(UpdateCheck.remembered(this))
            if (UpdateCheck.due(this)) checkForUpdate()
        } else {
            showUpdate(null)
        }
    }

    override fun onStop() {
        Protection.windowVisible = false
        Protection.unlisten(onChange)
        main.removeCallbacks(ticker)
        orb.pause()
        super.onStop()
    }

    /* Android 15 draws every window edge to edge; earlier ones are asked to,
     * from 11, and the content keeps clear of the bars either way. */
    private fun edgeToEdge() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.VANILLA_ICE_CREAM) {
            @Suppress("DEPRECATION")
            window.setDecorFitsSystemWindows(false)
        }
        val root = findViewById<ScrollView>(R.id.root)
        root.setOnApplyWindowInsetsListener { v, insets ->
            val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
    }

    /* ── on and off ────────────────────────────────────────────────────── */

    private fun onToggle() {
        when (Protection.state) {
            Protection.State.ON -> ShroudlyVpnService.stop(this)
            Protection.State.OFF -> {
                vpnDenied = false
                Protection.clearError()
                ShroudlyVpnService.clearAlert(this)
                askNotificationsThenStart()
            }
            else -> {}
        }
    }

    /* The notification is how the user sees protection is on and stops it
     * from anywhere; asked for once, and starting does not wait on the answer. */
    private fun askNotificationsThenStart() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED &&
            !getSharedPreferences("ui", MODE_PRIVATE).getBoolean("askedNotifications", false)
        ) {
            getSharedPreferences("ui", MODE_PRIVATE).edit().putBoolean("askedNotifications", true).apply()
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST_NOTIFICATIONS)
            return
        }
        startWithConsent()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQUEST_NOTIFICATIONS) startWithConsent()
    }

    private fun startWithConsent() {
        val consent = try {
            VpnService.prepare(this)
        } catch (e: Exception) {
            null
        }
        if (consent == null) {
            startService()
        } else {
            try {
                @Suppress("DEPRECATION")
                startActivityForResult(consent, REQUEST_VPN)
            } catch (e: ActivityNotFoundException) {
                vpnDenied = true
                render()
            }
        }
    }

    @Deprecated("Activity result API of the framework")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQUEST_VPN) return
        if (resultCode == RESULT_OK) {
            startService()
        } else {
            vpnDenied = true
            render()
        }
    }

    /* The service starts only once the VPN is allowed (see ShroudlyVpnService.start). */
    private fun startService() {
        if (!ShroudlyVpnService.start(this)) {
            vpnDenied = true
            render()
        }
    }

    /* ── what is shown ─────────────────────────────────────────────────── */

    @SuppressLint("SetTextI18n")
    private fun render() {
        val st = Protection.state
        val on = st == Protection.State.ON
        val busy = st == Protection.State.STARTING || st == Protection.State.STOPPING

        val statusText = getString(
            when (st) {
                Protection.State.ON -> R.string.protected_
                Protection.State.STARTING -> R.string.starting
                Protection.State.STOPPING -> R.string.stopping
                Protection.State.OFF -> R.string.notProtected
            },
        )
        toggle.isActivated = on
        toggle.isEnabled = !busy
        toggle.contentDescription = getString(
            when (st) {
                Protection.State.ON -> R.string.stop
                Protection.State.STARTING -> R.string.starting
                Protection.State.STOPPING -> R.string.stopping
                Protection.State.OFF -> R.string.start
            },
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && toggle.stateDescription?.toString() != statusText) {
            toggle.stateDescription = statusText
        }
        orb.set(if (busy) Orb.Mode.BUSY else if (on) Orb.Mode.ON else Orb.Mode.OFF)

        // Set only when it changes: status and detail are live regions, and
        // TalkBack reads every change out.
        status.show(statusText)
        status.setTextColor(getColor(if (on) R.color.accent else R.color.text))

        val error = Protection.errorRes
        var more = false
        when {
            vpnDenied && st == Protection.State.OFF -> {
                detail.show(getString(R.string.androidVpnDenied))
                detail.setTextColor(getColor(R.color.warn))
            }
            error != 0 && st == Protection.State.OFF -> {
                // In the user's language; the technical words behind "Details".
                detail.show(getString(error))
                detail.setTextColor(getColor(R.color.warn))
                more = Protection.errorDetail != null
            }
            else -> {
                detail.show(if (on) getString(R.string.androidAllApps) else getString(R.string.dpiBypassStopped))
                detail.setTextColor(getColor(R.color.text_dim))
            }
        }
        detailMore.visibility = if (more) View.VISIBLE else View.GONE

        // Under the status, what a tap on the switch does; nothing while it works.
        if (!busy) hintLabel.show(getString(if (on) R.string.stop else R.string.start))
        hint.visibility = if (busy) View.INVISIBLE else View.VISIBLE

        val s = Protection.stats
        if (on && s != null) {
            val n = NumberFormat.getIntegerInstance()
            // Active now, and the session's total under it.
            connections.show(n.format(s.connsActive))
            connectionsTotal.show(text(R.string.totalCount, "count" to n.format(s.connsTotal)))
            upload.show(Format.bytes(s.bytesUp))
            download.show(Format.bytes(s.bytesDown))
            uptime.show(Format.duration(System.currentTimeMillis() - Protection.startedAt))
            statsHint.visibility = View.GONE
        } else {
            // Set only when it changes: the window redraws every second, and a
            // text set again is announced to accessibility services again.
            for (v in listOf(connections, upload, download, uptime)) v.show("–")
            connectionsTotal.show(text(R.string.totalCount, "count" to "–"))
            statsHint.visibility = if (on) View.GONE else View.VISIBLE
        }
    }

    /* ── about and updates ─────────────────────────────────────────────── */

    private fun checkForUpdate() {
        val port = Protection.socksPort
        val auth = Protection.socksAuth
        Thread({
            val offer = try {
                UpdateCheck.check(applicationContext, port, auth)
            } catch (e: Exception) {
                ShroudlyVpnService.log("Update check failed: ${e.message}")
                return@Thread
            }
            main.post { showUpdate(offer) }
        }, "update-check").apply { isDaemon = true }.start()
    }

    private fun showUpdate(offer: UpdateCheck.Offer?) {
        if (offer == null) {
            update.visibility = View.GONE
            return
        }
        updateUrl = offer.url
        updateText.text = text(R.string.updAvailable, "version" to offer.version)
        update.visibility = View.VISIBLE
    }

    /* ── battery and logs ──────────────────────────────────────────────── */

    /* Asked each time the window comes back: the user may just have changed
     * the setting. */
    private fun showBatteryHint() {
        val b = Diagnostics.battery(this)
        battery.visibility = if (Diagnostics.batteryHint(b, Build.MANUFACTURER, Build.BRAND)) View.VISIBLE else View.GONE
    }

    /* The app's own page in Settings: every Android version and every phone
     * maker has its battery setting there ("Battery", "App battery usage",
     * "Battery saver"), where the user can choose no restrictions. No
     * permission is needed for it, unlike asking Android to exempt the app
     * directly. */
    private fun openBatterySettings() {
        val details = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null))
        try {
            startActivity(details)
        } catch (_: ActivityNotFoundException) {
            try { startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) } catch (_: ActivityNotFoundException) {}
        }
    }

    /* The recent log and the phone's details, as text the user sends where
     * they choose (Diagnostics). */
    private fun shareLogs() {
        val text = try { Diagnostics.report(this) } catch (e: Exception) { "Shroudly ${BuildConfig.VERSION_NAME}: no report ($e)" }
        val send = Intent(Intent.ACTION_SEND)
            .setType("text/plain")
            .putExtra(Intent.EXTRA_SUBJECT, "Shroudly ${BuildConfig.VERSION_NAME} log")
            .putExtra(Intent.EXTRA_TEXT, text)
        try {
            startActivity(Intent.createChooser(send, getString(R.string.androidShareLogs)))
        } catch (_: ActivityNotFoundException) {
        }
    }

    private fun TextView.show(s: CharSequence) {
        if (text.toString() != s.toString()) text = s
    }

    /* What went wrong, in the engine's and Android's own words (English). */
    private fun showDetail() {
        val more = Protection.errorDetail ?: return
        val body = TextView(this).apply {
            text = more
            setTextColor(getColor(R.color.text_dim))
            textSize = 13f
            typeface = Typeface.MONOSPACE
            textDirection = View.TEXT_DIRECTION_LTR
            setTextIsSelectable(true)
            val pad = (20 * resources.displayMetrics.density).toInt()
            setPadding(pad, pad / 2, pad, pad)
        }
        AlertDialog.Builder(this)
            .setTitle(R.string.androidDetails)
            .setView(ScrollView(this).apply { addView(body) })
            .setPositiveButton(android.R.string.ok, null)
            .show()
    }

    @SuppressLint("SetTextI18n")
    private fun showNotices() {
        val notices = resources.openRawResource(R.raw.notices).bufferedReader().use { it.readText() }
        val body = TextView(this).apply {
            text = getString(R.string.openSourceDesc) + "\n\n" + notices
            setTextColor(getColor(R.color.text_dim))
            textSize = 12f
            typeface = Typeface.MONOSPACE
            setTextIsSelectable(true)
            val pad = (20 * resources.displayMetrics.density).toInt()
            setPadding(pad, pad / 2, pad, pad)
        }
        AlertDialog.Builder(this)
            .setTitle(R.string.openSourceTitle)
            .setView(ScrollView(this).apply { addView(body) })
            .setPositiveButton(android.R.string.ok, null)
            .show()
    }

    private fun open(url: String) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        } catch (_: ActivityNotFoundException) {
        }
    }
}
