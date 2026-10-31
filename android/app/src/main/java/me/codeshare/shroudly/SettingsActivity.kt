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
 * Settings: the technique (as the desktop's "Bypass strategy"), the DNS
 * server, the apps that skip Shroudly, starting when the phone starts, and
 * automation apps (AppSettings). A change
 * reaches a running protection at once (ShroudlyVpnService.ACTION_SETTINGS).
 *
 * Under a bar with the title and a way back, as any Android screen has. A
 * setting shows its title (and its value: a language, a count); what it
 * does is explained under it only once its section's (i) is tapped, so the
 * screen is not a wall of text (issue #47).
 */
class SettingsActivity : Activity() {
    private companion object {
        /* The Quick Settings tile was added (or found there) from Settings. */
        const val KEY_TILE_ADDED = "quickTileAdded"
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
                // The label, and the engine's spec under it, smaller and dimmer
                // (with the section's explanations).
                strategies += this to { titled(label, ifOpen(R.id.strategyTitle, s.spec), 12f) }
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
        }
        redraw[R.id.strategyTitle] = { for ((b, t) in strategies) b.text = t() }

        findViewById<TextView>(R.id.language).setOnClickListener { pickLanguage() }
        showLanguage()

        findViewById<TextView>(R.id.dnsServer).setOnClickListener { pickDns() }
        showDns()

        // QUIC and IPv6 off (#59): the engine again with its options.
        findViewById<Switch>(R.id.quicOff).apply {
            isChecked = AppSettings.quicOff(this@SettingsActivity)
            setOnCheckedChangeListener { _, on -> AppSettings.setQuicOff(this@SettingsActivity, on); tell("network") }
        }
        findViewById<Switch>(R.id.ipv6Off).apply {
            isChecked = AppSettings.ipv6Off(this@SettingsActivity)
            setOnCheckedChangeListener { _, on -> AppSettings.setIpv6Off(this@SettingsActivity, on); tell("network") }
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
            }
        }
        showApps()
        redraw[R.id.appsTitle] = { showApps() }
        explanations()
        Fit.apply(findViewById(R.id.root))
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
     * phone, automation apps, and (in showExcluded, showQuickTile) the apps
     * that skip Shroudly and the Quick Settings tile. */
    private fun showApps() {
        findViewById<Switch>(R.id.startAtBoot).text =
            titled(getString(R.string.androidStartAtBoot), ifOpen(R.id.appsTitle, getString(R.string.androidStartAtBootDesc)))
        // The names break only after a dot, never inside a word.
        findViewById<Switch>(R.id.remoteControl).text = titled(getString(R.string.androidRemoteControl), ifOpen(R.id.appsTitle,
            text(R.string.androidRemoteControlDesc, "package" to Fit.breakable(packageName), "action" to Fit.breakable(AutomationReceiver.ACTION_START.substringBeforeLast('.')))))
        showExcluded()
        showQuickTile()
    }

    /* Appearance: the accents as round swatches, the chosen one ringed. A
     * choice is kept and the window made again in it (the main window follows
     * when it comes back). */
    private fun showAccents() {
        val row = findViewById<LinearLayout>(R.id.accents)
        val density = resources.displayMetrics.density
        val size = (34 * density).toInt()
        val gap = (10 * density).toInt()
        val chosen = Accent.id(this)
        for (o in Accent.OPTIONS) {
            row.addView(View(this).apply {
                layoutParams = LinearLayout.LayoutParams(size, size).apply { marginEnd = gap; topMargin = gap / 2; bottomMargin = gap / 2 }
                background = android.graphics.drawable.GradientDrawable().apply {
                    shape = android.graphics.drawable.GradientDrawable.OVAL
                    setColor(o.swatch)
                    if (o.id == chosen) setStroke((3 * density).toInt(), getColor(R.color.text))
                }
                contentDescription = if (o.id == "logo") getString(R.string.app_name) else o.id
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

    /* VPN or proxy only, each with what it means; a change while protection
     * is on takes effect at the next start (the window says so). */
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
        group.addView(option(true, R.string.androidModeProxy, text(R.string.androidModeProxyDesc, "port" to ShroudlyProxyService.PORT)))
        redraw[R.id.modeTitle] = { for ((b, t) in options) b.text = t() }
        group.setOnCheckedChangeListener { g, checkedId ->
            val on = g.findViewById<RadioButton>(checkedId)?.tag as? Boolean ?: return@setOnCheckedChangeListener
            if (on == AppSettings.proxyOnly(this)) return@setOnCheckedChangeListener
            AppSettings.setProxyOnly(this, on)
            if (Protection.state != Protection.State.OFF) {
                android.widget.Toast.makeText(this, R.string.androidModeNextStart, android.widget.Toast.LENGTH_LONG).show()
            }
        }
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
     * with Add and Don't add); before, the row says how. Gone once added. */
    private fun showQuickTile() {
        val row = findViewById<TextView>(R.id.quickTile)
        val added = getSharedPreferences("settings", MODE_PRIVATE).getBoolean(KEY_TILE_ADDED, false)
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
        if (AppSettings.appsOnly(this)) {
            val n = AppSettings.included(this).size
            val sub = if (n == 0) getString(R.string.androidAppsOnlyDesc) else text(R.string.androidAppsOnlyCount, "count" to n)
            findViewById<TextView>(R.id.excludedApps).text = titled(getString(R.string.androidAppsOnly), sub)
            return
        }
        val n = AppSettings.excluded(this).size
        val label = getString(R.string.excludedApps)
        // How many skip it is a value, always shown; what the setting does
        // only with the section's explanations.
        val sub = if (n == 0) ifOpen(R.id.appsTitle, getString(R.string.excludedAppsDesc)) else text(R.string.excludedAppsCount, "count" to n)
        findViewById<TextView>(R.id.excludedApps).text = titled(label, sub)
    }

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
        fun showInput() {
            val v = if (kind == "auto") View.GONE else View.VISIBLE
            input.visibility = v; strict.visibility = v; strictDesc.visibility = v
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
            addView(TextView(context).apply {
                text = getString(R.string.dnsServerDesc)
                setTextColor(getColor(R.color.text_dim))
                textSize = 12.5f
                setPadding(0, pad / 2, 0, pad / 2)
            })
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
    private fun pickApps() {
        val pm = packageManager
        val launcher = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val infos = if (Build.VERSION.SDK_INT >= 33) pm.queryIntentActivities(launcher, PackageManager.ResolveInfoFlags.of(0))
        else @Suppress("DEPRECATION") pm.queryIntentActivities(launcher, 0)
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
        val list = ListView(this).apply {
            this.adapter = adapter
            setOnItemClickListener { _, view, position, _ ->
                val app = shown[position]
                if (!chosen().remove(app.pkg)) chosen().add(app.pkg)
                ((view as LinearLayout).getChildAt(2) as CheckBox).isChecked = app.pkg in chosen()
            }
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
        fun describe() { desc.text = getString(if (only) R.string.androidAppsOnlyDesc else R.string.excludedAppsDesc) }
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
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad / 2, pad, 0)
            addView(ways)
            addView(desc)
            addView(search)
            addView(list, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, (resources.displayMetrics.heightPixels * 0.5).toInt()))
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
