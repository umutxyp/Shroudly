package me.codeshare.shroudly

import android.app.Activity
import android.content.Context
import android.util.TypedValue

/*
 * The accent colour, chosen under Settings → Appearance: the logo's blue (the
 * default) or one of the desktop's accents (components/Appearance.js
 * ACCENTS). The theme holds it (res/values/attrs.xml, Accent.* in
 * themes.xml), so every view and drawable follows; the greys, the status
 * colours and the logo itself stay as they are.
 */
object Accent {
    private const val PREFS = "settings"
    private const val KEY = "accent"

    /* id, the swatch shown in Settings, and the style laid over the theme
     * (0: none, the logo's blue). */
    data class Option(val id: String, val swatch: Int, val style: Int)

    val OPTIONS = listOf(
        Option("logo", 0xFF0A6CF5.toInt(), 0),
        Option("sky", 0xFF38BDF8.toInt(), R.style.Accent_Sky),
        Option("teal", 0xFF2DD4BF.toInt(), R.style.Accent_Teal),
        Option("emerald", 0xFF34D399.toInt(), R.style.Accent_Emerald),
        Option("lime", 0xFFA3E635.toInt(), R.style.Accent_Lime),
        Option("amber", 0xFFFBBF24.toInt(), R.style.Accent_Amber),
        Option("rose", 0xFFFB7185.toInt(), R.style.Accent_Rose),
        Option("pink", 0xFFF472B6.toInt(), R.style.Accent_Pink),
        Option("violet", 0xFFA78BFA.toInt(), R.style.Accent_Violet),
        Option("indigo", 0xFF818CF8.toInt(), R.style.Accent_Indigo),
    )

    fun id(ctx: Context): String {
        val id = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null)
        return OPTIONS.firstOrNull { it.id == id }?.id ?: OPTIONS[0].id
    }

    fun set(ctx: Context, id: String) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, id).apply()
    }

    /* Before setContentView: the chosen accent over the app's theme. */
    fun apply(activity: Activity) {
        val style = OPTIONS.first { it.id == id(activity) }.style
        if (style != 0) activity.theme.applyStyle(style, true)
    }

    /* A colour of the accent as the context's theme has it (R.attr.accent…). */
    fun color(ctx: Context, attr: Int): Int {
        val v = TypedValue()
        return if (ctx.theme.resolveAttribute(attr, v, true)) v.data else ctx.getColor(R.color.accent)
    }

    /* The notification's colour: no window theme there, so the swatch. */
    fun swatch(ctx: Context): Int = OPTIONS.first { it.id == id(ctx) }.swatch
}
