package me.codeshare.shroudly

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import android.content.Intent

/*
 * Protection stays on until the user turns it off (issue #39). Some phones
 * end apps while the screen is locked, and with them the VPN: a power saver
 * that also turns Wi-Fi and mobile data off, a cleaner that runs at lock.
 * Nothing of Shroudly runs then, so what brings it back is a job Android
 * keeps for it (ResumeJob), waiting for a network:
 *   - armed while protection is on and the network goes away (the moment
 *     such a phone ends apps); with the network back and protection still
 *     on, it does nothing;
 *   - armed when protection ended by itself (a tunnel that kept failing, a
 *     network the engine could not get through), no sooner than RETRY_MS,
 *     at most MAX_RESUMES times an hour, so a network where it cannot work
 *     is not tried over and over;
 *   - never after the user turned protection off, or another VPN took over.
 * An update of Shroudly ends it too; that one needs no job: it comes back
 * at once (updated). So does a restart of the phone (booted): turning the
 * phone off and on is not turning protection off. And Proxy only after
 * Android ended the app while it was on (ShroudlyProxyService,
 * START_STICKY): a network's proxy set to it reaches nothing while it is
 * off, and apps that use it would have no connection at all.
 * A VPN app the user has allowed may start its service from the background,
 * so the job turns protection on by itself. Where Android still refuses
 * (Proxy only), a notice offers it with one tap.
 *
 * Android's own Always-on VPN does the same from the system's settings, and
 * more (it also brings back an app the phone stopped altogether); this is
 * for phones where it is not set.
 */
object KeepOn {
    private const val PREFS = "settings"
    private const val KEY_WANTED = "keepOnWanted"
    private const val KEY_RESUMES = "keepOnResumes"
    const val JOB_ID = 7301
    const val NETWORK_GONE_DELAY_MS = 0L
    const val RETRY_MS = 2 * 60 * 1000L
    const val WINDOW_MS = 60 * 60 * 1000L
    const val MAX_RESUMES = 3
    private const val OFFER_ID = 7302

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /* Protection was on and the user has not turned it off since. */
    fun wanted(ctx: Context): Boolean = prefs(ctx).getBoolean(KEY_WANTED, false)

    /* Protection is on. */
    fun on(ctx: Context) {
        prefs(ctx).edit().putBoolean(KEY_WANTED, true).apply()
        try { ctx.getSystemService(NotificationManager::class.java)?.cancel(OFFER_ID) } catch (_: Exception) {}
    }

    /* The user turned it off, or gave it to another VPN: it stays off. */
    fun stoppedByUser(ctx: Context) {
        prefs(ctx).edit().putBoolean(KEY_WANTED, false).remove(KEY_RESUMES).apply()
        cancel(ctx)
    }

    /* The network went away while protection was on. */
    fun networkGone(ctx: Context) {
        if (wanted(ctx)) arm(ctx, NETWORK_GONE_DELAY_MS)
    }

    /* Protection ended by itself. Whether it will be brought back. */
    fun endedByItself(ctx: Context): Boolean {
        if (!wanted(ctx)) return false
        if (!mayResume(resumes(ctx), System.currentTimeMillis())) return false
        arm(ctx, RETRY_MS)
        return true
    }

    /* The times protection was brought back, within the last WINDOW_MS. */
    private fun resumes(ctx: Context): List<Long> =
        prefs(ctx).getString(KEY_RESUMES, "").orEmpty().split(',').mapNotNull { it.toLongOrNull() }

    private fun resumed(ctx: Context) {
        val now = System.currentTimeMillis()
        val keep = resumes(ctx).filter { now - it in 0 until WINDOW_MS } + now
        prefs(ctx).edit().putString(KEY_RESUMES, keep.joinToString(",")).apply()
    }

    /* Fewer than MAX_RESUMES in the last WINDOW_MS (a time in the future,
     * the clock set back, counts as recent). */
    fun mayResume(times: List<Long>, now: Long): Boolean =
        times.count { now - it < WINDOW_MS } < MAX_RESUMES

    private fun arm(ctx: Context, delayMs: Long) {
        try {
            val job = JobInfo.Builder(JOB_ID, ComponentName(ctx, ResumeJob::class.java))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setMinimumLatency(delayMs)
                .build()
            ctx.getSystemService(JobScheduler::class.java)?.schedule(job)
        } catch (e: Exception) {
            ShroudlyVpnService.log("Could not ask Android to bring protection back: ${e.message}")
        }
    }

