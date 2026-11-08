package me.codeshare.shroudly

import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.content.Context
import android.graphics.RadialGradient
import android.graphics.Shader
import android.graphics.drawable.ShapeDrawable
import android.graphics.drawable.shapes.OvalShape
import android.util.AttributeSet
import android.view.View
import android.view.animation.LinearInterpolator
import android.widget.ImageView
import android.widget.LinearLayout
import kotlin.math.min

/* The main column: the whole width on a phone, at most content_max_width
 * (centred by its layout_gravity) on a tablet or in landscape. */
class Column(context: Context, attrs: AttributeSet?) : LinearLayout(context, attrs) {
    private val maxWidth = resources.getDimensionPixelSize(R.dimen.content_max_width)

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val size = MeasureSpec.getSize(widthMeasureSpec)
        val spec = if (MeasureSpec.getMode(widthMeasureSpec) != MeasureSpec.UNSPECIFIED && size > maxWidth) {
            MeasureSpec.makeMeasureSpec(maxWidth, MeasureSpec.EXACTLY)
        } else {
            widthMeasureSpec
        }
        super.onMeasure(spec, heightMeasureSpec)
    }
}

/*
 * The switch's look, as on the desktop and the iPhone (ControlPanel.js,
 * PowerOrb.swift): Shroudly's logo, shut and grey while off, open in its own
 * colours once protected, the one fading into the other, with a still soft
 * light behind it. Calm: nothing moves on its own but a thin arc running
 * round it while starting or stopping, and only between resume() and pause()
 * (the window on screen), never when the system's animations are off.
 */
class Orb(private val halo: View, private val ring: View, private val closed: ImageView, private val open: ImageView) {
    enum class Mode { OFF, ON, BUSY }

    private companion object {
        const val FADE = 450L
        /* The light behind it while protected. */
        const val REST = 0.75f
    }

    private var mode: Mode? = null
    private var resumed = false
    private var spin: ObjectAnimator? = null

    init {
        val accent = Accent.color(open.context, R.attr.accent)
        fun a(alpha: Int) = (alpha shl 24) or (accent and 0xFFFFFF)
        halo.background = ShapeDrawable(OvalShape()).apply {
            shaderFactory = object : ShapeDrawable.ShaderFactory() {
                override fun resize(width: Int, height: Int): Shader {
                    val r = min(width, height) / 2f
                    // Under the switch, strongest at its edge (172 of 212dp:
                    // 0.81), gone at the view's.
                    return RadialGradient(
                        width / 2f, height / 2f, r,
                        intArrayOf(a(0x30), a(0x30), a(0x40), a(0x14), a(0)),
                        floatArrayOf(0f, 0.72f, 0.81f, 0.92f, 1f),
                        Shader.TileMode.CLAMP,
                    )
                }
            }
        }
    }

    fun set(next: Mode) {
        if (next == mode) return
        val first = mode == null
        mode = next
        val on = next == Mode.ON
        val shut = next == Mode.OFF
        val animate = !first && ValueAnimator.areAnimatorsEnabled()
        fun fade(v: View, to: Float) {
            v.animate().cancel()
            if (animate) v.animate().alpha(to).setDuration(FADE).start() else v.alpha = to
        }
        fade(open, if (shut) 0f else 1f)
        fade(closed, if (shut) 1f else 0f)
        fade(halo, if (on) REST else 0f)
        ring.visibility = if (next == Mode.BUSY) View.VISIBLE else View.INVISIBLE
        loops()
    }

    fun resume() {
        resumed = true
        loops()
    }

    fun pause() {
        resumed = false
        loops()
    }

    /* The one thing that moves: the arc while starting or stopping. */
    private fun loops() {
        val moving = resumed && ValueAnimator.areAnimatorsEnabled()
        if (moving && mode == Mode.BUSY) {
            if (spin == null) {
                spin = ObjectAnimator.ofFloat(ring, View.ROTATION, 0f, 360f).apply {
                    duration = 1100
                    repeatCount = ValueAnimator.INFINITE
                    interpolator = LinearInterpolator()
                    start()
                }
            }
        } else {
            spin?.cancel()
            spin = null
        }
    }
}
