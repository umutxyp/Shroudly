package me.codeshare.shroudly

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import java.io.File
import java.io.FileNotFoundException

/*
 * "Share Shroudly" (About): this app's own APK, to another phone through
 * whatever the share sheet offers (Bluetooth, a nearby-share app, a
 * messenger inside the country). During a shutdown the download page abroad
 * cannot be reached, but a phone next to you can pass it on.
 *
 * The APK from GitHub only: it is one file that installs anywhere. A copy
 * from Google Play is split in parts no other phone can install, and Play
 * installs its own updates. The file is read where Android keeps it, nothing
 * copied, served by ApkProvider to the app chosen, for that once.
 */
object ApkShare {
    const val MIME = "application/vnd.android.package-archive"

    fun available(ctx: Context): Boolean =
        !BuildConfig.STORE_BUILD && ctx.applicationInfo.splitSourceDirs.isNullOrEmpty() && File(ctx.applicationInfo.sourceDir).canRead()

    fun fileName(): String = "Shroudly-${BuildConfig.VERSION_NAME}.apk"

    fun uri(ctx: Context): Uri = Uri.parse("content://${ctx.packageName}.apk/${fileName()}")

    fun share(a: Activity) {
        if (!available(a)) return
        val send = Intent(Intent.ACTION_SEND)
            .setType(MIME)
            .putExtra(Intent.EXTRA_STREAM, uri(a))
            .putExtra(Intent.EXTRA_TEXT, a.text(R.string.shareAppText, "version" to BuildConfig.VERSION_NAME))
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        try {
            a.startActivity(Intent.createChooser(send, a.getString(R.string.shareApp)).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
        } catch (_: ActivityNotFoundException) {
        }
    }
}

/* The one file ApkShare offers, read-only, to an app it was granted to
 * (not exported). */
class ApkProvider : ContentProvider() {
    override fun onCreate() = true

    private fun apk(): File {
        val ctx = context ?: throw FileNotFoundException("no context")
        if (!ApkShare.available(ctx)) throw FileNotFoundException("not shared from this copy")
        return File(ctx.applicationInfo.sourceDir)
    }

    override fun getType(uri: Uri) = ApkShare.MIME

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        if (mode != "r") throw FileNotFoundException("read only")
        return ParcelFileDescriptor.open(apk(), ParcelFileDescriptor.MODE_READ_ONLY)
    }

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor {
        val cols = projection?.filter { it == OpenableColumns.DISPLAY_NAME || it == OpenableColumns.SIZE }?.toTypedArray()
            ?: arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
        val f = apk()
        return MatrixCursor(cols, 1).apply { addRow(cols.map<String, Any> { if (it == OpenableColumns.SIZE) f.length() else ApkShare.fileName() }.toTypedArray()) }
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?) = 0
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?) = 0
}
