package me.codeshare.shroudly

import android.app.Activity
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.TextWatcher
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView

/*
 * Connections (issue #74; the main window's Connections tile opens it):
 * what went through Shroudly, by site, as the engine counts it (Conns), with
 * the data each way, how many are open now and how each went out; a site
 * blocked here has its connections ended and new ones refused. Shroudly's own
 * names are marked, and blocking one asks first. Asked again every two
 * seconds while on screen. Built in code: one list, no layout of its own.
 */
class ConnectionsActivity : Activity() {
    override fun attachBaseContext(base: android.content.Context) = super.attachBaseContext(Lang.wrap(base))

    private val main = Handler(Looper.getMainLooper())
    private lateinit var list: LinearLayout
    private lateinit var empty: TextView
    private lateinit var blockTyped: Button
    private lateinit var torTyped: Button
    private lateinit var torDesc: TextView
    private lateinit var appsBox: LinearLayout
    private val appSwitches = HashMap<String, Switch>()
    private var settingApps = false
    private lateinit var search: EditText
    private var shown = true

    private fun dp(v: Float) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, resources.displayMetrics).toInt()

    private fun label(size: Float, color: Int, bold: Boolean = false) = TextView(this).apply {
        setTextSize(TypedValue.COMPLEX_UNIT_SP, size)
        setTextColor(getColor(color))
        if (bold) setTypeface(typeface, Typeface.BOLD)
        textAlignment = View.TEXT_ALIGNMENT_VIEW_START
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        Accent.apply(this)
        super.onCreate(savedInstanceState)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16f), dp(16f), dp(16f), dp(16f))
        }
        root.addView(label(20f, R.color.text, true).apply { setText(R.string.connsTitle) })
        root.addView(label(13f, R.color.text_dim).apply { setText(R.string.connsDesc); setPadding(0, dp(4f), 0, dp(6f)) })
        torDesc = label(13f, R.color.text_dim).apply { setText(R.string.connsTorDesc); setPadding(0, 0, 0, dp(12f)) }
        root.addView(torDesc)
        // "Apps always through Tor": a whole app picked at once (its names,
        // and its addresses for one that connects by address). A switch
        // each: one tap on a phone, one press of the remote on a TV.
        appsBox = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(0, 0, 0, dp(12f)) }
        appsBox.addView(label(15f, R.color.text, true).apply { setText(R.string.connsTorApps) })
        appsBox.addView(label(12f, R.color.text_dim).apply { setText(R.string.connsTorAppsDesc); setPadding(0, dp(2f), 0, dp(4f)) })
        for (a in TorAppsList.apps) {
            val sw = Switch(this).apply {
                text = a.name
                textDirection = View.TEXT_DIRECTION_LTR
                setTextColor(getColor(R.color.text))
                setPadding(0, dp(6f), 0, dp(6f))
                setOnCheckedChangeListener { _, on -> if (!settingApps) { Conns.setTorApp(this@ConnectionsActivity, a.id, on); render() } }
            }
            appSwitches[a.id] = sw
            appsBox.addView(sw, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
        root.addView(appsBox)
        search = EditText(this).apply {
            setHint(R.string.connsSearch)
            isSingleLine = true
            textDirection = View.TEXT_DIRECTION_LTR
            setTextColor(getColor(R.color.text))
            setHintTextColor(getColor(R.color.text_faint))
            addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
                override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
                override fun afterTextChanged(s: Editable?) = render()
            })
        }
        root.addView(search)
        blockTyped = Buttons.ghost(Button(this)).apply {
            visibility = View.GONE
            setOnClickListener { Conns.clean(search.text.toString())?.let { block(it, true); search.setText("") } }
        }
        root.addView(blockTyped, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        torTyped = Buttons.ghost(Button(this)).apply {
            visibility = View.GONE
            setOnClickListener { Conns.clean(search.text.toString())?.let { tor(it, true); search.setText("") } }
        }
        root.addView(torTyped, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        empty = label(13f, R.color.text_faint).apply { setPadding(0, dp(12f), 0, 0) }
        root.addView(empty)
        list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        root.addView(list)
        val scroll = ScrollView(this).apply { id = View.generateViewId(); addView(root, WideColumn.params(this@ConnectionsActivity)); setBackgroundColor(getColor(R.color.bg)); defaultFocusHighlightEnabled = false }
        setContentView(scroll)
        Tv.rings(window)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.VANILLA_ICE_CREAM) {
                @Suppress("DEPRECATION")
                window.setDecorFitsSystemWindows(false)
            }
            scroll.setOnApplyWindowInsetsListener { v, insets ->
                val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
                insets
            }
        }
        render()
    }

    private val tick = object : Runnable {
        override fun run() {
            if (!shown) return
            Protector.tell(this@ConnectionsActivity, ShroudlyVpnService.ACTION_CONNS, "CONNS")
            main.postDelayed({ render() }, 400)
            main.postDelayed(this, 2000)
        }
    }

    override fun onResume() { super.onResume(); shown = true; main.post(tick) }
    override fun onPause() { super.onPause(); shown = false; main.removeCallbacks(tick) }

    private fun route(r: Conns.Row): String? = when (r.route) {
        "tor" -> getString(R.string.connsRouteTor)
        "server" -> getString(R.string.connsRouteServer)
        "technique" -> getString(R.string.connsRouteTechnique)
        // Datagrams (QUIC, games, calls): no technique works on them.
        "udp" -> "UDP"
        else -> null
    }

    /* A name Shroudly itself needs (its DNS, Tor, codeshare.me, the user's own
     * server) is never blocked: no button is shown for it (row). */
    private fun block(host: String, on: Boolean) {
        if (on && Conns.isSystem(host, AppSettings.ownServer(this)?.host)) return
        Conns.setBlocked(this, host, on)
        // Shown at once; the engine's next list confirms it.
        Conns.rows = Conns.rows.map { if (it.host == host || it.host.endsWith(".$host")) it.copy(blocked = on, active = if (on) 0 else it.active) else it }
        render()
    }

    /* Through Tor: for a site that turns the user's country away itself
     * (Conns.setTorSite turns the last way out on; not in the lite APK). */
    private fun torOk(): Boolean = TorRoute.bundled(this) && AppSettings.ownServer(this) == null

    private fun tor(host: String, on: Boolean) {
        Conns.setTorSite(this, host, on)
        render()
    }

    private fun render() {
        val needle = search.text.toString().trim().lowercase()
        val own = AppSettings.ownServer(this)?.host
        val blocked = Conns.blocked(this)
        val rows = Conns.rows.filter { needle.isEmpty() || it.host.contains(needle) }.take(100)
        val blockedOnly = blocked.filter { b -> Conns.rows.none { it.host == b } && (needle.isEmpty() || b.contains(needle)) }.sorted()
        val typed = Conns.clean(needle)
        val canBlock = typed != null && typed.contains('.') && typed !in blocked && Conns.rows.none { it.host == typed } && !Conns.isSystem(typed, own)
        blockTyped.visibility = if (canBlock) View.VISIBLE else View.GONE
        if (canBlock) blockTyped.text = text(R.string.connsBlockName, "host" to typed!!)
        val torSites = Conns.torSites(this)
        val canTor = canBlock && torOk() && torSites.none { typed == it || typed!!.endsWith(".$it") }
        torTyped.visibility = if (canTor) View.VISIBLE else View.GONE
        if (canTor) torTyped.text = text(R.string.connsTorName, "host" to typed!!)
        torDesc.visibility = if (torOk()) View.VISIBLE else View.GONE
        appsBox.visibility = if (torOk()) View.VISIBLE else View.GONE
        val picked = Conns.torApps(this)
        settingApps = true
        for ((id, sw) in appSwitches) if (sw.isChecked != (id in picked)) sw.isChecked = id in picked
        settingApps = false
        appNames = Conns.appEntries(picked).filter { !it.contains('/') }.toSet()
        val torOnly = torSites.filter { t -> Conns.rows.none { it.host == t } && (needle.isEmpty() || t.contains(needle)) }.sorted()
        empty.visibility = if (rows.isEmpty() && blockedOnly.isEmpty() && torOnly.isEmpty() && !canBlock) View.VISIBLE else View.GONE
        empty.setText(if (Protection.state == Protection.State.ON) R.string.connsEmpty else R.string.statsInactiveHint)
        list.removeAllViews()
        for (r in rows) list.addView(row(r.host, meta(r, own), r.blocked, Conns.isSystem(r.host, own), viaTor(r.host, torSites), viaTor(r.host, appNames) != null))
        for (b in blockedOnly) list.addView(row(b, getString(R.string.connsBlocked), true, Conns.isSystem(b, own), null))
        for (t in torOnly) list.addView(row(t, getString(R.string.connsTorChosen), false, false, t))
        // What the ad list stopped, with a button to let one through: a page
        // that "does not open" with protection on is often a name the list
        // blocks whole (a link shortener's, SR-G563).
        val allowed = AdBlock.allow(this)
        val ads = if (AdBlock.enabled(this)) Conns.ads.filter { a ->
            (needle.isEmpty() || a.host.contains(needle)) && allowed.none { a.host == it || a.host.endsWith(".$it") }
        }.take(30) else emptyList()
        if (ads.isNotEmpty()) {
            list.addView(label(15f, R.color.text, true).apply { setText(R.string.connsAdsTitle); setPadding(0, dp(16f), 0, dp(2f)) })
            list.addView(label(12f, R.color.text_dim).apply { setText(R.string.connsAdsDesc); setPadding(0, 0, 0, dp(4f)) })
            for (a in ads) list.addView(adRow(a))
        }
    }

    private fun adRow(a: Conns.AdRow): View {
        val r = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(10f), 0, dp(10f))
        }
        val texts = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        texts.addView(label(15f, R.color.text).apply { text = a.host; textDirection = View.TEXT_DIRECTION_LTR; isSingleLine = true; ellipsize = android.text.TextUtils.TruncateAt.MIDDLE })
        val sub = text(R.string.connsAdStopped, "count" to a.count)
        texts.addView(label(12f, R.color.text_faint).apply { text = sub })
        r.addView(texts, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        r.addView(Buttons.ghost(Button(this)).apply {
            setText(R.string.connsAdAllow)
            setOnClickListener {
                AdBlock.setAllow(this@ConnectionsActivity, (AdBlock.allow(this@ConnectionsActivity) + a.host).joinToString("\n"))
                Protector.tell(this@ConnectionsActivity, ShroudlyVpnService.ACTION_ADBLOCK)
                Conns.adAllowed(a.host)
                render()
            }
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginStart = dp(8f) })
        return r
    }

    private fun meta(r: Conns.Row, own: String?): String {
        if (r.blocked) return getString(R.string.connsBlocked) + if (r.refused > 0) " · " + text(R.string.connsRefused, "count" to r.refused) else ""
        val parts = mutableListOf("↓ ${Format.bytes(r.down)}", "↑ ${Format.bytes(r.up)}")
        if (r.active > 0) parts += text(R.string.connsOpen, "count" to r.active)
        route(r)?.let { parts += it }
        if (Conns.isSystem(r.host, own)) parts += getString(R.string.connsSystem)
        if (r.route != "tor" && (viaTor(r.host, Conns.torSites(this)) != null || viaTor(r.host, appNames) != null)) parts += getString(R.string.connsTorChosen)
        return parts.joinToString(" · ")
    }

    /* The listed name that sends this one through Tor (itself or one above it). */
    private fun viaTor(host: String, sites: Set<String>): String? = sites.firstOrNull { host == it || host.endsWith(".$it") }

    // The names of the apps picked (their switches decide those).
    private var appNames: Set<String> = emptySet()

    private fun row(host: String, sub: String, blocked: Boolean, system: Boolean, torBy: String?, byApp: Boolean = false): View {
        val r = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(10f), 0, dp(10f))
        }
        val texts = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        texts.addView(label(15f, R.color.text).apply { text = host; textDirection = View.TEXT_DIRECTION_LTR; isSingleLine = true; ellipsize = android.text.TextUtils.TruncateAt.MIDDLE })
        texts.addView(label(12f, if (blocked) R.color.warn else R.color.text_faint).apply { text = sub })
        r.addView(texts, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        // Through Tor, or back the usual way (never for Shroudly's own names).
        // A name an app picked sends there: that app's switch brings it back.
        val gap = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginStart = dp(8f) }
        if (!blocked && !system && torOk() && !(byApp && torBy == null)) r.addView(Buttons.ghost(Button(this)).apply {
            setText(if (torBy != null) R.string.connsTorBack else R.string.connsTor)
            if (torBy != null) setTextColor(Accent.color(this@ConnectionsActivity, R.attr.accentLight))
            setOnClickListener { if (torBy != null) tor(torBy, false) else tor(host, true) }
        }, gap)
        // Shroudly's own names: Allow if one was blocked before, never Block.
        if (blocked || !system) r.addView(Buttons.ghost(Button(this)).apply {
            setText(if (blocked) R.string.connsAllow else R.string.connsBlock)
            if (!blocked) setTextColor(getColor(R.color.danger))
            setOnClickListener { block(host, !blocked) }
        }, LinearLayout.LayoutParams(gap))
        return r
    }
}
