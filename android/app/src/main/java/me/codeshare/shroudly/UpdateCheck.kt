package me.codeshare.shroudly

import android.content.Context
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.URL

/*
 * Is there a newer release with an Android build? Asks GitHub's API for the
 * latest release. While protection is on the request goes through the engine,
 * like the desktop updater's, so a network that blocks GitHub does not hide
 * updates; otherwise it goes direct. Nothing is downloaded or installed here:
 * the window offers the release page.
 */
object UpdateCheck {
    const val REPO_URL = "https://github.com/umutxyp/Shroudly"
    const val RELEASES_URL = "$REPO_URL/releases"
    private const val API = "https://api.github.com/repos/umutxyp/Shroudly/releases/latest"
    private const val EVERY_MS = 6L * 60 * 60 * 1000
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
    fun check(ctx: Context, socksPort: Int): Offer? {
        val proxy = if (socksPort > 0) Proxy(Proxy.Type.SOCKS, InetSocketAddress("127.0.0.1", socksPort)) else Proxy.NO_PROXY
        val c = URL(API).openConnection(proxy) as HttpURLConnection
        val body = try {
            c.connectTimeout = 15000
            c.readTimeout = 15000
            c.setRequestProperty("Accept", "application/vnd.github+json")
            c.setRequestProperty("User-Agent", "Shroudly-Android/${BuildConfig.VERSION_NAME}")
            if (c.responseCode != 200) throw java.io.IOException("HTTP ${c.responseCode}")
            c.inputStream.use { it.readBytes().toString(Charsets.UTF_8) }
        } finally {
            c.disconnect()
        }
        val json = JSONObject(body)
        val tag = json.optString("tag_name")
        val url = json.optString("html_url").takeIf { it.startsWith("https://github.com/") } ?: RELEASES_URL
        val assets = json.optJSONArray("assets")
        val names = (0 until (assets?.length() ?: 0)).map { assets!!.getJSONObject(it).optString("name") }
        val offered = Versions.offers(tag, names, BuildConfig.VERSION_NAME)
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putLong("checkedAt", System.currentTimeMillis())
            .putString("tag", if (offered) tag else null)
            .putString("url", if (offered) url else null)
            .apply()
        return if (offered) Offer(Versions.display(tag), url) else null
    }
}
