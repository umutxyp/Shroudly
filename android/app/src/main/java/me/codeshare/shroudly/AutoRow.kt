package me.codeshare.shroudly

import android.content.Context
import android.util.AttributeSet
import android.view.View
import android.widget.LinearLayout

/*
 * Boxes side by side while each still has the room its words need, one under
 * the other once they would be squeezed: decided from what is in them, not
 * from the screen's size, so a large font, a long language or a narrow phone
 * each get what fits (the Stats counters; the desktop's grid does the same).
 */
class AutoRow(context: Context, attrs: AttributeSet?) : LinearLayout(context, attrs) {
    private val density = resources.displayMetrics.density
    private val gap = (12 * density).toInt()
    /* Less than this each, and they go one under the other anyway. */
    private val least = (140 * density).toInt()
    private var decided: Int? = null

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val kids = (0 until childCount).map { getChildAt(it) }.filter { it.visibility != View.GONE }
        var side = true
        if (MeasureSpec.getMode(widthMeasureSpec) != MeasureSpec.UNSPECIFIED && kids.size > 1) {
            val room = MeasureSpec.getSize(widthMeasureSpec) - paddingLeft - paddingRight
            val cell = (room - gap * (kids.size - 1)) / kids.size
            if (cell < least) side = false
            val free = MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED)
            for (k in kids) {
                if (!side) break
                k.measure(free, free)
                if (k.measuredWidth > cell) side = false
            }
        }
        val want = if (side) HORIZONTAL else VERTICAL
        if (want != decided) {
            decided = want
            orientation = want
            kids.forEachIndexed { i, k ->
                val lp = k.layoutParams as LayoutParams
                if (side) {
                    lp.width = 0
                    lp.height = LayoutParams.MATCH_PARENT
                    lp.weight = 1f
                    lp.marginStart = if (i > 0) gap else 0
                    lp.topMargin = 0
                } else {
                    lp.width = LayoutParams.MATCH_PARENT
                    lp.height = LayoutParams.WRAP_CONTENT
                    lp.weight = 0f
                    lp.marginStart = 0
                    lp.topMargin = if (i > 0) gap else 0
                }
            }
        }
        super.onMeasure(widthMeasureSpec, heightMeasureSpec)
    }
}

/*
 * Settings' four tabs: all on one line while every name fits whole at its
 * size, else two by two, else one under the other; never shrunk or cut.
 */
class FitTabs(context: Context, private val items: List<View>) : LinearLayout(context) {
    private val gap = (4 * resources.displayMetrics.density).toInt()
    private var cols = 0

    init {
        orientation = VERTICAL
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        if (MeasureSpec.getMode(widthMeasureSpec) != MeasureSpec.UNSPECIFIED) {
            val room = MeasureSpec.getSize(widthMeasureSpec) - paddingLeft - paddingRight
            val free = MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED)
            val widest = items.maxOf { it.measure(free, free); it.measuredWidth }
            val c = listOf(items.size, 2, 1).firstOrNull { n -> (room - gap * (n - 1)) / n >= widest } ?: 1
            if (c != cols) {
                cols = c
                for (i in 0 until childCount) (getChildAt(i) as? LinearLayout)?.removeAllViews()
                removeAllViews()
                items.chunked(c).forEachIndexed { r, rowItems ->
                    val row = LinearLayout(context).apply { orientation = HORIZONTAL }
                    rowItems.forEachIndexed { i, v ->
                        row.addView(v, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f).apply { if (i > 0) marginStart = gap })
                    }
                    addView(row, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { if (r > 0) topMargin = gap })
                }
            }
        }
        super.onMeasure(widthMeasureSpec, heightMeasureSpec)
    }
}
