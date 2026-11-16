import CryptoKit
import Foundation

/*
 * Remote settings: what Shroudly can be told without a new version, the same
 * file and rules as the desktop (electron/remote-config.js, where the format
 * and every key are described) and Android (RemoteConfig.kt). Data, never
 * code: remote.json and its ECDSA P-256 / SHA-256 signature, checked against
 * the public key below; a file that does not check, is older than the one in
 * use, has expired or is not understood is never used, and the last good one
 * is kept. The app asks for it (through the tunnel while it is on) and keeps
 * it in the app group, where the tunnel reads it.
 */
enum RemoteConfig {
    static let publicKey = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAERbLcXjFix6KWe3RTG+f7yhiqxBJ5mmNwu9jl2ZK5c7yDpxnC+wcU/YuC1vR3HnQCXfeylIYc7opckWkmTd/4HQ=="
    static let sources = [
        "https://raw.githubusercontent.com/umutxyp/Shroudly/main/",
        "https://cdn.jsdelivr.net/gh/umutxyp/Shroudly@main/",
    ]
    static let every: TimeInterval = 6 * 3600
    private enum Key {
        static let text = "remoteConfigText"
        static let sig = "remoteConfigSig"
        static let at = "remoteConfigAt"
    }

    /* The engine arguments a remote file may add: technique tuning only (the
     * desktop's ENGINE_ALLOWED); nil takes no value. */
    static let engineAllowed: [String: String?] = [
        "--strategy": "^[A-Za-z0-9_(),=.:+\\-]{1,200}$",
        "--decoy-name": "^(?=.{1,253}$)([A-Za-z0-9-]{1,63}\\.)+[A-Za-z]{2,63}$",
        "--fake-repeats": "^([1-9]|1[0-6])$",
        "--tlsrec": "^[01]$",
        "--ipv4-only": nil,
        "--drop-quic": nil,
        "--no-quic-block": nil,
        "--no-udp-fake": nil,
    ]

    static func verify(_ text: String, sig: String, key: String = publicKey) -> Bool {
        guard let der = Data(base64Encoded: key), let s = Data(base64Encoded: sig.trimmingCharacters(in: .whitespacesAndNewlines)),
              let k = try? P256.Signing.PublicKey(derRepresentation: der),
              let signature = try? P256.Signing.ECDSASignature(derRepresentation: s) else { return false }
        return k.isValidSignature(signature, for: Data(text.utf8))
    }

    /* The file, understood, or nil. */
    static func parse(_ text: String, now: Date = Date()) -> [String: Any]? {
        guard let o = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
              (o["v"] as? Int) == 1, let serial = o["serial"] as? Int, serial >= 1 else { return nil }
        if let e = o["expires"] as? String {
            guard let d = ISO8601DateFormatter().date(from: e), d > now else { return nil }
        }
        if o["set"] != nil && !(o["set"] is [String: Any]) { return nil }
        if o["rules"] != nil && !(o["rules"] is [Any]) { return nil }
        return o
    }

    static func cmpVersion(_ a: String, _ b: String) -> Int {
        let x = a.split(separator: ".").map { Int($0) ?? 0 }, y = b.split(separator: ".").map { Int($0) ?? 0 }
        for i in 0..<max(x.count, y.count) {
            let p = i < x.count ? x[i] : 0, q = i < y.count ? y[i] : 0
            if p != q { return p < q ? -1 : 1 }
        }
        return 0
    }

    struct Ctx { let platform: String; let country: String?; let app: String }

    static func matches(_ when: Any?, _ ctx: Ctx) -> Bool {
        guard let when else { return true }
        guard let w = when as? [String: Any] else { return false }
        func inList(_ k: String, _ v: String?) -> Bool { ((w[k] as? [Any]) ?? []).contains { "\($0)".lowercased() == (v ?? "").lowercased() } }
        if w["platform"] != nil && !inList("platform", ctx.platform) { return false }
        if w["country"] != nil && !inList("country", ctx.country) { return false }
        if let m = w["appMin"] as? String, cmpVersion(ctx.app, m) < 0 { return false }
        if let m = w["appMax"] as? String, cmpVersion(ctx.app, m) > 0 { return false }
        return true
    }

    static func effective(_ c: [String: Any]?, _ ctx: Ctx) -> [String: Any] {
        guard let c else { return [:] }
        var out = (c["set"] as? [String: Any]) ?? [:]
        for r in (c["rules"] as? [Any]) ?? [] {
            guard let r = r as? [String: Any], matches(r["when"], ctx), let s = r["set"] as? [String: Any] else { continue }
            out.merge(s) { _, new in new }
        }
        return out
    }

