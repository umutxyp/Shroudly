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
import android.view.View
import android.view.WindowInsets
import android.widget.Button
import android.widget.ImageView
import android.widget.ProgressBar
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
    private lateinit var toggleIcon: ImageView
    private lateinit var progress: ProgressBar
    private lateinit var status: TextView
    private lateinit var detail: TextView
    private lateinit var detailMore: TextView
    private lateinit var action: Button
    private lateinit var connections: TextView
    private lateinit var upload: TextView
    private lateinit var download: TextView
    private lateinit var uptime: TextView
    private lateinit var statsHint: TextView
    private lateinit var update: View
    private lateinit var updateText: TextView

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
        setContentView(R.layout.activity_main)
        edgeToEdge()

        toggle = findViewById(R.id.toggle)
        toggleIcon = findViewById(R.id.toggleIcon)
        progress = findViewById(R.id.progress)
        status = findViewById(R.id.status)
        detail = findViewById(R.id.detail)
        detailMore = findViewById(R.id.detailMore)
        action = findViewById(R.id.action)
        connections = findViewById(R.id.connections)
        upload = findViewById(R.id.upload)
        download = findViewById(R.id.download)
        uptime = findViewById(R.id.uptime)
        statsHint = findViewById(R.id.statsHint)
        update = findViewById(R.id.update)
        updateText = findViewById(R.id.updateText)

        toggle.setOnClickListener { onToggle() }
        action.setOnClickListener { onToggle() }
        findViewById<TextView>(R.id.version).text = text(R.string.versionLabel, "version" to BuildConfig.VERSION_NAME)
        findViewById<View>(R.id.releases).setOnClickListener { open(UpdateCheck.RELEASES_URL) }
        findViewById<View>(R.id.notices).setOnClickListener { showNotices() }
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
        if (Protection.state == Protection.State.OFF) onToggle()
    }

    override fun onStart() {
        super.onStart()
        Protection.windowVisible = true
        ShroudlyVpnService.clearAlert(this)
        Protection.listen(onChange)
        main.post(ticker)
        showUpdate(UpdateCheck.remembered(this))
        if (UpdateCheck.due(this)) checkForUpdate()
    }

    override fun onStop() {
        Protection.windowVisible = false
        Protection.unlisten(onChange)
        main.removeCallbacks(ticker)
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
            ShroudlyVpnService.start(this)
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
            ShroudlyVpnService.start(this)
        } else {
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
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) toggle.stateDescription = statusText
        toggleIcon.setColorFilter(getColor(if (on) R.color.on_accent else R.color.text_dim))
        progress.visibility = if (busy) View.VISIBLE else View.GONE

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
                detail.setTextColor(getColor(R.color.danger))
                more = Protection.errorDetail != null
            }
            else -> {
                detail.show(if (on) getString(R.string.androidAllApps) else getString(R.string.dpiBypassStopped))
                detail.setTextColor(getColor(R.color.text_dim))
            }
        }
        detailMore.visibility = if (more) View.VISIBLE else View.GONE

        action.text = getString(if (on) R.string.stop else R.string.start)
        action.isEnabled = !busy
        action.alpha = if (busy) 0.5f else 1f

        val s = Protection.stats
        if (on && s != null) {
            val n = NumberFormat.getIntegerInstance()
            // Active now, then the session's total.
            connections.text = "${n.format(s.connsActive)}  ·  ${text(R.string.totalCount, "count" to n.format(s.connsTotal))}"
            upload.text = Format.bytes(s.bytesUp)
            download.text = Format.bytes(s.bytesDown)
            uptime.text = Format.duration(System.currentTimeMillis() - Protection.startedAt)
            statsHint.visibility = View.GONE
        } else {
            for (v in listOf(connections, upload, download, uptime)) v.text = "–"
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
