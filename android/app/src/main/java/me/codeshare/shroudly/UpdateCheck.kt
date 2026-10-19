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
 * updates; otherwise it goes direct. Nothing is downloaded or installed here:
 * the window's button opens the release's APK in the browser, which downloads
 * it, and Android asks before installing it.
 */
object UpdateCheck {
    const val REPO_URL = "https://github.com/umutxyp/Shroudly"
    const val RELEASES_URL = "$REPO_URL/releases"
    private const val API_HOST = "api.github.com"
    private const val API_PATH = "/repos/umutxyp/Shroudly/releases/latest"
    private const val EVERY_MS = 6L * 60 * 60 * 1000
    private const val TIMEOUT_MS = 15000
    // A release's JSON, with its notes and every platform's files.
    private const val MAX_BODY = 1 shl 20
    private const val PREFS = "update"

    class Offer(val version: String, val url: String)

    /* The offer remembered from the last check, if it is still newer than this app. */
    fun remembered(ctx: Context): Offer? {
        val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val tag = p.getString("tag", null) ?: return null
        val url = p.getString("url", null) ?: return null
        return if (Versions.isNewer(tag, BuildConfig.VERSION_NAME)) Offer(Versions.display(tag), url) else null
    }

    fun due(ctx: Context): Boolean {
        val at = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getLong("checkedAt", 0)
        val now = System.currentTimeMillis()
        return now - at > EVERY_MS || at > now
    }

    /* Blocking: call off the main thread. Returns the offer, or null if up to date. Throws on failure. */
    fun check(ctx: Context, socksPort: Int, auth: SocksAuth?): Offer? {
        val body = if (socksPort > 0) viaEngine(socksPort, auth) else direct()
        val json = JSONObject(body)
        val tag = json.optString("tag_name")
        val page = json.optString("html_url").takeIf { it.startsWith("https://github.com/") } ?: RELEASES_URL
        val assets = json.optJSONArray("assets")
        val files = (0 until (assets?.length() ?: 0)).map {
            val a = assets!!.getJSONObject(it)
            a.optString("name") to a.optString("browser_download_url")
        }
        val offered = Versions.offers(tag, files.map { it.first }, BuildConfig.VERSION_NAME)
        // The APK itself, so the phone does not land on a page of desktop installers.
        val url = Versions.apkUrl(files) ?: page
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putLong("checkedAt", System.currentTimeMillis())
            .putString("tag", if (offered) tag else null)
            .putString("url", if (offered) url else null)
            .apply()
        return if (offered) Offer(Versions.display(tag), url) else null
    }

    private fun direct(): String {
        val c = URL("https://$API_HOST$API_PATH").openConnection(Proxy.NO_PROXY) as HttpURLConnection
        try {
            c.connectTimeout = TIMEOUT_MS
            c.readTimeout = TIMEOUT_MS
            c.setRequestProperty("Accept", "application/vnd.github+json")
            c.setRequestProperty("User-Agent", userAgent())
            if (c.responseCode != 200) throw IOException("HTTP ${c.responseCode}")
            return c.inputStream.use { it.readBytes().toString(Charsets.UTF_8) }
        } finally {
            c.disconnect()
        }
    }

    /* Through the engine's SOCKS5 port, by name, so the engine resolves and
     * splits it like any other site. */
    private fun viaEngine(port: Int, auth: SocksAuth?): String {
        val raw = Socket(Proxy.NO_PROXY)
        try {
            raw.connect(InetSocketAddress(InetAddress.getByName("127.0.0.1"), port), TIMEOUT_MS)
            raw.soTimeout = TIMEOUT_MS
            Socks5.connect(raw, API_HOST, 443, auth)
            val ssl = (SSLSocketFactory.getDefault() as SSLSocketFactory).createSocket(raw, API_HOST, 443, true) as SSLSocket
            ssl.sslParameters = ssl.sslParameters.apply { serverNames = listOf(SNIHostName(API_HOST)) }
            ssl.startHandshake()
            if (!HttpsURLConnection.getDefaultHostnameVerifier().verify(API_HOST, ssl.session)) {
                throw IOException("certificate does not belong to $API_HOST")
            }
            val head = "GET $API_PATH HTTP/1.1\r\nHost: $API_HOST\r\nAccept: application/vnd.github+json\r\n" +
                "User-Agent: ${userAgent()}\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n"
            ssl.outputStream.apply { write(head.toByteArray(Charsets.ISO_8859_1)); flush() }
            val resp = Http1.read(ssl.inputStream.buffered(), MAX_BODY)
            if (resp.status != 200) throw IOException("HTTP ${resp.status}")
            ssl.close()
            return resp.body.toString(Charsets.UTF_8)
        } finally {
            try { raw.close() } catch (_: IOException) {}
        }
    }

    private fun userAgent() = "Shroudly-Android/${BuildConfig.VERSION_NAME}"
}
