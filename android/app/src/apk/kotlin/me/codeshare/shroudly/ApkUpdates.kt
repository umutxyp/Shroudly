package me.codeshare.shroudly

import android.app.Activity
import android.app.AlertDialog
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.Proxy
import java.net.Socket
import java.net.URL

/*
 * The APK from GitHub updates itself (the build made for Google Play has an
 * empty one, src/play/kotlin: Play's policy allows updates from Play alone).
 *
 *  - Found while protection is on, without the window (look, from the
 *    services now and then): one quiet notification a version, while
 *    notifications are allowed (ApkUpdatePolicy.notifyFor). Most open the
 *    window seldom; the tile and starting with the phone are enough.
 *  - "Download and install" (the window's card, or that notification):
 *    where Android does not let Shroudly install apps yet, its one settings
 *    page for that, after a word on what to switch on. Then the APK, from
 *    the release on GitHub or, where GitHub's file host does not answer,
 *    from Shroudly's download server (ApkUpdatePolicy.sources), through the
 *    engine while protection is on. It is installed only if it is this app,
 *    newer, and signed with this app's certificate (the same SHA-256), and
 *    Android's own installer then asks the user. Protection comes back by
 *    itself after the update (KeepOn.updated).
 */
object ApkUpdates {
    enum class Stage { DOWNLOADING, WAITING, FAILED }

    /* Where the update the window shows stands (null: nothing under way). */
    data class Now(val version: String, val stage: Stage, val percent: Int = 0, val failed: Int = 0)

    @Volatile var now: Now? = null
        private set

    private const val PREFS = "update"
    private const val KEY_NOTIFIED = "notifiedVersion"
    private const val NOTICE_ID = 10
    private const val READY_ID = 11
    const val EXTRA_VERSION = "version"

    // An update asked for while Android did not let Shroudly install apps:
    // taken up again once the user is back from that setting (resume).
    @Volatile private var pending: Triple<String, String, String>? = null
    @Volatile private var checking = false

    fun available(ctx: Context): Boolean = InstallSource.githubUpdates(ctx)

    private fun set(n: Now?) {
        now = n
        Protection.changed()
    }

