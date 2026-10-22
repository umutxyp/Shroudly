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
 * Settings: the technique (as the desktop's "Bypass strategy"), the apps that
 * skip Shroudly, starting when the phone starts, and automation apps
 * (AppSettings). A change
 * reaches a running protection at once (ShroudlyVpnService.ACTION_SETTINGS).
 */
class SettingsActivity : Activity() {
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
            val desc = text(R.string.androidRemoteControlDesc, "package" to packageName, "action" to AutomationReceiver.ACTION_START.substringBeforeLast('.'))
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
