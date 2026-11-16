package me.codeshare.shroudly

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.X509EncodedKeySpec

/*
 * Remote settings: what Shroudly can be told without a new version, the same
 * file and rules as the desktop (electron/remote-config.js, where the format
 * and every key are described) and the Apple apps (RemoteConfig.swift).
 * Data, never code: remote.json and its ECDSA P-256 / SHA-256 signature,
 * checked against the public key below; a file that does not check, is
 * older than the one in use, has expired or is not understood is never
 * used, and the last good one is kept. Asked for every six hours, through
 * the engine while protection is on (UpdateCheck.fetch).
 */
object RemoteConfig {
    const val PUBLIC_KEY = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAERbLcXjFix6KWe3RTG+f7yhiqxBJ5mmNwu9jl2ZK5c7yDpxnC+wcU/YuC1vR3HnQCXfeylIYc7opckWkmTd/4HQ=="
    // Each source in turn: host and path of remote.json (the .sig beside it).
    val SOURCES = listOf(
        "raw.githubusercontent.com" to "/umutxyp/Shroudly/main/remote.json",
        "cdn.jsdelivr.net" to "/gh/umutxyp/Shroudly@main/remote.json",
    )
    private const val PREFS = "remote"
    private const val EVERY_MS = 6 * 60 * 60 * 1000L
    private const val MAX_BYTES = 256 * 1024

    /* The engine arguments a remote file may add: technique tuning only
     * (the desktop's ENGINE_ALLOWED): null takes no value. */
    val ENGINE_ALLOWED: Map<String, Regex?> = mapOf(
        "--strategy" to Regex("^[a-z0-9_(),=.:+\\-]{1,200}$", RegexOption.IGNORE_CASE),
        "--decoy-name" to Regex("^(?=.{1,253}$)([a-z0-9-]{1,63}\\.)+[a-z]{2,63}$", RegexOption.IGNORE_CASE),
        "--fake-repeats" to Regex("^([1-9]|1[0-6])$"),
        "--tlsrec" to Regex("^[01]$"),
        "--ipv4-only" to null,
        "--drop-quic" to null,
        "--no-quic-block" to null,
        "--no-udp-fake" to null,
    )

