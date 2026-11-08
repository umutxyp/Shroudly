package me.codeshare.shroudly

import android.content.Context
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Shader
import android.util.AttributeSet
import android.view.View

/* A speed's last minute as a line with a soft fill under it, newest on the
 * end side (the desktop's sparkline in StatsPanel). */
class Spark(context: Context, attrs: AttributeSet?) : View(context, attrs) {
    private val values = ArrayDeque<Float>()
    private val max = 30
    private val density = resources.displayMetrics.density
    var color: Int = Accent.color(context, R.attr.accentLight)
        set(v) { field = v; invalidate() }

    private val line = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 1.6f * density
        strokeJoin = Paint.Join.ROUND
        strokeCap = Paint.Cap.ROUND
    }
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val base = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 1f * density
        pathEffect = android.graphics.DashPathEffect(floatArrayOf(3 * density, 4 * density), 0f)
    }

    fun push(v: Float) {
        // The first speed: the minute before it drawn flat, so the line
        // starts across the whole width.
        if (values.isEmpty()) repeat(max - 1) { values.addLast(0f) }
        values.addLast(v)
        while (values.size > max) values.removeFirst()
        invalidate()
    }

    fun clear() {
        values.clear()
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        val w = width.toFloat()
        val h = height.toFloat()
        val pad = 2 * density
        base.color = context.getColor(R.color.line_strong)
        canvas.drawLine(0f, h - pad, w, h - pad, base)
        if (values.size < 2) return
        val top = maxOf(values.maxOrNull() ?: 0f, 1f)
        val rtl = layoutDirection == LAYOUT_DIRECTION_RTL
        val step = w / (max - 1)
        val start = (max - values.size) * step
        val path = Path()
        values.forEachIndexed { i, v ->
            val x0 = start + i * step
            val x = if (rtl) w - x0 else x0
            val y = h - pad - (v / top) * (h - 2 * pad)
            if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
        }
        val area = Path(path)
        val lastX = if (rtl) 0f else w
        val firstX = if (rtl) w - start else start
        area.lineTo(lastX, h)
        area.lineTo(firstX, h)
        area.close()
        fill.shader = LinearGradient(0f, 0f, 0f, h, (color and 0xFFFFFF) or 0x40000000, color and 0xFFFFFF, Shader.TileMode.CLAMP)
        canvas.drawPath(area, fill)
        line.color = color
        canvas.drawPath(path, line)
    }
}
