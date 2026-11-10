package me.codeshare.shroudly

import android.content.Context

/*
 * After an update, the main screen says once what changed (whatsNewAndroid,
 * a line each, in the user's language), as the desktop does
 * (electron/whats-new.js): the version last opened is kept, and an opening
 * with another one leaves it to be shown until it is closed. A new install
 * shows nothing; one from before 2.6.48, which kept no version, counts as
 * updated when Android says it was updated since it was installed.
 *
 * Notes already shown are not shown again, and no notes show nothing, as on
 * the desktop: a version whose notes were not rewritten showed the old ones
 * under the new number (2.6.65 to 2.6.70 all said 2.6.64's).
 */
object WhatsNew {
    private const val PREFS = "ui"
    private const val KEY_SEEN = "last_version_seen"
    private const val KEY_PENDING = "whats_new"
    private const val KEY_NOTES = "whats_new_notes"

    /* What the decision needs, apart from the preferences: the version kept,
     * this version, and whether the app was ever updated. Returns the
     * version whose notes to show now, or null. */
    fun decide(lastSeen: String?, current: String, updatedSinceInstall: Boolean, sameNotes: Boolean = false): String? = when {
        lastSeen == current -> null
        sameNotes -> null
        lastSeen == null -> if (updatedSinceInstall) current else null
        else -> current
    }

    /* The version whose notes are still to be shown, or null; opening with a
     * new version keeps it as seen and leaves its notes to be shown. */
    fun pending(ctx: Context, notes: String = ctx.getString(R.string.whatsNewAndroid)): String? {
        val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val current = BuildConfig.VERSION_NAME
        val last = p.getString(KEY_SEEN, null)
        if (last != current) {
            val info = try { ctx.packageManager.getPackageInfo(ctx.packageName, 0) } catch (_: Exception) { null }
            val updated = info != null && info.lastUpdateTime > info.firstInstallTime + 1000
            val d = digest(notes)
            val show = decide(last, current, updated, sameNotes = d == null || d == p.getString(KEY_NOTES, null))
            val e = p.edit().putString(KEY_SEEN, current)
            if (d != null) e.putString(KEY_NOTES, d)
            if (show != null) e.putString(KEY_PENDING, show)
            e.apply()
        }
        return p.getString(KEY_PENDING, null)
    }

    fun seen(ctx: Context) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(KEY_PENDING).apply()
    }

    /* The notes, as a short digest: the same notes, the same digest; none
     * for no notes. */
    fun digest(text: String): String? {
        val t = text.trim()
        if (t.isEmpty()) return null
        val h = java.security.MessageDigest.getInstance("SHA-256").digest(t.toByteArray(Charsets.UTF_8))
        return h.take(8).joinToString("") { "%02x".format(it) }
    }

    /* The notes as shown: one line each, a bullet before it. */
    fun lines(text: String): String = text.split('\n').map { it.trim() }.filter { it.isNotEmpty() }.joinToString("\n") { "• $it" }
}
