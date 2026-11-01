package me.codeshare.shroudly

import android.content.Context

/*
 * The main window's cards about Google Play, only while Shroudly is on Play
 * (Stores): a rating, in the copy Play installed or updates (RATE); and in
 * any other copy (the APK from GitHub, any other install) a suggestion to
 * move to the one from Play, which Play keeps up to date by itself (MOVE).
 *
 * The rating card shows in the copy Google Play installed or updates only. Never a notification, never a dialog, never more than one
 * prompt a session, never beside a card that asks for something else
 * (MainActivity.showStoreCard), and at a good moment only: protection on and
 * working right now, the app installed for INSTALLED_DAYS and protection
 * having worked on RATE_DAYS different days (Usage). It asks nothing about
 * the user's opinion and offers nothing for a rating (Google Play's rules).
 *
 * A showing that ends without the button is a "no": the next one waits 14
 * days after the first, then 28, 56, 112... (each "no" doubles it). The
 * button opens Shroudly's Play page itself (not Play's in-app review, whose
 * quota may show nothing after a tap) and the card never comes back.
 */
object StoreCards {
    private const val DAY = 24L * 60 * 60 * 1000
    const val INSTALLED_DAYS = 3
    const val RATE_DAYS = 3
    const val RATE_FIRST_WAIT_DAYS = 14

    /* The copy Google Play installed or last updated (the APK from GitHub,
     * or one put on the phone any other way, is not). */
    fun fromPlay(installer: String?): Boolean = installer == InstallSource.PLAY_STORE

    /* A card's record: done (its button tapped: never again), how many
     * times it was shown, when last, and when it may come next. */
    data class State(val done: Boolean = false, val shown: Int = 0, val lastAt: Long = 0, val nextAt: Long = 0)

    /* A clock set back before the last showing: the wait starts over from
     * now, as long as it was, so it shows neither early nor never. */
    fun rebase(s: State, now: Long): State =
        if (s.lastAt > 0 && now < s.lastAt) s.copy(lastAt = now, nextAt = now + (s.nextAt - s.lastAt).coerceAtLeast(0)) else s

    /* The wait after the n-th "no": 14 days, doubled each time after. */
    fun rateWaitMs(noes: Int): Long = RATE_FIRST_WAIT_DAYS * DAY shl (noes.coerceIn(1, 16) - 1)

    fun rateDue(fromPlay: Boolean, live: Boolean, working: Boolean, installedAt: Long, workedDays: Int, s: State, now: Long): Boolean =
        fromPlay && live && working && !s.done && now - installedAt >= INSTALLED_DAYS * DAY && workedDays >= RATE_DAYS && now >= s.nextAt

    /* Shown: a "no" until the button is tapped (rateTapped). */
    fun rateShown(s: State, now: Long): State {
        val n = s.shown + 1
        return s.copy(shown = n, lastAt = now, nextAt = now + rateWaitMs(n))
    }

    /* The suggestion to move to the copy from Google Play: at most
     * MOVE_MAX times ever, the second MOVE_AGAIN_DAYS after the first; never
     * again once "Open Google Play" was tapped. Only where the Play Store is
     * on the phone, not while the ad blocker is on (the copy from Play has
     * none: moving would lose it), while protection is on and working, the
     * app installed INSTALLED_DAYS and protection having worked on MOVE_DAYS.
     * A window not opened for NOTIFY_IDLE_DAYS when it is due gets one quiet
     * notification instead, which counts as a showing. */
    const val MOVE_DAYS = 2
    const val MOVE_AGAIN_DAYS = 30
    const val MOVE_MAX = 2
    const val NOTIFY_IDLE_DAYS = 3

    fun moveDue(fromPlay: Boolean, live: Boolean, playStore: Boolean, working: Boolean, adBlock: Boolean,
                installedAt: Long, workedDays: Int, s: State, now: Long): Boolean =
        !fromPlay && live && playStore && working && !adBlock && !s.done && s.shown < MOVE_MAX &&
            now - installedAt >= INSTALLED_DAYS * DAY && workedDays >= MOVE_DAYS && now >= s.nextAt

    fun moveShown(s: State, now: Long): State = s.copy(shown = s.shown + 1, lastAt = now, nextAt = now + MOVE_AGAIN_DAYS * DAY)

