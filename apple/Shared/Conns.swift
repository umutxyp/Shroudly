import Foundation

/*
 * The Connections list (issue #74), as on the desktop and Android
 * (electron/system-hosts.js, android Conns.kt): what went through Shroudly,
 * by site name, as the engine counts it (core/src/conns.c, CONNS), and the
 * names the user blocked there, kept in the app group's settings only and
 * given to the engine by the tunnel at every start and every change.
 */
struct ConnRow: Identifiable, Equatable {
    let host: String
    let active: Int
    let conns: Int64
    let up: Int64
    let down: Int64
    let route: String
    let blocked: Bool
    let refused: Int64
    var id: String { host }

    init?(_ o: [String: Any]) {
        guard let h = o["host"] as? String, !h.isEmpty else { return nil }
        host = h
        func n(_ k: String) -> Int64 { (o[k] as? NSNumber)?.int64Value ?? 0 }
        active = Int(n("active")); conns = n("conns"); up = n("up"); down = n("down")
        route = o["route"] as? String ?? "direct"
        blocked = n("blocked") != 0
        refused = n("refused")
    }

    var dictionary: [String: Any] {
        ["host": host, "active": active, "conns": conns, "up": up, "down": down, "route": route, "blocked": blocked ? 1 : 0, "refused": refused]
    }
}

enum Conns {
    static let key = "userBlocked"
    /* The names Shroudly itself uses: marked, and blocking one asks first. */
    static let system = [
        "cloudflare-dns.com", "one.one.one.one", "dns.google", "dns.quad9.net", "doh.opendns.com", "dns.opendns.com",
        "doh.sb", "dns.sb", "unfiltered.adguard-dns.com", "dns.adguard-dns.com", "dns.mullvad.net",
        "codeshare.me", "github.com", "githubusercontent.com", "api.github.com",
        "torproject.net", "torproject.org",
    ]

    static func isSystem(_ host: String, own: String? = nil) -> Bool {
        let h = host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
        return (system + [own].compactMap { $0 }).contains { h == $0 || h.hasSuffix("." + $0) }
    }

    /* A name as the user typed it, or nil when it cannot be one. */
    static func clean(_ host: String) -> String? {
        var h = host.trimmingCharacters(in: .whitespaces).lowercased()
        while h.hasSuffix(".") { h.removeLast() }
        guard (1...253).contains(h.count), h.range(of: "^[a-z0-9._:-]+$", options: .regularExpression) != nil else { return nil }
        return h
    }

    static func blocked(_ d: UserDefaults = AppGroup.defaults) -> [String] {
        (d.stringArray(forKey: key) ?? []).sorted()
    }

    @discardableResult
    static func set(_ host: String, blocked on: Bool, _ d: UserDefaults = AppGroup.defaults) -> [String]? {
        guard let h = clean(host) else { return nil }
        var now = Set(blocked(d))
        if on { now.insert(h) } else { now.remove(h) }
        d.set(Array(now).sorted(), forKey: key)
        return Array(now).sorted()
    }

    /* The sites the user sends through Tor (the last way out; the Mac): for
     * a site that turns the user's country away itself. */
    static let torKey = "torSites"
    static func torSites(_ d: UserDefaults = AppGroup.defaults) -> [String] {
        (d.stringArray(forKey: torKey) ?? []).sorted()
    }

    @discardableResult
    static func set(_ host: String, tor on: Bool, _ d: UserDefaults = AppGroup.defaults) -> [String]? {
        guard let h = clean(host) else { return nil }
        var now = Set(torSites(d))
        if on { now.insert(h) } else { now.remove(h) }
        d.set(Array(now).sorted(), forKey: torKey)
        return Array(now).sorted()
    }

    /* "Apps always through Tor" (TorAppsList, from electron/tor-apps.js):
     * the ids picked, known ones only, in the list's order. */
    static let torAppsKey = "torApps"
    static func torApps(_ d: UserDefaults = AppGroup.defaults) -> [String] {
        let kept = Set(d.stringArray(forKey: torAppsKey) ?? [])
        return TorAppsList.apps.map(\.id).filter { kept.contains($0) }
    }

    @discardableResult
    static func set(app id: String, tor on: Bool, _ d: UserDefaults = AppGroup.defaults) -> [String]? {
        guard TorAppsList.apps.contains(where: { $0.id == id }) else { return nil }
        var now = Set(torApps(d))
        if on { now.insert(id) } else { now.remove(id) }
        d.set(TorAppsList.apps.map(\.id).filter { now.contains($0) }, forKey: torAppsKey)
        return torApps(d)
    }

    /* The names and ranges of the apps `ids`, each once. */
    static func appEntries(_ ids: [String]) -> [String] {
        var seen = Set<String>()
        return TorAppsList.apps.filter { ids.contains($0.id) }.flatMap(\.entries).filter { seen.insert($0).inserted }
    }

    /* Everything sent through Tor by the user's choice: the sites typed and
     * the apps picked. */
    static func torEntries(_ d: UserDefaults = AppGroup.defaults) -> [String] {
        var seen = Set<String>()
        return (torSites(d) + appEntries(torApps(d))).filter { seen.insert($0).inserted }
    }

    /* The listed name that sends this one through Tor (itself or one above). */
    static func viaTor(_ host: String, _ sites: [String]) -> String? {
        sites.first { host == $0 || host.hasSuffix("." + $0) }
    }

    /* Only the listed sites go through Shroudly's ways (Settings); every
     * other goes out as it is, with the network's own DNS. */
    static let onlyModeKey = "onlySitesMode"
    static let onlyKey = "onlySites"
    static func onlyMode(_ d: UserDefaults = AppGroup.defaults) -> Bool { d.bool(forKey: onlyModeKey) }
    static func onlySites(_ d: UserDefaults = AppGroup.defaults) -> [String] {
        var seen = Set<String>()
        return (d.string(forKey: onlyKey) ?? "").split(separator: "\n").compactMap { line -> String? in
            var t = String(line).trimmingCharacters(in: .whitespaces)
            for p in ["https://", "http://"] where t.lowercased().hasPrefix(p) { t = String(t.dropFirst(p.count)) }
            if let slash = t.firstIndex(of: "/") { t = String(t[..<slash]) }
            guard let h = clean(t), h.contains(".") || h.contains(":"), seen.insert(h).inserted else { return nil }
            return h
        }
    }
    static func setOnly(mode: Bool, text: String, _ d: UserDefaults = AppGroup.defaults) {
        d.set(mode, forKey: onlyModeKey)
        d.set(text, forKey: onlyKey)
    }

    /* What the engine is given (the tunnel sends it, at a start and after
     * every change: each list cleared first, so sending it again is safe). */
    static func commands(_ d: UserDefaults = AppGroup.defaults) -> [String] {
        ["BLOCK-CLEAR"] + blocked(d).map { "BLOCK \($0)" }
            + ["TOR-CLEAR"] + torEntries(d).map { "TOR \($0)" }
            + ["ONLY-CLEAR"] + onlySites(d).map { "ONLY \($0)" } + ["ONLY-MODE \(onlyMode(d) ? 1 : 0)"]
    }
}
