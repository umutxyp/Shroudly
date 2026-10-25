package me.codeshare.shroudly

import android.content.Context
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.Socket
import java.net.URL
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SNIHostName
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

/*
 * Is there a newer release with an Android build? Asks GitHub's API for the
 * latest release. While protection is on the request goes through the engine,
 * like the desktop updater's, so a network that blocks GitHub does not hide
 * updates; otherwise it goes direct. Where GitHub cannot be reached at all
 * (its addresses blackholed), Shroudly's own download server answers instead.
 * Nothing is downloaded or installed here: the window's button opens the
 * release's APK in the browser, which downloads it, and Android asks before
 * installing it.
 *
 * Only for the APK from GitHub: a copy that Google Play installed or updates,
 * and the build made for Play, never ask GitHub (InstallSource).
 */
object UpdateCheck {
    const val REPO_URL = "https://github.com/umutxyp/Shroudly"
    const val RELEASES_URL = "$REPO_URL/releases"
    const val PRIVACY_URL = "$REPO_URL#privacy"
    private const val API_HOST = "api.github.com"
    private const val API_PATH = "/repos/umutxyp/Shroudly/releases/latest"
    // Shroudly's download server serves the latest release's files by name
    // (server/stats/server.js); its update feed carries the version.
    private const val MIRROR_HOST = OnlineHttp.HOST
    private const val MIRROR_FEED = "/dl/latest.yml"
    private const val EVERY_MS = 6L * 60 * 60 * 1000
    private const val TIMEOUT_MS = 15000
    // A release's JSON, with its notes and every platform's files.
    private const val MAX_BODY = 1 shl 20
    private const val PREFS = "update"

    class Offer(val version: String, val url: String)

    /* The offer remembered from the last check, if it is still newer than this app. */
    fun remembered(ctx: Context): Offer? {
        if (!InstallSource.githubUpdates(ctx)) return null
        val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val tag = p.getString("tag", null) ?: return null
        val url = p.getString("url", null) ?: return null
        return if (Versions.isNewer(tag, BuildConfig.VERSION_NAME)) Offer(Versions.display(tag), url) else null
    }

    fun due(ctx: Context): Boolean {
        if (!InstallSource.githubUpdates(ctx)) return false
        val at = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getLong("checkedAt", 0)
        val now = System.currentTimeMillis()
        return now - at > EVERY_MS || at > now
    }

    /* Blocking: call off the main thread. Returns the offer, or null if up to date. Throws on failure. */
    fun check(ctx: Context, socksPort: Int, auth: SocksAuth?): Offer? {
        if (!InstallSource.githubUpdates(ctx)) return null
        val found = try {
            fromGitHub(socksPort, auth)
        } catch (e: Exception) {
            // Some networks blackhole GitHub's addresses, which no technique
            // gets past: then the same release from Shroudly's download server.
            try { fromMirror(socksPort, auth) } catch (_: Exception) { throw e }
        }
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putLong("checkedAt", System.currentTimeMillis())
            .putString("tag", found?.first)
            .putString("url", found?.second)
            .apply()
        return found?.let { Offer(Versions.display(it.first), it.second) }
    }

    /* (tag, where to get it) when the latest release is offered to this app, else null. */
    private fun fromGitHub(port: Int, auth: SocksAuth?): Pair<String, String>? {
        val resp = fetch(API_HOST, API_PATH, "application/vnd.github+json", port, auth)
        if (resp.status != 200) throw IOException("HTTP ${resp.status}")
        val json = JSONObject(resp.body.toString(Charsets.UTF_8))
        val tag = json.optString("tag_name")
        val page = json.optString("html_url").takeIf { it.startsWith("https://github.com/") } ?: RELEASES_URL
        val assets = json.optJSONArray("assets")
        val files = (0 until (assets?.length() ?: 0)).map {
            val a = assets!!.getJSONObject(it)
            a.optString("name") to a.optString("browser_download_url")
        }
        if (!Versions.offers(tag, files.map { it.first }, BuildConfig.VERSION_NAME)) return null
        // The APK itself, so the phone does not land on a page of desktop installers.
        return tag to (Versions.apkUrl(files) ?: page)
    }

    /* The download server's update feed names the latest version; its APK is
     * offered only if the server has one (desktop-only releases share the
     * version numbers). */
    private fun fromMirror(port: Int, auth: SocksAuth?): Pair<String, String>? {
        val feed = fetch(MIRROR_HOST, MIRROR_FEED, "*/*", port, auth)
        if (feed.status != 200) throw IOException("$MIRROR_HOST: HTTP ${feed.status}")
        val version = Versions.feedVersion(feed.body.toString(Charsets.UTF_8)) ?: throw IOException("$MIRROR_HOST: no version")
        if (!Versions.isNewer(version, BuildConfig.VERSION_NAME)) return null
        val apk = Versions.mirrorApkPath(version)
        if (fetch(MIRROR_HOST, apk, "*/*", port, auth, head = true).status != 200) return null
        return version to "https://$MIRROR_HOST$apk"
    }

    /* GET (or HEAD) https://host/path: through the engine while protection is
     * on, otherwise direct. */
    private fun fetch(host: String, path: String, accept: String, port: Int, auth: SocksAuth?, head: Boolean = false) =
        if (port > 0) viaEngine(host, path, accept, port, auth, head) else direct(host, path, accept, head)

    private fun direct(host: String, path: String, accept: String, head: Boolean): Http1.Response {
        val c = URL("https://$host$path").openConnection(Proxy.NO_PROXY) as HttpURLConnection
        try {
            c.connectTimeout = TIMEOUT_MS
            c.readTimeout = TIMEOUT_MS
            if (head) c.requestMethod = "HEAD"
            c.setRequestProperty("Accept", accept)
            c.setRequestProperty("User-Agent", userAgent())
            val status = c.responseCode
            val body = if (head || status != 200) ByteArray(0) else c.inputStream.use { it.readBytes() }
            return Http1.Response(status, emptyMap(), body)
        } finally {
            c.disconnect()
        }
    }

    /* Through the engine's SOCKS5 port, by name, so the engine resolves and
     * splits it like any other site. */
    private fun viaEngine(host: String, path: String, accept: String, port: Int, auth: SocksAuth?, head: Boolean): Http1.Response {
        val raw = Socket(Proxy.NO_PROXY)
        try {
            raw.connect(InetSocketAddress(InetAddress.getByName("127.0.0.1"), port), TIMEOUT_MS)
            raw.soTimeout = TIMEOUT_MS
            Socks5.connect(raw, host, 443, auth)
            val ssl = (SSLSocketFactory.getDefault() as SSLSocketFactory).createSocket(raw, host, 443, true) as SSLSocket
            ssl.sslParameters = ssl.sslParameters.apply { serverNames = listOf(SNIHostName(host)) }
            ssl.startHandshake()
            if (!HttpsURLConnection.getDefaultHostnameVerifier().verify(host, ssl.session)) {
                throw IOException("certificate does not belong to $host")
            }
            val request = "${if (head) "HEAD" else "GET"} $path HTTP/1.1\r\nHost: $host\r\nAccept: $accept\r\n" +
                "User-Agent: ${userAgent()}\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n"
            ssl.outputStream.apply { write(request.toByteArray(Charsets.ISO_8859_1)); flush() }
            val resp = Http1.read(ssl.inputStream.buffered(), MAX_BODY, bodyless = head)
            ssl.close()
            return resp
        } finally {
            try { raw.close() } catch (_: IOException) {}
        }
    }

    private fun userAgent() = "Shroudly-Android/${BuildConfig.VERSION_NAME}"
}
