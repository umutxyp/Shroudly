package me.codeshare.shroudly

import android.content.Context

/*
 * The settings of the Settings window (SettingsActivity), kept with the
 * other switches ("settings" preferences):
 *  - the technique, as on the desktop (components/SettingsPanel.js
 *    STRATEGIES): automatic, which looks for what works per site and keeps
 *    it, or one technique for every site;
 *  - apps that skip Shroudly: their traffic goes straight out, past the VPN
 *    (VpnService.Builder.addDisallowedApplication), e.g. a game that does not
 *    need it;
 *  - start when the phone starts, once the user has allowed the VPN;
 *  - VPN (every app) or proxy only (the VPN slot left to another app);
 *  - whether automation apps may turn protection on and off;
 *  - the DNS server: automatic (the built-in encrypted routes) or the
 *    user's own (CustomDns), kept as typed.
 */
object AppSettings {
    private const val PREFS = "settings"
    private const val KEY_STRATEGY = "strategyId"
    private const val KEY_EXCLUDED = "excludedApps"
    private const val KEY_APPS_ONLY = "appsOnly"
    private const val KEY_INCLUDED = "includedApps"
    private const val KEY_QUIC_OFF = "quicOff"
    private const val KEY_IPV6_OFF = "ipv6Off"
    private const val KEY_BOOT = "startAtBoot"
    private const val KEY_MODE = "mode"
    private const val KEY_REMOTE = "remoteControl"
    private const val KEY_DNS_KIND = "customDnsKind"
    private const val KEY_DNS_SERVER = "customDnsServer"
    private const val KEY_DNS_STRICT = "customDnsStrict"
    private const val KEY_DNS_PROXY = "customDnsProxy"

    /* The desktop's list, in its order: id, label (locale key), the
     * engine's spec, and whether the engine looks for what works by itself. */
    data class Strategy(val id: String, val labelKey: String, val spec: String, val auto: Boolean)

    val STRATEGIES = listOf(
        Strategy("auto", "stratAuto", "split(sni)", true),
        Strategy("split-sni", "stratSplitSni", "split(sni)", false),
        Strategy("disorder-sni", "stratDisorderSni", "disorder(sni)", false),
        Strategy("split-sni-mid", "stratSplitMid", "split(sni_mid)", false),
        Strategy("double-split", "stratDoubleSplit", "split(1),split(sni)", false),
        Strategy("split2", "stratSplit2", "split(2)", false),
        // Off: connections untouched, encrypted DNS only (issue #37).
        Strategy("none", "stratNone", "none", false),
    )

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun strategy(ctx: Context): Strategy = byId(prefs(ctx).getString(KEY_STRATEGY, null))

    fun byId(id: String?): Strategy = STRATEGIES.firstOrNull { it.id == id } ?: STRATEGIES[0]

    fun setStrategy(ctx: Context, id: String) {
        prefs(ctx).edit().putString(KEY_STRATEGY, byId(id).id).apply()
    }

    /* Package names; never Shroudly itself (it is always outside the VPN). */
    fun excluded(ctx: Context): Set<String> =
        (prefs(ctx).getStringSet(KEY_EXCLUDED, emptySet()) ?: emptySet()).filter { it != ctx.packageName }.toSet()

    fun setExcluded(ctx: Context, packages: Set<String>) {
        prefs(ctx).edit().putStringSet(KEY_EXCLUDED, packages.filter { it != ctx.packageName }.toSet()).apply()
    }

    /* The other way round (#60): only the apps chosen here go through
     * Shroudly (VpnService.Builder.addAllowedApplication), every other app
     * straight out. Its own list, so switching back finds the other one as
     * it was. With none chosen, every app goes through, as before. */
    fun appsOnly(ctx: Context): Boolean = prefs(ctx).getBoolean(KEY_APPS_ONLY, false)

    fun setAppsOnly(ctx: Context, on: Boolean) {
        prefs(ctx).edit().putBoolean(KEY_APPS_ONLY, on).apply()
    }

    fun included(ctx: Context): Set<String> =
        (prefs(ctx).getStringSet(KEY_INCLUDED, emptySet()) ?: emptySet()).filter { it != ctx.packageName }.toSet()

    fun setIncluded(ctx: Context, packages: Set<String>) {
        prefs(ctx).edit().putStringSet(KEY_INCLUDED, packages.filter { it != ctx.packageName }.toSet()).apply()
    }

