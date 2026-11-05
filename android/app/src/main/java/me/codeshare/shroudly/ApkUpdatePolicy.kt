package me.codeshare.shroudly

import java.security.MessageDigest

/*
 * The rules of the APK's own updates (ApkUpdates, in the APK from GitHub
 * only; the copy from Google Play is updated by Play alone): when a new
 * version found in the background is said in a notification, where its APK
 * is fetched from, and whether a file fetched is one to install.
 */
object ApkUpdatePolicy {
    /* The largest APK taken (it is about 30 MB). */
    const val MAX_APK = 200L * 1024 * 1024
    private const val REDIRECTS = 5

    /* A notification for `version`, found in the background: once a
     * version, and only while notifications are allowed (one not shown is
     * not counted as said). */
    fun notifyFor(version: String?, notified: String?, notificationsOn: Boolean): Boolean =
        version != null && notificationsOn && version != notified

    /* Where the APK is fetched from, in order: the release's own file on
     * GitHub, then the same file from Shroudly's download server, which
     * passes the latest release's files through from GitHub where its
     * addresses are blocked (server/stats, as the desktop's updater uses
     * it). A link from anywhere else is not followed. */
    fun sources(url: String?, version: String): List<String> {
        val mirror = "https://${OnlineHttp.HOST}${Versions.mirrorApkPath(version, BuildConfig.APK_VARIANT)}"
        val own = url?.takeIf { it.startsWith(Versions.DOWNLOADS) || it.startsWith("https://${OnlineHttp.HOST}/dl/") }
        return listOfNotNull(own, mirror).distinct()
    }

    /* Where a redirect goes: https only, at most REDIRECTS of them. */
    fun redirect(from: String, location: String?, hops: Int): String? {
        if (location.isNullOrBlank() || hops >= REDIRECTS) return null
        val to = try { java.net.URL(java.net.URL(from), location.trim()) } catch (_: Exception) { return null }
        return if (to.protocol == "https" && !to.host.isNullOrEmpty()) to.toString() else null
    }

    fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    /* The file's signers are this app's: the same certificates (by SHA-256),
     * none missing, none more. Nothing read on either side: not the same. */
    fun sameSigner(installed: Collection<String>, file: Collection<String>): Boolean =
        installed.isNotEmpty() && file.isNotEmpty() && installed.map { it.lowercase() }.toSet() == file.map { it.lowercase() }.toSet()

    /* A file to hand to Android's installer: this app, a newer version of
     * it, signed as it is. */
    fun installable(filePackage: String?, fileCode: Long, ownPackage: String, ownCode: Long, sameSigner: Boolean): Boolean =
        filePackage == ownPackage && fileCode > ownCode && sameSigner
}
