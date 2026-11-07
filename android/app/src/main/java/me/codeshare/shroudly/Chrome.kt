package me.codeshare.shroudly

import android.app.Activity
import android.content.Intent
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.text.style.StyleSpan
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView

/*
 * What every screen of the app has around it, as the desktop app's window
 * (app/page.js): the logo, the name and tagline with the Active / Inactive
 * pill on top, and the six tabs at the bottom with "A Codeshare product"
 * under them. Protection, Stats, Logs and About are pages of the main
 * screen; Settings and Follow are screens of their own with the same top
 * and bottom, so a tab goes where the desktop's would.
 */
object Chrome {
    enum class Tab(val icon: Int, val label: Int) {
        PROTECTION(R.drawable.ic_shield, R.string.navProtection),
        STATS(R.drawable.ic_gauge_accent, R.string.navStats),
        SETTINGS(R.drawable.ic_settings_accent, R.string.navSettings),
        LOGS(R.drawable.ic_file_text, R.string.navLogs),
        FOLLOW(R.drawable.ic_users, R.string.navFollow),
        ABOUT(R.drawable.ic_info, R.string.navInfo),
    }

    const val EXTRA_TAB = "me.codeshare.shroudly.TAB"

    private fun dp(a: Activity, v: Float): Int =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, a.resources.displayMetrics).toInt()

    /* The logo, name and tagline, and the pill (returned, for updatePill). */
    fun header(a: Activity): Pair<View, TextView> {
        val row = LinearLayout(a).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(a, 20f), dp(a, 12f), dp(a, 20f), dp(a, 12f))
            setBackgroundColor(a.getColor(R.color.bg))
        }
        row.addView(ImageView(a).apply {
            setImageResource(R.drawable.logo)
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }, LinearLayout.LayoutParams(dp(a, 36f), dp(a, 36f)))
        val names = LinearLayout(a).apply { orientation = LinearLayout.VERTICAL }
        names.addView(TextView(a).apply {
            text = a.getString(R.string.app_name)
            setTextColor(a.getColor(R.color.text))
            textSize = 18f
            typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
            if (android.os.Build.VERSION.SDK_INT >= 28) isAccessibilityHeading = true
        })
        names.addView(TextView(a).apply {
            text = a.getString(R.string.tagline)
            setTextColor(a.getColor(R.color.text_dim))
            textSize = 12.5f
            maxLines = 1
        })
        row.addView(names, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = dp(a, 12f) })
        val pill = TextView(a).apply {
            textSize = 13f
            typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
            setPadding(dp(a, 11f), dp(a, 5f), dp(a, 11f), dp(a, 5f))
            compoundDrawablePadding = dp(a, 7f)
            maxLines = 1
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        }
        row.addView(pill, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginStart = dp(a, 8f) })
        updatePill(a, pill)
        val box = LinearLayout(a).apply { orientation = LinearLayout.VERTICAL }
        box.addView(row)
        box.addView(View(a).apply { setBackgroundColor(a.getColor(R.color.line)) }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(a, 1f)))
        return box to pill
    }

    /* Active (green), Starting… (amber) or Inactive (red), with a dot. */
    fun updatePill(a: Activity, pill: TextView) {
        val st = Protection.state
        val color = when (st) {
            Protection.State.ON -> a.getColor(R.color.ok)
            Protection.State.OFF -> a.getColor(R.color.danger)
            else -> a.getColor(R.color.warn)
        }
        pill.text = a.getString(when (st) {
            Protection.State.ON -> R.string.active
            Protection.State.OFF -> R.string.inactive
            else -> R.string.starting
        })
        pill.setTextColor(color)
        pill.background = GradientDrawable().apply {
            cornerRadius = dp(a, 100f).toFloat()
            setColor((color and 0x00FFFFFF) or 0x1F000000)
        }
        val dot = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(color)
            setSize(dp(a, 7f), dp(a, 7f))
        }
        pill.setCompoundDrawablesRelativeWithIntrinsicBounds(dot, null, null, null)
    }

    /* The six tabs and the line under them; `onTab` gets a tap on another. */
    fun bottomBar(a: Activity, selected: Tab, onTab: (Tab) -> Unit): View {
        val accent = Accent.color(a, R.attr.accentLight)
        val faint = a.getColor(R.color.text_faint)
        val box = LinearLayout(a).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(a.getColor(R.color.bg))
        }
        box.addView(View(a).apply { setBackgroundColor(a.getColor(R.color.line)) }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(a, 1f)))
        val row = LinearLayout(a).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(dp(a, 4f), 0, dp(a, 4f), 0)
        }
        for (t in Tab.values()) {
            val on = t == selected
            val cell = LinearLayout(a).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER_HORIZONTAL
                setPadding(0, dp(a, 6f), 0, dp(a, 7f))
                setBackgroundResource(R.drawable.pressable)
                isClickable = true
                isFocusable = true
                contentDescription = a.getString(t.label)
                isSelected = on
                setOnClickListener { if (!on) onTab(t) }
            }
            // The desktop's mark over the chosen tab.
            cell.addView(View(a).apply {
                background = GradientDrawable().apply { cornerRadius = dp(a, 2f).toFloat(); setColor(if (on) accent else 0) }
            }, LinearLayout.LayoutParams(dp(a, 28f), dp(a, 2.5f)).apply { bottomMargin = dp(a, 6f) })
            cell.addView(ImageView(a).apply {
                setImageResource(t.icon)
                imageTintList = android.content.res.ColorStateList.valueOf(if (on) accent else faint)
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            }, LinearLayout.LayoutParams(dp(a, 21f), dp(a, 21f)))
            cell.addView(TextView(a).apply {
                text = a.getString(t.label)
                textSize = 11f
                maxLines = 1
                ellipsize = android.text.TextUtils.TruncateAt.END
                gravity = Gravity.CENTER
                setTextColor(if (on) accent else faint)
                typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(a, 3f) })
            row.addView(cell, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        }
        box.addView(row)
        box.addView(View(a).apply { setBackgroundColor(a.getColor(R.color.line)) }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(a, 1f)))
        // "A Codeshare product", the brand stronger, as under the desktop's tabs.
        val parts = a.getString(R.string.footerProduct).split("{brand}")
        val sb = SpannableStringBuilder(parts.getOrElse(0) { "" })
        val at = sb.length
        sb.append("Codeshare")
        sb.setSpan(StyleSpan(Typeface.BOLD), at, sb.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        sb.setSpan(ForegroundColorSpan(a.getColor(R.color.text_dim)), at, sb.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        sb.append(parts.getOrElse(1) { "" })
        box.addView(TextView(a).apply {
            text = sb
            textSize = 12f
            gravity = Gravity.CENTER
            setTextColor(faint)
            setPadding(0, dp(a, 6f), 0, dp(a, 6f))
        })
        return box
    }

    /* From Settings or Follow: the main screen's page, or the other screen. */
    fun go(a: Activity, t: Tab) {
        when (t) {
            Tab.SETTINGS -> a.startActivity(Intent(a, SettingsActivity::class.java))
            Tab.FOLLOW -> a.startActivity(Intent(a, FollowActivity::class.java))
            else -> a.startActivity(Intent(a, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra(EXTRA_TAB, t.name))
        }
        a.overridePendingTransition(0, 0)
        if (a !is MainActivity) a.finish()
    }
}
