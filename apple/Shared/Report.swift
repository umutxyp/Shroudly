import Foundation
import CryptoKit

/*
 * "Something not working?" (ReportView): what the user wrote, a few facts
 * about the device and the log (Diagnostics.text), sent to codeshare.me
 * (POST /api/shroudly/report, on Codeshare's own server), which mails it to
 * the developer and keeps nothing. Only when the user taps Send, after
 * reading what goes and agreeing to send it with the log. The same as the
 * desktop's (electron/report.js) and Android's (Report.kt): the same body,
 * limits, proof of work and reference numbers.
 *
 * On the device: the references sent, with when, for 60 days, so the user
 * can quote one; and so no more than one goes an hour and three a day (the
 * server holds its own limits too). Nothing else is kept.
 *
 * The request is the app's own: while protection is on it goes through the
 * tunnel like every app's.
 */
enum Report {
    static let url = URL(string: "https://codeshare.me/api/shroudly/report")!
    static let hour: TimeInterval = 3600
    static let day: TimeInterval = 24 * 3600
    static let historySpan: TimeInterval = 60 * 24 * 3600
    static let perHour = 1
    static let perDay = 3
    static let whatMin = 50
    static let whatMax = 1000
    static let powBits = 18
    static let logMaxChars = 2 * 1024 * 1024
    private static let powPrefix = "shroudly-report-v1"
    private static let key = "shroudlyReports"

    struct Sent: Codable, Equatable {
        let ref: String
        let at: Date
    }

    struct Wait: Equatable {
        let seconds: TimeInterval
        let limit: String?
    }

    struct Fields {
        var what = ""
        var site = ""
        var isp = ""
        var country = ""
        var contact = ""
    }

    enum Outcome: Equatable {
        case sent(String)
        case failed(String, limit: String?)
    }

    static func isRef(_ s: String) -> Bool {
        s.range(of: "^SR-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$", options: .regularExpression) != nil
    }

    /* Characters as the server counts them (code points). */
    static func chars(_ s: String) -> Int {
        s.trimmingCharacters(in: .whitespacesAndNewlines).unicodeScalars.count
    }

    static func history(_ list: [Sent], now: Date = Date()) -> [Sent] {
        Array(list.filter { isRef($0.ref) && $0.at <= now.addingTimeInterval(60) && now.timeIntervalSince($0.at) < historySpan }
            .sorted { $0.at > $1.at }.prefix(50))
    }

    static func wait(_ list: [Sent], now: Date = Date()) -> Wait {
        let h = history(list, now: now)
        let dayList = h.filter { now.timeIntervalSince($0.at) < day }
        let hourList = h.filter { now.timeIntervalSince($0.at) < hour }
        if dayList.count >= perDay { return Wait(seconds: dayList[perDay - 1].at.addingTimeInterval(day).timeIntervalSince(now), limit: "day") }
        if hourList.count >= perHour { return Wait(seconds: hourList[perHour - 1].at.addingTimeInterval(hour).timeIntervalSince(now), limit: "hour") }
        return Wait(seconds: 0, limit: nil)
    }

    static func load(_ defaults: UserDefaults = .standard) -> [Sent] {
        let list = (defaults.data(forKey: key)).flatMap { try? JSONDecoder().decode([Sent].self, from: $0) } ?? []
        let h = history(list)
        if h != list, let d = try? JSONEncoder().encode(h) { defaults.set(d, forKey: key) }
        return h
    }

    static func record(_ ref: String, _ defaults: UserDefaults = .standard) {
        let h = history([Sent(ref: ref, at: Date())] + load(defaults))
        if let d = try? JSONEncoder().encode(h) { defaults.set(d, forKey: key) }
    }

    private static func cut(_ s: String, _ max: Int) -> String {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        var u = String.UnicodeScalarView()
        u.append(contentsOf: t.unicodeScalars.prefix(max))
        return String(u)
    }

    // ── gzip (the server unpacks gzip; Foundation makes raw deflate) ───────

    private static let crcTable: [UInt32] = (0..<256).map { i -> UInt32 in
        var c = UInt32(i)
        for _ in 0..<8 { c = (c & 1) != 0 ? 0xEDB8_8320 ^ (c >> 1) : c >> 1 }
        return c
    }

