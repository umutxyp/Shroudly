package me.codeshare.shroudly

import android.app.LocaleManager
import android.content.Context
import android.content.res.Configuration
import android.os.Build
import android.os.LocaleList
import java.util.Locale

/*
 * The app's language (Settings → Language, issue #38): the phone's, or one of
 * the app's 31 chosen in the app, so that someone whose phone speaks Persian
 * can read Shroudly in English when they write a report. Android 13 and later
 * keep the choice themselves (the per-app language, LocaleManager) for every
 * part of the app. Before that it is kept here and given to each window,
 * service and notice as it is made (wrap).
 */
object Lang {
    private const val PREFS = "settings"
    private const val KEY = "language"

    /* Locale tags and each language's name for itself (gen-strings.js, from
     * the desktop's list), in the desktop's order. */
    fun tags(ctx: Context): Array<String> = ctx.resources.getStringArray(R.array.language_tags)
    fun names(ctx: Context): Array<String> = ctx.resources.getStringArray(R.array.language_names)

    /* The chosen tag, or null: the phone's language. */
    fun chosen(ctx: Context): String? {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val l = ctx.getSystemService(LocaleManager::class.java)?.applicationLocales
            if (l == null || l.isEmpty) return null
            val tag = l[0].toLanguageTag()
            // The one of ours it is (a system setting may give "fa" for "fa-IR").
            return tags(ctx).firstOrNull { it.equals(tag, true) } ?: tags(ctx).firstOrNull { it.substringBefore('-') == l[0].language } ?: tag
        }
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null)
    }

    /* null: the phone's language again. Android 13 and later remake the
     * app's windows by themselves; before that the caller recreates them. */
    fun set(ctx: Context, tag: String?) {
        val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
        if (tag == null) p.remove(KEY) else p.putString(KEY, tag)
        p.commit()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ctx.getSystemService(LocaleManager::class.java)?.applicationLocales =
                if (tag == null) LocaleList.getEmptyLocaleList() else LocaleList.forLanguageTags(tag)
        }
    }

    /* Before Android 13: base, in the chosen language (and its direction). */
    fun wrap(base: Context): Context {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) return base
        val tag = base.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null) ?: return base
        val locale = Locale.forLanguageTag(tag)
        val conf = Configuration(base.resources.configuration)
        conf.setLocale(locale)
        conf.setLayoutDirection(locale)
        return base.createConfigurationContext(conf)
    }
}
