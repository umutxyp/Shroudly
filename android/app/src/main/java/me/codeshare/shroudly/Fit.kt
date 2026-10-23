package me.codeshare.shroudly

import android.annotation.SuppressLint
import android.content.Context
import android.text.Layout
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.TextView

/*
 * The windows' rows on a narrow screen or with large text (a 320 dp phone,
 * or the system's font size turned up): below NARROW_DP of width for each
 * step of font scale, the rows' icon tiles go and the side margins shrink,
 * so a row's title and description get the room instead of a column a few
 * words wide beside its switch. Everywhere, long words break at syllables
 * (German compounds, Russian) rather than at whatever letter reached the
 * edge.
 */
object Fit {
    private const val NARROW_DP = 360
    // A row's tile is 30 dp; the small icons inside text (the stats labels)
    // are 16 dp and stay.
    private const val TILE_MIN_DP = 26

    fun narrow(ctx: Context): Boolean {
        val c = ctx.resources.configuration
        return c.screenWidthDp / c.fontScale.coerceAtLeast(0.5f) < NARROW_DP
    }

    // Layout's break strategy is LineBreaker's (API 29) by another name, and
    // there on Android 8 too.
    @SuppressLint("WrongConstant")
    fun apply(root: View) {
        val narrow = narrow(root.context)
        val d = root.resources.displayMetrics.density
        walk(root) { v ->
            if (v is TextView) {
                v.hyphenationFrequency = Layout.HYPHENATION_FREQUENCY_NORMAL
                v.breakStrategy = Layout.BREAK_STRATEGY_HIGH_QUALITY
            }
            if (!narrow) return@walk
            when {
                v is Column -> v.setPaddingRelative((14 * d).toInt(), v.paddingTop, (14 * d).toInt(), v.paddingBottom)
                v is ImageView && v.tag == "tile" -> {
                    v.visibility = View.GONE
                    // What came after it starts where the tile did.
                    val parent = v.parent as? ViewGroup
                    val next = parent?.getChildAt(parent.indexOfChild(v) + 1)
                    (next?.layoutParams as? ViewGroup.MarginLayoutParams)?.let { it.marginStart = 0; next.layoutParams = it }
                }
                v is TextView -> {
                    val c = v.compoundDrawablesRelative
                    val start = c[0]
                    if (start != null && start.intrinsicWidth >= TILE_MIN_DP * d) v.setCompoundDrawablesRelative(null, c[1], c[2], c[3])
                }
            }
        }
    }

    private fun walk(v: View, f: (View) -> Unit) {
        f(v)
        if (v is ViewGroup) for (i in 0 until v.childCount) walk(v.getChildAt(i), f)
    }

    /* A name with dots (a package, an action) that may break only after a dot. */
    fun breakable(name: String) = name.replace(".", ".​")
}
