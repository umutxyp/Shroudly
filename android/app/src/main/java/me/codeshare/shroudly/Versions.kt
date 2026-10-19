package me.codeshare.shroudly

/* Version numbers as tagged on GitHub ("v2.5.14", "2.6.0"). */
object Versions {
    fun parse(v: String): List<Int>? {
        val core = display(v).substringBefore('-').substringBefore('+')
        val parts = core.split('.')
        if (parts.isEmpty() || parts.size > 4) return null
        return parts.map { it.toIntOrNull()?.takeIf { n -> n >= 0 } ?: return null }
    }

    /* Negative, zero or positive, like compareTo. Unreadable versions sort first. */
    fun compare(a: String, b: String): Int {
        val x = parse(a) ?: return if (parse(b) == null) 0 else -1
        val y = parse(b) ?: return 1
        for (i in 0 until maxOf(x.size, y.size)) {
            val c = x.getOrElse(i) { 0 }.compareTo(y.getOrElse(i) { 0 })
            if (c != 0) return c
        }
        return 0
    }

    fun isNewer(candidate: String, current: String) = compare(candidate, current) > 0

    /* A release is offered to this app only when it is newer and has an APK:
     * desktop-only releases share the version numbers. */
    fun offers(tag: String, assetNames: List<String>, current: String): Boolean =
        isNewer(tag, current) && assetNames.any { it.endsWith(".apk", ignoreCase = true) }

    /* "v2.6.0" -> "2.6.0", for display. */
    fun display(tag: String) = tag.trim().removePrefix("v").removePrefix("V")
}
