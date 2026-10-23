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

/*
 * Settings: the technique (as the desktop's "Bypass strategy"), the DNS
 * server, the apps that skip Shroudly, starting when the phone starts, and
 * automation apps (AppSettings). A change
 * reaches a running protection at once (ShroudlyVpnService.ACTION_SETTINGS).
 */
class SettingsActivity : Activity() {
    // In the language chosen below (Lang; before Android 13).
    override fun attachBaseContext(base: android.content.Context) = super.attachBaseContext(Lang.wrap(base))

    override fun onCreate(savedInstanceState: Bundle?) {
        Accent.apply(this)
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)
        edgeToEdge()
        showAccents()
        showMode()

        val group = findViewById<RadioGroup>(R.id.strategy)
        val current = AppSettings.strategy(this).id
        for ((i, s) in AppSettings.STRATEGIES.withIndex()) {
            val label = getString(labelOf(s.id))
            group.addView(RadioButton(this).apply {
                id = View.generateViewId()
                tag = s.id
                // The label, and the engine's spec under it, smaller and dimmer.
                text = SpannableStringBuilder(label).append('\n').apply {
                    val from = length
                    append(s.spec)
                    setSpan(ForegroundColorSpan(getColor(R.color.text_dim)), from, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                    setSpan(RelativeSizeSpan(12f / 15f), from, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
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

        findViewById<TextView>(R.id.language).setOnClickListener { pickLanguage() }
        showLanguage()

        findViewById<TextView>(R.id.dnsServer).setOnClickListener { pickDns() }
        showDns()

        findViewById<TextView>(R.id.excludedApps).setOnClickListener { pickApps() }
        showExcluded()

        findViewById<Switch>(R.id.startAtBoot).apply {
            val desc = getString(R.string.androidStartAtBootDesc)
            text = SpannableStringBuilder(getString(R.string.androidStartAtBoot)).append('\n').apply {
                val from = length
                append(desc)
                setSpan(ForegroundColorSpan(getColor(R.color.text_dim)), from, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                setSpan(RelativeSizeSpan(12.5f / 15f), from, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            }
            isChecked = AppSettings.startAtBoot(this@SettingsActivity)
            setOnCheckedChangeListener { _, on -> AppSettings.setStartAtBoot(this@SettingsActivity, on) }
        }

        // Automation apps: what to send, under the switch.
        findViewById<Switch>(R.id.remoteControl).apply {
            // The names break only after a dot, never inside a word.
            val desc = text(R.string.androidRemoteControlDesc, "package" to Fit.breakable(packageName), "action" to Fit.breakable(AutomationReceiver.ACTION_START.substringBeforeLast('.')))
            text = SpannableStringBuilder(getString(R.string.androidRemoteControl)).append('\n').apply {
                val from = length
                append(desc)
                setSpan(ForegroundColorSpan(getColor(R.color.text_dim)), from, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                setSpan(RelativeSizeSpan(12.5f / 15f), from, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            }
            isChecked = AppSettings.remoteControl(this@SettingsActivity)
            setOnCheckedChangeListener { _, on ->
                AppSettings.setRemoteControl(this@SettingsActivity, on)
                ShroudlyVpnService.log(if (on) "Automation apps allowed (Settings)" else "Automation apps no longer allowed (Settings)")
            }
        }
        Fit.apply(findViewById(R.id.root))
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
        fun option(on: Boolean, label: Int, desc: String) = RadioButton(this).apply {
            id = View.generateViewId()
            tag = on
            text = SpannableStringBuilder(getString(label)).append('\n').apply {
                val from = length
                append(desc)
                setSpan(ForegroundColorSpan(getColor(R.color.text_dim)), from, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                setSpan(RelativeSizeSpan(12.5f / 15f), from, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            }
            textSize = 15f
            setTextColor(getColor(R.color.text))
            textAlignment = View.TEXT_ALIGNMENT_VIEW_START
            setPadding(pad, pad, pad, pad)
            isChecked = on == proxy
        }
        group.addView(option(false, R.string.androidModeVpn, getString(R.string.androidModeVpnDesc)))
        group.addView(option(true, R.string.androidModeProxy, text(R.string.androidModeProxyDesc, "port" to ShroudlyProxyService.PORT)))
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

    /* The row says how many apps skip Shroudly. */
    private fun showExcluded() {
        val n = AppSettings.excluded(this).size
        val label = getString(R.string.excludedApps)
        val sub = if (n == 0) getString(R.string.excludedAppsDesc) else text(R.string.excludedAppsCount, "count" to n)
        findViewById<TextView>(R.id.excludedApps).text = SpannableStringBuilder(label).append('\n').apply {
            val from = length
            append(sub)
            setSpan(ForegroundColorSpan(getColor(R.color.text_dim)), from, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            setSpan(RelativeSizeSpan(12.5f / 15f), from, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
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
            input.hint = example()
        }
        showInput()
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad / 2, pad, 0)
            addView(group)
            addView(input)
            addView(status)
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
            AppSettings.setCustomDns(this, k, t, strict.isChecked)
            ShroudlyVpnService.log(if (k == null) "DNS server: automatic" else "DNS server: ${CustomDns.parse(k, t ?: "").first?.let { CustomDns.shown(it) } ?: t}${if (strict.isChecked) " (only this one)" else ""}")
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
                if (failed == "$kind $server") { save(kind, server); dialog.dismiss(); return@setOnClickListener }
                if (typed != null && typed.first == kind && typed.second == server) { dialog.dismiss(); return@setOnClickListener }
                use.isEnabled = false
                status.setTextColor(getColor(R.color.text_dim))
                status.text = getString(R.string.testing)
                val asked = "$kind $server"
                Thread {
                    val r = testDns(spec)
                    runOnUiThread {
                        if (isFinishing || !dialog.isShowing) return@runOnUiThread
                        use.isEnabled = true
                        if ("$kind ${input.text.toString().trim()}" != asked) return@runOnUiThread
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
    private fun testDns(spec: DnsSpec): Pair<Long?, String> {
        val routes = DohForwarder({}, null) {}
        val d = CustomDns(spec, { 0 }, { null }) { name ->
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
     * search field; the ones checked skip Shroudly. */
    private fun pickApps() {
        val pm = packageManager
        val launcher = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val infos = if (Build.VERSION.SDK_INT >= 33) pm.queryIntentActivities(launcher, PackageManager.ResolveInfoFlags.of(0))
        else @Suppress("DEPRECATION") pm.queryIntentActivities(launcher, 0)
        val all = infos.map { it.activityInfo.packageName }.distinct().filter { it != packageName }.map { pkg ->
            val ai = try { pm.getApplicationInfo(pkg, 0) } catch (_: PackageManager.NameNotFoundException) { null }
            App(pkg, ai?.let { pm.getApplicationLabel(it).toString() } ?: pkg, ai?.let { pm.getApplicationIcon(it) })
        }.sortedBy { it.label.lowercase() }
        val chosen = AppSettings.excluded(this).toMutableSet()
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
                (row.getChildAt(2) as CheckBox).isChecked = app.pkg in chosen
                row.contentDescription = app.label
                return row
            }
        }
        val list = ListView(this).apply {
            this.adapter = adapter
            setOnItemClickListener { _, view, position, _ ->
                val app = shown[position]
                if (!chosen.remove(app.pkg)) chosen += app.pkg
                ((view as LinearLayout).getChildAt(2) as CheckBox).isChecked = app.pkg in chosen
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
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad / 2, pad, 0)
            addView(TextView(context).apply {
                text = getString(R.string.excludedAppsDesc)
                setTextColor(getColor(R.color.text_dim))
                textSize = 13f
            })
            addView(search)
            addView(list, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, (resources.displayMetrics.heightPixels * 0.5).toInt()))
        }
        AlertDialog.Builder(this)
            .setTitle(R.string.excludedApps)
            .setView(box)
            .setPositiveButton(android.R.string.ok) { _, _ ->
                if (chosen != AppSettings.excluded(this)) {
                    AppSettings.setExcluded(this, chosen)
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
        findViewById<ScrollView>(R.id.root).setOnApplyWindowInsetsListener { v, insets ->
            val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
    }
}
