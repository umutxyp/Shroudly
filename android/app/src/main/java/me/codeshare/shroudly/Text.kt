package me.codeshare.shroudly

import android.content.Context
import java.util.Locale

/* Strings come from the desktop's locales, with {name} placeholders (scripts/gen-strings.js). */
fun Context.text(id: Int, vararg values: Pair<String, Any>): String {
    var s = getString(id)
    for ((k, v) in values) s = s.replace("{$k}", v.toString())
    return s
}

object Format {
    fun bytes(n: Long, locale: Locale = Locale.getDefault()): String {
        if (n < 1024) return "$n B"
        val units = arrayOf("KB", "MB", "GB", "TB")
        var v = n / 1024.0
        var i = 0
        while (v >= 1024 && i < units.size - 1) { v /= 1024; i++ }
        return String.format(locale, if (v < 10) "%.1f %s" else "%.0f %s", v, units[i])
    }

    fun duration(ms: Long): String {
        val s = maxOf(0L, ms / 1000)
        val h = s / 3600
        val m = s % 3600 / 60
        val sec = s % 60
        return if (h > 0) String.format(Locale.ROOT, "%d:%02d:%02d", h, m, sec) else String.format(Locale.ROOT, "%d:%02d", m, sec)
    }
}
