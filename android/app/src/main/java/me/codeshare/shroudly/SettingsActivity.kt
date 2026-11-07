package me.codeshare.shroudly

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.drawable.Drawable
import android.os.Build
import android.os.Bundle
import android.text.Editable
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.TextWatcher
import android.text.style.ForegroundColorSpan
import android.text.style.RelativeSizeSpan
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.widget.BaseAdapter
import android.widget.CheckBox
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import android.widget.Toolbar

/*
 * Settings: first what anyone may want (the language, the accent, the apps
 * that skip Shroudly, starting with the phone, the live count and the ad
 * blocker); then, folded away under "Advanced", what only someone helping
 * them should change: the mode, the technique (as the desktop's "Bypass
 * strategy"), the DNS server, QUIC and IPv6, and automation apps
 * (AppSettings). A change reaches a running protection at once
 * (ShroudlyVpnService.ACTION_SETTINGS); a new mode starts it again in that
 * mode.
 *
 * Under a bar with the title and a way back, as any Android screen has. A
 * setting shows its title (and its value: a language, a count); what it
 * does is explained under it only once its section's (i) is tapped, so the
 * screen is not a wall of text (issue #47).
 */
class SettingsActivity : Activity() {
    private companion object {
        // How long Advanced takes to unfold or fold.
        const val ADVANCED_ANIM_MS = 220L
        /* The Quick Settings tile was added (or found there) from Settings. */
        const val KEY_TILE_ADDED = "quickTileAdded"
        // The VPN's consent, asked for before protection moves to VPN mode.
        const val REQUEST_VPN = 1
        // The swatches per row: ten in two rows, on any phone.
        const val SWATCHES_PER_ROW = 5
    }

    // In the language chosen below (Lang; before Android 13).
    override fun attachBaseContext(base: android.content.Context) = super.attachBaseContext(Lang.wrap(base))

    /* The sections whose explanations are shown, and how each draws its
     * settings again (see explanations()). */
    private val open = mutableSetOf<Int>()
    private val redraw = mutableMapOf<Int, () -> Unit>()

