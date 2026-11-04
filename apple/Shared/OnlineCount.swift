import Foundation

/*
 * The live count ("Online now"), backed by server/stats: the device is
 * counted in the same total as the desktop and Android, by the same rules
 * (Android's OnlineCount.kt, electron/presence.js), and nothing in what it
 * sends says it is an iPhone, an iPad, a Mac or an Apple TV.
 *
 *   - Only while protection is on, and only with "Count me in the live total"
 *     on (Settings; on by default, like the desktop and Android).
 *   - A random id made fresh each time counting starts, never stored, sent as
 *     {"id":"<id>"} to /v1/ping and nothing else; again after the interval
 *     the server asks for (30 s to 15 min), after 30 s when a ping failed.
 *   - Through the engine (Tunnel/EngineHTTPS.swift): whoever filters the
 *     network sees a protected connection, not a request to our domain.
 *   - The user's Stop, or the setting switched off, sends /v1/leave, so the
 *     device drops out at once; protection ending on its own sends nothing
 *     and the id expires on the server within minutes.
 */
enum OnlineCount {
    static let key = "shareOnlineCount"
    /* The last total the server gave while counted, for the app to show. */
    static let onlineKey = "onlineNow"

    static let host = "shroudly.codeshare.me"
    static let ping = "/v1/ping"
    static let leave = "/v1/leave"
    static let minInterval: TimeInterval = 30
    static let maxInterval: TimeInterval = 900
    static let retry: TimeInterval = 30
    static let defaultInterval: TimeInterval = 60
    static let pingTimeout: TimeInterval = 10
    static let leaveTimeout: TimeInterval = 1.5
    static let maxBody = 4096
    // The desktop's Electron (package.json) and its Chromium (OnlineCount.kt).
    static let electron = "43.8.1"
    static let chrome = "150.0.7871.250"

    /* On unless switched off. */
    static func enabled(_ d: UserDefaults = AppGroup.defaults) -> Bool {
        d.object(forKey: key) as? Bool ?? true
    }

    /* Exactly what the desktop sends: JSON.stringify({ id }). */
    static func body(_ id: String) -> String { "{\"id\":\"\(id)\"}" }

    /* How many are online, as the server's answer says ({"online": n}). */
    static func online(in answer: String) -> Int? {
        guard let r = answer.range(of: "\"online\"\\s*:\\s*[0-9]{1,9}", options: .regularExpression) else { return nil }
        return Int(answer[r].filter(\.isNumber))
    }

    /* Seconds to the next ping after an answer, as the desktop works it out:
     * the server's interval, 60 when it gives none, kept between 30 seconds
     * and 15 minutes. nil: not an answer (a failure). */
    static func nextDelay(_ answer: String) -> TimeInterval? {
        let t = answer.trimmingCharacters(in: .whitespacesAndNewlines)
        guard t.hasPrefix("{"), t.hasSuffix("}") else { return nil }
        var n = defaultInterval
        if let r = t.range(of: "\"interval\"\\s*:\\s*-?[0-9]+(\\.[0-9]+)?", options: .regularExpression),
           let v = Double(t[r].split(separator: ":").last?.trimmingCharacters(in: .whitespaces) ?? ""), v != 0 {
            n = v.rounded(.towardZero)
        }
        return min(max(n, minInterval), maxInterval)
    }

    static func userAgent(_ version: String) -> String {
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Shroudly/\(version) Chrome/\(chrome) Electron/\(electron) Safari/537.36"
    }

    /* Electron's net module on Windows: these headers, in this order. */
    static func request(_ path: String, body: String, version: String, acceptLanguage: String) -> Data {
        let b = Array(body.utf8)
        let head = "POST \(path) HTTP/1.1\r\n" +
            "Host: \(host)\r\n" +
            "Connection: keep-alive\r\n" +
            "Content-Length: \(b.count)\r\n" +
            "content-type: application/json\r\n" +
            "Sec-Fetch-Site: none\r\n" +
            "Sec-Fetch-Mode: no-cors\r\n" +
            "Sec-Fetch-Dest: empty\r\n" +
            "User-Agent: \(userAgent(version))\r\n" +
            "Accept-Encoding: gzip, deflate, br, zstd\r\n" +
            "Accept-Language: \(acceptLanguage)\r\n" +
            "\r\n"
        return Data(head.utf8) + Data(b)
    }

    // Chromium's UI languages (Electron 43's locales), as it names them.
    private static let chromium: Set<String> = [
        "af", "am", "ar", "bg", "bn", "ca", "cs", "da", "de", "el", "en-GB", "en-US", "es", "es-419", "et", "fa",
        "fi", "fil", "fr", "gu", "he", "hi", "hr", "hu", "id", "it", "ja", "kn", "ko", "lt", "lv", "ml", "mr", "ms",
        "nb", "nl", "pl", "pt-BR", "pt-PT", "ro", "ru", "sk", "sl", "sr", "sv", "sw", "ta", "te", "th", "tr", "uk",
        "ur", "vi", "zh-CN", "zh-TW",
    ]
    private static let alias = ["iw": "he", "in": "id", "no": "nb", "nn": "nb", "tl": "fil"]

    /* The language Chromium would pick for these system languages, most
     * preferred first (Android's chromiumLocale); en-US when none fits. */
    static func chromiumLocale(_ tags: [String]) -> String {
        for tag in tags {
            let parts = tag.replacingOccurrences(of: "_", with: "-").split(separator: "-").map(String.init)
            guard let first = parts.first else { continue }
            let lang = alias[first.lowercased()] ?? first.lowercased()
            let script = parts.dropFirst().first { $0.count == 4 }?.lowercased()
            let region = parts.dropFirst().first { $0.count == 2 || ($0.count == 3 && $0.allSatisfy(\.isNumber)) }?.uppercased()
            if let region, chromium.contains("\(lang)-\(region)") { return "\(lang)-\(region)" }
            switch lang {
            case "zh": return script == "hant" || ["TW", "HK", "MO"].contains(region ?? "") ? "zh-TW" : "zh-CN"
            case "es": return region != nil && region != "ES" ? "es-419" : "es"
            case "pt": return region != nil && region != "BR" ? "pt-PT" : "pt-BR"
            case "en": return ["AU", "CA", "IN", "NZ", "ZA"].contains(region ?? "") ? "en-GB" : "en-US"
            default: break
            }
            if chromium.contains(lang) { return lang }
        }
        return "en-US"
    }
}
