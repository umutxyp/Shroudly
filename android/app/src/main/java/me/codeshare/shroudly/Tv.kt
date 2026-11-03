package me.codeshare.shroudly

import android.app.UiModeManager
import android.content.Context
import android.content.res.Configuration
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.StateListDrawable
import android.view.View
import android.view.Window
import android.widget.AbsListView
import android.widget.EditText

/*
 * Android TV and Google TV: the same screens, used with a remote. What the
 * remote's arrows have reached has to stand out from across the room; the
 * ripples a phone shows on a tap barely change a focused view's shade. So on
 * a TV, whatever takes the focus gets a ring in the accent colour (round for
 * the round switch), and a small one a slightly larger size. Views added
 * later (rows, cards that appear) get it the moment they are reached.
 */
object Tv {
    fun isTv(ctx: Context): Boolean {
        val ui = ctx.getSystemService(Context.UI_MODE_SERVICE) as? UiModeManager
        return ui?.currentModeType == Configuration.UI_MODE_TYPE_TELEVISION
    }

    fun rings(window: Window) {
        val ctx = window.context
        if (!isTv(ctx)) return
        val accent = Accent.color(ctx, R.attr.accent)
        val d = ctx.resources.displayMetrics.density
        window.decorView.viewTreeObserver.addOnGlobalFocusChangeListener { old, new ->
            old?.takeIf { it.getTag(R.id.tvRing) != null }?.animate()?.scaleX(1f)?.scaleY(1f)?.setDuration(120)?.start()
            if (new == null || new is EditText || new is AbsListView) return@addOnGlobalFocusChangeListener
            if (new.getTag(R.id.tvRing) == null) {
                new.setTag(R.id.tvRing, true)
                if (new.foreground == null) new.foreground = ring(new, accent, d)
            }
            // A row as wide as the screen's column would grow out of its card.
            if (new.width < 400 * d) new.animate().scaleX(1.04f).scaleY(1.04f).setDuration(120).start()
        }
    }

    private fun ring(v: View, accent: Int, d: Float): StateListDrawable {
        val shape = GradientDrawable().apply {
            setStroke((3 * d).toInt(), accent)
            if (v.id == R.id.toggle) shape = GradientDrawable.OVAL else cornerRadius = 12 * d
        }
        return StateListDrawable().apply {
            addState(intArrayOf(android.R.attr.state_focused), shape)
        }
    }
}
