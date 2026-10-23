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
    private const val KEY_BOOT = "startAtBoot"
    private const val KEY_MODE = "mode"
    private const val KEY_REMOTE = "remoteControl"
    private const val KEY_DNS_KIND = "customDnsKind"
    private const val KEY_DNS_SERVER = "customDnsServer"

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

    /* null: automatic. */
    fun setCustomDns(ctx: Context, kind: String?, text: String?) {
        val e = prefs(ctx).edit()
        if (kind == null || text.isNullOrBlank()) e.remove(KEY_DNS_KIND).remove(KEY_DNS_SERVER)
        else e.putString(KEY_DNS_KIND, kind).putString(KEY_DNS_SERVER, text.trim())
        e.apply()
    }

    fun startAtBoot(ctx: Context): Boolean = prefs(ctx).getBoolean(KEY_BOOT, false)

    fun setStartAtBoot(ctx: Context, on: Boolean) {
        prefs(ctx).edit().putBoolean(KEY_BOOT, on).apply()
    }
}
