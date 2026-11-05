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

    /* What the engine is given (the tunnel sends it). */
    static func commands(_ d: UserDefaults = AppGroup.defaults) -> [String] {
        ["BLOCK-CLEAR"] + blocked(d).map { "BLOCK \($0)" }
    }
}
