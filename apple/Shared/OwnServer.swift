import Foundation

/*
 * "Your own server" (Settings): a server the user names, which carries every
 * connection to a name (the engine's --upstream-file). In a shutdown, a
 * server inside the country whose own connection to the world still works is
 * the way out. The Apple side of electron/own-server.js and OwnServer.kt,
 * the same links:
 *   socks5://user:password@host:port   (user and password optional)
 *   http://user:password@host:port     (CONNECT; the same)
 *   ss://BASE64URL(method:password)@host:port#name   (SIP002)
 *   ss://BASE64(method:password@host:port)#name      (the older form)
 *   host:port                          (SOCKS5)
 * Shadowsocks goes through Shroudly's own client in the tunnel
 * (Tunnel/Shadowsocks.swift).
 */
struct OwnServerLink: Equatable {
    var kind: String          // "socks5", "http" or "ss"
    var host: String
    var port: Int
    var user = ""
    var pass = ""
    var method = ""
    var password = ""
    var name = ""
}

enum OwnServer {
    /* Shadowsocks methods and their key lengths (Tunnel/Shadowsocks.swift). */
    static let methods: [String: Int] = ["chacha20-ietf-poly1305": 32, "aes-256-gcm": 32, "aes-128-gcm": 16]

    /* A link, or why it cannot be used: empty, format, method, user. */
    struct Parsed: Equatable {
        var link: OwnServerLink?
        var error: String?
        var method: String?
    }

    private static func match(_ pattern: String, _ text: String, _ opts: NSRegularExpression.Options = []) -> [String?]? {
        guard let re = try? NSRegularExpression(pattern: pattern, options: opts),
              let m = re.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              m.range.location == 0, m.range.length == (text as NSString).length else { return nil }
        return (0..<m.numberOfRanges).map { i in
            let r = m.range(at: i)
            return r.location == NSNotFound ? nil : (text as NSString).substring(with: r)
        }
    }

    private static func hostPort(_ text: String) -> (String, Int)? {
        guard let m = match("^\\[([0-9a-fA-F:.]+)]:(\\d{1,5})$", text) ?? match("^([^\\s:/@\\[\\]]+):(\\d{1,5})$", text),
              let host = m[1], let p = m[2], let port = Int(p), (1...65535).contains(port) else { return nil }
        return (host, port)
    }

    private static func fromB64(_ s: String) -> String {
        var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while t.hasSuffix("=") { t.removeLast() }
        while t.count % 4 != 0 { t += "=" }
        guard let d = Data(base64Encoded: t), let str = String(data: d, encoding: .utf8) else { return "" }
        return str
    }

    /* Percent-decoding as a URL's user part has it ("+" stays "+"). */
    private static func decode(_ s: String) -> String? { s.removingPercentEncoding }

