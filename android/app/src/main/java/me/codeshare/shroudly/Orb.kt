package me.codeshare.shroudly

import android.animation.ObjectAnimator
import android.animation.PropertyValuesHolder
import android.animation.ValueAnimator
import android.content.Context
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.RadialGradient
import android.graphics.Shader
import android.graphics.drawable.ShapeDrawable
import android.graphics.drawable.shapes.OvalShape
import android.util.AttributeSet
import android.view.View
import android.view.animation.AccelerateDecelerateInterpolator
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
 * The switch's look (ControlPanel.js): the real logo, grey and dim while off,
 * in its colours when protected, with a soft halo that breathes behind it; a
 * thin arc runs round it while starting or stopping. Only view properties are
 * animated (alpha, scale, rotation), so nothing is redrawn for them, and the
 * endless ones run only between resume() and pause() (the window on screen),
 * never when the system's animations are off.
 */
class Orb(private val halo: View, private val ring: View, private val logo: ImageView) {
    enum class Mode { OFF, ON, BUSY }

    private companion object {
        const val FADE = 450L
        /* The halo's opacity at rest; it breathes up to 1 (the desktop's 0.5 to 0.95). */
        const val REST = 0.6f
    }

    private var mode: Mode? = null
    private var resumed = false
    private var logoLevel = -1f
    private var logoAnim: ValueAnimator? = null
    private var pulse: ObjectAnimator? = null
    private var spin: ObjectAnimator? = null

    init {
        val accent = Accent.color(logo.context, R.attr.accent)
        fun a(alpha: Int) = (alpha shl 24) or (accent and 0xFFFFFF)
        halo.background = ShapeDrawable(OvalShape()).apply {
            shaderFactory = object : ShapeDrawable.ShaderFactory() {
                override fun resize(width: Int, height: Int): Shader {
                    val r = min(width, height) / 2f
                    // Faint under the switch, strongest at its edge (172 of
                    // 212dp: 0.81), gone at the view's.
                    return RadialGradient(
                        width / 2f, height / 2f, r,
                        intArrayOf(a(0x14), a(0x14), a(0x50), a(0x1C), a(0)),
                        floatArrayOf(0f, 0.72f, 0.81f, 0.9f, 1f),
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
        // The logo: its colours while protected; grey and dim otherwise.
        fadeLogo(if (on) 1f else 0f, animate = !first)
        // The halo fades in, then breathes (loops); fades out when off.
        stopPulse()
        halo.animate().cancel()
        if (first || !ValueAnimator.areAnimatorsEnabled()) {
            halo.alpha = if (on) REST else 0f
        } else {
            halo.animate().alpha(if (on) REST else 0f).setDuration(FADE).start()
        }
        ring.visibility = if (next == Mode.BUSY) View.VISIBLE else View.INVISIBLE
        loops(delay = if (first) 0 else FADE)
    }

    fun resume() {
        resumed = true
        loops(delay = 0)
    }

    fun pause() {
        resumed = false
        loops(delay = 0)
    }

    /* The endless animations: the halo's breath when on, the arc when busy. */
    private fun loops(delay: Long) {
        val moving = resumed && ValueAnimator.areAnimatorsEnabled()
        if (moving && mode == Mode.ON) {
            if (pulse == null) {
                pulse = ObjectAnimator.ofPropertyValuesHolder(
                    halo,
                    PropertyValuesHolder.ofFloat(View.ALPHA, REST, 1f),
                    PropertyValuesHolder.ofFloat(View.SCALE_X, 1f, 1.04f),
                    PropertyValuesHolder.ofFloat(View.SCALE_Y, 1f, 1.04f),
                ).apply {
                    duration = 1700
                    startDelay = delay
                    repeatMode = ValueAnimator.REVERSE
                    repeatCount = ValueAnimator.INFINITE
                    interpolator = AccelerateDecelerateInterpolator()
                    start()
                }
            }
        } else {
            stopPulse()
        }
        if (moving && mode == Mode.BUSY) {
            if (spin == null) {
                spin = ObjectAnimator.ofFloat(ring, View.ROTATION, 0f, 360f).apply {
                    duration = 1000
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

    private fun stopPulse() {
        pulse?.cancel() ?: return
        pulse = null
        halo.scaleX = 1f
        halo.scaleY = 1f
        if (mode == Mode.ON) halo.alpha = REST
    }

    private fun fadeLogo(to: Float, animate: Boolean) {
        logoAnim?.cancel()
        if (!animate || !ValueAnimator.areAnimatorsEnabled() || logoLevel < 0f) {
            paintLogo(to)
            return
        }
        logoAnim = ValueAnimator.ofFloat(logoLevel, to).apply {
            duration = FADE
            addUpdateListener { paintLogo(it.animatedValue as Float) }
            start()
        }
    }

    /* 0: no colour, lifted a little so the dark shield still reads on the
     * dark circle, at 45%; 1: the logo as it is. */
    private fun paintLogo(level: Float) {
        logoLevel = level
        if (level >= 1f) {
            logo.clearColorFilter()
        } else {
            val lift = 1f + 0.7f * (1f - level)
            val m = ColorMatrix().apply { setSaturation(level) }
            m.postConcat(ColorMatrix().apply { setScale(lift, lift, lift, 1f) })
            logo.colorFilter = ColorMatrixColorFilter(m)
        }
        logo.imageAlpha = (255 * (0.45f + 0.55f * level)).toInt()
    }
}
