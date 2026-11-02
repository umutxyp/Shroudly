package me.codeshare.shroudly

import android.content.Context

/*
 * After an update, the main screen says once what changed (whatsNewAndroid,
 * a line each, in the user's language), as the desktop does
 * (electron/whats-new.js): the version last opened is kept, and an opening
 * with another one leaves it to be shown until it is closed. A new install
 * shows nothing; one from before 2.6.48, which kept no version, counts as
 * updated when Android says it was updated since it was installed.
 */
object WhatsNew {
    private const val PREFS = "ui"
    private const val KEY_SEEN = "last_version_seen"
    private const val KEY_PENDING = "whats_new"

    /* What the decision needs, apart from the preferences: the version kept,
     * this version, and whether the app was ever updated. Returns the
     * version whose notes to show now, or null. */
    fun decide(lastSeen: String?, current: String, updatedSinceInstall: Boolean): String? = when {
        lastSeen == current -> null
        lastSeen == null -> if (updatedSinceInstall) current else null
        else -> current
    }

    /* The version whose notes are still to be shown, or null; opening with a
     * new version keeps it as seen and leaves its notes to be shown. */
    fun pending(ctx: Context): String? {
        val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val current = BuildConfig.VERSION_NAME
        val last = p.getString(KEY_SEEN, null)
        if (last != current) {
            val info = try { ctx.packageManager.getPackageInfo(ctx.packageName, 0) } catch (_: Exception) { null }
            val updated = info != null && info.lastUpdateTime > info.firstInstallTime + 1000
            val show = decide(last, current, updated)
            val e = p.edit().putString(KEY_SEEN, current)
            if (show != null) e.putString(KEY_PENDING, show)
            e.apply()
        }
        return p.getString(KEY_PENDING, null)
    }

    fun seen(ctx: Context) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(KEY_PENDING).apply()
    }

    /* The notes as shown: one line each, a bullet before it. */
    fun lines(text: String): String = text.split('\n').map { it.trim() }.filter { it.isNotEmpty() }.joinToString("\n") { "• $it" }
}