    /* QUIC off (#59): apps' UDP to port 443 is dropped, so they use TCP,
     * which the techniques get through (engine --drop-quic). */
    fun quicOff(ctx: Context): Boolean = prefs(ctx).getBoolean(KEY_QUIC_OFF, false)

    fun setQuicOff(ctx: Context, on: Boolean) {
        prefs(ctx).edit().putBoolean(KEY_QUIC_OFF, on).apply()
    }

    /* IPv6 off (#59): the VPN carries no IPv6, so Android tells apps at once
     * that there is none and they use IPv4, and the engine never uses it
     * either (--ipv4-only). For a network whose IPv6 is broken or slow. */
    fun ipv6Off(ctx: Context): Boolean = prefs(ctx).getBoolean(KEY_IPV6_OFF, false)

    fun setIpv6Off(ctx: Context, on: Boolean) {
        prefs(ctx).edit().putBoolean(KEY_IPV6_OFF, on).apply()
    }

    /* "Proxy only": Shroudly as a proxy on this phone, with no VPN, so the VPN
     * slot stays free for another VPN app (ShroudlyProxyService). */
    fun proxyOnly(ctx: Context): Boolean = prefs(ctx).getString(KEY_MODE, "vpn") == "proxy"

    fun setProxyOnly(ctx: Context, on: Boolean) {
        prefs(ctx).edit().putString(KEY_MODE, if (on) "proxy" else "vpn").apply()
    }

    /* Automation apps (Tasker, MacroDroid) may turn protection on and off
     * (AutomationReceiver); off by default. */
    fun remoteControl(ctx: Context): Boolean = prefs(ctx).getBoolean(KEY_REMOTE, false)

    fun setRemoteControl(ctx: Context, on: Boolean) {
        prefs(ctx).edit().putBoolean(KEY_REMOTE, on).apply()
    }

    /* The user's own DNS server as typed (kind, text), or null: automatic. */
    fun customDnsTyped(ctx: Context): Pair<String, String>? {
        val p = prefs(ctx)
        val kind = p.getString(KEY_DNS_KIND, null) ?: return null
        val text = p.getString(KEY_DNS_SERVER, null) ?: return null
        return if (kind in CustomDns.KINDS && text.isNotBlank()) kind to text else null
    }

    /* Read: null when automatic, or when what was kept cannot be read. */
    fun customDns(ctx: Context): DnsSpec? = customDnsTyped(ctx)?.let { (k, t) -> CustomDns.parse(k, t).first }

    /* That server used alone ("Only this server"): no fallback. */
    fun customDnsStrict(ctx: Context): Boolean = customDns(ctx) != null && prefs(ctx).getBoolean(KEY_DNS_STRICT, false)

    /* The user's proxy for that server as typed (#58), "" for none. */
    fun customDnsProxyTyped(ctx: Context): String = prefs(ctx).getString(KEY_DNS_PROXY, null) ?: ""

    /* Read: null with no server, a UDP one, or none that can be read. */
    fun customDnsProxy(ctx: Context): DnsProxy? {
        val spec = customDns(ctx) ?: return null
        return if (spec.kind == "udp") null else CustomDns.parseProxy(customDnsProxyTyped(ctx)).first
    }

    /* null: automatic. */
    fun setCustomDns(ctx: Context, kind: String?, text: String?, strict: Boolean = false, proxy: String? = null) {
        val e = prefs(ctx).edit()
        if (kind == null || text.isNullOrBlank()) e.remove(KEY_DNS_KIND).remove(KEY_DNS_SERVER).remove(KEY_DNS_STRICT).remove(KEY_DNS_PROXY)
        else {
            e.putString(KEY_DNS_KIND, kind).putString(KEY_DNS_SERVER, text.trim()).putBoolean(KEY_DNS_STRICT, strict)
            if (proxy.isNullOrBlank() || kind == "udp") e.remove(KEY_DNS_PROXY) else e.putString(KEY_DNS_PROXY, proxy.trim())
        }
        e.apply()
    }

    fun startAtBoot(ctx: Context): Boolean = prefs(ctx).getBoolean(KEY_BOOT, false)

    fun setStartAtBoot(ctx: Context, on: Boolean) {
        prefs(ctx).edit().putBoolean(KEY_BOOT, on).apply()
    }
}