    fun verify(text: String, sigB64: String, publicKey: String = PUBLIC_KEY): Boolean = try {
        val key = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(java.util.Base64.getDecoder().decode(publicKey)))
        Signature.getInstance("SHA256withECDSA").run {
            initVerify(key)
            update(text.toByteArray(Charsets.UTF_8))
            verify(java.util.Base64.getDecoder().decode(sigB64.trim()))
        }
    } catch (_: Exception) { false }

    /* The file, understood, or null. */
    fun parse(text: String, now: Long = System.currentTimeMillis()): JSONObject? = try {
        val c = JSONObject(text)
        val serial = c.optInt("serial", 0)
        when {
            c.optInt("v", 0) != 1 || serial < 1 || !c.has("serial") -> null
            c.has("expires") && (parseTime(c.optString("expires")) ?: 0L) <= now -> null
            c.has("set") && c.optJSONObject("set") == null -> null
            c.has("rules") && c.optJSONArray("rules") == null -> null
            else -> c
        }
    } catch (_: Exception) { null }

    private fun parseTime(s: String): Long? = try {
        java.time.Instant.parse(s).toEpochMilli()
    } catch (_: Exception) { null }

    /* "2.6.81" against "2.6.9", by numbers, part by part. */
    fun cmpVersion(a: String, b: String): Int {
        val x = a.split('.').map { it.toIntOrNull() ?: 0 }
        val y = b.split('.').map { it.toIntOrNull() ?: 0 }
        for (i in 0 until maxOf(x.size, y.size)) {
            val d = (x.getOrElse(i) { 0 }).compareTo(y.getOrElse(i) { 0 })
            if (d != 0) return d
        }
        return 0
    }

    data class Ctx(val platform: String, val country: String?, val app: String)

    private fun inList(a: JSONArray?, v: String?): Boolean {
        if (a == null) return false
        for (i in 0 until a.length()) if (a.optString(i).equals(v ?: "", ignoreCase = true)) return true
        return false
    }

    fun matches(w: JSONObject?, ctx: Ctx): Boolean {
        if (w == null) return true
        if (w.has("platform") && !inList(w.optJSONArray("platform"), ctx.platform)) return false
        if (w.has("country") && !inList(w.optJSONArray("country"), ctx.country)) return false
        if (w.has("appMin") && cmpVersion(ctx.app, w.optString("appMin")) < 0) return false
        if (w.has("appMax") && cmpVersion(ctx.app, w.optString("appMax")) > 0) return false
        return true
    }

    /* "set", then every rule that matches, in order. */
    fun effective(c: JSONObject?, ctx: Ctx): JSONObject {
        val out = JSONObject()
        if (c == null) return out
        fun put(o: JSONObject?) { if (o != null) for (k in o.keys()) out.put(k, o.get(k)) }
        put(c.optJSONObject("set"))
        val rules = c.optJSONArray("rules") ?: JSONArray()
        for (i in 0 until rules.length()) {
            val r = rules.optJSONObject(i) ?: continue
            if (r.has("when") && r.optJSONObject("when") == null) continue
            if (matches(r.optJSONObject("when"), ctx)) put(r.optJSONObject("set"))
        }
        return out
    }

    /* engineArgs, only what ENGINE_ALLOWED takes. */
    fun engineArgs(list: JSONArray?): List<String> {
        val out = mutableListOf<String>()
        if (list == null) return out
        var i = 0
        while (i < list.length()) {
            val a = list.optString(i)
            if (ENGINE_ALLOWED.containsKey(a)) {
                val shape = ENGINE_ALLOWED[a]
                if (shape == null) out += a
                else {
                    val v = if (i + 1 < list.length()) list.opt(i + 1) else null
                    if (v is String && shape.matches(v)) { out += listOf(a, v); i++ }
                }
            }
            i++
        }
        return out
    }

    fun torBridges(eff: JSONObject): Map<String, List<String>> {
        val o = eff.optJSONObject("torBridges") ?: return emptyMap()
        val out = linkedMapOf<String, List<String>>()
        for (k in o.keys()) {
            if (!Regex("^[a-z0-9_]{1,20}$", RegexOption.IGNORE_CASE).matches(k)) continue
            val a = o.optJSONArray(k) ?: continue
            val lines = (0 until a.length()).mapNotNull { a.opt(it) as? String }
                .filter { it.length < 2000 && !it.contains('\n') && !it.contains('\r') && it.substringBefore(' ') == k }.take(40)
            if (lines.isNotEmpty()) out[k] = lines
        }
        return out
    }

    fun decoyNames(eff: JSONObject, cc: String?): List<String>? {
        val o = eff.optJSONObject("decoyNames") ?: return null
        val a = o.optJSONArray((cc ?: "").uppercase()) ?: return null
        val shape = ENGINE_ALLOWED["--decoy-name"]!!
        return (0 until a.length()).mapNotNull { a.opt(it) as? String }.filter { shape.matches(it) }.take(8)
    }

    /* What of the settings the engine and Tor start with: a new file
     * restarts them only when this changes (issue #90: a first, empty file
     * restarted the engine and cut every open connection). */
    fun engineKey(eff: JSONObject): String = listOf(
        engineArgs(eff.optJSONArray("engineArgs")).joinToString("\u0000"),
        eff.optJSONObject("decoyNames")?.toString() ?: "",
        eff.optBoolean("torAllowed", true).toString(),
        torBridges(eff).toString(),
        if (eff.has("quicOff")) eff.optBoolean("quicOff").toString() else "",
    ).joinToString("|")

    fun reportOffer(eff: JSONObject): String = eff.optString("reportOffer").takeIf { it in setOf("fault", "always", "never") } ?: "fault"

    // ── this phone's settings ─────────────────────────────────────────────

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    @Volatile private var cached: Pair<String, JSONObject?>? = null

    private fun current(ctx: Context): JSONObject? {
        val p = prefs(ctx)
        val text = p.getString("text", null) ?: return null
        cached?.let { if (it.first == text) return it.second }
        val c = if (verify(text, p.getString("sig", "") ?: "")) parse(text) else null
        cached = text to c
        return c
    }

    fun serial(ctx: Context): Int = current(ctx)?.optInt("serial", 0) ?: 0

    fun ctxOf(ctx: Context): Ctx {
        val cc = try { Country.of(ctx) } catch (_: Exception) { null }
            ?: NationalNet.homeCountry(AppSettings.homeCountry(ctx), java.util.TimeZone.getDefault().id)
        return Ctx("android", cc, BuildConfig.VERSION_NAME)
    }

    /* The settings for this phone now: {} when there are none. */
    fun settings(ctx: Context): JSONObject = effective(current(ctx), ctxOf(ctx))

    fun engineArgs(ctx: Context): List<String> = engineArgs(settings(ctx).optJSONArray("engineArgs"))

    /* A file and its signature as fetched: kept when it checks and is newer. */
    fun offer(ctx: Context, text: String, sig: String): Boolean {
        if (text.toByteArray().size > MAX_BYTES) return false
        if (!verify(text, sig)) { ShroudlyVpnService.log("Remote settings: a file whose signature does not check was refused"); return false }
        val c = parse(text) ?: return false
        if (c.optInt("serial") <= serial(ctx)) return false
        prefs(ctx).edit().putString("text", text).putString("sig", sig.trim()).apply()
        ShroudlyVpnService.log("Remote settings: number ${c.optInt("serial")} in use")
        return true
    }

    @Volatile private var asking = false

    /* On a thread of its own when due; port and auth: the engine's while
     * protection is on (0: directly). A new file: the engine starts again
     * with it (the same as a network setting changed). */
    fun refreshIfDue(ctx: Context, port: Int, auth: SocksAuth?) {
        val app = ctx.applicationContext
        val p = prefs(app)
        if (asking || System.currentTimeMillis() - p.getLong("checkedAt", 0) < EVERY_MS) return
        asking = true
        Thread({
            try {
                for ((host, path) in SOURCES) {
                    try {
                        val f = UpdateCheck.fetch(host, path, "application/json", port, auth)
                        val s = UpdateCheck.fetch(host, "$path.sig", "text/plain", port, auth)
                        if (f.status != 200 || s.status != 200) continue
                        p.edit().putLong("checkedAt", System.currentTimeMillis()).apply()
                        val before = engineKey(settings(app))
                        if (offer(app, f.body.toString(Charsets.UTF_8), s.body.toString(Charsets.UTF_8)) &&
                            engineKey(settings(app)) != before && Protection.state == Protection.State.ON) {
                            Protector.tell(app, ShroudlyVpnService.ACTION_SETTINGS, "network")
                        }
                        break
                    } catch (_: Exception) {}
                }
            } finally { asking = false }
        }, "remote-config").apply { isDaemon = true }.start()
    }
}