    static func crc32(_ data: Data) -> UInt32 {
        var c: UInt32 = 0xFFFF_FFFF
        for b in data { c = crcTable[Int((c ^ UInt32(b)) & 0xFF)] ^ (c >> 8) }
        return c ^ 0xFFFF_FFFF
    }

    static func gzip(_ data: Data) -> Data? {
        guard let deflated = try? (data as NSData).compressed(using: .zlib) as Data else { return nil }
        var out = Data([0x1F, 0x8B, 0x08, 0x00, 0, 0, 0, 0, 0x00, 0xFF])
        out.append(deflated)
        var crc = crc32(data).littleEndian
        var size = UInt32(truncatingIfNeeded: data.count).littleEndian
        withUnsafeBytes(of: &crc) { out.append(contentsOf: $0) }
        withUnsafeBytes(of: &size) { out.append(contentsOf: $0) }
        return out
    }

    // ── the request ─────────────────────────────────────────────────────────

    /* The body, as JSON text; a long log keeps its end. */
    static func body(_ f: Fields, version: String, platform: String, os: String, device: String, lang: String, log: String) -> String? {
        let l = log.count > logMaxChars ? "[… the start was cut]\n" + String(log.suffix(logMaxChars)) : log
        guard let gz = gzip(Data(l.utf8)) else { return nil }
        let o: [String: Any] = [
            "v": 1,
            "app": ["platform": platform, "version": version, "os": cut(os, 100), "device": cut(device, 100)],
            "lang": cut(lang, 20),
            "what": cut(f.what, whatMax),
            "site": cut(f.site, 300),
            "isp": cut(f.isp, 120),
            "country": cut(f.country, 80),
            "contact": cut(f.contact, 200),
            "log": gz.base64EncodedString(),
        ]
        guard let d = try? JSONSerialization.data(withJSONObject: o) else { return nil }
        return String(decoding: d, as: UTF8.self)
    }

    private static func hex(_ d: some Sequence<UInt8>) -> String { d.map { String(format: "%02x", $0) }.joined() }

    private static func zeroBits(_ d: some Sequence<UInt8>) -> Int {
        var n = 0
        for b in d {
            if b == 0 { n += 8; continue }
            return n + b.leadingZeroBitCount
        }
        return n
    }

    /* The proof of work the server asks of every report (codeshare.me,
     * server/shroudly/report.ts powOk): "<unix seconds>.<nonce>" such that
     * SHA-256 of "shroudly-report-v1\n<seconds>\n<SHA-256 of the body, hex>\n
     * <nonce>" starts with powBits zero bits. A fraction of a second. */
    static func proofOfWork(_ body: String, bits: Int = powBits, now: Date = Date()) -> String {
        let at = Int(now.timeIntervalSince1970)
        let bh = hex(SHA256.hash(data: Data(body.utf8)))
        let head = Data("\(powPrefix)\n\(at)\n\(bh)\n".utf8)
        var n: UInt64 = 0
        while true {
            let nonce = String(n, radix: 16)
            var h = SHA256()
            h.update(data: head)
            h.update(data: Data(nonce.utf8))
            if zeroBits(h.finalize()) >= bits { return "\(at).\(nonce)" }
            n += 1
        }
    }

    static func answer(status: Int, data: Data?) -> Outcome {
        let j = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        if status == 200, j?["ok"] as? Bool == true, let ref = j?["ref"] as? String, isRef(ref) { return .sent(ref) }
        let e = (j?["error"] as? String).flatMap { ["rate", "bad", "off", "mail"].contains($0) ? $0 : nil } ?? "network"
        return .failed(e, limit: e == "rate" ? "hour" : nil)
    }

    /* POST it, with the app's header ("<platform>/<version>") and the proof
     * of work, worked off the main thread. */
    static func send(_ body: String, app: String) async -> Outcome {
        let pow = await Task.detached(priority: .userInitiated) { proofOfWork(body) }.value
        var req = URLRequest(url: url, timeoutInterval: 45)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.setValue(app, forHTTPHeaderField: "x-shroudly-app")
        req.setValue(pow, forHTTPHeaderField: "x-shroudly-pow")
        req.httpBody = Data(body.utf8)
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            return answer(status: (resp as? HTTPURLResponse)?.statusCode ?? 0, data: data)
        } catch {
            return .failed("network", limit: nil)
        }
    }
}
