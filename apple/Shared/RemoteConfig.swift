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
    // Asked again this soon when a source answered but none gave a usable file.
    static let retry: TimeInterval = 3600
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

    /* What a file and its signature as fetched are worth (the desktop's
     * take, electron/remote-config.js): .new checks and is newer than the
     * one in use; .same checks and is the one in use (the check is done,
     * nothing changes); .unusable is too large, signed wrong (a mirror out
     * of step, a captive portal's page), not understood, expired or older,
     * and the next source is asked. An HTTP 200 alone used to end the
     * check, and an unusable answer from the first source kept the mirror
     * from being asked until six hours on. */
    enum Take: Equatable { case new, same, unusable }

    static func worth(_ text: String, sig: String, inUse: Int, key: String = publicKey, now: Date = Date()) -> Take {
        guard !text.isEmpty, text.utf8.count <= 256 * 1024, verify(text, sig: sig, key: key),
              let c = parse(text, now: now), let serial = c["serial"] as? Int else { return .unusable }
        if serial < inUse { return .unusable }
        return serial == inUse ? .same : .new
    }

    /* Each source in turn until one gives a usable file. fetch: the file and
     * its signature, or nil when the source did not answer (offline, not
     * HTTP 200); take: what they are worth (and kept when new). Returns .new
     * or .same from the source that gave a usable file, .unusable when one
     * answered but none gave a usable file, nil when none answered. */
    static func ask<S>(_ sources: [S], fetch: (S) async -> (String, String)?, take: (String, String) -> Take) async -> Take? {
        var answered = false
        for src in sources {
            guard let got = await fetch(src) else { continue }
            answered = true
            let t = take(got.0, got.1)
            if t != .unusable { return t }
        }
        return answered ? .unusable : nil
    }

    /* When the last check counts as made, after one that ended `how` at
     * `now`: now after a usable file (six hours to the next); an hour before
     * the next is due when sources answered but none gave one, rather than
     * at every look; unchanged (nil) when none answered (offline). */
    static func checkedAt(_ how: Take?, now: TimeInterval) -> TimeInterval? {
        switch how {
        case nil: return nil
        case .unusable?: return now - every + retry
        default: return now
        }
    }

    /* A file and its signature as fetched, kept when new (worth). */
    static func take(_ text: String, sig: String, _ d: UserDefaults = AppGroup.defaults, log: (String) -> Void = { _ in }) -> Take {
        let t = worth(text, sig: sig, inUse: Self.serial(d))
        if t == .unusable, !text.isEmpty, text.utf8.count <= 256 * 1024, !verify(text, sig: sig) {
            log("Remote settings: a file whose signature does not check was refused")
        }
        guard t == .new else { return t }
        d.set(text, forKey: Key.text)
        d.set(sig.trimmingCharacters(in: .whitespacesAndNewlines), forKey: Key.sig)
        log("Remote settings: number \((parse(text)?["serial"] as? Int) ?? 0) in use")
        return t
    }

    /* Kept when it checks and is newer. */
    @discardableResult
    static func offer(_ text: String, sig: String, _ d: UserDefaults = AppGroup.defaults, log: (String) -> Void = { _ in }) -> Bool {
        take(text, sig: sig, d, log: log) == .new
    }

    /* Asked for every six hours by the app; true when a new one came and
     * what the tunnel starts with changed (protection starts again). */
    static func refreshIfDue(_ d: UserDefaults = AppGroup.defaults, session: URLSession = .shared, log: (String) -> Void = { _ in }) async -> Bool {
        if Date().timeIntervalSince1970 - d.double(forKey: Key.at) < every { return false }
        let before = engineKey(settings(d))
        let how = await ask(sources, fetch: { base -> (String, String)? in
            guard let fu = URL(string: base + "remote.json"), let su = URL(string: base + "remote.json.sig") else { return nil }
            do {
                let (f, fr) = try await session.data(from: fu)
                let (s, sr) = try await session.data(from: su)
                guard (fr as? HTTPURLResponse)?.statusCode == 200, (sr as? HTTPURLResponse)?.statusCode == 200 else { return nil }
                return (String(decoding: f, as: UTF8.self), String(decoding: s, as: UTF8.self))
            } catch { return nil }
        }, take: { take($0, sig: $1, d, log: log) })
        if let at = checkedAt(how, now: Date().timeIntervalSince1970) { d.set(at, forKey: Key.at) }
        return how == .new && engineKey(settings(d)) != before
    }
}
