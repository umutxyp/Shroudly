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
        root.addView(label(13f, R.color.text_dim).apply { setText(R.string.connsDesc); setPadding(0, dp(4f), 0, dp(12f)) })
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
        blockTyped = Button(this).apply {
            visibility = View.GONE
            setOnClickListener { Conns.clean(search.text.toString())?.let { block(it, true); search.setText("") } }
        }
        root.addView(blockTyped, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        empty = label(13f, R.color.text_faint).apply { setPadding(0, dp(12f), 0, 0) }
        root.addView(empty)
        list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        root.addView(list)
        val scroll = ScrollView(this).apply { id = View.generateViewId(); addView(root); setBackgroundColor(getColor(R.color.bg)) }
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
        empty.visibility = if (rows.isEmpty() && blockedOnly.isEmpty() && !canBlock) View.VISIBLE else View.GONE
        empty.setText(if (Protection.state == Protection.State.ON) R.string.connsEmpty else R.string.statsInactiveHint)
        list.removeAllViews()
        for (r in rows) list.addView(row(r.host, meta(r, own), r.blocked, Conns.isSystem(r.host, own)))
        for (b in blockedOnly) list.addView(row(b, getString(R.string.connsBlocked), true, Conns.isSystem(b, own)))
    }

    private fun meta(r: Conns.Row, own: String?): String {
        if (r.blocked) return getString(R.string.connsBlocked) + if (r.refused > 0) " · " + text(R.string.connsRefused, "count" to r.refused) else ""
        val parts = mutableListOf("↓ ${Format.bytes(r.down)}", "↑ ${Format.bytes(r.up)}")
        if (r.active > 0) parts += text(R.string.connsOpen, "count" to r.active)
        route(r)?.let { parts += it }
        if (Conns.isSystem(r.host, own)) parts += getString(R.string.connsSystem)
        return parts.joinToString(" · ")
    }

    private fun row(host: String, sub: String, blocked: Boolean, system: Boolean): View {
        val r = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(10f), 0, dp(10f))
        }
        val texts = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        texts.addView(label(15f, R.color.text).apply { text = host; textDirection = View.TEXT_DIRECTION_LTR; isSingleLine = true; ellipsize = android.text.TextUtils.TruncateAt.MIDDLE })
        texts.addView(label(12f, if (blocked) R.color.warn else R.color.text_faint).apply { text = sub })
        r.addView(texts, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        // Shroudly's own names: Allow if one was blocked before, never Block.
        if (blocked || !system) r.addView(Button(this).apply {
            setText(if (blocked) R.string.connsAllow else R.string.connsBlock)
            setOnClickListener { block(host, !blocked) }
        })
        return r
    }
}
