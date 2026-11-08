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

    /* The tabs at the bottom: Logs is a row of About instead (on a phone the
     * bar keeps room for each name; on a TV the bar stays short). */
    @Suppress("UNUSED_PARAMETER")
    fun tabs(a: Activity): List<Tab> = Tab.values().filter { it != Tab.LOGS }

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

    /*
     * The tabs at the bottom, as on the iPhone: a floating rounded bar with a
     * lens over the chosen tab. A press lifts the lens over the tab under the
     * finger, the finger can slide along the bar with the lens following (a
     * light tick at each tab), and letting go opens that tab. "A Codeshare
     * product" under it. `onTab` gets the tab let go on, if another.
     */
    fun bottomBar(a: Activity, selected: Tab, onTab: (Tab) -> Unit): View {
        val accent = Accent.color(a, R.attr.accentLight)
        val faint = a.getColor(R.color.text_dim)
        val shown = tabs(a)
        // Logs opened from About: About stays lit.
        val lit = if (selected in shown) selected else Tab.ABOUT
        val box = LinearLayout(a).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(a.getColor(R.color.bg))
            setPadding(dp(a, 12f), dp(a, 6f), dp(a, 12f), 0)
            clipToPadding = false
            clipChildren = false
        }
        // Android TV: a short bar in the middle with the icons alone, each
        // a clear target for the remote (its name is read out).
        val tv = Tv.isTv(a)
        val capsule = android.widget.FrameLayout(a).apply {
            background = GradientDrawable().apply {
                cornerRadius = dp(a, 30f).toFloat()
                setColor(a.getColor(R.color.surface))
                setStroke(dp(a, 1f), a.getColor(R.color.line_strong))
            }
            elevation = dp(a, 10f).toFloat()
            setPadding(dp(a, 4f), dp(a, 4f), dp(a, 4f), dp(a, 4f))
        }
        val lens = View(a).apply {
            background = GradientDrawable().apply {
                cornerRadius = dp(a, 26f).toFloat()
                setColor((accent and 0x00FFFFFF) or 0x26000000)
                setStroke(dp(a, 1f), (accent and 0x00FFFFFF) or 0x40000000)
            }
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }
        capsule.addView(lens, android.widget.FrameLayout.LayoutParams(0, 0))
        val cells = ArrayList<LinearLayout>()
        val icons = ArrayList<ImageView>()
        val labels = ArrayList<TextView>()
        val row = DragRow(a)
        for (t in shown) {
            val cell = LinearLayout(a).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER
                setPadding(0, dp(a, if (tv) 10f else 7f), 0, dp(a, if (tv) 10f else 6f))
                isClickable = true
                isFocusable = true
                contentDescription = a.getString(t.label)
                isSelected = t == lit
                setOnClickListener { if (t != lit) onTab(t) }
            }
            val icon = ImageView(a).apply {
                setImageResource(t.icon)
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            }
            cell.addView(icon, LinearLayout.LayoutParams(dp(a, if (tv) 24f else 21f), dp(a, if (tv) 24f else 21f)))
            val label = TextView(a).apply {
                text = a.getString(t.label)
                textSize = 10.5f
                maxLines = 1
                ellipsize = android.text.TextUtils.TruncateAt.END
                gravity = Gravity.CENTER
                typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            }
            if (!tv) cell.addView(label, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(a, 3f) })
            row.addView(cell, if (tv) LinearLayout.LayoutParams(dp(a, 76f), ViewGroup.LayoutParams.WRAP_CONTENT)
                else LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            cells += cell
            icons += icon
            labels += label
        }
        fun paint(at: Int) {
            for (k in cells.indices) {
                val c = if (k == at || shown[k] == lit) accent else faint
                icons[k].imageTintList = android.content.res.ColorStateList.valueOf(c)
                labels[k].setTextColor(c)
            }
        }
        fun place(at: Int, animate: Boolean) {
            val c = cells.getOrNull(at) ?: return
            if (c.width == 0) return
            if (lens.layoutParams.width != c.width || lens.layoutParams.height != c.height) {
                lens.layoutParams = lens.layoutParams.apply { width = c.width; height = c.height }
            }
            if (animate && android.animation.ValueAnimator.areAnimatorsEnabled()) {
                lens.animate().translationX(c.left.toFloat()).setDuration(220)
                    .setInterpolator(android.view.animation.OvershootInterpolator(0.9f)).start()
            } else {
                lens.translationX = c.left.toFloat()
            }
        }
        val start = shown.indexOf(lit)
        paint(start)
        row.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> if (row.pressed < 0) place(start, false) }
        row.onMove = { at ->
            a.window.decorView.performHapticFeedback(android.view.HapticFeedbackConstants.CLOCK_TICK)
            paint(at)
            place(at, true)
            lens.animate().scaleX(1.06f).scaleY(1.06f).setDuration(120).start()
        }
        row.onUp = { at ->
            lens.animate().scaleX(1f).scaleY(1f).setDuration(120).start()
            if (at >= 0 && shown[at] != lit) onTab(shown[at]) else { paint(start); place(start, true) }
        }
        capsule.addView(row, android.widget.FrameLayout.LayoutParams(if (tv) ViewGroup.LayoutParams.WRAP_CONTENT else ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        box.addView(capsule, LinearLayout.LayoutParams(if (tv) ViewGroup.LayoutParams.WRAP_CONTENT else ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            gravity = Gravity.CENTER_HORIZONTAL
        })
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
            setTextColor(a.getColor(R.color.text_faint))
            setPadding(0, dp(a, 6f), 0, dp(a, 6f))
        })
        return box
    }

    /* The bar's row: takes the finger itself (a press, a slide along it, a
     * lift), while each tab stays a button for TalkBack and the D-pad. */
    class DragRow(a: Activity) : LinearLayout(a) {
        var pressed = -1
        var onMove: ((Int) -> Unit)? = null
        var onUp: ((Int) -> Unit)? = null

        init {
            orientation = HORIZONTAL
        }

        private fun at(x: Float): Int {
            for (i in 0 until childCount) {
                val c = getChildAt(i)
                if (x >= c.left && x < c.right) return i
            }
            return if (x < 0) (if (layoutDirection == LAYOUT_DIRECTION_RTL) childCount - 1 else 0)
                else (if (layoutDirection == LAYOUT_DIRECTION_RTL) 0 else childCount - 1)
        }

        override fun onInterceptTouchEvent(ev: android.view.MotionEvent): Boolean = true

        @android.annotation.SuppressLint("ClickableViewAccessibility")
        override fun onTouchEvent(ev: android.view.MotionEvent): Boolean {
            when (ev.actionMasked) {
                android.view.MotionEvent.ACTION_DOWN, android.view.MotionEvent.ACTION_MOVE -> {
                    parent?.requestDisallowInterceptTouchEvent(true)
                    val i = at(ev.x)
                    if (i != pressed) {
                        pressed = i
                        onMove?.invoke(i)
                    }
                }
                android.view.MotionEvent.ACTION_UP -> {
                    val i = at(ev.x)
                    pressed = -1
                    onUp?.invoke(i)
                }
                android.view.MotionEvent.ACTION_CANCEL -> {
                    pressed = -1
                    onUp?.invoke(-1)
                }
            }
            return true
        }
    }

    /*
     * A swipe across the screen goes to the tab beside it, as between an
     * Android app's pages: to the next tab from right to left (the other
     * way round in a right-to-left language). Only a clear sideways fling
     * counts, so scrolling a page never changes the tab.
     */
    class Swipe(private val a: Activity, private val current: () -> Tab, private val go: (Tab) -> Unit) {
        private val far = dp(a, 72f)
        private val detector = android.view.GestureDetector(a, object : android.view.GestureDetector.SimpleOnGestureListener() {
            override fun onFling(e1: android.view.MotionEvent?, e2: android.view.MotionEvent, vx: Float, vy: Float): Boolean {
                if (e1 == null) return false
                val dx = e2.x - e1.x
                val dy = e2.y - e1.y
                if (kotlin.math.abs(dx) < far || kotlin.math.abs(dx) < kotlin.math.abs(dy) * 2 || kotlin.math.abs(vx) < 500) return false
                val rtl = a.resources.configuration.layoutDirection == View.LAYOUT_DIRECTION_RTL
                val tabs = tabs(a)
                val now = current().let { if (it in tabs) it else Tab.ABOUT }
                val j = tabs.indexOf(now) + if ((dx < 0) != rtl) 1 else -1
                if (j !in tabs.indices) return false
                go(tabs[j])
                return true
            }
        })

        fun feed(ev: android.view.MotionEvent) {
            detector.onTouchEvent(ev)
        }
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