    /* A setting's title, and under it, smaller and dimmer, sub (its
     * explanation, or its value), when there is one. */
    private fun titled(title: CharSequence, sub: CharSequence?, size: Float = 12.5f): CharSequence {
        if (sub.isNullOrEmpty()) return title
        return SpannableStringBuilder(title).append('\n').apply {
            val from = length
            append(sub)
            setSpan(ForegroundColorSpan(getColor(R.color.text_dim)), from, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            setSpan(RelativeSizeSpan(size / 15f), from, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
    }

    /* An explanation, when its section shows them. */
    private fun ifOpen(section: Int, text: CharSequence): CharSequence? = if (section in open) text else null

    override fun onCreate(savedInstanceState: Bundle?) {
        Accent.apply(this)
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)
        Tv.rings(window)
        findViewById<Toolbar>(R.id.toolbar).apply {
            navigationIcon?.mutate()?.setTint(getColor(R.color.text))
            setNavigationOnClickListener { finish() }
        }
        edgeToEdge()
        showAccents()
        showMode()

        val group = findViewById<RadioGroup>(R.id.strategy)
        val current = AppSettings.strategy(this).id
        val strategies = mutableListOf<Pair<RadioButton, () -> CharSequence>>()
        for ((i, s) in AppSettings.STRATEGIES.withIndex()) {
            val label = getString(labelOf(s.id))
            group.addView(RadioButton(this).apply {
                id = View.generateViewId()
                tag = s.id
                // The label; under Auto, with the section's explanations, what
                // it does and when another one is for (never the engine's own
                // spec: words for the user, not code).
                strategies += this to { titled(label, if (s.auto) ifOpen(R.id.strategyTitle, getString(R.string.androidStrategyDesc)) else null, 12f) }
                text = strategies.last().second()
                textSize = 15f
                setTextColor(getColor(R.color.text))
                // The spec under the label lines up with it in right-to-left languages too.
                textAlignment = View.TEXT_ALIGNMENT_VIEW_START
                val pad = (8 * resources.displayMetrics.density).toInt()
                setPadding(pad, pad, pad, pad)
                isChecked = s.id == current
                if (i == 0) contentDescription = label
            })
        }
        group.setOnCheckedChangeListener { g, checkedId ->
            val id = g.findViewById<RadioButton>(checkedId)?.tag as? String ?: return@setOnCheckedChangeListener
            if (id == AppSettings.strategy(this).id) return@setOnCheckedChangeListener
            AppSettings.setStrategy(this, id)
            tell("strategy")
            showAdvancedTitle()
        }
        redraw[R.id.strategyTitle] = { for ((b, t) in strategies) b.text = t() }

        findViewById<TextView>(R.id.language).setOnClickListener { pickLanguage() }
        showLanguage()

        findViewById<TextView>(R.id.dnsServer).setOnClickListener { pickDns() }
        showDns()
        findViewById<TextView>(R.id.ownServer).setOnClickListener { pickOwnServer() }
        showOwnServer()

        // QUIC and IPv6 off (#59): the engine again with its options.
        findViewById<Switch>(R.id.quicOff).apply {
            isChecked = AppSettings.quicOff(this@SettingsActivity)
            setOnCheckedChangeListener { _, on -> AppSettings.setQuicOff(this@SettingsActivity, on); tell("network"); showAdvancedTitle() }
        }
        findViewById<Switch>(R.id.ipv6Off).apply {
            isChecked = AppSettings.ipv6Off(this@SettingsActivity)
            setOnCheckedChangeListener { _, on -> AppSettings.setIpv6Off(this@SettingsActivity, on); tell("network"); showAdvancedTitle() }
        }
        showNetwork()
        redraw[R.id.networkTitle] = { showNetwork() }

        findViewById<TextView>(R.id.excludedApps).setOnClickListener { pickApps() }

        findViewById<Switch>(R.id.startAtBoot).apply {
            isChecked = AppSettings.startAtBoot(this@SettingsActivity)
            setOnCheckedChangeListener { _, on -> AppSettings.setStartAtBoot(this@SettingsActivity, on) }
        }

        // Automation apps: what to send, under the switch (showApps).
        findViewById<Switch>(R.id.remoteControl).apply {
            isChecked = AppSettings.remoteControl(this@SettingsActivity)
            setOnCheckedChangeListener { _, on ->
                AppSettings.setRemoteControl(this@SettingsActivity, on)
                ShroudlyVpnService.log(if (on) "Automation apps allowed (Settings)" else "Automation apps no longer allowed (Settings)")
                showAdvancedTitle()
            }
        }
        showApps()
        redraw[R.id.appsTitle] = { showApps() }
        showAutomation()
        redraw[R.id.automationTitle] = { showAutomation() }
        setUpApplication()
        redraw[R.id.appTitle] = { showApplication() }
        explanations()
        setUpAdvanced()
        Fit.apply(findViewById(R.id.root))
    }

    /* Something under "Advanced" is set otherwise than a new install has it
     * (and so is opened to be seen). */
    private fun advancedSet(): Boolean =
        AppSettings.proxyOnly(this) || AppSettings.strategy(this).id != AppSettings.STRATEGIES[0].id ||
            AppSettings.customDnsTyped(this) != null || AppSettings.quicOff(this) || AppSettings.ipv6Off(this) ||
            AppSettings.ownServerTyped(this).isNotEmpty() ||
            AppSettings.remoteControl(this)

    /* "Advanced": folded away, with what it holds and who it is for under
     * its title; open from the start when something in it is set. */
    private fun setUpAdvanced() {
        val box = findViewById<View>(R.id.advancedBox)
        val row = findViewById<TextView>(R.id.advanced)
        if (advancedSet()) box.visibility = View.VISIBLE
        showAdvancedTitle()
        row.setOnClickListener {
            val opening = box.visibility != View.VISIBLE
            // It opens below the fold, at the end of the page: up to 2.6.59 it
            // appeared there at once, unseen, and a tap looked like it did
            // nothing ("is it open or closed?"). Now it unfolds, and the page
            // moves up to it.
            (box.parent as? ViewGroup)?.let {
                android.transition.TransitionManager.beginDelayedTransition(it, android.transition.AutoTransition().setDuration(ADVANCED_ANIM_MS))
            }
            box.visibility = if (opening) View.VISIBLE else View.GONE
            showAdvancedTitle()
            if (opening) row.postDelayed({ scrollToAdvanced(row) }, ADVANCED_ANIM_MS / 2)
        }
    }

    /* The Advanced row at the top of the page, what it holds below it. */
    private fun scrollToAdvanced(row: View) {
        var p = row.parent
        while (p != null && p !is ScrollView) p = p.parent
        val scroll = p as? ScrollView ?: return
        val r = android.graphics.Rect()
        row.getDrawingRect(r)
        scroll.offsetDescendantRectToMyCoords(row, r)
        scroll.smoothScrollTo(0, (r.top - (12 * resources.displayMetrics.density).toInt()).coerceAtLeast(0))
    }

    private fun showAdvancedTitle() {
        val row = findViewById<TextView>(R.id.advanced)
        val shown = findViewById<View>(R.id.advancedBox).visibility == View.VISIBLE
        row.text = titled(getString(R.string.androidAdvanced), getString(R.string.androidAdvancedDesc))
        val chevron = getDrawable(if (shown) R.drawable.ic_chevron_down else R.drawable.chevron_end)?.mutate()
        if (shown) chevron?.setTint(getColor(R.color.text_faint))
        val c = row.compoundDrawablesRelative
        val d = resources.displayMetrics.density
        chevron?.setBounds(0, 0, (18 * d).toInt(), (18 * d).toInt())
        row.setCompoundDrawablesRelative(c[0], c[1], chevron, c[3])
        // TalkBack says "expanded" or "collapsed", in the phone's language.
        row.accessibilityDelegate = object : View.AccessibilityDelegate() {
            override fun onInitializeAccessibilityNodeInfo(host: View, info: android.view.accessibility.AccessibilityNodeInfo) {
                super.onInitializeAccessibilityNodeInfo(host, info)
                info.addAction(if (shown) android.view.accessibility.AccessibilityNodeInfo.AccessibilityAction.ACTION_COLLAPSE
                    else android.view.accessibility.AccessibilityNodeInfo.AccessibilityAction.ACTION_EXPAND)
            }

            override fun performAccessibilityAction(host: View, action: Int, args: Bundle?): Boolean {
                if (action == android.view.accessibility.AccessibilityNodeInfo.ACTION_EXPAND ||
                    action == android.view.accessibility.AccessibilityNodeInfo.ACTION_COLLAPSE) return host.performClick()
                return super.performAccessibilityAction(host, action, args)
            }
        }
    }

    /* The app's own switches (the desktop's "Application"): the live count
     * and the ad blocker, which lived under About in the main window up to
     * 2.6.44, where they were a long paragraph between the links. */
    private fun setUpApplication() {
        findViewById<Switch>(R.id.shareOnlineCount).apply {
            isChecked = OnlineCount.enabled(this@SettingsActivity)
            setOnCheckedChangeListener { _, on -> OnlineCount.setEnabled(this@SettingsActivity, on) }
        }
        // The lite APK has no Tor, and nothing of Tor's is offered there
        // either: helping others is a Snowflake proxy for the Tor network
        // (issue #75). Its divider and the Tor toggle's go with them.
        val lite = BuildConfig.APK_VARIANT == "lite"
        for (id in intArrayOf(R.id.snowflakeDivider, R.id.torDivider)) findViewById<View>(id).visibility = if (lite) View.GONE else View.VISIBLE
        // Where Tor itself is blocked the user is among those who need the
        // help: the Snowflake switch is not shown (HelpNudge.torBlockedHere).
        val helpHidden = lite || HelpNudge.torBlockedHere(this)
        findViewById<View>(R.id.snowflakeDivider).visibility = if (helpHidden) View.GONE else View.VISIBLE
        // Inside Shroudly while on, charging, on Wi-Fi (Snowflake).
        findViewById<Switch>(R.id.snowflake).apply {
            visibility = if (helpHidden) View.GONE else View.VISIBLE
            isChecked = Snowflake.enabled(this@SettingsActivity)
            setOnCheckedChangeListener { _, on ->
                Snowflake.setEnabled(this@SettingsActivity, on)
                Protector.tell(this@SettingsActivity, ShroudlyVpnService.ACTION_SNOWFLAKE)
            }
        }
        // The last way out (TorRoute): on unless turned off.
        findViewById<Switch>(R.id.torLastResort).apply {
            // The lite APK has no Tor (issue #75): nothing to turn on.
            visibility = if (BuildConfig.APK_VARIANT == "lite") View.GONE else View.VISIBLE
            isChecked = TorRoute.enabled(this@SettingsActivity)
            setOnCheckedChangeListener { _, on ->
                TorRoute.setEnabled(this@SettingsActivity, on)
                if (!on) TorAsk.rest(this@SettingsActivity)
                tell("torLastResort")
            }
        }
        // Only in the copy from GitHub (AdBlock.offered).
        val adBlock = AdBlock.offered(this)
        val allowRow = findViewById<View>(R.id.adBlockAllow)
        findViewById<View>(R.id.adBlockDivider).visibility = if (adBlock) View.VISIBLE else View.GONE
        findViewById<Switch>(R.id.adBlock).apply {
            visibility = if (adBlock) View.VISIBLE else View.GONE
            isChecked = AdBlock.enabled(this@SettingsActivity)
            setOnCheckedChangeListener { _, on ->
                AdBlock.setEnabled(this@SettingsActivity, on)
                allowRow.visibility = if (on && adBlock) View.VISIBLE else View.GONE
                Protector.tell(this@SettingsActivity, ShroudlyVpnService.ACTION_ADBLOCK)
            }
        }
        allowRow.visibility = if (adBlock && AdBlock.enabled(this)) View.VISIBLE else View.GONE
        allowRow.setOnClickListener { editAdBlockAllow() }
        showApplication()
    }

    private fun showApplication() {
        findViewById<Switch>(R.id.shareOnlineCount).text =
            titled(getString(R.string.shareOnlineCount), ifOpen(R.id.appTitle, getString(R.string.shareOnlineCountDesc)))
        findViewById<Switch>(R.id.adBlock).text =
            titled(getString(R.string.adBlock), ifOpen(R.id.appTitle, getString(R.string.adBlockDesc)))
        findViewById<Switch>(R.id.snowflake).text =
            titled(getString(R.string.snowflakeDevice), ifOpen(R.id.appTitle, getString(R.string.snowflakeWhenAndroid)))
        findViewById<Switch>(R.id.torLastResort).text =
            titled(getString(R.string.lastResort), ifOpen(R.id.appTitle,
                if (AppSettings.ownServer(this) != null) getString(R.string.lastResortOwnServer)
                else getString(R.string.lastResortDesc) + " " + getString(R.string.lastResortAsks)))
    }

    /* "Sites never to block": one domain per line, cleaned on save. */
    private fun editAdBlockAllow() {
        val pad = (20 * resources.displayMetrics.density).toInt()
        val field = EditText(this).apply {
            setText(AdBlock.allow(this@SettingsActivity).joinToString("\n"))
            hint = "example.com"
            setHintTextColor(getColor(R.color.text_faint))
            minLines = 4
            textDirection = View.TEXT_DIRECTION_LTR
            typeface = android.graphics.Typeface.MONOSPACE
        }
        val hintText = TextView(this).apply {
            text = getString(R.string.adBlockAllowDesc)
            setTextColor(getColor(R.color.text_dim))
            textSize = 13f
        }
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad / 2, pad, 0)
            addView(hintText)
            addView(field)
        }
        AlertDialog.Builder(this)
            .setTitle(R.string.adBlockAllow)
            .setView(ScrollView(this).apply { addView(box) })
            .setPositiveButton(android.R.string.ok) { _, _ ->
                AdBlock.setAllow(this, field.text.toString())
                Protector.tell(this, ShroudlyVpnService.ACTION_ADBLOCK)
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    /* The (i) on a section's title shows its settings' explanations, or
     * hides them again; it says which it will do. */
    private fun explanations() {
        for ((section, draw) in redraw) {
            val title = findViewById<TextView>(section)
            val name = title.text
            fun say() {
                title.contentDescription = "$name, " + getString(if (section in open) R.string.androidHideExplanation else R.string.androidShowExplanation)
            }
            say()
            title.setOnClickListener {
                if (!open.remove(section)) open += section
                draw()
                say()
            }
        }
    }

    private fun showNetwork() {
        findViewById<Switch>(R.id.quicOff).text =
            titled(getString(R.string.androidQuicOff), ifOpen(R.id.networkTitle, getString(R.string.androidQuicOffDesc)))
        findViewById<Switch>(R.id.ipv6Off).text =
            titled(getString(R.string.androidIpv6Off), ifOpen(R.id.networkTitle, getString(R.string.androidIpv6OffDesc)))
    }

    /* The Apps section's settings that explain themselves: starting with the
     * phone, and (in showExcluded, showQuickTile) the apps that skip Shroudly
     * and the Quick Settings tile. */
    private fun showApps() {
        findViewById<Switch>(R.id.startAtBoot).text =
            titled(getString(R.string.androidStartAtBoot), ifOpen(R.id.appsTitle, getString(R.string.androidStartAtBootDesc)))
        showExcluded()
        showQuickTile()
    }

    private fun showAutomation() {
        // The names break only after a dot, never inside a word.
        findViewById<Switch>(R.id.remoteControl).text = titled(getString(R.string.androidRemoteControl), ifOpen(R.id.automationTitle,
            text(R.string.androidRemoteControlDesc, "package" to Fit.breakable(packageName), "action" to Fit.breakable(AutomationReceiver.ACTION_START.substringBeforeLast('.')))))
    }

    /* Appearance: the accents as round swatches, the chosen one ringed, in
     * rows that fit any screen (one row that scrolled hid some swatches with
     * nothing to say so). A choice is kept and the window made again in it
     * (the main window follows when it comes back). TalkBack says which of
     * how many each is, and which one is chosen. */
    private fun showAccents() {
        val rows = findViewById<LinearLayout>(R.id.accents)
        val density = resources.displayMetrics.density
        val size = (34 * density).toInt()
        val gap = (10 * density).toInt()
        val chosen = Accent.id(this)
        var row: LinearLayout? = null
        for ((i, o) in Accent.OPTIONS.withIndex()) {
            if (i % SWATCHES_PER_ROW == 0) row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }.also { rows.addView(it) }
            row!!.addView(View(this).apply {
                layoutParams = LinearLayout.LayoutParams(size, size).apply { marginEnd = gap; topMargin = gap / 2; bottomMargin = gap / 2 }
                background = android.graphics.drawable.GradientDrawable().apply {
                    shape = android.graphics.drawable.GradientDrawable.OVAL
                    setColor(o.swatch)
                    if (o.id == chosen) setStroke((3 * density).toInt(), getColor(R.color.text))
                }
                contentDescription = text(R.string.androidAccentSwatch, "n" to i + 1, "total" to Accent.OPTIONS.size)
                isSelected = o.id == chosen
                // A tap shows on the circle itself, as on any button.
                foreground = android.graphics.drawable.RippleDrawable(
                    android.content.res.ColorStateList.valueOf(0x55FFFFFF), null,
                    android.graphics.drawable.ShapeDrawable(android.graphics.drawable.shapes.OvalShape()),
                )
                isClickable = true
                isFocusable = true
                setOnClickListener {
                    if (o.id == Accent.id(this@SettingsActivity)) return@setOnClickListener
                    Accent.set(this@SettingsActivity, o.id)
                    recreate()
                }
            })
        }
    }

    /* VPN or proxy only, each with what it means. A change while protection
     * is on starts it again in the new mode (up to 2.6.44 a toast said it
     * would be used at the next start, and the window went on showing the
     * old one); to VPN mode, Android's consent first where it is needed,
     * while Proxy only goes on, and nothing changes if it is refused. */
    private var modeGroup: RadioGroup? = null

    private fun showMode() {
        val group = findViewById<RadioGroup>(R.id.mode)
        val proxy = AppSettings.proxyOnly(this)
        val pad = (8 * resources.displayMetrics.density).toInt()
        val options = mutableListOf<Pair<RadioButton, () -> CharSequence>>()
        fun option(on: Boolean, label: Int, desc: String) = RadioButton(this).apply {
            id = View.generateViewId()
            tag = on
            options += this to { titled(getString(label), ifOpen(R.id.modeTitle, desc)) }
            text = options.last().second()
            textSize = 15f
            setTextColor(getColor(R.color.text))
            textAlignment = View.TEXT_ALIGNMENT_VIEW_START
            setPadding(pad, pad, pad, pad)
            isChecked = on == proxy
        }
        group.addView(option(false, R.string.androidModeVpn, getString(R.string.androidModeVpnDesc)))
        group.addView(option(true, R.string.androidModeProxy, text(R.string.androidModeProxyDesc, "port" to ProxyPort.shown(this))))
        redraw[R.id.modeTitle] = { for ((b, t) in options) b.text = t() }
        modeGroup = group
        group.setOnCheckedChangeListener { g, checkedId ->
            val on = g.findViewById<RadioButton>(checkedId)?.tag as? Boolean ?: return@setOnCheckedChangeListener
            if (on == AppSettings.proxyOnly(this)) return@setOnCheckedChangeListener
            if (!on && Protection.state != Protection.State.OFF) {
                val consent = try { android.net.VpnService.prepare(this) } catch (_: Exception) { null }
                if (consent != null) {
                    try {
                        @Suppress("DEPRECATION")
                        startActivityForResult(consent, REQUEST_VPN)
                    } catch (_: android.content.ActivityNotFoundException) {
                        checkMode(true)
                    }
                    return@setOnCheckedChangeListener
                }
            }
            switchMode(on)
        }
    }

    /* The radio back on what is in use (the VPN's consent refused). */
    private fun checkMode(proxy: Boolean) {
        val group = modeGroup ?: return
        for (i in 0 until group.childCount) {
            val b = group.getChildAt(i) as? RadioButton ?: continue
            if (b.tag == proxy && !b.isChecked) b.isChecked = true
        }
    }

    private fun switchMode(proxy: Boolean) {
        AppSettings.setProxyOnly(this, proxy)
        ShroudlyVpnService.log("Mode: ${if (proxy) "Proxy only" else "VPN"} (Settings)")
        showExcluded()
        showAdvancedTitle()
        if (Protection.state != Protection.State.OFF) {
            Protector.restart(this)
            android.widget.Toast.makeText(this, R.string.androidModeSwitching, android.widget.Toast.LENGTH_LONG).show()
        }
    }

    @Deprecated("Activity result API of the framework")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQUEST_VPN) return
        if (resultCode == RESULT_OK) switchMode(false) else checkMode(true)
    }

    /* The desktop's labels for the techniques (locales: strat*). */
    private fun labelOf(id: String): Int = when (id) {
        "none" -> R.string.stratNone
        "split-sni" -> R.string.stratSplitSni
        "disorder-sni" -> R.string.stratDisorderSni
        "split-sni-mid" -> R.string.stratSplitMid
        "double-split" -> R.string.stratDoubleSplit
        "split2" -> R.string.stratSplit2
        else -> R.string.stratAuto
    }

    /* The Quick Settings tile (ShroudlyTileService), one tap to turn
     * protection on and off. It is there from the start, but a phone shows a
     * tile only once the user puts it in the panel, which few find on their
     * own. Android 13 and later let the app ask (the system shows the tile
     * with Add and Don't add); before, the row says how. Gone once added,
     * and on a TV, which has no Quick Settings panel. */
    private fun showQuickTile() {
        val row = findViewById<TextView>(R.id.quickTile)
        val added = Tv.isTv(this) || getSharedPreferences("settings", MODE_PRIVATE).getBoolean(KEY_TILE_ADDED, false)
        row.visibility = if (added) View.GONE else View.VISIBLE
        findViewById<View>(R.id.quickTileDivider).visibility = row.visibility
        if (added) return
        row.text = titled(getString(R.string.androidTileAdd), ifOpen(R.id.appsTitle, getString(R.string.androidTileAddDesc)))
        row.setOnClickListener { addQuickTile() }
    }

    private fun addQuickTile() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            AlertDialog.Builder(this)
                .setTitle(R.string.androidTileAdd)
                .setMessage(R.string.androidTileHowTo)
                .setPositiveButton(android.R.string.ok, null)
                .show()
            return
        }
        val sbm = getSystemService(android.app.StatusBarManager::class.java) ?: return
        try {
            sbm.requestAddTileService(
                android.content.ComponentName(this, ShroudlyTileService::class.java),
                getString(R.string.app_name),
                android.graphics.drawable.Icon.createWithResource(this, R.drawable.ic_shield),
                mainExecutor,
            ) { result ->
                if (result == android.app.StatusBarManager.TILE_ADD_REQUEST_RESULT_TILE_ADDED ||
                    result == android.app.StatusBarManager.TILE_ADD_REQUEST_RESULT_TILE_ALREADY_ADDED) {
                    getSharedPreferences("settings", MODE_PRIVATE).edit().putBoolean(KEY_TILE_ADDED, true).apply()
                    android.widget.Toast.makeText(this, R.string.androidTileAdded, android.widget.Toast.LENGTH_SHORT).show()
                    showQuickTile()
                }
            }
        } catch (e: Exception) {
            // Some phones refuse it: then by hand, as before Android 13.
            AlertDialog.Builder(this)
                .setTitle(R.string.androidTileAdd)
                .setMessage(R.string.androidTileHowTo)
                .setPositiveButton(android.R.string.ok, null)
                .show()
        }
    }

    /* The row says how many apps skip Shroudly, or (#60) how many are the
     * only ones that go through it; with none of those, that every app does. */
    private fun showExcluded() {
        val row = findViewById<TextView>(R.id.excludedApps)
        // Proxy only has no VPN to leave apps out of: each app's own proxy
        // setting decides. Shown, but not to be changed there.
        val vpn = !AppSettings.proxyOnly(this)
        row.isEnabled = vpn
        row.alpha = if (vpn) 1f else 0.5f
        if (!vpn) {
            row.text = titled(getString(R.string.excludedApps), getString(R.string.androidAppsVpnOnly))
            return
        }
        // Under "Block connections without VPN" the apps left out have no
        // internet at all (NA-2): said with the count, always.
        val lockdown = lockdownLine()
        if (AppSettings.appsOnly(this)) {
            val n = AppSettings.included(this).size
            val sub = if (n == 0) getString(R.string.androidAppsOnlyDesc) else text(R.string.androidAppsOnlyCount, "count" to n) + lockdown
            findViewById<TextView>(R.id.excludedApps).text = titled(getString(R.string.androidAppsOnly), sub)
            return
        }
        val n = AppSettings.excluded(this).size
        val label = getString(R.string.excludedApps)
        // How many skip it is a value, always shown; what the setting does
        // only with the section's explanations.
        val sub = if (n == 0) ifOpen(R.id.appsTitle, getString(R.string.excludedAppsDesc)) else text(R.string.excludedAppsCount, "count" to n) + lockdown
        findViewById<TextView>(R.id.excludedApps).text = titled(label, sub)
    }

    /* "\n" and what lockdown means for the apps left out, when the VPN last
     * ran under it (Usage.lockdown); "" otherwise. */
    private fun lockdownLine(): String =
        if (Usage.lockdown(this) && !AppSettings.proxyOnly(this)) "\n" + getString(R.string.androidAppsLockdown) else ""

    /* The row says the app's language: the phone's, or the one chosen. */
    private fun showLanguage() {
        val tag = Lang.chosen(this)
        val i = if (tag == null) -1 else Lang.tags(this).indexOf(tag)
        findViewById<TextView>(R.id.language).text = if (i < 0) getString(R.string.languageSystem) else Lang.names(this)[i]
    }

    /* The phone's language, or one of the app's, each in its own name (issue
     * #38). Android 13 and later remake the windows by themselves; before
     * that this one is remade here and the main window when it comes back. */
    private fun pickLanguage() {
        val tags = Lang.tags(this)
        val items = arrayOf(getString(R.string.languageSystem)) + Lang.names(this)
        val now = Lang.chosen(this)
        val checked = if (now == null) 0 else tags.indexOf(now) + 1
        AlertDialog.Builder(this)
            .setTitle(R.string.language)
            .setSingleChoiceItems(items, checked) { d, which ->
                d.dismiss()
                val tag = if (which == 0) null else tags[which - 1]
                if (tag == now) return@setSingleChoiceItems
                Lang.set(this, tag)
                ShroudlyVpnService.log("Language: ${tag ?: "the phone's"} (Settings)")
                ShroudlyVpnService.channels(applicationContext)
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) recreate() else showLanguage()
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    /* The row (under the "DNS server" heading) says which one answers:
     * automatic, or the user's own. */
    private fun showDns() {
        val spec = AppSettings.customDns(this)
        val shown = if (spec == null) getString(R.string.dnsServerAuto) else CustomDns.shown(spec)
        findViewById<TextView>(R.id.dnsServer).apply {
            text = Fit.breakable(shown)
            contentDescription = "${getString(R.string.dnsServer)}: $shown"
        }
    }

    /* The row (under "Your own server"): the one in use, never its password,
     * or that there is none. */
    private fun showOwnServer() {
        val l = AppSettings.ownServer(this)
        val shown = if (l == null) getString(R.string.ownServer) else text(R.string.ownServerInUse, "server" to OwnServer.describe(l))
        findViewById<TextView>(R.id.ownServer).apply {
            text = Fit.breakable(shown)
            contentDescription = if (l == null) shown else "${getString(R.string.ownServer)}: $shown"
        }
    }

    /* "Your own server", as on the desktop: a link, tested before it is used
     * (a site's certificate has to come through it); one that does not work
     * is used only when "Use anyway" is pressed. "Stop using" when one is set. */
    private fun pickOwnServer() {
        val density = resources.displayMetrics.density
        val pad = (16 * density).toInt()
        val typed = AppSettings.ownServerTyped(this)
        val desc = TextView(this).apply {
            text = getString(R.string.ownServerDesc)
            setTextColor(getColor(R.color.text_dim))
            textSize = 13f
            setPadding(0, 0, 0, pad / 2)
        }
        val input = EditText(this).apply {
            setSingleLine()
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_URI
            imeOptions = android.view.inputmethod.EditorInfo.IME_ACTION_DONE
            textDirection = View.TEXT_DIRECTION_LTR
            setText(typed)
            hint = "socks5://1.2.3.4:1080 · ss://…"
            setHintTextColor(getColor(R.color.text_faint))
        }
        val status = TextView(this).apply { textSize = 13f; setTextColor(getColor(R.color.text_dim)) }
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad / 2, pad, 0)
            addView(desc)
            addView(input)
            addView(status)
        }
        Fit.apply(box)
        var failed: String? = null
        val b = AlertDialog.Builder(this)
            .setTitle(R.string.ownServer)
            .setView(ScrollView(this).apply { addView(box) })
            .setPositiveButton(R.string.dnsServerUse, null)
            .setNegativeButton(android.R.string.cancel, null)
        if (typed.isNotEmpty()) b.setNeutralButton(R.string.ownServerOff, null)
        val dialog = b.create()
        fun save(link: String?) {
            AppSettings.setOwnServer(this, link)
            val l = link?.let { OwnServer.parse(it).link }
            ShroudlyVpnService.log(if (l == null) "Your own server: off; sites go straight again" else "Your own server: ${OwnServer.describe(l)}; every site goes through it")
            showOwnServer()
            showAdvancedTitle()
            tell("ownServer")
        }
        dialog.setOnShowListener {
            val use = dialog.getButton(AlertDialog.BUTTON_POSITIVE)
            fun reset() { failed = null; use.setText(R.string.dnsServerUse); status.text = "" }
            dialog.getButton(AlertDialog.BUTTON_NEUTRAL)?.setOnClickListener { save(null); dialog.dismiss() }
            input.setOnEditorActionListener { _, action, _ ->
                if (action == android.view.inputmethod.EditorInfo.IME_ACTION_DONE && use.isEnabled) { use.performClick(); true } else false
            }
            input.addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
                override fun afterTextChanged(s: Editable?) { if (failed != null) reset() else status.text = "" }
            })
            use.setOnClickListener {
                val link = input.text.toString().trim()
                val parsed = OwnServer.parse(link)
                val l = parsed.link
                val bad = if (l == null) parsed.error else null
                if (bad != null) {
                    status.setTextColor(getColor(R.color.warn))
                    status.text = when (bad) {
                        "method" -> text(R.string.ownServerErrMethod, "method" to (parsed.method ?: l?.method ?: ""))
                        "user" -> getString(R.string.ownServerErrUser)
                        else -> getString(R.string.ownServerErrFormat)
                    }
                    return@setOnClickListener
                }
                if (failed == link) { save(link); dialog.dismiss(); return@setOnClickListener }
                if (link == typed) { dialog.dismiss(); return@setOnClickListener }
                use.isEnabled = false
                status.setTextColor(getColor(R.color.text_dim))
                status.text = getString(R.string.testing)
                Thread {
                    val t0 = System.nanoTime()
                    val why = OwnServer.test(l!!)
                    val ms = (System.nanoTime() - t0) / 1_000_000
                    runOnUiThread {
                        if (isFinishing || !dialog.isShowing) return@runOnUiThread
                        use.isEnabled = true
                        if (input.text.toString().trim() != link) return@runOnUiThread
                        if (why == null) {
                            save(link)
                            android.widget.Toast.makeText(this, text(R.string.ownServerOk, "ms" to ms), android.widget.Toast.LENGTH_LONG).show()
                            dialog.dismiss()
                        } else {
                            failed = link
                            status.setTextColor(getColor(R.color.warn))
                            status.text = text(R.string.ownServerFails, "why" to getString(OwnServer.whyRes(why)))
                            use.setText(R.string.dnsServerUseAnyway)
                        }
                    }
                }.apply { isDaemon = true }.start()
            }
        }
        dialog.show()
    }

    private val dnsKinds = listOf(
        Triple("doh", R.string.dnsKindDoh, "https://dns.google/dns-query"),
        Triple("dot", R.string.dnsKindDot, "dns.quad9.net"),
        Triple("tcp", R.string.dnsKindTcp, "8.8.8.8"),
        Triple("udp", R.string.dnsKindUdp, "1.1.1.1"),
    )

    /* "DNS server" (issue #34), as on the desktop: automatic, or a kind and
     * an address. What is typed is asked once before it is used and the
     * answer shown; one that does not answer is used only when "Use anyway"
     * is pressed (if it stops answering later, the built-in DNS answers
     * meanwhile, unless "Only this server" is ticked). */
    private fun pickDns() {
        val density = resources.displayMetrics.density
        val pad = (16 * density).toInt()
        val typed = AppSettings.customDnsTyped(this)
        var kind = typed?.first ?: "auto"
        val group = RadioGroup(this)
        val input = EditText(this).apply {
            setSingleLine()
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_URI
            imeOptions = android.view.inputmethod.EditorInfo.IME_ACTION_DONE
            textDirection = View.TEXT_DIRECTION_LTR
            setText(typed?.second ?: "")
            // An example, not a value: dim, as an empty field's hint is.
            setHintTextColor(getColor(R.color.text_faint))
        }
        val status = TextView(this).apply { textSize = 13f; setTextColor(getColor(R.color.text_dim)) }
        // Through a proxy of the user's own (#58): not for UDP.
        val proxyLabel = TextView(this).apply {
            text = getString(R.string.dnsServerProxy)
            textSize = 14f
            setTextColor(getColor(R.color.text))
            setPadding(0, pad / 2, 0, 0)
        }
        val proxyInput = EditText(this).apply {
            setSingleLine()
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_URI
            imeOptions = android.view.inputmethod.EditorInfo.IME_ACTION_DONE
            textDirection = View.TEXT_DIRECTION_LTR
            hint = "socks5://127.0.0.1:1080"
            setHintTextColor(getColor(R.color.text_faint))
            setText(AppSettings.customDnsProxyTyped(this@SettingsActivity))
        }
        val proxyDesc = TextView(this).apply {
            text = getString(R.string.dnsServerProxyDesc)
            setTextColor(getColor(R.color.text_dim))
            textSize = 12.5f
        }
        // Nothing else asked, not even when it does not answer (issue #34).
        val strict = CheckBox(this).apply {
            text = getString(R.string.dnsServerStrict)
            textSize = 15f
            setTextColor(getColor(R.color.text))
            textAlignment = View.TEXT_ALIGNMENT_VIEW_START
            minHeight = (48 * density).toInt()
            isChecked = AppSettings.customDnsStrict(this@SettingsActivity)
        }
        val strictDesc = TextView(this).apply {
            text = getString(R.string.dnsServerStrictDesc)
            setTextColor(getColor(R.color.text_dim))
            textSize = 12.5f
        }
        fun option(id: String, label: String) = RadioButton(this).apply {
            this.id = View.generateViewId()
            tag = id
            text = label
            textSize = 15f
            setTextColor(getColor(R.color.text))
            textAlignment = View.TEXT_ALIGNMENT_VIEW_START
            minHeight = (48 * density).toInt()
            isChecked = id == kind
        }
        group.addView(option("auto", getString(R.string.dnsServerAuto)))
        for ((id, label, _) in dnsKinds) group.addView(option(id, getString(label)))
        fun example() = dnsKinds.firstOrNull { it.first == kind }?.third ?: ""
        // What a server of one's own does: said once one is chosen.
        val desc = TextView(this).apply {
            text = getString(R.string.dnsServerDesc)
            setTextColor(getColor(R.color.text_dim))
            textSize = 12.5f
            setPadding(0, pad / 2, 0, pad / 2)
        }
        fun showInput() {
            val v = if (kind == "auto") View.GONE else View.VISIBLE
            input.visibility = v; strict.visibility = v; strictDesc.visibility = v; desc.visibility = v
            val p = if (kind == "auto" || kind == "udp") View.GONE else View.VISIBLE
            proxyLabel.visibility = p; proxyInput.visibility = p; proxyDesc.visibility = p
            input.hint = example()
        }
        fun proxyText() = if (kind == "udp") "" else proxyInput.text.toString().trim()
        showInput()
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad / 2, pad, 0)
            addView(group)
            addView(input)
            addView(status)
            addView(proxyLabel)
            addView(proxyInput)
            addView(proxyDesc)
            addView(desc)
            // The exception to the line above.
            addView(strict)
            addView(strictDesc)
        }
        // Its description lines up with the box's text, not the box.
        strict.post { strictDesc.setPaddingRelative(strict.compoundPaddingStart, 0, 0, pad / 2) }
        Fit.apply(box)
        // What was asked last and did not answer: pressing again uses it anyway.
        var failed: String? = null
        val dialog = AlertDialog.Builder(this)
            .setTitle(R.string.dnsServer)
            .setView(ScrollView(this).apply { addView(box) })
            .setPositiveButton(R.string.dnsServerUse, null)
            .setNegativeButton(android.R.string.cancel, null)
            .create()
        fun save(k: String?, t: String?) {
            AppSettings.setCustomDns(this, k, t, strict.isChecked, proxyText())
            ShroudlyVpnService.log(if (k == null) "DNS server: automatic" else "DNS server: ${CustomDns.parse(k, t ?: "").first?.let { CustomDns.shown(it) } ?: t}${if (strict.isChecked) " (only this one)" else ""}")
            if (k != null) CustomDns.parseProxy(proxyText()).first?.let { ShroudlyVpnService.log("DNS server proxy: ${CustomDns.shownProxy(it)}") }
            showDns()
            tell("dns")
        }
        dialog.setOnShowListener {
            val use = dialog.getButton(AlertDialog.BUTTON_POSITIVE)
            fun reset() { failed = null; use.setText(R.string.dnsServerUse); status.text = "" }
            group.setOnCheckedChangeListener { g, checkedId ->
                kind = g.findViewById<RadioButton>(checkedId)?.tag as? String ?: return@setOnCheckedChangeListener
                input.setText(if (typed != null && kind == typed.first) typed.second else "")
                showInput(); reset()
                // A kind picked: straight on to typing its address.
                if (kind != "auto") {
                    input.requestFocus()
                    input.post { getSystemService(android.view.inputmethod.InputMethodManager::class.java)?.showSoftInput(input, 0) }
                }
            }
            // The server in use already: the choice applies at once.
            strict.setOnCheckedChangeListener { _, _ ->
                if (typed != null && typed.first == kind && typed.second == input.text.toString().trim()) save(kind, typed.second)
            }
            input.setOnEditorActionListener { _, action, _ ->
                if (action == android.view.inputmethod.EditorInfo.IME_ACTION_DONE && use.isEnabled) { use.performClick(); true } else false
            }
            input.addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
                override fun afterTextChanged(s: Editable?) { if (failed != null) reset() else status.text = "" }
            })
            proxyInput.setOnEditorActionListener { _, action, _ ->
                if (action == android.view.inputmethod.EditorInfo.IME_ACTION_DONE && use.isEnabled) { use.performClick(); true } else false
            }
            proxyInput.addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
                override fun afterTextChanged(s: Editable?) { if (failed != null) reset() else status.text = "" }
            })
            use.setOnClickListener {
                if (kind == "auto") {
                    if (typed != null) save(null, null)
                    dialog.dismiss()
                    return@setOnClickListener
                }
                val server = input.text.toString().trim()
                val (spec, err) = CustomDns.parse(kind, server)
                if (spec == null) {
                    status.setTextColor(getColor(R.color.warn))
                    status.text = text(when (err) {
                        "empty" -> R.string.dnsErrorEmpty
                        "url" -> R.string.dnsErrorUrl
                        "port" -> R.string.dnsErrorPort
                        else -> R.string.dnsErrorHost
                    }, "example" to example())
                    return@setOnClickListener
                }
                val px = proxyText()
                val (proxy, proxyErr) = CustomDns.parseProxy(px)
                if (proxyErr != null) {
                    status.setTextColor(getColor(R.color.warn))
                    status.text = getString(R.string.dnsErrorProxy)
                    return@setOnClickListener
                }
                if (failed == "$kind $server $px") { save(kind, server); dialog.dismiss(); return@setOnClickListener }
                if (typed != null && typed.first == kind && typed.second == server && AppSettings.customDnsProxyTyped(this) == px) { dialog.dismiss(); return@setOnClickListener }
                use.isEnabled = false
                status.setTextColor(getColor(R.color.text_dim))
                status.text = getString(R.string.testing)
                val asked = "$kind $server $px"
                Thread {
                    val r = testDns(spec, proxy)
                    runOnUiThread {
                        if (isFinishing || !dialog.isShowing) return@runOnUiThread
                        use.isEnabled = true
                        if ("$kind ${input.text.toString().trim()} ${proxyText()}" != asked) return@runOnUiThread
                        if (r.first != null) {
                            save(kind, server)
                            android.widget.Toast.makeText(this, text(R.string.dnsServerOk, "ms" to r.first!!, "address" to r.second), android.widget.Toast.LENGTH_LONG).show()
                            dialog.dismiss()
                        } else {
                            failed = asked
                            status.setTextColor(getColor(R.color.warn))
                            status.text = text(R.string.dnsServerFails, "error" to r.second)
                            use.setText(R.string.dnsServerUseAnyway)
                        }
                    }
                }.apply { isDaemon = true }.start()
            }
        }
        dialog.show()
    }

    /* Does it answer? (ms, address) or (null, why). Asked twice, the second
     * time on the connection the first opened; a name looked up through the
     * built-in routes. Not on the main thread. */
    private fun testDns(spec: DnsSpec, proxy: DnsProxy? = null): Pair<Long?, String> {
        val routes = DohForwarder({}, null) {}
        val d = CustomDns(spec, { 0 }, { null }, proxy) { name ->
            Dns.firstA(routes.resolveRoutes(Dns.buildQuery(name, Dns.TYPE_A, 1), System.nanoTime() / 1_000_000 + DohForwarder.ANSWER_BY_MS))
        }
        return try {
            d.query(Dns.buildQuery("cloudflare.com", Dns.TYPE_A, 2))
            val t0 = System.nanoTime()
            val a = d.query(Dns.buildQuery("example.com", Dns.TYPE_A, 3))
            val ms = (System.nanoTime() - t0) / 1_000_000
            Dns.firstA(a)?.let { ms to it } ?: (null to "rcode ${a[3].toInt() and 15}")
        } catch (e: Exception) {
            null to (if (e is java.net.ConnectException) "ECONNREFUSED" else if (e is java.net.SocketTimeoutException) "timeout" else e.message ?: e.javaClass.simpleName).take(80)
        } finally {
            d.close()
        }
    }

    /* A running protection takes the change at once. */
    private fun tell(what: String) {
        Protector.tell(this, ShroudlyVpnService.ACTION_SETTINGS, what)
    }

    private class App(val pkg: String, val label: String, val icon: Drawable?)

    /* The apps that can be opened (their launcher entries), by name, with a
     * search field; the ones checked skip Shroudly, or (#60) are the only ones
     * that go through it. Each way keeps its own list. */
    @android.annotation.SuppressLint("SetTextI18n")
    private fun pickApps() {
        val pm = packageManager
        // A TV's apps are in its own launcher (LEANBACK_LAUNCHER); some have no other entry.
        val infos = listOf(Intent.CATEGORY_LAUNCHER, Intent.CATEGORY_LEANBACK_LAUNCHER).flatMap { category ->
            val launcher = Intent(Intent.ACTION_MAIN).addCategory(category)
            if (Build.VERSION.SDK_INT >= 33) pm.queryIntentActivities(launcher, PackageManager.ResolveInfoFlags.of(0))
            else @Suppress("DEPRECATION") pm.queryIntentActivities(launcher, 0)
        }
        val all = infos.map { it.activityInfo.packageName }.distinct().filter { it != packageName }.map { pkg ->
            val ai = try { pm.getApplicationInfo(pkg, 0) } catch (_: PackageManager.NameNotFoundException) { null }
            App(pkg, ai?.let { pm.getApplicationLabel(it).toString() } ?: pkg, ai?.let { pm.getApplicationIcon(it) })
        }.sortedBy { it.label.lowercase() }
        var only = AppSettings.appsOnly(this)
        val skip = AppSettings.excluded(this).toMutableSet()
        val through = AppSettings.included(this).toMutableSet()
        fun chosen() = if (only) through else skip
        var shown = all

        val density = resources.displayMetrics.density
        val iconSize = (32 * density).toInt()
        val adapter = object : BaseAdapter() {
            override fun getCount() = shown.size
            override fun getItem(position: Int) = shown[position]
            override fun getItemId(position: Int) = position.toLong()
            override fun getView(position: Int, convertView: View?, parent: ViewGroup?): View {
                val row = (convertView as? LinearLayout) ?: LinearLayout(this@SettingsActivity).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = android.view.Gravity.CENTER_VERTICAL
                    val pad = (10 * density).toInt()
                    setPadding(pad, pad / 2, pad, pad / 2)
                    addView(ImageView(context).apply { layoutParams = LinearLayout.LayoutParams(iconSize, iconSize); importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO })
                    addView(TextView(context).apply {
                        layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = (12 * density).toInt() }
                        textSize = 15f
                        setTextColor(getColor(R.color.text))
                        textAlignment = View.TEXT_ALIGNMENT_VIEW_START
                    })
                    addView(CheckBox(context).apply { isClickable = false; isFocusable = false })
                }
                val app = shown[position]
                (row.getChildAt(0) as ImageView).setImageDrawable(app.icon)
                (row.getChildAt(1) as TextView).text = app.label
                (row.getChildAt(2) as CheckBox).isChecked = app.pkg in chosen()
                row.contentDescription = app.label
                return row
            }
        }
        val list = ListView(this)
        list.setOnItemClickListener { _, view, position, _ ->
            // The radios and the description above the apps are the list's header.
            val app = shown.getOrNull(position - list.headerViewsCount) ?: return@setOnItemClickListener
            if (!chosen().remove(app.pkg)) chosen().add(app.pkg)
            ((view as LinearLayout).getChildAt(2) as CheckBox).isChecked = app.pkg in chosen()
        }
        val search = EditText(this).apply {
            hint = getString(R.string.searchApps)
            setSingleLine()
            addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
                override fun afterTextChanged(s: Editable?) {
                    val q = s?.toString()?.trim()?.lowercase().orEmpty()
                    shown = if (q.isEmpty()) all else all.filter { q in it.label.lowercase() || q in it.pkg.lowercase() }
                    adapter.notifyDataSetChanged()
                }
            })
        }
        val pad = (16 * density).toInt()
        val desc = TextView(this).apply {
            setTextColor(getColor(R.color.text_dim))
            textSize = 13f
        }
        fun describe() { desc.text = getString(if (only) R.string.androidAppsOnlyDesc else R.string.excludedAppsDesc) + lockdownLine() }
        describe()
        // Which way the list works.
        val ways = RadioGroup(this).apply {
            orientation = RadioGroup.VERTICAL
            val skipWay = RadioButton(context).apply { id = View.generateViewId(); text = getString(R.string.androidAppsModeSkip); textSize = 15f }
            val onlyWay = RadioButton(context).apply { id = View.generateViewId(); text = getString(R.string.androidAppsModeOnly); textSize = 15f }
            addView(skipWay); addView(onlyWay)
            check(if (only) onlyWay.id else skipWay.id)
            setOnCheckedChangeListener { _, checked ->
                only = checked == onlyWay.id
                describe()
                adapter.notifyDataSetChanged()
            }
        }
        // The search stays at the top; the radios and the description scroll
        // away with the apps, and the list takes all the room the dialog has.
        // Up to 2.6.44 they sat above a list of half the screen's height, and
        // with large text, a small phone or the phone held sideways no app
        // was left to tick.
        list.addHeaderView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(ways)
            addView(desc)
        }, null, false)
        list.adapter = adapter
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad / 2, pad, 0)
            addView(search)
            addView(list, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        }
        AlertDialog.Builder(this)
            .setTitle(R.string.androidAppsSection)
            .setView(box)
            .setPositiveButton(android.R.string.ok) { _, _ ->
                if (only != AppSettings.appsOnly(this) || skip != AppSettings.excluded(this) || through != AppSettings.included(this)) {
                    AppSettings.setAppsOnly(this, only)
                    AppSettings.setExcluded(this, skip)
                    AppSettings.setIncluded(this, through)
                    showExcluded()
                    tell("apps")
                }
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun edgeToEdge() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.VANILLA_ICE_CREAM) {
            @Suppress("DEPRECATION")
            window.setDecorFitsSystemWindows(false)
        }
        findViewById<View>(R.id.frame).setOnApplyWindowInsetsListener { v, insets ->
            val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
    }
}
