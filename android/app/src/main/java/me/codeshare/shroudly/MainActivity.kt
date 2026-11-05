package me.codeshare.shroudly

import android.content.Context
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
import android.os.SystemClock
import android.os.UserManager
import android.provider.Settings
import android.view.View
import android.view.WindowInsets
import android.widget.Button
import android.widget.ImageView
import android.widget.ScrollView
import android.widget.TextView
import java.text.NumberFormat

/* The one window: a switch, what it is doing, live counters, and About. */
class MainActivity : Activity() {
    companion object {
        private const val REQUEST_VPN = 1
        private const val REQUEST_NOTIFICATIONS = 2
        // Asked again from the notice that notifications are off.
        private const val REQUEST_NOTIFICATIONS_AGAIN = 3
        // When "Not now" was pressed on each notice ("ui" preferences).
        private const val KEY_BATTERY_LATER = "batteryLater"
        private const val KEY_NOTIFICATIONS_LATER = "notificationsLater"
        // How long the window has been up before a store card may show.
        private const val STORE_CARD_AFTER_MS = 3000L
        /* Start protection as soon as the window is up (from the tile). */
        const val EXTRA_START = "start"
        /* Install the update Google Play has downloaded (PlayUpdates' notice). */
        const val EXTRA_INSTALL_UPDATE = "installUpdate"
        /* The notification's Stop under lockdown: asked here first (confirmStop). */
        const val EXTRA_CONFIRM_STOP = "confirmStop"
        /* The suggestion's notification (StoreCards.look): its card, shown. */
        const val EXTRA_STORE_CARD = "storeCard"
        /* The notification of an update found in the background (ApkUpdates):
         * it is downloaded and installed. */
        const val EXTRA_UPDATE = "update"
        // Networks' proxies on this phone found not running, told once a run (ProxyCheck).
        private val deadProxyTold = HashSet<String>()
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
    private lateinit var onlineNow: TextView
    private lateinit var update: View
    private lateinit var updateText: TextView
    private lateinit var releases: View
    private lateinit var releasesLabel: TextView
    private lateinit var releasesIcon: ImageView
    private lateinit var notice: View
    private lateinit var noticeIcon: ImageView
    private lateinit var noticeText: TextView
    private lateinit var noticeOpen: Button
    // The notice on screen (showNotice): R.string.androidBatterySettings for
    // the battery's, R.string.showNotifications for notifications', or 0.
    private var noticeShown = 0
    private lateinit var support: View
    private var supportDue = false
    // The card asking whether the user would like to help (HelpNudge).
    private lateinit var helpCard: View
    private var helpDue = false
    // What changed in this version, shown once after an update (WhatsNew).
    private var whatsNewOpen = false
    private lateinit var storeCard: View
    // The store card on screen (StoreCards.RATE), or null; what it goes by,
    // as of onStart; and when the window came (uptime): the other cards
    // have their say first.
    private var storeShown: String? = null
    // The card a tap on the suggestion's notification asked for.
    private var storeAsked: String? = null
    private var fromPlay = false
    private var playStore = false
    // The phone's country (Country), as of onStart: the store cards only
    // where the listing is there for it.
    private var country: String? = null
    private var installedAt = 0L
    private var workedDays = 0
    private var startedAt = 0L

    private val main = Handler(Looper.getMainLooper())
    private val onChange: () -> Unit = { render() }
    private val ticker = object : Runnable {
        override fun run() {
            render()
            // Proxy only: whether a network's proxy is set to it, now and then.
            if (++ticks % 3 == 0) checkProxyUse()
            main.postDelayed(this, 1000)
        }
    }
    private var updateUrl: String? = null
    private var updateVersion: String? = null
    // Asked for from the update's notification: started once the card is up.
    private var updateAsked = false
    private var vpnDenied = false
    // Android would not ask for the VPN at all (another app's always-on VPN,
    // or VPN changes not allowed on this phone): see onActivityResult.
    private var vpnBlocked = false
    // The VPN's consent asked for (uptime), and whether its dialog took the
    // window's focus, as a dialog the user answers does.
    private var consentAskedAt = 0L
    private var consentSeen = false
    private var installUpdate = false
    // What protection covers in VPN mode (Coverage), as of onStart.
    private var coverage = ""
    // Proxy only: a network's proxy is set to its port (null: not known).
    private var proxySet: Boolean? = null
    private var proxyChecking = false
    private var ticks = 0

    /* The accent this window was made with; another one chosen in Settings
     * makes it again on return. */
    private var accentShown = ""
    private var langShown: String? = null

    // In the language chosen in Settings (Lang; before Android 13).
    override fun attachBaseContext(base: Context) = super.attachBaseContext(Lang.wrap(base))

    override fun onCreate(savedInstanceState: Bundle?) {
        Accent.apply(this)
        accentShown = Accent.id(this)
        langShown = Lang.chosen(this)
        super.onCreate(savedInstanceState)
        ShroudlyVpnService.attachLog(this)
        setContentView(R.layout.activity_main)
        edgeToEdge()
        Tv.rings(window)

        toggle = findViewById(R.id.toggle)
        orb = Orb(findViewById(R.id.halo), findViewById(R.id.ring), findViewById(R.id.toggleIcon))
        status = findViewById(R.id.status)
        detail = findViewById(R.id.detail)
        detailMore = findViewById(R.id.detailMore)
        hint = findViewById(R.id.hint)
        hintLabel = findViewById(R.id.hintLabel)
        connections = findViewById(R.id.connections)
        // Connections by site, with blocking (issue #74).
        findViewById<View>(R.id.connectionsTile).setOnClickListener { startActivity(android.content.Intent(this, ConnectionsActivity::class.java)) }
        connectionsTotal = findViewById(R.id.connectionsTotal)
        upload = findViewById(R.id.upload)
        download = findViewById(R.id.download)
        uptime = findViewById(R.id.uptime)
        statsHint = findViewById(R.id.statsHint)
        onlineNow = findViewById(R.id.onlineNow)
        update = findViewById(R.id.update)
        updateText = findViewById(R.id.updateText)
        releases = findViewById(R.id.releases)
        releasesLabel = findViewById(R.id.releasesLabel)
        releasesIcon = findViewById(R.id.releasesIcon)
        notice = findViewById(R.id.notice)
        noticeIcon = findViewById(R.id.noticeIcon)
        noticeText = findViewById(R.id.noticeText)
        noticeOpen = findViewById(R.id.noticeOpen)
        support = findViewById(R.id.support)
        helpCard = findViewById(R.id.helpCard)
        storeCard = findViewById(R.id.storeCard)
        // The rows' ripples stay inside the card's rounded corners.
        findViewById<View>(R.id.about).clipToOutline = true
        Fit.apply(findViewById(R.id.root))

        // The logo's circle is the switch, the one control for on and off;
        // the line under it, which reads like a link, does the same.
        toggle.setOnClickListener { onToggle() }
        hint.setOnClickListener { onToggle() }
        findViewById<TextView>(R.id.version).text = text(R.string.versionLabel, "version" to BuildConfig.VERSION_NAME)
        findViewById<View>(R.id.notices).setOnClickListener { showNotices() }
        findViewById<View>(R.id.privacy).setOnClickListener { open(UpdateCheck.PRIVACY_URL) }
        findViewById<View>(R.id.website).setOnClickListener { open("https://codeshare.me") }
        findViewById<View>(R.id.shareLogs).setOnClickListener { shareLogs() }
        findViewById<View>(R.id.helpOthers).setOnClickListener { showHelpOthers() }
        // "Share Shroudly": the APK to another phone, where there is one file to pass on.
        val apk = ApkShare.available(this)
        findViewById<View>(R.id.shareApp).apply { visibility = if (apk) View.VISIBLE else View.GONE; setOnClickListener { ApkShare.share(this@MainActivity) } }
        findViewById<View>(R.id.shareAppDivider).visibility = if (apk) View.VISIBLE else View.GONE
        // Settings: the gear at the top, and the row under About.
        val settings = View.OnClickListener { startActivity(Intent(this, SettingsActivity::class.java)) }
        findViewById<View>(R.id.settings).setOnClickListener(settings)
        findViewById<View>(R.id.settingsTop).setOnClickListener(settings)
        noticeOpen.setOnClickListener {
            if (noticeShown == R.string.androidBatterySettings) openBatterySettings() else openNotificationSettings()
        }
        findViewById<View>(R.id.noticeLater).setOnClickListener {
            val key = if (noticeShown == R.string.androidBatterySettings) KEY_BATTERY_LATER else KEY_NOTIFICATIONS_LATER
            getSharedPreferences("ui", MODE_PRIVATE).edit().putLong(key, System.currentTimeMillis()).apply()
            noticeShown = 0
            notice.visibility = View.GONE
        }
        findViewById<View>(R.id.updateOpen).setOnClickListener { updateApk() }
        findViewById<View>(R.id.supportRow).setOnClickListener { openSupport() }
        findViewById<View>(R.id.followRow).setOnClickListener { startActivity(android.content.Intent(this, FollowActivity::class.java)) }
        findViewById<View>(R.id.supportOpen).setOnClickListener { openSupport() }
        findViewById<View>(R.id.supportLater).setOnClickListener {
            Support.rest(this)
            supportDue = false
            support.visibility = View.GONE
        }
        findViewById<View>(R.id.helpLater).setOnClickListener {
            HelpNudge.refused(this)
            helpDue = false
            helpCard.visibility = View.GONE
        }
        findViewById<View>(R.id.helpShow).setOnClickListener {
            HelpNudge.accepted(this)
            helpDue = false
            helpCard.visibility = View.GONE
            showHelpOthers()
        }
        detailMore.setOnClickListener { showDetail() }
        findViewById<View>(R.id.storeOpen).setOnClickListener {
            val key = storeShown ?: return@setOnClickListener
            // Done: never again.
            StoreCards.save(this, key, StoreCards.load(this, key).copy(done = true))
            hideStoreCard()
            Stores.openPlay(this)
        }
        // Counted as a "no" when it was shown; it only goes away here.
        findViewById<View>(R.id.storeLater).setOnClickListener { hideStoreCard() }
        // The channels' names follow the language, also after a per-app
        // language change (which recreates this window).
        ShroudlyVpnService.channels(this)
        if (savedInstanceState == null) {
            handleStart(intent)
            handleInstall(intent)
            handleConfirmStop(intent)
            handleStoreCard(intent)
            handleUpdate(intent)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleStart(intent)
        handleInstall(intent)
        handleConfirmStop(intent)
        handleStoreCard(intent)
        handleUpdate(intent)
    }

    private fun handleUpdate(intent: Intent?) {
        if (intent?.getBooleanExtra(EXTRA_UPDATE, false) != true) return
        intent.removeExtra(EXTRA_UPDATE)
        if (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return
        updateAsked = true
    }

    private fun handleStoreCard(intent: Intent?) {
        val key = intent?.getStringExtra(EXTRA_STORE_CARD) ?: return
        intent.removeExtra(EXTRA_STORE_CARD)
        if (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return
        if (key == StoreCards.MOVE) storeAsked = key
    }

    /* The notification's Stop under lockdown (ShroudlyVpnService.goForeground). */
    private fun handleConfirmStop(intent: Intent?) {
        if (intent?.getBooleanExtra(EXTRA_CONFIRM_STOP, false) != true) return
        intent.removeExtra(EXTRA_CONFIRM_STOP)
        if (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return
        if (Protection.state == Protection.State.ON) confirmStop()
    }

    private fun handleStart(intent: Intent?) {
        if (intent?.getBooleanExtra(EXTRA_START, false) != true) return
        intent.removeExtra(EXTRA_START)
        // Reopened from Recents (Android 8 to 11 hand back the tile's original
        // intent, extra included): the user did not ask to start again.
        if (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return
        if (Protection.state == Protection.State.OFF) onToggle()
    }

    /* From PlayUpdates' notice: installed once the window is in front. */
    private fun handleInstall(intent: Intent?) {
        if (intent?.getBooleanExtra(EXTRA_INSTALL_UPDATE, false) != true) return
        intent.removeExtra(EXTRA_INSTALL_UPDATE)
        if (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return
        installUpdate = true
    }

    override fun onStart() {
        super.onStart()
        if (Accent.id(this) != accentShown || Lang.chosen(this) != langShown) { recreate(); return }
        Protection.windowVisible = true
        ShroudlyVpnService.clearAlert(this)
        ShroudlyProxyService.clearAlert(this)
        Protection.listen(onChange)
        orb.resume()
        coverage = Coverage.text(this)
        proxySet = null
        checkProxyUse()
        main.post(ticker)
        Usage.windowSeen(this)
        showNotice()
        // Is Shroudly on Google Play (stores.json): asked now and then.
        Stores.refreshIfDue(this, Protection.socksPort, Protection.socksAuth)
        fromPlay = StoreCards.fromPlay(InstallSource.installer(this))
        playStore = !fromPlay && StoreCards.playStoreInstalled(this)
        country = Country.of(this)
        // Seen: the suggestion's notification, if any, has had its turn.
        StoreCards.clearNotice(this)
        installedAt = Usage.installedAt(this)
        workedDays = Usage.days(this)
        startedAt = SystemClock.uptimeMillis()
        checkNetworkProxy()
        val offered = Support.offered(this)
        findViewById<View>(R.id.supportRow).visibility = if (offered) View.VISIBLE else View.GONE
        findViewById<View>(R.id.supportDivider).visibility = if (offered) View.VISIBLE else View.GONE
        supportDue = try { Support.cardDue(this) } catch (_: Exception) { false }
        helpDue = try { HelpNudge.due(this) } catch (_: Exception) { false }
        val news = try { WhatsNew.pending(this) } catch (_: Exception) { null }
        if (news != null) showWhatsNew(news)
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
            if (updateAsked) { updateAsked = false; updateApk() }
            if (UpdateCheck.due(this)) checkForUpdate()
        } else {
            // Google Play's own offer, if any, comes in onResume (PlayUpdates).
            showUpdate(null)
        }
    }

    override fun onResume() {
        super.onResume()
        // Back from "install unknown apps": the update goes on if allowed.
        ApkUpdates.resume(this)
        if (installUpdate) { installUpdate = false; PlayUpdates.install(this); return }
        // A copy Google Play updates: Play's in-app update (PlayUpdates; the
        // APK's does nothing). Every time the window comes back, as Play asks,
        // so an update left half way is taken up again; Play's dialog not
        // while protection is starting or stopping.
        PlayUpdates.resume(this, mayAsk = {
            val st = Protection.state
            !isFinishing && (st == Protection.State.OFF || st == Protection.State.ON)
        }) { card ->
            runOnUiThread { if (!isFinishing && !isDestroyed) showPlayUpdate(card) }
        }
    }

    override fun onPause() {
        PlayUpdates.pause()
        super.onPause()
    }

    override fun onStop() {
        // Shown once in this run of the app; it does not come back with the window.
        if (storeShown != null) hideStoreCard()
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
            Protection.State.ON -> if (Protection.lockdown && !Protection.proxyOnly) confirmStop() else Protector.stop(this)
            Protection.State.OFF -> {
                vpnDenied = false
                vpnBlocked = false
                Protection.clearError()
                ShroudlyVpnService.clearAlert(this)
                ShroudlyProxyService.clearAlert(this)
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
        if (requestCode == REQUEST_NOTIFICATIONS_AGAIN) showNotice()
    }

    private fun startWithConsent() {
        // Proxy only: no VPN, so no consent to ask for (asking would end
        // another VPN app's connection).
        if (!Protector.needsVpnConsent(this)) { startService(); return }
        val consent = try {
            VpnService.prepare(this)
        } catch (e: Exception) {
            null
        }
        if (consent == null) {
            startService()
            return
        }
        // Another VPN app is on: Android ends it once Shroudly's VPN is
        // allowed, and its own dialog does not say so. Said first, with the
        // way to keep it (NA-5).
        if (otherVpnOn()) {
            try {
                AlertDialog.Builder(this)
                    .setMessage(R.string.androidOtherVpn)
                    .setPositiveButton(R.string.androidContinue) { _, _ -> askConsent(consent) }
                    .setNeutralButton(R.string.androidUseProxyOnly) { _, _ -> useProxyOnly() }
                    .setNegativeButton(android.R.string.cancel, null)
                    .show()
                return
            } catch (_: Exception) {}
        }
        askConsent(consent)
    }

    private fun askConsent(consent: Intent) {
        try {
            consentAskedAt = SystemClock.elapsedRealtime()
            consentSeen = false
            @Suppress("DEPRECATION")
            startActivityForResult(consent, REQUEST_VPN)
        } catch (e: ActivityNotFoundException) {
            // No dialog to ask with on this phone: Android's refusal too.
            consentAskedAt = 0
            vpnBlocked = true
            render()
            showVpnBlocked()
        }
    }

    /* The VPN's dialog took the focus: the user saw it. */
    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (!hasFocus && consentAskedAt > 0) consentSeen = true
    }

    @Deprecated("Activity result API of the framework")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQUEST_VPN) return
        val ms = SystemClock.elapsedRealtime() - consentAskedAt
        consentAskedAt = 0
        if (resultCode == RESULT_OK) {
            startService()
            return
        }
        val restricted = try { getSystemService(UserManager::class.java)?.hasUserRestriction(UserManager.DISALLOW_CONFIG_VPN) == true } catch (_: Exception) { false }
        if (Protector.refusedByAndroid(consentSeen, ms, restricted)) {
            ShroudlyVpnService.log("Android did not ask for the VPN (${ms}ms, ${if (restricted) "VPN changes not allowed on this phone" else "another app's always-on VPN, most likely"})")
            vpnBlocked = true
            render()
            showVpnBlocked()
        } else {
            vpnDenied = true
            render()
        }
    }

    /* After an update, once: what changed, in the user's language. */
    private fun showWhatsNew(version: String) {
        if (whatsNewOpen) return
        try {
            AlertDialog.Builder(this)
                .setTitle(text(R.string.whatsNewTitle, "version" to version))
                .setMessage(WhatsNew.lines(getString(R.string.whatsNewAndroid)))
                .setPositiveButton(R.string.whatsNewOk, null)
                .setOnDismissListener { whatsNewOpen = false; WhatsNew.seen(this) }
                .show()
            whatsNewOpen = true
        } catch (_: Exception) {}
    }

    /* "Help people in censored countries": the apps made for it (HelpOthers). */
    private fun showHelpOthers() {
        try {
            AlertDialog.Builder(this)
                .setTitle(R.string.helpOthers)
                .setMessage(R.string.helpOthersBody)
                .setPositiveButton(R.string.helpOthersConduit) { _, _ -> open(HelpOthers.conduitUrl(resources.configuration.locales[0].language)) }
                .setNeutralButton(R.string.helpOthersOrbot) { _, _ -> open(HelpOthers.orbotUrl()) }
                .setNegativeButton(android.R.string.cancel, null)
                .show()
        } catch (_: Exception) {}
    }

    /* Android would not ask for the VPN: why, and the two ways on (NA-4). */
    private fun showVpnBlocked() {
        try {
            AlertDialog.Builder(this)
                .setMessage(R.string.androidVpnBlocked)
                .setPositiveButton(R.string.androidVpnSettings) { _, _ -> openVpnSettings() }
                .setNeutralButton(R.string.androidUseProxyOnly) { _, _ -> useProxyOnly() }
                .setNegativeButton(android.R.string.cancel, null)
                .show()
        } catch (_: Exception) {}
    }

    /* Another VPN app's VPN is up (Shroudly's own is off here). */
    @Suppress("DEPRECATION")
    private fun otherVpnOn(): Boolean = try {
        val cm = getSystemService(android.net.ConnectivityManager::class.java)
        cm.allNetworks.any { cm.getNetworkCapabilities(it)?.hasTransport(android.net.NetworkCapabilities.TRANSPORT_VPN) == true }
    } catch (_: Exception) {
        false
    }

    /* Proxy only from now on, and on: the other VPN stays as it is. */
    private fun useProxyOnly() {
        AppSettings.setProxyOnly(this, true)
        ShroudlyVpnService.log("Proxy only chosen in the window, so the other VPN app keeps the VPN")
        vpnBlocked = false
        vpnDenied = false
        if (Protection.state == Protection.State.OFF) startService()
    }

    private fun openVpnSettings() {
        for (action in listOf(Settings.ACTION_VPN_SETTINGS, Settings.ACTION_WIRELESS_SETTINGS, Settings.ACTION_SETTINGS)) {
            try { startActivity(Intent(action)); return } catch (_: ActivityNotFoundException) {}
        }
    }

    /* Under "Block connections without VPN", off means no internet at all
     * for every app: asked once more (NA-8). */
    private fun confirmStop() {
        try {
            AlertDialog.Builder(this)
                .setMessage(R.string.androidLockdownStop)
                .setPositiveButton(R.string.stop) { _, _ -> if (Protection.state == Protection.State.ON) Protector.stop(this) }
                .setNegativeButton(android.R.string.cancel, null)
                .show()
        } catch (_: Exception) {
            Protector.stop(this)
        }
    }

    /* The service starts only once the VPN is allowed (see ShroudlyVpnService.start). */
    private fun startService() {
        if (!Protector.start(this)) {
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
        // Proxy only on, and no network's proxy set to it: only apps with a
        // proxy setting of their own go through it, so not "Protected".
        val proxyIdle = on && Protection.proxyOnly && proxySet == false

        val statusText = getString(
            when (st) {
                Protection.State.ON -> if (proxyIdle) R.string.androidProxyOnlyRunning
                    else if (Protection.ownServerDown != null) R.string.ownServerDown
                    else if (Protection.national != null) R.string.nationalOnlyTitle else R.string.protected_
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
        support.visibility = if (supportDue && on) View.VISIBLE else View.GONE
        // Only while protection works, and never beside another card.
        val working = on && !proxyIdle && Protection.troubleRes == 0 && Protection.ownServerDown == null && Protection.national == null
        helpCard.visibility = if (helpDue && working && storeShown == null && listOf(notice, update, support).none { it.visibility == View.VISIBLE }) View.VISIBLE else View.GONE
        showStoreCard(on && !proxyIdle && Protection.troubleRes == 0)
        if (update.visibility == View.VISIBLE && updateVersion != null && ApkUpdates.now != null) showApkUpdate()

        // Set only when it changes: status and detail are live regions, and
        // TalkBack reads every change out.
        status.show(statusText)
        status.setTextColor(
            if (on && Protection.ownServerDown != null) getColor(R.color.warn)
            else if (on && !proxyIdle) Accent.color(this, R.attr.accent) else getColor(R.color.text),
        )

        val error = Protection.errorRes
        val off = st == Protection.State.OFF
        // The link under the line: what more there is to it.
        var more = 0
        when {
            vpnBlocked && off -> {
                detail.show(getString(R.string.androidVpnBlocked))
                detail.setTextColor(getColor(R.color.warn))
                more = R.string.androidVpnSettings
            }
            vpnDenied && off -> {
                detail.show(getString(R.string.androidVpnDeniedHere))
                detail.setTextColor(getColor(R.color.warn))
            }
            // The user's own server (Settings, Advanced) is not carrying
            // connections: said first, it is why nothing opens.
            on && Protection.ownServerDown != null -> {
                val (server, why) = Protection.ownServerDown ?: ("" to "")
                val path = listOf(R.string.navSettings, R.string.androidAdvanced, R.string.ownServer).joinToString(
                    if (resources.configuration.layoutDirection == View.LAYOUT_DIRECTION_RTL) " ← " else " → ",
                ) { getString(it) }
                detail.show(text(R.string.ownServerDownBody, "server" to server, "why" to getString(OwnServer.whyRes(why)), "path" to path))
                detail.setTextColor(getColor(R.color.warn))
            }
            // Only the country's own network answers: a shutdown, which no
            // app gets past; where to read what can still help.
            on && Protection.national != null -> {
                detail.show(getString(R.string.nationalOnlyBody))
                detail.setTextColor(getColor(R.color.warn))
                more = R.string.nationalOnlyHelp
            }
            on && Protection.troubleRes != 0 -> {
                detail.show(getString(Protection.troubleRes))
                detail.setTextColor(getColor(R.color.warn))
            }
            proxyIdle -> {
                detail.show(text(R.string.androidProxyNotSet, "port" to Protection.socksPort))
                detail.setTextColor(getColor(R.color.warn))
                more = R.string.androidWifiSettings
            }
            error != 0 && off -> {
                // In the user's language, as the window says it (no "open
                // Shroudly" here); the technical words behind "Details".
                detail.show(getString(here(error)))
                detail.setTextColor(getColor(R.color.warn))
                if (Protection.errorDetail != null) more = R.string.androidDetails
            }
            // Turned off under "Block connections without VPN": no app has
            // internet now, which is not what "off" means anywhere else.
            off && Usage.lockdown(this) && !AppSettings.proxyOnly(this) -> {
                detail.show(getString(R.string.androidLockdownStop))
                detail.setTextColor(getColor(R.color.warn))
            }
            // Working through the user's own server: the address sites see
            // (issue #66), so no site has to be opened to check.
            on && !proxyIdle && Protection.ownServerExit != null -> {
                detail.show(text(R.string.ownServerExit, "ip" to (Protection.ownServerExit ?: "")))
                detail.setTextColor(getColor(R.color.text_dim))
            }
            // Apps' lookups go around the tunnel (DnsNotice): what to turn off.
            on && !proxyIdle && !Protection.proxyOnly && Protection.dnsAround -> {
                detail.show(getString(R.string.dnsAroundAndroid))
                detail.setTextColor(getColor(R.color.warn))
            }
            // Just started: an app that was open before may hold its old
            // connections; said for the first two minutes.
            on && !proxyIdle && !Protection.proxyOnly && Protection.startedAt > 0 &&
                android.os.SystemClock.elapsedRealtime() - Protection.startedAt < 120_000 -> {
                detail.show(getString(R.string.reopenAppsHint))
                detail.setTextColor(getColor(R.color.text_dim))
            }
            // The last way out (TorRoute) at work: connecting, carrying sites
            // nothing else opened, or not getting through.
            on && !proxyIdle && !Protection.proxyOnly && TorRoute.state != "off" -> {
                detail.show(when (TorRoute.state) {
                    "ready" -> getString(R.string.lastResortReady)
                    "failed" -> getString(R.string.lastResortFailed)
                    else -> text(R.string.lastResortStarting, "progress" to TorRoute.progress)
                })
                detail.setTextColor(getColor(if (TorRoute.state == "failed") R.color.warn else R.color.text_dim))
            }
            else -> {
                detail.show(when {
                    // Starting or stopping: nothing that says otherwise.
                    busy -> ""
                    !on -> getString(R.string.androidOffHint)
                    // Proxy only: where apps are to be pointed.
                    Protection.proxyOnly -> ProxyPort.onText(this, Protection.socksPort)
                    else -> coverage
                })
                detail.setTextColor(getColor(R.color.text_dim))
            }
        }
        detailMore.visibility = if (more != 0) View.VISIBLE else View.GONE
        if (more != 0 && detailMore.tag != more) {
            detailMore.tag = more
            detailMore.setText(more)
            detailMore.setOnClickListener {
                when (more) {
                    R.string.androidVpnSettings -> openVpnSettings()
                    R.string.androidWifiSettings -> openWifiSettings(this)
                    R.string.nationalOnlyHelp -> open(NationalNet.guideUrl(resources.configuration.locales[0].language))
                    else -> showDetail()
                }
            }
        }

        // Under the status, what a tap on the switch does; nothing while it works.
        if (!busy) hintLabel.show(getString(if (on) R.string.stop else R.string.start))
        hint.visibility = if (busy) View.INVISIBLE else View.VISIBLE

        val s = Protection.stats
        if (on && s != null) {
            val n = NumberFormat.getIntegerInstance()
            // Active now, and the session's total under it.
            connections.show(n.format(s.connsActive))
            val total = text(R.string.totalCount, "count" to n.format(s.connsTotal))
            // With "Block ads and trackers": how many it ended, beside it.
            connectionsTotal.show(if (s.blocked > 0) "$total · ${getString(R.string.adsBlocked)}: ${n.format(s.blocked)}" else total)
            upload.show(Format.bytes(s.bytesUp))
            download.show(Format.bytes(s.bytesDown))
            uptime.show(Format.duration(android.os.SystemClock.elapsedRealtime() - Protection.startedAt))
            statsHint.visibility = View.GONE
            // The live total this phone is counted in ("Count me in", Settings).
            val online = OnlineCount.online()
            if (online != null) onlineNow.show("${getString(R.string.onlineNow)}: ${n.format(online)}")
            onlineNow.visibility = if (online != null) View.VISIBLE else View.GONE
        } else {
            // Set only when it changes: the window redraws every second, and a
            // text set again is announced to accessibility services again.
            for (v in listOf(connections, upload, download, uptime)) v.show("–")
            onlineNow.visibility = View.GONE
            connectionsTotal.show(text(R.string.totalCount, "count" to "–"))
            // "Start protection to see live traffic": while it is off, not
            // while it starts or stops.
            statsHint.visibility = if (off) View.VISIBLE else View.GONE
        }
    }

    /* The store card (StoreCards), once a run at most: only after the other
     * cards have had their say, and never beside one of them. */
    private fun showStoreCard(working: Boolean) {
        if (storeShown != null) return
        // Asked for from the suggestion's notification: already counted then.
        storeAsked?.let { storeAsked = null; putStoreCard(it); return }
        if (StoreCards.promptedThisRun || !working) return
        if (SystemClock.uptimeMillis() - startedAt < STORE_CARD_AFTER_MS) return
        if (listOf(notice, update, support, helpCard).any { it.visibility == View.VISIBLE }) return
        val now = System.currentTimeMillis()
        val live = Stores.playHere(this, now, country)
        val rate = StoreCards.load(this, StoreCards.RATE, now)
        val move = StoreCards.load(this, StoreCards.MOVE, now)
        when {
            StoreCards.rateDue(fromPlay, live, working, installedAt, workedDays, rate, now) -> {
                StoreCards.save(this, StoreCards.RATE, StoreCards.rateShown(rate, now))
                ShroudlyVpnService.log("Asking for a rating on Google Play (${rate.shown + 1}. time)")
                putStoreCard(StoreCards.RATE)
            }
            StoreCards.moveDue(fromPlay, live, playStore, working, AdBlock.enabled(this), installedAt, workedDays, move, now) -> {
                StoreCards.save(this, StoreCards.MOVE, StoreCards.moveShown(move, now))
                ShroudlyVpnService.log("Suggesting the copy from Google Play (${move.shown + 1}. time)")
                putStoreCard(StoreCards.MOVE)
            }
            else -> return
        }
        StoreCards.promptedThisRun = true
    }

    private fun putStoreCard(key: String) {
        val rate = key == StoreCards.RATE
        storeShown = key
        findViewById<ImageView>(R.id.storeIcon).setImageResource(if (rate) R.drawable.ic_star else R.drawable.ic_download)
        findViewById<TextView>(R.id.storeTitle).setText(if (rate) R.string.androidRateTitle else R.string.androidMoveTitle)
        findViewById<TextView>(R.id.storeText).setText(if (rate) R.string.androidRateBody else R.string.androidMoveBody)
        findViewById<Button>(R.id.storeOpen).setText(if (rate) R.string.androidRateOpen else R.string.androidMoveOpen)
        storeCard.visibility = View.VISIBLE
    }

    private fun hideStoreCard() {
        storeShown = null
        storeCard.visibility = View.GONE
    }

    /* A reason as the window says it: the notice's own words tell the user
     * to open Shroudly, where they already are. */
    private fun here(res: Int) = when (res) {
        R.string.androidProtectionLost -> R.string.androidProtectionLostHere
        R.string.androidProxyOnlyLost -> R.string.androidProxyOnlyLostHere
        R.string.androidNoInternet -> R.string.androidNoInternetHere
        R.string.androidVpnDenied -> R.string.androidVpnDeniedHere
        else -> res
    }

    /* Proxy only: whether a network's proxy is set to its port, off the main
     * thread (ProxyCheck asks Android about every network). */
    private fun checkProxyUse() {
        if (Protection.state != Protection.State.ON || !Protection.proxyOnly) {
            proxySet = null
            return
        }
        if (proxyChecking) return
        val port = Protection.socksPort
        proxyChecking = true
        Thread({
            val set = try { ProxyCheck.pointsAt(this, port) != null } catch (_: Exception) { null }
            main.post {
                proxyChecking = false
                if (set != proxySet) { proxySet = set; render() }
            }
        }, "proxy-use").apply { isDaemon = true }.start()
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
        updateVersion = offer.version
        // Seen here: no notification for it as well (ApkUpdates.look).
        ApkUpdates.seen(this, offer.version)
        showApkUpdate()
        update.visibility = View.VISIBLE
    }

    /* The APK from GitHub: downloaded and installed here (ApkUpdates), or
     * where this build cannot, its page opened. */
    private fun updateApk() {
        val url = updateUrl ?: return
        val version = updateVersion ?: return
        if (ApkUpdates.available(this) && ApkUpdates.now?.let { it.version == version && it.stage == ApkUpdates.Stage.FAILED } != true) {
            ApkUpdates.start(this, version, url)
        } else {
            open(if (ApkUpdates.now?.stage == ApkUpdates.Stage.FAILED) UpdateCheck.RELEASES_URL else url)
        }
        showApkUpdate()
    }

    /* The card as the APK's own update stands: offered, downloading, with
     * Android's installer, or failed (then the release page, by hand). */
    private fun showApkUpdate() {
        val version = updateVersion ?: return
        val button = findViewById<Button>(R.id.updateOpen)
        val now = ApkUpdates.now?.takeIf { it.version == version }
        when (now?.stage) {
            ApkUpdates.Stage.DOWNLOADING -> updateText.show(text(R.string.updDownloading, "version" to version, "percent" to now.percent))
            ApkUpdates.Stage.WAITING -> updateText.show(text(R.string.updReady, "version" to version))
            ApkUpdates.Stage.FAILED -> updateText.show(getString(now.failed))
            null -> updateText.show(text(R.string.updAvailable, "version" to version))
        }
        val label = if (now?.stage == ApkUpdates.Stage.FAILED || !ApkUpdates.available(this)) R.string.androidDownloadApk else R.string.updDownload
        if (button.tag != label) { button.tag = label; button.setText(label) }
        button.visibility = if (now?.stage == ApkUpdates.Stage.DOWNLOADING || now?.stage == ApkUpdates.Stage.WAITING) View.GONE else View.VISIBLE
    }

    /* A copy Google Play updates: the APK's card, with Play behind its button. */
    private fun showPlayUpdate(card: PlayUpdatePolicy.Card?) {
        if (card == null) { update.visibility = View.GONE; return }
        val button = findViewById<Button>(R.id.updateOpen)
        when (card.stage) {
            PlayUpdatePolicy.Stage.AVAILABLE -> {
                updateText.show(text(if (card.urgent) R.string.androidUpdateImportant else R.string.updAvailable, "version" to card.version))
                button.setText(R.string.updDownload)
                button.setOnClickListener { PlayUpdates.offer(this) }
            }
            PlayUpdatePolicy.Stage.DOWNLOADING ->
                updateText.show(text(R.string.updDownloading, "version" to card.version, "percent" to card.percent))
            PlayUpdatePolicy.Stage.READY -> {
                updateText.show(text(R.string.updReady, "version" to card.version))
                button.setText(R.string.updRestartNow)
                button.setOnClickListener { PlayUpdates.install(this) }
            }
        }
        button.visibility = if (card.stage == PlayUpdatePolicy.Stage.DOWNLOADING) View.GONE else View.VISIBLE
        update.visibility = View.VISIBLE
    }

    /* ── battery and logs ──────────────────────────────────────────────── */

    /* Asked each time the window comes back: the user may just have changed
     * the setting. */
    /* A network's proxy pointing at a proxy on this phone where nothing runs
     * (ProxyCheck): told once a run, with the way to the Wi-Fi settings,
     * where only the user may change it. Where it is Shroudly's own port in
     * Proxy only (ProxyPort), set there for it, the proxy is no leftover:
     * while Shroudly is off (the phone restarted, Android ended it), turning
     * it on is what makes those apps work again; while it is on another
     * port (the one it asked for was held), that port is the one to set. */
    private fun checkNetworkProxy() {
        Thread({
            val dead = try { ProxyCheck.deadLocal(this) } catch (_: Exception) { null } ?: return@Thread
            main.post {
                if (isFinishing || isDestroyed || !deadProxyTold.add(dead)) return@post
                val ours = AppSettings.proxyOnly(this) && ProxyPort.ours(this, dead.substringAfterLast(':').toIntOrNull() ?: 0)
                val st = Protection.state
                // Starting or stopping, or the VPN still on (Proxy only is
                // chosen for the next start): looked at again next time.
                if (ours && st != Protection.State.OFF && !(st == Protection.State.ON && Protection.proxyOnly)) { deadProxyTold.remove(dead); return@post }
                try {
                    val d = AlertDialog.Builder(this)
                    when {
                        ours && st == Protection.State.OFF -> {
                            ShroudlyVpnService.log("A network's proxy points at $dead, Shroudly's own port, while Proxy only is off; apps that use it cannot connect")
                            d.setTitle(R.string.notProtected)
                                .setMessage(text(R.string.androidWifiProxyShroudlyOff, "addr" to dead))
                                .setPositiveButton(R.string.start) { _, _ -> if (Protection.state == Protection.State.OFF) onToggle() }
                                .setNeutralButton(R.string.androidWifiSettings) { _, _ -> openWifiSettings(this) }
                                .setNegativeButton(R.string.updLater, null)
                        }
                        ours -> {
                            ShroudlyVpnService.log("A network's proxy points at $dead, where Shroudly listened before; it is on 127.0.0.1:${Protection.socksPort} now")
                            d.setTitle(R.string.androidWifiProxyDeadTitle)
                                .setMessage(text(R.string.androidWifiProxyOtherPort, "addr" to dead, "port" to Protection.socksPort))
                                .setPositiveButton(R.string.androidWifiSettings) { _, _ -> openWifiSettings(this) }
                                .setNegativeButton(R.string.updLater, null)
                        }
                        else -> {
                            ShroudlyVpnService.log("A network's proxy points at $dead on this phone, where nothing is running; apps that use it cannot connect")
                            d.setTitle(R.string.androidWifiProxyDeadTitle)
                                .setMessage(text(R.string.androidWifiProxyDead, "addr" to dead))
                                .setPositiveButton(R.string.androidWifiSettings) { _, _ -> openWifiSettings(this) }
                                .setNegativeButton(R.string.updLater, null)
                        }
                    }
                    d.show()
                } catch (_: Exception) {}
            }
        }, "proxy-check").apply { isDaemon = true }.start()
    }

    /* One notice at most, the one that matters most: battery settings that
     * may stop protection in the background (Diagnostics.batteryDue), else
     * notifications turned off, so that protection stopping is never said
     * (notificationsDue). Each with its one way to fix it and "Not now";
     * neither on a new install's first screen. */
    @SuppressLint("SetTextI18n")
    private fun showNotice() {
        val now = System.currentTimeMillis()
        val ui = getSharedPreferences("ui", MODE_PRIVATE)
        val days = Usage.days(this)
        val battery = Diagnostics.batteryDue(Diagnostics.batteryHint(Diagnostics.battery(this), Build.MANUFACTURER, Build.BRAND),
            days, ui.getLong(KEY_BATTERY_LATER, 0), Usage.endedByAndroidAt(this), now)
        val notifications = Diagnostics.notificationsDue(notificationsEnabled(), days, ui.getLong(KEY_NOTIFICATIONS_LATER, 0), now)
        noticeShown = when {
            battery -> R.string.androidBatterySettings
            notifications -> R.string.showNotifications
            else -> 0
        }
        notice.visibility = if (noticeShown != 0) View.VISIBLE else View.GONE
        if (noticeShown == 0) return
        if (battery) {
            // The steps for the screen it opens, where the setting is not
            // the first thing in sight.
            noticeText.text = getString(R.string.androidBatteryHint) + "\n" + getString(R.string.androidBatterySteps)
            noticeIcon.setImageResource(R.drawable.ic_battery)
        } else {
            noticeText.setText(R.string.androidNotificationsOff)
            noticeIcon.setImageResource(R.drawable.ic_bell_off)
        }
        noticeOpen.setText(noticeShown)
    }

    private fun notificationsEnabled(): Boolean =
        try { getSystemService(android.app.NotificationManager::class.java)?.areNotificationsEnabled() != false } catch (_: Exception) { true }

    /* Android 13+ asks again while it still may (it lets an app ask twice);
     * after that, and before 13, Shroudly's page in Android's notification
     * settings. */
    private fun openNotificationSettings() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED &&
            shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS)
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST_NOTIFICATIONS_AGAIN)
            return
        }
        val page = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
        try {
            startActivity(page)
        } catch (_: ActivityNotFoundException) {
            try { startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null))) } catch (_: ActivityNotFoundException) {}
        }
    }

    /* The app's own page in Settings: every Android version and every phone
     * maker has its battery setting there ("Battery", "App battery usage",
     * "Battery saver"), where the user can choose no restrictions; the
     * notice says where to look. No permission is needed for it, unlike
     * asking Android to exempt the app directly. */
    private fun openBatterySettings() {
        val details = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null))
        try {
            startActivity(details)
        } catch (_: ActivityNotFoundException) {
            try { startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) } catch (_: ActivityNotFoundException) {}
        }
    }

    /* The recent log and the phone's details, as text the user sends where
     * they choose (Diagnostics). First who to send it to, and that it names
     * the sites Shroudly handled, with the choice to leave them out: a bare
     * share sheet said neither, and a log with someone's browsing could end
     * up in a public issue. */
    private fun shareLogs() {
        try {
            AlertDialog.Builder(this)
                .setTitle(R.string.androidShareLogs)
                .setMessage(R.string.androidShareLogsWho)
                .setPositiveButton(R.string.androidShareLogs) { _, _ -> sendLogs(sites = true) }
                .setNeutralButton(R.string.androidShareLogsNoSites) { _, _ -> sendLogs(sites = false) }
                .setNegativeButton(android.R.string.cancel, null)
                .show()
        } catch (_: Exception) {
            sendLogs(sites = true)
        }
    }

    private fun sendLogs(sites: Boolean) {
        val text = try { Diagnostics.report(this, sites) } catch (e: Exception) { "Shroudly ${BuildConfig.VERSION_NAME}: no report ($e)" }
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

    private fun openSupport() {
        supportDue = false
        support.visibility = View.GONE
        try { Support.show(this) } catch (_: Exception) {}
    }

    private fun open(url: String) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        } catch (_: ActivityNotFoundException) {
        }
    }
}

/* Android's Wi-Fi settings (any network settings where a phone has none). */
fun openWifiSettings(ctx: android.content.Context) {
    for (action in listOf(Settings.ACTION_WIFI_SETTINGS, Settings.ACTION_WIRELESS_SETTINGS, Settings.ACTION_SETTINGS)) {
        try { ctx.startActivity(Intent(action).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); return } catch (_: ActivityNotFoundException) {}
    }
}