    /* The window has not been on screen for NOTIFY_IDLE_DAYS (or ever, or
     * the clock was set back past it). */
    fun windowIdle(windowSeenAt: Long, now: Long): Boolean = now - windowSeenAt !in 0 until NOTIFY_IDLE_DAYS * DAY

    /* At most one prompt in a run of the app. */
    @Volatile var promptedThisRun = false

    private fun prefs(ctx: Context) = ctx.getSharedPreferences("ui", Context.MODE_PRIVATE)

    fun load(ctx: Context, key: String, now: Long = System.currentTimeMillis()): State {
        val p = prefs(ctx)
        val s = State(p.getBoolean("${key}Done", false), p.getInt("${key}Shown", 0), p.getLong("${key}LastAt", 0), p.getLong("${key}NextAt", 0))
        val r = rebase(s, now)
        if (r != s) save(ctx, key, r)
        return r
    }

    fun save(ctx: Context, key: String, s: State) {
        prefs(ctx).edit().putBoolean("${key}Done", s.done).putInt("${key}Shown", s.shown)
            .putLong("${key}LastAt", s.lastAt).putLong("${key}NextAt", s.nextAt).apply()
    }

    const val RATE = "rate"
    const val MOVE = "move"
    private const val NOTICE_ID = 9
    // The services look this often whether the notification is due.
    const val LOOK_EVERY_MS = 6L * 60 * 60 * 1000

    fun playStoreInstalled(ctx: Context): Boolean = try {
        ctx.packageManager.getPackageInfo(InstallSource.PLAY_STORE, 0); true
    } catch (_: Exception) {
        false
    }

    /* Whether the suggestion to move is due now (protection working:
     * the caller knows). */
    fun moveDueNow(ctx: Context, working: Boolean, now: Long = System.currentTimeMillis()): Boolean =
        moveDue(fromPlay(InstallSource.installer(ctx)), Stores.playLive(ctx, now), playStoreInstalled(ctx), working,
            AdBlock.enabled(ctx), Usage.installedAt(ctx), Usage.days(ctx), load(ctx, MOVE, now), now)

    /* From the services while protection is on (now and then): the flag
     * asked for through the engine, and the suggestion as one quiet
     * notification when it is due and the window has not been opened for
     * days. A tap opens the window, which shows the card. */
    fun look(ctx: Context, port: Int, auth: SocksAuth?) {
        Stores.refreshIfDue(ctx, port, auth)
        val now = System.currentTimeMillis()
        if (promptedThisRun || !windowIdle(Usage.windowSeenAt(ctx), now)) return
        val working = Protection.state == Protection.State.ON && Protection.troubleRes == 0
        if (!moveDueNow(ctx, working, now)) return
        promptedThisRun = true
        save(ctx, MOVE, moveShown(load(ctx, MOVE, now), now))
        ShroudlyVpnService.log("Suggesting the copy from Google Play in a notification (the window has not been opened for days)")
        try {
            ShroudlyVpnService.channels(ctx)
            val open = android.app.PendingIntent.getActivity(
                ctx, NOTICE_ID, android.content.Intent(ctx, MainActivity::class.java).putExtra(MainActivity.EXTRA_STORE_CARD, MOVE)
                    .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK or android.content.Intent.FLAG_ACTIVITY_SINGLE_TOP),
                android.app.PendingIntent.FLAG_IMMUTABLE or android.app.PendingIntent.FLAG_UPDATE_CURRENT,
            )
            val body = ctx.getString(R.string.androidMoveBody)
            // The quiet channel (protection's own: low, no sound, no heads-up).
            val n = android.app.Notification.Builder(ctx, ShroudlyVpnService.CHANNEL)
                .setSmallIcon(R.drawable.ic_shield)
                .setContentTitle(ctx.getString(R.string.androidMoveTitle))
                .setContentText(body)
                .setStyle(android.app.Notification.BigTextStyle().bigText(body))
                .setContentIntent(open)
                .setAutoCancel(true)
                .setOnlyAlertOnce(true)
                .setCategory(android.app.Notification.CATEGORY_RECOMMENDATION)
                .build()
            ctx.getSystemService(android.app.NotificationManager::class.java)?.notify(NOTICE_ID, n)
        } catch (e: Exception) {
            ShroudlyVpnService.log("Could not post the notice: ${e.message}")
        }
    }

    fun clearNotice(ctx: Context) {
        try { ctx.getSystemService(android.app.NotificationManager::class.java)?.cancel(NOTICE_ID) } catch (_: Exception) {}
    }
}