    private fun cancel(ctx: Context) {
        try { ctx.getSystemService(JobScheduler::class.java)?.cancel(JOB_ID) } catch (_: Exception) {}
    }

    /* The job: a network is there. */
    fun resume(ctx: Context) {
        if (!wanted(ctx) || Protection.state != Protection.State.OFF) return
        ShroudlyVpnService.attachLog(ctx)
        resumed(ctx)
        ShroudlyVpnService.log("A network is there and protection was not turned off by you: turning it on again")
        val started = try {
            Protector.start(ctx)
        } catch (e: Exception) {
            // Android does not let this app start it from the background.
            ShroudlyVpnService.log("Android did not let protection start in the background (${e.javaClass.simpleName}); a notice offers it")
            offer(ctx)
            return
        }
        // The VPN is no longer allowed (another VPN app, or the user took it
        // back in Android's settings): nothing to bring back.
        if (!started) stoppedByUser(ctx)
    }

    /* Updated while protection was on (Google Play, inside the app or by
     * itself, or a new APK over it): installing ended the app and the VPN
     * with it, not the user. Android lets an app start its service right
     * after its own update (MY_PACKAGE_REPLACED, BootReceiver), so it comes
     * back at once instead of staying off until the user notices. */
    fun updated(ctx: Context) {
        if (!wanted(ctx) || Protection.state != Protection.State.OFF) return
        startAgain(ctx, "Updated to ${BuildConfig.VERSION_NAME} while protection was on: turning it on again", "after the update")
    }

    /* The phone restarted while protection was on, and "Start when the
     * phone starts" is off (BootReceiver): it comes back, in either mode.
     * Up to 2.6.44 only Proxy only did (apps set to use it reach nothing
     * without it), and the VPN stayed off without a word: blocked sites were
     * blocked again in the morning, though the user had never turned it
     * off. The VPN starts only where it is still allowed (another app made
     * the always-on VPN meanwhile: nothing, and it stays off). */
    fun booted(ctx: Context) {
        if (!wanted(ctx) || Protection.state != Protection.State.OFF) return
        startAgain(ctx, "The phone restarted while protection was on: turning it on again", "after the phone restarted")
    }

    private fun startAgain(ctx: Context, line: String, moment: String) {
        ShroudlyVpnService.attachLog(ctx)
        resumed(ctx)
        ShroudlyVpnService.log(line)
        val started = try {
            Protector.start(ctx)
        } catch (e: Exception) {
            ShroudlyVpnService.log("Android did not let protection start $moment (${e.javaClass.simpleName}); a notice offers it")
            offer(ctx)
            return
        }
        if (!started) stoppedByUser(ctx)
    }

    /* A notice that turns protection on with one tap (also where Android
     * refused Proxy only's own start again, ShroudlyProxyService). */
    fun offer(ctx: Context) {
        try {
            ShroudlyVpnService.channels(ctx)
            val intent = if (AppSettings.proxyOnly(ctx)) Intent(ctx, ShroudlyProxyService::class.java).setAction(ShroudlyProxyService.ACTION_START)
                else Intent(ctx, ShroudlyVpnService::class.java).setAction(ShroudlyVpnService.ACTION_START)
            val start = PendingIntent.getForegroundService(
                ctx, OFFER_ID, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            val body = ctx.getString(R.string.androidKeepOnOffer)
            val n = Notification.Builder(ctx, ShroudlyVpnService.ALERT_CHANNEL)
                .setSmallIcon(R.drawable.ic_shield)
                .setContentTitle(ctx.getString(R.string.app_name))
                .setContentText(body)
                .setStyle(Notification.BigTextStyle().bigText(body))
                .setContentIntent(start)
                .setAutoCancel(true)
                .build()
            ctx.getSystemService(NotificationManager::class.java)?.notify(OFFER_ID, n)
        } catch (e: Exception) {
            ShroudlyVpnService.log("Could not post the notice: ${e.message}")
        }
    }
}

/* Run by Android once a network is there (KeepOn). */
class ResumeJob : JobService() {
    override fun attachBaseContext(base: Context) = super.attachBaseContext(Lang.wrap(base))

    override fun onStartJob(params: JobParameters): Boolean {
        KeepOn.resume(this)
        return false
    }

    override fun onStopJob(params: JobParameters): Boolean = false
}
