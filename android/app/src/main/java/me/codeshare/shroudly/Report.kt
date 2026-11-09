package me.codeshare.shroudly

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.Socket
import java.net.URL
import java.security.MessageDigest
import java.util.Base64
import java.util.zip.GZIPOutputStream
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SNIHostName
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

/*
 * "Something not working?" (ReportActivity): what the user wrote, a few facts
 * about the device and the log (Diagnostics.report), sent to codeshare.me
 * (POST /api/shroudly/report, on Codeshare's own server), which mails it to
 * the developer and keeps nothing. Only when the user taps Send, after
 * reading what goes. The same as the desktop's (electron/report.js) and the
 * Apple app's: the same body, limits and reference numbers.
 *
 * On the device: the references of the reports sent, with when, for
 * HISTORY_MS (then they go by themselves), so the user can quote one; and so
 * no more than one goes an hour and three a day (the server holds its own
 * limits too). Nothing else is kept.
 *
 * While protection is on the request goes through the engine (by name, as
 * the live count's does); otherwise straight over the network. Every report
 * carries the app's header and a proof of work bound to its body: the server
 * takes nothing else (server/shroudly/report.ts).
 */
object Report {
    const val HOST = "codeshare.me"
    const val PATH = "/api/shroudly/report"
    const val HOUR = 3600_000L
    const val DAY = 24 * HOUR
    const val HISTORY_MS = 60 * DAY
    const val PER_HOUR = 1
    const val PER_DAY = 3
    const val LOG_MAX_CHARS = 2 * 1024 * 1024
    // What went wrong, in characters (code points, as the server counts).
    const val WHAT_MIN = 80
    const val WHAT_WORDS = 8
    const val WHAT_MAX = 1000
    const val POW_BITS = 18
    private const val POW_PREFIX = "shroudly-report-v1"
    val REF = Regex("^SR-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$")
    private const val PREFS = "reports"
    private const val KEY = "sent"

    data class Sent(val ref: String, val at: Long)

    /* "hour" or "day" when one may not go yet, and for how long. */
    data class Wait(val ms: Long, val limit: String?)

    data class Fields(val what: String, val site: String = "", val isp: String = "", val country: String = "", val contact: String = "")

    /* ok with the reference, or the error: rate, bad, off, mail, network. */
    data class Result(val ok: Boolean, val ref: String? = null, val error: String? = null, val limit: String? = null)

    /* Newest first, without those older than HISTORY_MS or not real ones. */
    fun history(list: List<Sent>, now: Long): List<Sent> =
        list.filter { REF.matches(it.ref) && it.at <= now + 60_000 && now - it.at < HISTORY_MS }
            .sortedByDescending { it.at }.take(50)

    fun wait(list: List<Sent>, now: Long): Wait {
        val h = history(list, now)
        val day = h.filter { now - it.at < DAY }
        val hour = h.filter { now - it.at < HOUR }
        if (day.size >= PER_DAY) return Wait(day[PER_DAY - 1].at + DAY - now, "day")
        if (hour.size >= PER_HOUR) return Wait(hour[PER_HOUR - 1].at + HOUR - now, "hour")
        return Wait(0, null)
    }

    fun parseSent(json: String?): List<Sent> = try {
        val a = JSONArray(json ?: "[]")
        (0 until a.length()).mapNotNull { i ->
            val o = a.optJSONObject(i) ?: return@mapNotNull null
            Sent(o.optString("ref"), o.optLong("at", -1))
        }
    } catch (_: Exception) {
        emptyList()
    }

    fun sentJson(list: List<Sent>): String =
        JSONArray().apply { list.forEach { put(JSONObject().put("ref", it.ref).put("at", it.at)) } }.toString()