    static func parse(_ input: String?) -> Parsed {
        let text = (input ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return Parsed(link: nil, error: "empty") }
        if let m = match("^(socks5h?|socks|http)://(?:([^@/]*)@)?([^/?#]+)/?$", text, [.caseInsensitive]) {
            guard let hp = hostPort(m[3] ?? "") else { return Parsed(link: nil, error: "format") }
            var user = "", pass = ""
            if let info = m[2] {
                let parts = info.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false).map(String.init)
                guard let u = decode(parts[0]) else { return Parsed(link: nil, error: "format") }
                user = u
                if parts.count > 1 {
                    guard let p = decode(parts[1]) else { return Parsed(link: nil, error: "format") }
                    pass = p
                }
                if user.isEmpty || user.contains(where: { ":@\r\n".contains($0) }) || user.utf8.count > 255 || pass.utf8.count > 255
                    || pass.contains(where: { "\r\n".contains($0) }) {
                    return Parsed(link: nil, error: "user")
                }
            }
            let kind = (m[1] ?? "").lowercased() == "http" ? "http" : "socks5"
            return Parsed(link: OwnServerLink(kind: kind, host: hp.0, port: hp.1, user: user, pass: pass))
        }
        if let m = match("^ss://([^#]+)(?:#(.*))?$", text, [.caseInsensitive]) {
            let name = m[2].flatMap { decode($0) } ?? ""
            // Plugin options and the like ("/?plugin=…") are not used.
            var body = m[1] ?? ""
            if let q = body.firstIndex(of: "?") { body = String(body[..<q]) }
            while body.hasSuffix("/") { body.removeLast() }
            let method: String, password: String
            let hp: (String, Int)?
            if let at = body.lastIndex(of: "@"), at > body.startIndex {
                let raw = String(body[..<at])
                let info = decode(raw) ?? raw
                let plain = info.contains(":") ? info : fromB64(info)
                guard let i = plain.firstIndex(of: ":"), i > plain.startIndex else { return Parsed(link: nil, error: "format") }
                method = plain[..<i].lowercased()
                password = String(plain[plain.index(after: i)...])
                hp = hostPort(String(body[body.index(after: at)...]))
            } else {
                guard let mm = match("^([^:]+):(.*)@([^@]+)$", fromB64(body)) else { return Parsed(link: nil, error: "format") }
                method = (mm[1] ?? "").lowercased()
                password = mm[2] ?? ""
                hp = hostPort(mm[3] ?? "")
            }
            guard let hp, !password.isEmpty else { return Parsed(link: nil, error: "format") }
            guard methods[method] != nil else { return Parsed(link: nil, error: "method", method: method) }
            return Parsed(link: OwnServerLink(kind: "ss", host: hp.0, port: hp.1, method: method, password: password, name: name))
        }
        guard let hp = hostPort(text) else { return Parsed(link: nil, error: "format") }
        return Parsed(link: OwnServerLink(kind: "socks5", host: hp.0, port: hp.1))
    }

    private static func place(_ l: OwnServerLink) -> String { l.host.contains(":") ? "[\(l.host)]:\(l.port)" : "\(l.host):\(l.port)" }

    /* What the screen and the log show: never the password. */
    static func describe(_ l: OwnServerLink) -> String {
        switch l.kind {
        case "ss": return "Shadowsocks \(place(l))"
        case "http": return "HTTP \(place(l))"
        default: return "SOCKS5 \(place(l))"
        }
    }

    /* The engine's --upstream-file line: the server, or for Shadowsocks the
     * tunnel's own client on 127.0.0.1:localPort with its user and password. */
    static func engineLine(_ l: OwnServerLink, localPort: Int = 0, auth: SocksAuth? = nil) -> String {
        if l.kind == "ss" { return "socks5://\(auth.map { "\($0.user):\($0.pass)@" } ?? "")127.0.0.1:\(localPort)" }
        let cred = l.user.isEmpty ? "" : "\(l.user)\(l.pass.isEmpty ? "" : ":\(l.pass)")@"
        return "\(l.kind)://\(cred)\(place(l))"
    }

    /* The link as typed, its password hidden: ss://••••@host:port, or the
     * user's password in the others (the screen shows this, never the
     * password itself). */
    static func masked(_ typed: String) -> String {
        let t = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        if let at = t.lastIndex(of: "@"), let scheme = t.range(of: "://") {
            if t.lowercased().hasPrefix("ss://") { return "ss://••••\(t[at...])" }
            let info = t[scheme.upperBound..<at]
            if let colon = info.firstIndex(of: ":") { return "\(t[..<scheme.upperBound])\(info[..<colon]):••••\(t[at...])" }
            return t
        }
        if t.lowercased().hasPrefix("ss://") { return "ss://••••" }
        return t
    }

    /* The engine's --upstream-file, readable by this process alone (0600
     * from the start); read once at the engine's start, then deleted. */
    static func writeFile(_ line: String, to path: String) throws {
        unlink(path)
        let fd = open(path, O_CREAT | O_EXCL | O_WRONLY, 0o600)
        guard fd >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        defer { close(fd) }
        let data = Array((line + "\n").utf8)
        guard Darwin.write(fd, data, data.count) == data.count else { throw POSIXError(.EIO) }
    }

    /* Where the tunnel tells the app that the server failed (the app group's
     * defaults): its reason, when, and which server. */
    enum Down {
        static let why = "ownServerDownWhy"
        static let at = "ownServerDownAt"
        static let server = "ownServerDownServer"
        /* Shown this long after the engine last said so (as on the desktop). */
        static let shownFor: TimeInterval = 90
    }

    /* Why a server could not be used, as the engine says it (engine.c,
     * upstream_report); the screen translates the code. */
    static let why: [String: String] = [
        "does not answer": "noAnswer",
        "refused the user name or password": "auth",
        "asks for a user name and password": "asks",
        "refused the connection": "refused",
        "does not speak the protocol chosen": "protocol",
    ]

    static func whyCode(_ text: String?) -> String { text.flatMap { why[$0] } ?? "protocol" }

    static func whyKey(_ code: String?) -> String {
        switch code {
        case "noAnswer": return "ownServerWhyNoAnswer"
        case "auth": return "ownServerWhyAuth"
        case "asks": return "ownServerWhyAsks"
        case "refused": return "ownServerWhyRefused"
        case "silent": return "ownServerWhySilent"
        case "tls": return "ownServerWhyTls"
        default: return "ownServerWhyProtocol"
        }
    }

    /* The reason a link cannot be used, as the screen says it. */
    static func errorKey(_ error: String?) -> String {
        switch error {
        case "method": return "ownServerErrMethod"
        case "user": return "ownServerErrUser"
        default: return "ownServerErrFormat"
        }
    }

    /* The texts themselves. Each key is named here as tr("…") so that
     * scripts/gen-strings.js, which collects the keys the sources name,
     * puts every one of them into the app. */
    static func whyText(_ code: String?) -> String {
        switch whyKey(code) {
        case "ownServerWhyNoAnswer": return tr("ownServerWhyNoAnswer")
        case "ownServerWhyAuth": return tr("ownServerWhyAuth")
        case "ownServerWhyAsks": return tr("ownServerWhyAsks")
        case "ownServerWhyRefused": return tr("ownServerWhyRefused")
        case "ownServerWhySilent": return tr("ownServerWhySilent")
        case "ownServerWhyTls": return tr("ownServerWhyTls")
        default: return tr("ownServerWhyProtocol")
        }
    }

    static func errorText(_ error: String?, method: String?) -> String {
        switch errorKey(error) {
        case "ownServerErrMethod": return tr("ownServerErrMethod", ["method": method ?? ""])
        case "ownServerErrUser": return tr("ownServerErrUser")
        default: return tr("ownServerErrFormat")
        }
    }
}
