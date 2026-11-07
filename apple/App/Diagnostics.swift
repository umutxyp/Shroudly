import Foundation

/*
 * "Share logs" (About): sent only when the user shares it, through the
 * system's share sheet. The version, the system and the device model, the
 * settings, and the last lines of the app's and the tunnel's logs; the site
 * lines only while protection is on (the tunnel keeps them in memory alone).
 */
enum Diagnostics {
    static let lines = 3000

    static var version: String {
        let v = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
        let b = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"
        return "\(v) (\(b))"
    }

    static var model: String {
        var u = utsname()
        uname(&u)
        return withUnsafeBytes(of: &u.machine) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
    }

    static func header() -> String {
        let s = SettingsStore().load()
        let os = ProcessInfo.processInfo.operatingSystemVersionString
        return """
        Shroudly \(version)
        \(os), \(model)
        Technique \(s.strategy.id), QUIC off \(s.quicOff), IPv6 off \(s.ipv6Off), keep on \(s.keepOn)
        """
    }

    static func text(sites: [String]) -> String {
        var parts = [header(), "", "== App", SharedLog(name: "app.log").tail(lines).joined(separator: "\n"),
                     "", "== Tunnel", SharedLog(name: "tunnel.log").tail(lines).joined(separator: "\n")]
        if !sites.isEmpty { parts += ["", "== Sites", sites.suffix(lines).joined(separator: "\n")] }
        return parts.joined(separator: "\n")
    }
}