    /* The window showed the card for `version`: no notification for it. */
    fun seen(ctx: Context, version: String) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_NOTIFIED, version).apply()
    }

    /* The full APK (with Tor) of this same version in place of the lite one
     * (LiteOffer): fetched and installed as an update is. */
    fun startFull(activity: Activity) {
        val v = BuildConfig.VERSION_NAME
        start(activity, v, ApkUpdatePolicy.fullApkUrl(v), "")
    }

    fun start(activity: Activity, version: String, url: String, variant: String = BuildConfig.APK_VARIANT) {
        if (!available(activity) || now?.stage == Stage.DOWNLOADING) return
        if (!activity.packageManager.canRequestPackageInstalls()) {
            pending = Triple(version, url, variant)
            try {
                AlertDialog.Builder(activity)
                    .setMessage(R.string.androidUnknownSources)
                    .setPositiveButton(R.string.androidContinue) { _, _ ->
                        try {
                            activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")))
                        } catch (_: Exception) {
                            pending = null
                            activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                        }
                    }
                    .setNegativeButton(android.R.string.cancel) { _, _ -> pending = null }
                    .show()
            } catch (_: Exception) {}
            return
        }
        val app = activity.applicationContext
        val port = Protection.socksPort
        val auth = Protection.socksAuth
        set(Now(version, Stage.DOWNLOADING))
        Thread({ run(app, version, url, port, auth, variant) }, "apk-update").apply { isDaemon = true }.start()
    }

    /* Back from Android's "install unknown apps" page: on, if it was allowed. */
    fun resume(activity: Activity) {
        val p = pending ?: return
        if (!activity.packageManager.canRequestPackageInstalls()) return
        pending = null
        start(activity, p.first, p.second, p.third)
    }

    private fun run(ctx: Context, version: String, url: String, port: Int, auth: SocksAuth?, variant: String) {
        val dir = File(ctx.cacheDir, "update").apply { mkdirs() }
        dir.listFiles()?.forEach { it.delete() }
        val file = File(dir, "Shroudly-$version.apk")
        try {
            var fetched = false
            for (src in ApkUpdatePolicy.sources(url, version, variant)) {
                try {
                    ShroudlyVpnService.log("Update $version: downloading from ${URL(src).host}${if (port > 0) " through the engine" else ""}")
                    fetch(src, file, port, auth) { done, total -> if (total > 0) set(Now(version, Stage.DOWNLOADING, (done * 100 / total).toInt())) }
                    fetched = true
                    break
                } catch (e: Exception) {
                    ShroudlyVpnService.log("Update $version: ${URL(src).host} did not give it (${e.message ?: e.javaClass.simpleName})")
                }
            }
            if (!fetched) { set(Now(version, Stage.FAILED, failed = R.string.updInstallFailed)); return }
            if (!verified(ctx, file, sameVersion = variant != BuildConfig.APK_VARIANT)) {
                ShroudlyVpnService.log("Update $version: the file is not this app, not newer, or not signed with its certificate; not installed")
                set(Now(version, Stage.FAILED, failed = R.string.androidUpdateNotSigned))
                return
            }
            install(ctx, file, version)
            set(Now(version, Stage.WAITING, 100))
        } catch (e: Exception) {
            ShroudlyVpnService.log("Update $version could not be installed: ${e.message ?: e.javaClass.simpleName}")
            set(Now(version, Stage.FAILED, failed = R.string.updInstallFailed))
        } finally {
            file.delete()
        }
    }

    /* GET url into `file`, following https redirects (GitHub's file host):
     * through the engine while protection is on, else directly. */
    private fun fetch(url: String, file: File, port: Int, auth: SocksAuth?, progress: (Long, Long) -> Unit) {
        var u = url
        var hops = 0
        while (true) {
            val at = URL(u)
            if (port > 0) {
                val raw = Socket(Proxy.NO_PROXY)
                try {
                    val ssl = UpdateCheck.getViaEngine(raw, at.host, at.file.ifEmpty { "/" }, "*/*", port, auth)
                    val input = ssl.inputStream.buffered()
                    val head = Http1.head(input)
                    if (head.status in 300..399) {
                        u = ApkUpdatePolicy.redirect(u, head.headers["location"], hops++) ?: throw IOException("HTTP ${head.status} to nowhere")
                        continue
                    }
                    if (head.status != 200) throw IOException("HTTP ${head.status}")
                    file.outputStream().use { Http1.copyBody(input, head, it, ApkUpdatePolicy.MAX_APK, progress) }
                    return
                } finally {
                    try { raw.close() } catch (_: IOException) {}
                }
            }
            val c = at.openConnection(Proxy.NO_PROXY) as HttpURLConnection
            try {
                c.instanceFollowRedirects = false
                c.connectTimeout = 15000
                c.readTimeout = 15000
                c.setRequestProperty("User-Agent", UpdateCheck.userAgent())
                val status = c.responseCode
                if (status in 300..399) {
                    u = ApkUpdatePolicy.redirect(u, c.getHeaderField("Location"), hops++) ?: throw IOException("HTTP $status to nowhere")
                    continue
                }
                if (status != 200) throw IOException("HTTP $status")
                val total = c.contentLengthLong
                if (total > ApkUpdatePolicy.MAX_APK) throw IOException("too large")
                c.inputStream.use { input ->
                    file.outputStream().use { out ->
                        val buf = ByteArray(65536)
                        var done = 0L
                        while (true) {
                            val r = input.read(buf)
                            if (r < 0) break
                            done += r
                            if (done > ApkUpdatePolicy.MAX_APK) throw IOException("too large")
                            out.write(buf, 0, r)
                            progress(done, total)
                        }
                        if (total >= 0 && done != total) throw IOException("cut short")
                    }
                }
                return
            } finally {
                c.disconnect()
            }
        }
    }

    @Suppress("DEPRECATION")
    private fun flags(): Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) PackageManager.GET_SIGNING_CERTIFICATES or PackageManager.GET_SIGNATURES
        else PackageManager.GET_SIGNATURES

    /* SHA-256 of each certificate the APK's contents are signed with. */
    @Suppress("DEPRECATION")
    private fun signers(info: PackageInfo?): List<String> {
        if (info == null) return emptyList()
        val certs = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && info.signingInfo != null) info.signingInfo!!.apkContentsSigners else info.signatures
        return certs?.filterNotNull()?.map { ApkUpdatePolicy.sha256Hex(it.toByteArray()) } ?: emptyList()
    }

    @Suppress("DEPRECATION")
    private fun code(info: PackageInfo?): Long =
        if (info == null) -1 else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode else info.versionCode.toLong()

    private fun verified(ctx: Context, file: File, sameVersion: Boolean = false): Boolean {
        val pm = ctx.packageManager
        val fileInfo = try { pm.getPackageArchiveInfo(file.path, flags()) } catch (_: Exception) { null }
        val own = try { pm.getPackageInfo(ctx.packageName, flags()) } catch (_: Exception) { null }
        return ApkUpdatePolicy.installable(fileInfo?.packageName, code(fileInfo), ctx.packageName, code(own),
            ApkUpdatePolicy.sameSigner(signers(own), signers(fileInfo)), sameVersion)
    }

    /* To Android's installer, which asks the user (UpdateInstallReceiver). */
    private fun install(ctx: Context, file: File, version: String) {
        val installer = ctx.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(ctx.packageName)
            setSize(file.length())
            setInstallReason(PackageManager.INSTALL_REASON_USER)
        }
        val id = installer.createSession(params)
        installer.openSession(id).use { s ->
            s.openWrite("shroudly.apk", 0, file.length()).use { out ->
                file.inputStream().use { it.copyTo(out) }
                s.fsync(out)
            }
            // Mutable: Android puts the outcome in it.
            val mutable = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
            val status = PendingIntent.getBroadcast(ctx, id,
                Intent(ctx, UpdateInstallReceiver::class.java).setPackage(ctx.packageName).putExtra(EXTRA_VERSION, version),
                PendingIntent.FLAG_UPDATE_CURRENT or mutable)
            s.commit(status.intentSender)
        }
        ShroudlyVpnService.log("Update $version: signed as this app; handed to Android's installer")
    }

    fun failed(version: String) = set(Now(version, Stage.FAILED, failed = R.string.updInstallFailed))

    /* Android's installer asks the user: at once while the window is open,
     * else in a notification (an app in the background may not open it). */
    fun confirm(ctx: Context, version: String, confirm: Intent) {
        if (Protection.windowVisible) {
            try { ctx.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); return } catch (_: Exception) {}
        }
        try {
            ShroudlyVpnService.channels(ctx)
            val open = PendingIntent.getActivity(ctx, READY_ID, confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            val n = Notification.Builder(ctx, ShroudlyVpnService.CHANNEL)
                .setSmallIcon(R.drawable.ic_shield)
                .setContentTitle(ctx.text(R.string.updReady, "version" to version))
                .setContentText(ctx.getString(R.string.androidUpdateInstallTap))
                .setContentIntent(open)
                .setAutoCancel(true)
                .build()
            ctx.getSystemService(NotificationManager::class.java)?.notify(READY_ID, n)
        } catch (e: Exception) {
            ShroudlyVpnService.log("Could not post the notice: ${e.message}")
        }
    }

    /* From the services while protection is on (now and then): an update
     * looked for when due, through the engine, and said once. */
    fun look(ctx: Context, port: Int, auth: SocksAuth?) {
        if (!available(ctx) || checking || !UpdateCheck.due(ctx)) return
        checking = true
        val app = ctx.applicationContext
        Thread({
            try {
                UpdateCheck.check(app, port, auth)?.let { found(app, it) }
            } catch (e: Exception) {
                ShroudlyVpnService.log("Update check failed: ${e.message}")
            } finally {
                checking = false
            }
        }, "update-look").apply { isDaemon = true }.start()
    }

    private fun found(ctx: Context, offer: UpdateCheck.Offer) {
        val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val nm = ctx.getSystemService(NotificationManager::class.java) ?: return
        val on = try { nm.areNotificationsEnabled() } catch (_: Exception) { false }
        if (!ApkUpdatePolicy.notifyFor(offer.version, p.getString(KEY_NOTIFIED, null), on)) return
        try {
            ShroudlyVpnService.channels(ctx)
            val open = PendingIntent.getActivity(ctx, NOTICE_ID,
                Intent(ctx, MainActivity::class.java).putExtra(MainActivity.EXTRA_UPDATE, true)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            // The quiet channel (protection's own: low, no sound, no heads-up).
            val n = Notification.Builder(ctx, ShroudlyVpnService.CHANNEL)
                .setSmallIcon(R.drawable.ic_shield)
                .setContentTitle(ctx.text(R.string.updAvailable, "version" to offer.version))
                .setContentText(ctx.getString(R.string.androidUpdateTap))
                .setContentIntent(open)
                .setAutoCancel(true)
                .setOnlyAlertOnce(true)
                .build()
            nm.notify(NOTICE_ID, n)
            p.edit().putString(KEY_NOTIFIED, offer.version).apply()
            ShroudlyVpnService.log("Update ${offer.version} found in the background; said in a notification")
        } catch (e: Exception) {
            ShroudlyVpnService.log("Could not post the notice: ${e.message}")
        }
    }
}

/* What Android's installer did with an update (ApkUpdates.install). */
class UpdateInstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val ctx = Lang.wrap(context)
        ShroudlyVpnService.attachLog(ctx)
        val version = intent.getStringExtra(ApkUpdates.EXTRA_VERSION) ?: ""
        when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                @Suppress("DEPRECATION")
                val confirm = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                    else intent.getParcelableExtra(Intent.EXTRA_INTENT)
                if (confirm != null) ApkUpdates.confirm(ctx, version, confirm) else ApkUpdates.failed(version)
            }
            PackageInstaller.STATUS_SUCCESS -> ShroudlyVpnService.log("Update $version installed")
            else -> {
                ShroudlyVpnService.log("Update $version was not installed (${intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)})")
                ApkUpdates.failed(version)
            }
        }
    }
}
