package me.codeshare.shroudly

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream

/*
 * "Help people in censored countries" inside Shroudly (Settings; off until
 * the user turns it on): a Snowflake proxy for the Tor network, the
 * desktop's own page (assets/snowflake/proxy.js, the same file as
 * electron/snowflake/proxy.js; a test keeps them so) in a hidden WebView
 * with nothing of the app's but one interface for its settings and counts.
 *
 * On a phone it runs only while protection is on (inside the VPN service,
 * which is in the foreground anyway: no service of its own) and only while
 * the phone is charging on Wi-Fi or Ethernet, so it costs no battery and no
 * mobile data; looked at again every minute. This app is left out of its
 * own VPN, so the page connects directly: it helps others and needs no
 * techniques. The page may load only its own files and Tor's broker and
 * probe; nothing is recorded of anyone, only how many are helped.
 */
class Snowflake(private val ctx: Context, private val log: (String) -> Unit) {
    companion object {
        private const val PREFS = "settings"
        private const val KEY = "snowflakeOn"
        private const val NAT = "snowflakeNat"
        private const val NAT_AT = "snowflakeNatAt"
        private const val CHECK_MS = 60_000L
        private const val BASE = "https://snowflake.shroudly.invalid/"

        // Never in the lite APK (issue #75), whatever an earlier copy kept.
        fun enabled(ctx: Context) = BuildConfig.APK_VARIANT != "lite" &&
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY, false)
        fun setEnabled(ctx: Context, on: Boolean) =
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY, on).apply()

        /* How many are helped now and since it started, for the window. */
        @Volatile var now = 0
            private set
        @Volatile var total = 0
            private set
        @Volatile var state = "off"
            private set
    }

    private val main = Handler(Looper.getMainLooper())
    private var web: WebView? = null
    private var running = false
    private val tick = object : Runnable {
        override fun run() {
            check()
            if (running) main.postDelayed(this, CHECK_MS)
        }
    }

    /* While protection is on: looked at now and every minute. */
    fun start() = main.post {
        if (running) return@post
        running = true
        tick.run()
    }

    fun stop() = main.post {
        running = false
        main.removeCallbacks(tick)
        close()
    }

    /* The setting changed. */
    fun changed() = main.post { if (running) check() }

    private fun charging(): Boolean {
        val b = ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED)) ?: return false
        return b.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) != 0
    }

    /* Wi-Fi or Ethernet underneath (not the VPN itself), not metered. */
    private fun unmetered(): Boolean {
        val cm = ctx.getSystemService(ConnectivityManager::class.java) ?: return false
        @Suppress("DEPRECATION")
        return cm.allNetworks.any { n ->
            val c = cm.getNetworkCapabilities(n) ?: return@any false
            !c.hasTransport(NetworkCapabilities.TRANSPORT_VPN) &&
                c.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
                c.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) &&
                (c.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || c.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET))
        }
    }

    private fun check() {
        val want = enabled(ctx) && charging() && unmetered()
        if (want && web == null) open() else if (!want && web != null) close()
    }

    private fun config(): String {
        val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val nat = p.getString(NAT, null)
        // The desktop's pageConfig (electron/snowflake.js).
        return JSONObject()
            .put("broker", "https://snowflake-broker.torproject.net/")
            .put("probe", "https://snowflake-broker.torproject.net:8443/probe")
            .put("defaultRelay", "wss://snowflake.torproject.net/")
            .put("relayPattern", "snowflake.torproject.net")
            .put("iceServers", JSONArray().put(JSONObject().put("urls", JSONArray().put("stun:stun.l.google.com:19302"))))
            .put("natIceServers", JSONArray().put(JSONObject().put("urls", "stun:stun1.l.google.com:19302")))
            .put("insecureRelay", false)
            .put("pollMs", 60_000)
            .put("minPollMs", 1000)
            .put("nat", if (nat == "unrestricted" || nat == "restricted") nat else JSONObject.NULL)
            .put("natAt", p.getLong(NAT_AT, 0))
            .toString()
    }

    private inner class Host {
        @JavascriptInterface fun config(): String = this@Snowflake.config()

        @JavascriptInterface fun report(json: String) {
            val s = try { JSONObject(json) } catch (_: Exception) { return }
            val st = s.optString("state")
            val was = state
            state = if (st in setOf("starting", "waiting", "serving", "unreachable")) st else "starting"
            // As the desktop's log says it (electron/snowflake.js).
            if (was == "starting" && state == "waiting") log("Helping people in censored countries: ready, waiting for someone to help")
            if (was != "unreachable" && state == "unreachable") log("Helping people in censored countries: Tor's Snowflake broker does not answer from this network")
            now = s.optInt("now", 0).coerceAtLeast(0)
            val t = s.optInt("total", 0)
            if (t > total) { total = t; log("Helping people in censored countries: someone reached Tor through this phone ($total since it was turned on)") }
            val nat = s.optString("nat")
            val at = s.optLong("natAt", 0)
            if ((nat == "unrestricted" || nat == "restricted") && at > 0) {
                ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(NAT, nat).putLong(NAT_AT, at).apply()
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    private fun open() {
        val w = try { WebView(ctx) } catch (e: Exception) {
            log("Helping people in censored countries could not start: ${e.message}")
            return
        }
        w.settings.javaScriptEnabled = true
        w.settings.allowFileAccess = false
        w.settings.allowContentAccess = false
        w.settings.blockNetworkImage = true
        w.addJavascriptInterface(Host(), "shroudlySnowflake")
        w.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, req: WebResourceRequest): WebResourceResponse? {
                val url = req.url.toString()
                // The page's own files, from the app.
                if (url.startsWith(BASE)) {
                    val name = url.removePrefix(BASE).substringBefore('?')
                    if (name !in setOf("proxy.html", "bridge.js", "proxy.js")) return blocked()
                    val type = if (name.endsWith(".html")) "text/html" else "application/javascript"
                    return try { WebResourceResponse(type, "utf-8", ctx.assets.open("snowflake/$name")) } catch (_: Exception) { blocked() }
                }
                // Tor's broker and probe go on; nothing else.
                return if (url.startsWith("https://snowflake-broker.torproject.net/") ||
                    url.startsWith("https://snowflake-broker.torproject.net:8443/")) null else blocked()
            }

            override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest) = true
        }
        web = w
        now = 0; total = 0; state = "starting"
        w.loadUrl("${BASE}proxy.html")
        log("Helping people in censored countries: on (a Snowflake proxy for Tor; charging on Wi-Fi)")
    }

    private fun blocked() = WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(ByteArray(0)))

    private fun close() {
        val w = web ?: return
        web = null
        try { w.evaluateJavascript("window.__shroudlyStop && window.__shroudlyStop()", null) } catch (_: Exception) {}
        main.postDelayed({ try { w.destroy() } catch (_: Exception) {} }, 500)
        state = "off"; now = 0
        log("Helping people in censored countries: off")
    }
}
