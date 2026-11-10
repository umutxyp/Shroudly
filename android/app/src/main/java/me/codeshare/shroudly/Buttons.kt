package me.codeshare.shroudly

import android.util.TypedValue
import android.widget.Button

/*
 * Buttons made in code (the Connections list, the report) in the app's own
 * look: a plain Button() is the system's grey slab with capital letters,
 * which stood out on every other screen.
 */
object Buttons {
    private fun base(b: Button, bg: Int) = b.apply {
        setBackgroundResource(bg)
        isAllCaps = false
        stateListAnimator = null
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
        val d = resources.displayMetrics.density
        setPadding((14 * d).toInt(), 0, (14 * d).toInt(), 0)
        minHeight = (48 * d).toInt(); minimumHeight = minHeight
        minWidth = 0; minimumWidth = 0
    }

    /* A quiet one beside a row. */
    fun ghost(b: Button): Button = base(b, R.drawable.button_ghost).apply { setTextColor(context.getColor(R.color.text)) }

    /* The one thing to do on a screen. */
    fun accent(b: Button): Button = base(b, R.drawable.button_accent).apply {
        setTextColor(context.getColor(android.R.color.white))
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
    }
}