    fun load(ctx: Context): List<Sent> {
        val now = System.currentTimeMillis()
        val h = history(parseSent(ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null)), now)
        save(ctx, h)
        return h
    }

    private fun save(ctx: Context, list: List<Sent>) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, sentJson(list)).apply()
    }

    fun record(ctx: Context, ref: String) {
        val now = System.currentTimeMillis()
        save(ctx, history(listOf(Sent(ref, now)) + load(ctx), now))
    }

    fun chars(s: String): Int = s.trim().let { it.codePointCount(0, it.length) }

    /* ── what a report must carry ──────────────────────────────────────
     * What happened in real words, the site or app, and an e-mail address
     * that can take an answer: as electron/report-check.js and the report
     * server, which also checks that the address's domain takes mail. Most
     * reports from some countries were a word or a keyboard mash, with a
     * Telegram name or a made-up address. Only e-mail is taken. Pure. */
    private val DISPOSABLE = setOf(
        "mailinator.com", "guerrillamail.com", "guerrillamail.net", "guerrillamailblock.com", "sharklasers.com", "grr.la",
        "yopmail.com", "yopmail.net", "yopmail.fr", "10minutemail.com", "10minutemail.net", "tempmail.com", "temp-mail.org",
        "temp-mail.io", "tempmailo.com", "tempail.com", "tmpmail.org", "tmpmail.net", "trashmail.com", "trashmail.de",
        "getnada.com", "nada.email", "dispostable.com", "maildrop.cc", "throwawaymail.com", "fakeinbox.com", "mintemail.com",
        "emailondeck.com", "mohmal.com", "mailnesia.com", "mytemp.email", "tempinbox.com", "spamgourmet.com", "mailcatch.com",
        "moakt.com", "emailfake.com", "fakemail.net", "burnermail.io", "dropmail.me", "tempr.email", "discard.email",
        "mail.tm", "mail.gw", "1secmail.com", "1secmail.org", "1secmail.net", "inboxkitten.com", "mailpoof.com", "linshiyouxiang.net",
    )
    private val FAKE_DOMAINS = setOf("example.com", "example.org", "example.net", "test.com", "test.org", "domain.com", "email.test",
        "localhost", "abc.com", "xyz.com", "asd.com", "aaa.com", "qwe.com", "asdf.com", "mail.com.com", "gmail.co", "gmial.com", "gamil.com")
    private val FAKE_LOCAL = Regex("^(test|testing|tester|example|admin|user|email|mail|fake|spam|none|no|null|nobody|asd+f*|qwe+r*t*y*|zxc+|abc+d*|x+|a+|1+2*3*4*5*6*)$", RegexOption.IGNORE_CASE)
    private val EMAIL = Regex("^([^\\s@]{1,64})@((?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z]{2,24})$")
    private val NO_VOWEL = Regex("^[b-df-hj-np-tv-xz]{6,}$", RegexOption.IGNORE_CASE)

    fun contactOk(v: String): Boolean {
        val s = v.trim()
        val m = EMAIL.matchEntire(s) ?: return false
        if (s.length > 200) return false
        val local = m.groupValues[1]
        val domain = m.groupValues[2].lowercase()
        if (FAKE_LOCAL.matches(local) || local.all { it == local[0] }) return false
        if (domain in DISPOSABLE || domain in FAKE_DOMAINS) return false
        return !NO_VOWEL.matches(local)
    }

    fun whatOk(v: String): Boolean {
        val t = v.trim()
        val cps = t.codePoints().toArray()
        if (cps.size < WHAT_MIN || cps.size > WHAT_MAX) return false
        val words = t.split(Regex("\\s+")).filter { w -> w.any { Character.isLetter(it) } }
        if (words.size < WHAT_WORDS) return false
        if (words.map { it.lowercase() }.toSet().size < 5) return false
        val letters = cps.filter { Character.isLetter(it) }
        if (letters.size < cps.size * 0.5) return false
        var run = 1
        for (i in 1 until cps.size) { run = if (cps[i] == cps[i - 1]) run + 1 else 1; if (run >= 6) return false }
        val most = letters.groupingBy { Character.toLowerCase(it) }.eachCount().values.maxOrNull() ?: 0
        if (most > letters.size * 0.3) return false
        val latin = words.filter { w -> w.length >= 6 && w.all { it in 'a'..'z' || it in 'A'..'Z' } }
        if (latin.isNotEmpty() && latin.count { w -> w.none { it.lowercaseChar() in "aeiouy" } } > latin.size * 0.4) return false
        return true
    }

    fun siteOk(v: String): Boolean = chars(v) >= 2

    /* The first thing to put right, or null: "what", "site" or "contact". */
    fun problem(what: String, site: String, contact: String): String? = when {
        !whatOk(what) -> "what"
        !siteOk(site) -> "site"
        !contactOk(contact) -> "contact"
        else -> null
    }

    /* ── where "Something not working?" is offered ──────────────────────
     * In Iran most reports were about what no app on the phone can change
     * (addresses blocked outright, Tor not yet allowed, the network down),
     * and they buried the rest. There the link shows only once Shroudly
     * itself has gone wrong (it could not start, protection ended by itself,
     * the engine stuck: fault()), for a day, and goes again as soon as a
     * report is sent. Everywhere else it always shows. Pure, for the tests. */
    const val FAULT_SHOWS_MS = 24 * 60 * 60 * 1000L
    private const val KEY_FAULT = "faultAt"

    fun offered(inIran: Boolean, faultAt: Long, lastSentAt: Long, now: Long): Boolean =
        !inIran || (faultAt > lastSentAt && now - faultAt in 0 until FAULT_SHOWS_MS)

    /* Shroudly's own failure, now: the link shows in Iran for a day. */
    fun fault(ctx: Context) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putLong(KEY_FAULT, System.currentTimeMillis()).apply()
    }

    /* The phone is in Iran: its SIM's or network's country, else its time zone. */
    fun inIran(ctx: Context): Boolean {
        val tm = try { ctx.getSystemService(android.telephony.TelephonyManager::class.java) } catch (_: Exception) { null }
        val sim = try { tm?.simCountryIso.orEmpty() } catch (_: Exception) { "" }
        val net = try { tm?.networkCountryIso.orEmpty() } catch (_: Exception) { "" }
        if (sim.equals("ir", true) || net.equals("ir", true)) return true
        if (sim.isNotEmpty() || net.isNotEmpty()) return false
        return NationalNet.homeCountry(AppSettings.homeCountry(ctx), java.util.TimeZone.getDefault().id) == "IR"
    }

    fun offered(ctx: Context): Boolean {
        val faultAt = maxOf(ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getLong(KEY_FAULT, 0), Protection.faultAt)
        val last = load(ctx).maxOfOrNull { it.at } ?: 0L
        return offered(inIran(ctx), faultAt, last, System.currentTimeMillis())
    }

    private fun cut(s: String, max: Int): String {
        val t = s.trim()
        val n = t.codePointCount(0, t.length)
        return if (n > max) t.substring(0, t.offsetByCodePoints(0, max)) else t
    }

    private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }

    private fun zeroBits(b: ByteArray): Int {
        var n = 0
        for (x in b) {
            val v = x.toInt() and 0xff
            if (v == 0) { n += 8; continue }
            return n + Integer.numberOfLeadingZeros(v) - 24
        }
        return n
    }

    /* The proof of work the server asks of every report (codeshare.me,
     * server/shroudly/report.ts powOk): "<unix seconds>.<nonce>" such that
     * SHA-256 of "shroudly-report-v1\n<seconds>\n<SHA-256 of the body, hex>\n
     * <nonce>" starts with POW_BITS zero bits. About a second on a slow TV;
     * run off the main thread. The same as electron/report.js. */
    fun proofOfWork(body: String, bits: Int = POW_BITS, nowMs: Long = System.currentTimeMillis()): String {
        val at = nowMs / 1000
        val md = MessageDigest.getInstance("SHA-256")
        val bh = hex(md.digest(body.toByteArray(Charsets.UTF_8)))
        val head = "$POW_PREFIX\n$at\n$bh\n".toByteArray(Charsets.UTF_8)
        var n = 0L
        while (true) {
            val nonce = java.lang.Long.toHexString(n)
            md.reset()
            md.update(head)
            if (zeroBits(md.digest(nonce.toByteArray(Charsets.US_ASCII))) >= bits) return "$at.$nonce"
            n++
        }
    }

    /* The request's body; a long log keeps its end, which is what matters. */
    fun body(f: Fields, version: String, platform: String, os: String, device: String, lang: String, log: String): String {
        val l = if (log.length > LOG_MAX_CHARS) "[… the start was cut]\n" + log.substring(log.length - LOG_MAX_CHARS) else log
        val gz = ByteArrayOutputStream().also { out -> GZIPOutputStream(out).use { it.write(l.toByteArray(Charsets.UTF_8)) } }.toByteArray()
        return JSONObject()
            .put("v", 1)
            .put("app", JSONObject().put("platform", platform).put("version", version).put("os", cut(os, 100)).put("device", cut(device, 100)))
            .put("lang", cut(lang, 20))
            .put("what", cut(f.what, 3000))
            .put("site", cut(f.site, 300))
            .put("isp", cut(f.isp, 120))
            .put("country", cut(f.country, 80))
            .put("contact", cut(f.contact, 200))
            .put("log", Base64.getEncoder().encodeToString(gz))
            .toString()
    }

    private val PRIVATE = Regex("server|pass|token|auth|key|secret|link|url|dns|proxy|host|ip|addr|path|dir|file|id$|ids$|reports", RegexOption.IGNORE_CASE)

    /* What the report adds after the log, so the problem can be seen at
     * once: the mobile network and SIM (operator and country, as Android
     * names them), whether the device is a TV, the engine's counters, and the
     * settings: switches, numbers and short choices only. Nothing that can
     * hold an address, a password, a server's link or the user's own lists
     * (those only by how many entries they have). The same as the desktop's
     * (main.js reportSituation). */
    fun situation(ctx: Context): String {
        val o = JSONObject()
        try {
            val tm = ctx.getSystemService(android.telephony.TelephonyManager::class.java)
            if (tm != null) o.put("mobile", JSONObject()
                .put("operator", tm.networkOperatorName ?: "").put("operatorCountry", tm.networkCountryIso ?: "")
                .put("sim", tm.simOperatorName ?: "").put("simCountry", tm.simCountryIso ?: ""))
        } catch (_: Exception) {}
        o.put("tv", try { Tv.isTv(ctx) } catch (_: Exception) { false })
        o.put("locale", java.util.Locale.getDefault().toLanguageTag())
        Protection.stats?.let { st ->
            o.put("stats", JSONObject().put("connsTotal", st.connsTotal).put("connsActive", st.connsActive)
                .put("bytesUp", st.bytesUp).put("bytesDown", st.bytesDown).put("desync", st.desync)
                .put("probeOk", st.probeOk).put("probeFail", st.probeFail).put("blocked", st.blocked).put("fallback", st.fallback))
        }
        val settings = JSONObject()
        for (file in listOf("settings", "ui")) {
            try {
                for ((k, v) in ctx.getSharedPreferences(file, Context.MODE_PRIVATE).all) {
                    when (v) {
                        is Boolean, is Int, is Long, is Float -> settings.put(k, v)
                        is Set<*> -> settings.put(k, "[${v.size}]")
                        is String -> if (v.length <= 24 && !PRIVATE.containsMatchIn(k) && !Regex("[/@:]").containsMatchIn(v)) settings.put(k, v)
                    }
                }
            } catch (_: Exception) {}
        }
        o.put("settings", settings)
        // Every setting as it acts, defaults included (one never changed is
        // not in the files above), and where protection stands now: the same
        // the desktop's report gives (report-settings.js). Whether a server
        // or a DNS of one's own is set, never which; lists by how many.
        o.put("effective", effective(ctx))
        o.put("state", stateNow(ctx))
        return o.toString(1)
    }

    private fun JSONObject.safe(k: String, f: () -> Any?): JSONObject {
        try { put(k, f() ?: JSONObject.NULL) } catch (_: Exception) { put(k, "unknown") }
        return this
    }

    fun effective(ctx: Context): JSONObject = JSONObject()
        .safe("apk") { if (BuildConfig.APK_VARIANT.isEmpty()) "full" else BuildConfig.APK_VARIANT }
        .safe("mode") { if (AppSettings.proxyOnly(ctx)) "proxy only" else "vpn" }
        .safe("technique") { AppSettings.strategy(ctx).id }
        .safe("appsOnly") { AppSettings.appsOnly(ctx) }
        .safe("appsLeftOut") { AppSettings.excluded(ctx).size }
        .safe("appsOnlyThese") { AppSettings.included(ctx).size }
        .safe("ipv6Off") { AppSettings.ipv6Off(ctx) }
        .safe("quicOff") { AppSettings.quicOff(ctx) }
        .safe("ownServer") { if (AppSettings.ownServerTyped(ctx).isNotBlank()) "set" else "not set" }
        .safe("ownDns") { if (AppSettings.customDnsTyped(ctx) != null) "set" else "not set" }
        .safe("ownDnsOnly") { AppSettings.customDnsStrict(ctx) }
        .safe("ownDnsProxy") { if (AppSettings.customDnsProxyTyped(ctx).isNotBlank()) "set" else "not set" }
        .safe("adBlock") { AdBlock.enabled(ctx) }
        .safe("torInThisApk") { TorRoute.bundled(ctx) }
        .safe("torLastResort") { TorRoute.enabled(ctx) }
        .safe("torAllowed") { TorRoute.approved(ctx) }
        .safe("torSites") { Conns.torSites(ctx).size }
        .safe("onlyListedSites") { if (Conns.onlyMode(ctx)) Conns.onlySites(ctx).size else "off" }
        .safe("helpOthers") { Snowflake.enabled(ctx) }
        .safe("countMeIn") { OnlineCount.enabled(ctx) }
        .safe("startAtBoot") { AppSettings.startAtBoot(ctx) }
        .safe("keepOn") { KeepOn.wanted(ctx) }
        .safe("automationApps") { AppSettings.remoteControl(ctx) }
        .safe("homeCountry") { AppSettings.homeCountry(ctx) }

    private fun res(ctx: Context, id: Int): String? =
        if (id == 0) null else try { ctx.resources.getResourceEntryName(id) } catch (_: Exception) { id.toString() }

    fun stateNow(ctx: Context): JSONObject = JSONObject()
        .safe("protection") { Protection.state.name.lowercase() }
        .safe("proxyOnlyRunning") { Protection.proxyOnly }
        .safe("error") { res(ctx, Protection.errorRes) }
        .safe("trouble") { res(ctx, Protection.troubleRes) }
        .safe("nationalOnly") { Protection.national }
        .safe("ownServerDown") { Protection.ownServerDown?.first }
        .safe("ownServerExitCountry") { Protection.ownServerExitCc }
        .safe("dnsGoesAround") { Protection.dnsAround }
        .safe("torAsking") { Protection.torAsk != null }
        .safe("torNow") { TorRoute.state }
        .safe("liteOffer") { Protection.liteOffer != null }
        .safe("alwaysOn") { Protection.alwaysOn }
        .safe("lockdown") { Protection.lockdown }
        .safe("ipv6") { Protection.ipv6 }
        .safe("windowOpen") { Protection.windowVisible }

    /* The apps whose names a report keeps however they went: the engine's
     * own families (core/src/engine.c SITE_FAMILY), the same list on every
     * platform (electron/report.js, Report.swift). */
    val APP_DOMAINS = listOf(
        "discord.com", "discord.gg", "discordapp.com", "discordapp.net", "discord.media", "discordcdn.com", "discord.co", "youtube.com",
        "youtu.be", "ytimg.com", "googlevideo.com", "ggpht.com", "youtube-nocookie.com", "x.com", "twitter.com", "twimg.com",
        "t.co", "instagram.com", "cdninstagram.com", "facebook.com", "fbcdn.net", "fb.com", "fbsbx.com", "messenger.com",
        "whatsapp.com", "whatsapp.net", "telegram.org", "t.me", "telegram.me", "telesco.pe", "tdesktop.com", "telegra.ph",
        "roblox.com", "rbxcdn.com", "rbx.com", "rbxinfra.net", "riotgames.com", "leagueoflegends.com", "pvp.net", "riotcdn.net",
        "playvalorant.com", "lolstatic.com", "rgpub.io", "twitch.tv", "ttvnw.net", "jtvnw.net", "spotify.com", "scdn.co",
        "spotifycdn.com", "reddit.com", "redd.it", "redditmedia.com", "redditstatic.com", "tiktok.com", "tiktokcdn.com", "tiktokv.com",
        "signal.org", "whispersystems.org",
    )
    /* An address rather than a name: an app that connects by address (a VPN
     * client chained through Proxy only, a game, a messenger's fallback),
     * whose connection the browsing filter must not hide. */
    fun isAddress(host: String): Boolean =
        Regex("^\\d{1,3}(\\.\\d{1,3}){3}$").matches(host) || (host.contains(':') && Regex("^[0-9a-fA-F:.]+$").matches(host))

    fun isApp(host: String): Boolean {
        val h = host.lowercase().trimEnd('.')
        return APP_DOMAINS.any { h == it || h.endsWith(".$it") }
    }

    private val ROUTE_ORDER = mapOf("tor" to 0, "server" to 1, "technique" to 2, "direct" to 3)

    /* The section: this session's list, or, protection off, the one of the
     * session that ended last (kept in memory until the next start). */
    fun connsSection(on: Boolean, now: List<Conns.Row>, last: List<Conns.Row>?, lastEnded: Long): String = when {
        on -> "== Connections this session ==\n" + connsText(now)
        last != null -> "== Connections last session (ended " +
            java.text.SimpleDateFormat("MM-dd HH:mm:ss", java.util.Locale.ROOT).format(java.util.Date(lastEnded)) + ") ==\n" + connsText(last)
        else -> "== Connections ==\n(protection is off, and has not run since the app started)"
    }

    /* The Connections list as lines of the report, as the desktop's
     * (electron/report.js connsText): the names Shroudly did something to,
     * the apps' names and the addresses apps connect to however they went,
     * and anything refused; other untouched names (the user's browsing)
     * left out. Tor first, then techniques, then the
     * busiest; at most `max`. */
    fun connsText(rows: List<Conns.Row>, max: Int = 60): String {
        val list = rows.filter { it.host.isNotEmpty() && (it.route != "direct" || isApp(it.host) || isAddress(it.host) || it.refused > 0) }
            .sortedWith(compareBy<Conns.Row>({ ROUTE_ORDER[it.route] ?: 3 }, { -it.conns }, { it.host }))
        if (list.isEmpty()) return "(none)"
        val lines = list.take(max).map { r ->
            val extra = listOfNotNull(if (r.blocked) "blocked by the user" else null, if (r.refused > 0) "${r.refused} refused" else null).joinToString(", ")
            "${r.host.take(120)}  ${r.route}  ${r.conns} conns${connDetail(r)}${if (extra.isNotEmpty()) "  ($extra)" else ""}"
        }.toMutableList()
        if (list.size > max) lines += "(+${list.size - max} more)"
        return lines.joinToString("\n")
    }

    /* What a row says beyond its count (electron/report.js connDetail): how
     * many are open now, what went each way, and how long ago the name was
     * last used. A connection that got nothing back ("down 0 B") is what a
     * report most often needs to see. */
    fun bytes(n: Long): String = when {
        n >= 1048576 -> String.format(java.util.Locale.ROOT, "%.1f MB", n / 1048576.0)
        n >= 1024 -> "${Math.round(n / 1024.0)} KB"
        else -> "$n B"
    }

    fun connDetail(r: Conns.Row): String {
        val parts = mutableListOf<String>()
        if (r.active > 0) parts += "${r.active} open"
        parts += "up ${bytes(r.up)}, down ${bytes(r.down)}"
        if (r.ago >= 0) parts += "last ${Math.round(r.ago / 1000.0)} s ago"
        return "  " + parts.joinToString(", ")
    }

    /* What the server's answer means. */
    fun answer(status: Int, text: String?): Result {
        val j = try { JSONObject(text ?: "") } catch (_: Exception) { null }
        val ref = j?.optString("ref")
        if (status == 200 && j?.optBoolean("ok") == true && ref != null && REF.matches(ref)) return Result(true, ref)
        val e = j?.optString("error")?.takeIf { it in setOf("rate", "bad", "off", "mail", "contact", "what", "site") } ?: "network"
        return Result(false, error = e, limit = if (e == "rate") "hour" else null)
    }

    /* POST it, with the app's header and the proof of work: through the
     * engine while protection is on, else directly. `app` is
     * "<platform>/<version>", as in the body. */
    fun send(body: String, app: String, port: Int, auth: SocksAuth?, timeoutMs: Int = 45_000): Result = try {
        val pow = proofOfWork(body)
        if (port > 0) viaEngine(body, app, pow, port, auth, timeoutMs) else direct(body, app, pow, timeoutMs)
    } catch (_: Exception) {
        Result(false, error = "network")
    }

    private fun direct(body: String, app: String, pow: String, timeoutMs: Int): Result {
        val c = URL("https://$HOST$PATH").openConnection(Proxy.NO_PROXY) as HttpURLConnection
        try {
            c.requestMethod = "POST"
            c.connectTimeout = timeoutMs
            c.readTimeout = timeoutMs
            c.doOutput = true
            c.setRequestProperty("content-type", "application/json")
            c.setRequestProperty("x-shroudly-app", app)
            c.setRequestProperty("x-shroudly-pow", pow)
            c.setRequestProperty("user-agent", "Shroudly/${BuildConfig.VERSION_NAME} (Android)")
            c.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val status = c.responseCode
            val stream = if (status in 200..299) c.inputStream else c.errorStream
            val text = stream?.use { s -> s.readBytes().take(4096).toByteArray().toString(Charsets.UTF_8) }
            return answer(status, text)
        } finally {
            c.disconnect()
        }
    }

    private fun viaEngine(body: String, app: String, pow: String, port: Int, auth: SocksAuth?, timeoutMs: Int): Result {
        val raw = Socket(Proxy.NO_PROXY)
        try {
            raw.connect(InetSocketAddress(InetAddress.getByName("127.0.0.1"), port), timeoutMs)
            raw.soTimeout = timeoutMs
            Socks5.connect(raw, HOST, 443, auth)
            val ssl = (SSLSocketFactory.getDefault() as SSLSocketFactory).createSocket(raw, HOST, 443, true) as SSLSocket
            ssl.sslParameters = ssl.sslParameters.apply { serverNames = listOf(SNIHostName(HOST)) }
            ssl.startHandshake()
            if (!HttpsURLConnection.getDefaultHostnameVerifier().verify(HOST, ssl.session)) throw IOException("certificate does not belong to $HOST")
            val b = body.toByteArray(Charsets.UTF_8)
            val head = "POST $PATH HTTP/1.1\r\nHost: $HOST\r\nConnection: close\r\nContent-Length: ${b.size}\r\n" +
                "content-type: application/json\r\nx-shroudly-app: $app\r\nx-shroudly-pow: $pow\r\nUser-Agent: Shroudly/${BuildConfig.VERSION_NAME} (Android)\r\nAccept-Encoding: identity\r\n\r\n"
            ssl.outputStream.apply { write(head.toByteArray(Charsets.ISO_8859_1) + b); flush() }
            val resp = Http1.read(ssl.inputStream.buffered(), 4096)
            ssl.close()
            return answer(resp.status, resp.body.toString(Charsets.UTF_8))
        } finally {
            try { raw.close() } catch (_: IOException) {}
        }
    }
}