    static func engineArgs(_ list: Any?) -> [String] {
        guard let l = list as? [Any] else { return [] }
        var out: [String] = [], i = 0
        while i < l.count {
            let a = "\(l[i])"
            if let shape = engineAllowed[a] {
                if let shape {
                    if i + 1 < l.count, let v = l[i + 1] as? String, v.range(of: shape, options: .regularExpression) != nil { out += [a, v]; i += 1 }
                } else { out.append(a) }
            }
            i += 1
        }
        return out
    }

    static func torBridges(_ eff: [String: Any]) -> [String: [String]] {
        guard let o = eff["torBridges"] as? [String: Any] else { return [:] }
        var out: [String: [String]] = [:]
        for (k, v) in o where k.range(of: "^[A-Za-z0-9_]{1,20}$", options: .regularExpression) != nil {
            let lines = ((v as? [Any]) ?? []).compactMap { $0 as? String }
                .filter { $0.count < 2000 && !$0.contains("\n") && !$0.contains("\r") && $0.split(separator: " ").first.map(String.init) == k }.prefix(40)
            if !lines.isEmpty { out[k] = Array(lines) }
        }
        return out
    }

    /* What of the settings the tunnel starts with: a new file restarts it
     * only when this changes (issue #90: a first, empty file restarted it). */
    static func engineKey(_ eff: [String: Any]) -> String {
        let decoys = (try? JSONSerialization.data(withJSONObject: eff["decoyNames"] ?? [:], options: .sortedKeys)).map { String(decoding: $0, as: UTF8.self) } ?? ""
        let bridges = torBridges(eff).sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value.joined(separator: ","))" }.joined(separator: ";")
        return [engineArgs(eff["engineArgs"]).joined(separator: " "), decoys, "\((eff["torAllowed"] as? Bool) ?? true)", bridges].joined(separator: "|")
    }

    static func reportOffer(_ eff: [String: Any]) -> String {
        let r = eff["reportOffer"] as? String ?? ""
        return ["fault", "always", "never"].contains(r) ? r : "fault"
    }

    // ── this device's settings (app and tunnel) ───────────────────────────

    static func current(_ d: UserDefaults = AppGroup.defaults) -> [String: Any]? {
        guard let t = d.string(forKey: Key.text), let s = d.string(forKey: Key.sig), verify(t, sig: s) else { return nil }
        return parse(t)
    }

    static func serial(_ d: UserDefaults = AppGroup.defaults) -> Int { (current(d)?["serial"] as? Int) ?? 0 }

    static var ctx: Ctx {
        #if os(macOS)
        let platform = "macos"
        #elseif os(tvOS)
        let platform = "tvos"
        #else
        let platform = "ios"
        #endif
        let cc = Locale.current.region?.identifier
        let app = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
        return Ctx(platform: platform, country: cc, app: app)
    }

    static func settings(_ d: UserDefaults = AppGroup.defaults) -> [String: Any] { effective(current(d), ctx) }

    /* A file and its signature as fetched: kept when it checks and is newer. */
    @discardableResult
    static func offer(_ text: String, sig: String, _ d: UserDefaults = AppGroup.defaults, log: (String) -> Void = { _ in }) -> Bool {
        guard text.utf8.count <= 256 * 1024 else { return false }
        guard verify(text, sig: sig) else { log("Remote settings: a file whose signature does not check was refused"); return false }
        guard let c = parse(text), let serial = c["serial"] as? Int, serial > Self.serial(d) else { return false }
        d.set(text, forKey: Key.text)
        d.set(sig.trimmingCharacters(in: .whitespacesAndNewlines), forKey: Key.sig)
        log("Remote settings: number \(serial) in use")
        return true
    }

    /* Asked for every six hours by the app; true when a new one came. */
    static func refreshIfDue(_ d: UserDefaults = AppGroup.defaults, session: URLSession = .shared, log: (String) -> Void = { _ in }) async -> Bool {
        if Date().timeIntervalSince1970 - d.double(forKey: Key.at) < every { return false }
        for base in sources {
            guard let fu = URL(string: base + "remote.json"), let su = URL(string: base + "remote.json.sig") else { continue }
            do {
                let (f, fr) = try await session.data(from: fu)
                let (s, sr) = try await session.data(from: su)
                guard (fr as? HTTPURLResponse)?.statusCode == 200, (sr as? HTTPURLResponse)?.statusCode == 200 else { continue }
                d.set(Date().timeIntervalSince1970, forKey: Key.at)
                let before = engineKey(settings(d))
                // True (protection starts again) only when what the tunnel
                // starts with changed.
                return offer(String(decoding: f, as: UTF8.self), sig: String(decoding: s, as: UTF8.self), d, log: log) && engineKey(settings(d)) != before
            } catch { continue }
        }
        return false
    }
}
