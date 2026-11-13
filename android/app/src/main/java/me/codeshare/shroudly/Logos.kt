package me.codeshare.shroudly

import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager

/*
 * The logo shown on the home screen (Settings, Appearance), the same choice
 * as the desktop's and the Apple apps' (scripts/logo/variants.py draws them
 * all). Each logo is an activity alias of HomeActivity with its own icon
 * (AndroidManifest.xml): the chosen one is turned on and every other off.
 * "classic" is the alias ".MainActivity", the launcher entry every phone has
 * had since the first version.
 *
 * The launcher notices a change after a moment (some only after their own
 * restart), and some end the app as it happens: the change is made with
 * DONT_KILL_APP, and the window comes back if it was ended. Not on a TV,
 * whose launchers show the banner, not the icon.
 */
object Logos {
    private const val PREFS = "settings"
    private const val KEY = "logo"

    val GROUPS = listOf(
        "styles" to listOf("classic", "flat", "line", "paper", "key", "veil", "terminal", "night", "coral"),
        "days" to listOf("newyear", "halloween", "valentine", "spring", "ramadan", "winter"),
        "countries" to listOf("tr", "ir", "ru", "cn", "pk", "az", "kz", "eg", "vn"),
    )
    val IDS = GROUPS.flatMap { it.second }

    /* The alias that carries logo `id` (pure, for the tests). */
    fun alias(id: String): String = if (id == "classic") ".MainActivity" else ".Logo_$id"

    fun id(ctx: Context): String {
        val v = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null)
        return if (v in IDS) v!! else "classic"
    }

    /* The pictures for the picker, named in the code: a release build drops
     * every resource nothing names, so looking them up by name at run time
     * found none there and every logo showed as the classic one. */
    val PICTURES: Map<String, Int> = mapOf(
        "classic" to R.drawable.logo_classic,
        "flat" to R.drawable.logo_flat,
        "line" to R.drawable.logo_line,
        "paper" to R.drawable.logo_paper,
        "key" to R.drawable.logo_key,
        "veil" to R.drawable.logo_veil,
        "terminal" to R.drawable.logo_terminal,
        "night" to R.drawable.logo_night,
        "coral" to R.drawable.logo_coral,
        "newyear" to R.drawable.logo_newyear,
        "halloween" to R.drawable.logo_halloween,
        "valentine" to R.drawable.logo_valentine,
        "spring" to R.drawable.logo_spring,
        "ramadan" to R.drawable.logo_ramadan,
        "winter" to R.drawable.logo_winter,
        "tr" to R.drawable.logo_tr,
        "ir" to R.drawable.logo_ir,
        "ru" to R.drawable.logo_ru,
        "cn" to R.drawable.logo_cn,
        "pk" to R.drawable.logo_pk,
        "az" to R.drawable.logo_az,
        "kz" to R.drawable.logo_kz,
        "eg" to R.drawable.logo_eg,
        "vn" to R.drawable.logo_vn,
    )

    /* The picture of logo `id` for the picker. */
    fun picture(id: String): Int = PICTURES[id] ?: R.drawable.logo

    fun set(ctx: Context, id: String) {
        val v = if (id in IDS) id else "classic"
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, v).apply()
        val pm = ctx.packageManager
        // The new one on first, so there is never a moment with no launcher entry.
        enable(ctx, pm, v, true)
        for (other in IDS) if (other != v) enable(ctx, pm, other, false)
    }

    private fun enable(ctx: Context, pm: PackageManager, id: String, on: Boolean) {
        val c = ComponentName(ctx.packageName, ctx.packageName + alias(id))
        val want = if (on) PackageManager.COMPONENT_ENABLED_STATE_ENABLED else PackageManager.COMPONENT_ENABLED_STATE_DISABLED
        try {
            if (pm.getComponentEnabledSetting(c) != want) pm.setComponentEnabledSetting(c, want, PackageManager.DONT_KILL_APP)
        } catch (_: Exception) {}
    }
}
