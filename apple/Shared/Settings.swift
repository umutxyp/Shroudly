import Foundation

/*
 * The few settings of the Settings screen, kept in the app group's defaults
 * so the packet tunnel reads them when it starts (the Android app's
 * AppSettings, without what iOS has no room for: there is no per-app VPN
 * outside device management, and no proxy-only mode).
 *  - the technique, as on the desktop and Android: automatic, which looks for
 *    what works per site and keeps it, or one technique for every site;
 *  - QUIC off and IPv6 off (#59), for networks where those are blocked or slow;
 *  - keep protection on: the system starts it again by itself (on demand)
 *    after a restart or when it dropped, until the user stops it;
 *  - your own server (Shared/OwnServer.swift): every site through it, the
 *    link as the user typed it ("" for none).
 */
struct Strategy: Equatable {
    let id: String
    /* Locale key of its name (locales/<language>.json). */
    let labelKey: String
    /* The engine's --strategy. */
    let spec: String
    /* The engine looks for what works by itself (--auto). */
    let auto: Bool
}

enum Strategies {
    /* The desktop's list (components/SettingsPanel.js), in its order. */
    static let all: [Strategy] = [
        Strategy(id: "auto", labelKey: "stratAuto", spec: "split(sni)", auto: true),
        Strategy(id: "split-sni", labelKey: "stratSplitSni", spec: "split(sni)", auto: false),
        Strategy(id: "disorder-sni", labelKey: "stratDisorderSni", spec: "disorder(sni)", auto: false),
        Strategy(id: "split-sni-mid", labelKey: "stratSplitMid", spec: "split(sni_mid)", auto: false),
        Strategy(id: "double-split", labelKey: "stratDoubleSplit", spec: "split(1),split(sni)", auto: false),
        Strategy(id: "split2", labelKey: "stratSplit2", spec: "split(2)", auto: false),
        // Off: connections untouched, encrypted DNS only (issue #37).
        Strategy(id: "none", labelKey: "stratNone", spec: "none", auto: false),
    ]

    /* An unknown or missing id is automatic. */
    static func byId(_ id: String?) -> Strategy {
        all.first { $0.id == id } ?? all[0]
    }
}

struct AppSettings: Equatable {
    var strategyId = Strategies.all[0].id
    var quicOff = false
    var ipv6Off = false
    var keepOn = false
    var ownServer = ""
    // "DNS server" (CustomDns.swift): "auto" or a kind, what was typed, alone.
    var dnsKind = "auto"
    var dnsServer = ""
    var dnsStrict = false
    // "When nothing else works: the Tor network" (Tunnel/TorRoute.swift): on
    // unless turned off; nothing to do on Apple TV, which has no Tor.
    var torLastResort = true
    // The Mac: every app's connections through the tunnel (a VPN), or, by
    // default, Shroudly as the Mac's proxy, as the desktop app from GitHub
    // works: the apps that use the system's proxy (browsers and most others)
    // go through it, the rest straight, much lighter than every packet of
    // the Mac in the tunnel. Not on iPhone, iPad or Apple TV (always all).
    var macAllApps = false

    var strategy: Strategy { Strategies.byId(strategyId) }

    /* Shroudly as the Mac's proxy, no packets in the tunnel. */
    var proxyOnly: Bool {
        #if os(macOS)
        return !macAllApps
        #else
        return false
        #endif
    }

    /* What the engine and the tunnel are started with; keepOn is the
     * system's business (on demand), not theirs. */
    func sameTunnel(as other: AppSettings) -> Bool {
        strategy == other.strategy && quicOff == other.quicOff && ipv6Off == other.ipv6Off && ownServer == other.ownServer
            && dnsKind == other.dnsKind && dnsServer == other.dnsServer && dnsStrict == other.dnsStrict
            && torLastResort == other.torLastResort && macAllApps == other.macAllApps
    }

    /* The own server in use, or nil (none, or a link that cannot be used). */
    var ownServerLink: OwnServerLink? { ownServer.isEmpty ? nil : OwnServer.parse(ownServer).link }
}

final class SettingsStore {
    private enum Key {
        static let strategy = "strategyId"
        static let quicOff = "quicOff"
        static let ipv6Off = "ipv6Off"
        static let keepOn = "keepOn"
        static let ownServer = "ownServer"
        static let torLastResort = "torLastResort"
        static let macAllApps = "macAllApps"
    }

    private let defaults: UserDefaults

    init(defaults: UserDefaults = AppGroup.defaults) {
        self.defaults = defaults
    }

    func load() -> AppSettings {
        var s = AppSettings()
        s.strategyId = Strategies.byId(defaults.string(forKey: Key.strategy)).id
        s.quicOff = defaults.bool(forKey: Key.quicOff)
        s.ipv6Off = defaults.bool(forKey: Key.ipv6Off)
        s.keepOn = defaults.bool(forKey: Key.keepOn)
        s.ownServer = defaults.string(forKey: Key.ownServer) ?? ""
        s.torLastResort = defaults.object(forKey: Key.torLastResort) as? Bool ?? true
        s.macAllApps = defaults.bool(forKey: Key.macAllApps)
        s.dnsKind = defaults.string(forKey: CustomDns.Key.kind) ?? "auto"
        s.dnsServer = defaults.string(forKey: CustomDns.Key.server) ?? ""
        s.dnsStrict = defaults.bool(forKey: CustomDns.Key.strict)
        return s
    }

    func save(_ s: AppSettings) {
        defaults.set(Strategies.byId(s.strategyId).id, forKey: Key.strategy)
        defaults.set(s.quicOff, forKey: Key.quicOff)
        defaults.set(s.ipv6Off, forKey: Key.ipv6Off)
        defaults.set(s.keepOn, forKey: Key.keepOn)
        defaults.set(s.ownServer, forKey: Key.ownServer)
        defaults.set(s.torLastResort, forKey: Key.torLastResort)
        defaults.set(s.macAllApps, forKey: Key.macAllApps)
        if s.dnsKind == "auto" || s.dnsServer.isEmpty {
            for k in [CustomDns.Key.kind, CustomDns.Key.server, CustomDns.Key.strict] { defaults.removeObject(forKey: k) }
        } else {
            defaults.set(s.dnsKind, forKey: CustomDns.Key.kind)
            defaults.set(s.dnsServer, forKey: CustomDns.Key.server)
            defaults.set(s.dnsStrict, forKey: CustomDns.Key.strict)
        }
    }
}
