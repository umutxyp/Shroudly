import CommonCrypto
import CryptoKit
import Foundation

/*
 * VLESS and Trojan for "Your own server": the Apple side of
 * electron/vless.js and Vless.kt, the same links and the same bytes (all
 * three are checked against tests/net/fixtures/vless-vectors.json).
 *
 * Both are a short header in front of the connection's own bytes:
 *   VLESS   0x00, the 16 bytes of the user's UUID, 0x00 (no additions),
 *           0x01 (TCP), the port, the address (1 IPv4, 2 a name with its
 *           length, 3 IPv6); the server answers 0x00, a length, that many
 *           bytes, then data.
 *   Trojan  the SHA-224 of the password in hex, CRLF, 0x01, the address as
 *           SOCKS5 writes it, the port, CRLF; only data comes back.
 * carried over plain TCP, a WebSocket (binary messages, masked on the way
 * up) or HTTPUpgrade, each with the system's TLS or without
 * (Tunnel/VlessClient.swift).
 *
 * Not carried: REALITY, the Vision flow, gRPC, XHTTP, mKCP, QUIC, VLESS's
 * own encryption, and allowInsecure (a server whose certificate cannot be
 * checked is not used here). A link that asks for one of these is told so
 * ("unsupported" with what), never tried another way.
 */
struct VlessLink: Equatable {
    var kind: String          // "vless" or "trojan"
    var host: String
    var port: Int
    var id = ""               // VLESS: the UUID, 32 hex digits
    var password = ""         // Trojan
    var net = "tcp"           // "tcp", "ws" or "httpupgrade"
    var tls = false
    var sni = ""
    var wsHost = ""
    var path = "/"
    var alpn: [String] = []
    var name = ""
}

enum Vless {
    static let nets = ["tcp", "ws", "httpupgrade"]
    static let wsGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
    static let wsMaxFrame = 16 * 1024 * 1024

    /* A link, or why not: "format", or "unsupported" with what (reality,
     * security, flow, encryption, transport, insecure). */
    struct Parsed: Equatable {
        var link: VlessLink?
        var error: String?
        var what: String?
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

    private static func plainName(_ s: String) -> Bool { match("^[A-Za-z0-9.\\-_:\\[\\]]{1,253}$", s) != nil }

    static func parse(_ input: String?) -> Parsed {
        let text = (input ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard let m = match("^(vless|trojan)://([^@/?#]+)@([^/?#]+)/?(?:\\?([^#]*))?(?:#(.*))?$", text, [.caseInsensitive]),
              let kindRaw = m[1], let secretRaw = m[2], let hp = hostPort(m[3] ?? "") else { return Parsed(link: nil, error: "format") }
        let kind = kindRaw.lowercased()
        // A "+" in the key is itself; in a value it is a space.
        guard let secret = secretRaw.removingPercentEncoding else { return Parsed(link: nil, error: "format") }
        let name = m[5].flatMap { $0.removingPercentEncoding } ?? ""
        var q: [String: String] = [:]
        for part in (m[4] ?? "").split(separator: "&", omittingEmptySubsequences: true) {
            let i = part.firstIndex(of: "=")
            let k = (i.map { String(part[..<$0]) } ?? String(part)).lowercased()
            let raw = i.map { String(part[part.index(after: $0)...]) } ?? ""
            guard let v = raw.replacingOccurrences(of: "+", with: " ").removingPercentEncoding else { return Parsed(link: nil, error: "format") }
            if q[k] == nil { q[k] = v }
        }
        func arg(_ keys: String...) -> String {
            for k in keys { if let v = q[k], !v.isEmpty { return v } }
            return ""
        }
        func no(_ what: String) -> Parsed { Parsed(link: nil, error: "unsupported", what: what) }
        let net = (arg("type", "net").isEmpty ? "tcp" : arg("type", "net")).lowercased()
        let security = (arg("security").isEmpty ? (kind == "trojan" ? "tls" : "none") : arg("security")).lowercased()
        if security == "reality" { return no("reality") }
        if security != "tls" && security != "none" { return no("security") }
        if !arg("flow").isEmpty { return no("flow") }
        if kind == "vless", !arg("encryption").isEmpty, arg("encryption").lowercased() != "none" { return no("encryption") }
        if !nets.contains(net) { return no("transport") }
        if net == "tcp", !arg("headertype").isEmpty, arg("headertype").lowercased() != "none" { return no("transport") }
        var link = VlessLink(kind: kind, host: hp.0, port: hp.1)
        if kind == "vless" {
            let id = secret.replacingOccurrences(of: "-", with: "").lowercased()
            guard match("^[0-9a-f]{32}$", id) != nil else { return Parsed(link: nil, error: "format") }
            link.id = id
        } else {
            guard !secret.isEmpty, secret.count <= 512, !secret.contains("\r"), !secret.contains("\n") else { return Parsed(link: nil, error: "format") }
            link.password = secret
        }
        let sni = arg("sni", "peer")
        let wsHost = arg("host")
        if (!sni.isEmpty && !plainName(sni)) || (!wsHost.isEmpty && !plainName(wsHost)) { return Parsed(link: nil, error: "format") }
        // The path as the server knows it: Xray's "?ed=2048" is its client's
        // own note (early data), not part of the path.
        var p = arg("path").isEmpty ? "/" : arg("path")
        if !p.hasPrefix("/") { p = "/" + p }
        if let re = try? NSRegularExpression(pattern: "([?&])ed=\\d+(&|$)"),
           let e = re.firstMatch(in: p, range: NSRange(p.startIndex..., in: p)), let whole = Range(e.range, in: p) {
            let lead = Range(e.range(at: 1), in: p).map { String(p[$0]) } ?? ""
            let tail = Range(e.range(at: 2), in: p).map { String(p[$0]) } ?? ""
            p.replaceSubrange(whole, with: tail.isEmpty ? "" : lead)
        }
        if p.hasSuffix("?") || p.hasSuffix("&") { p.removeLast() }
        if p.unicodeScalars.contains(where: { CharacterSet.whitespacesAndNewlines.contains($0) }) || p.count > 1024 { return Parsed(link: nil, error: "format") }
        if p.isEmpty { p = "/" }
        // A certificate that cannot be checked is not taken.
        if ["1", "true"].contains(arg("allowinsecure", "insecure").lowercased()) { return no("insecure") }
        link.net = net
        link.tls = security == "tls"
        link.sni = sni
        link.wsHost = wsHost
        link.path = p
        link.alpn = arg("alpn").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { match("^[A-Za-z0-9./-]{1,16}$", $0) != nil }
        link.name = name
        return Parsed(link: link)
    }

    /* What the screen and the log show: never the key. */
    static func describe(_ l: VlessLink) -> String {
        let place = l.host.contains(":") ? "[\(l.host)]:\(l.port)" : "\(l.host):\(l.port)"
        let how = (l.net == "ws" ? "WebSocket" : l.net == "httpupgrade" ? "HTTPUpgrade" : "TCP") + (l.tls ? " + TLS" : "")
        return "\(l.kind == "vless" ? "VLESS" : "Trojan") \(place) (\(how))"
    }

    /* The name a part of a link that is not carried goes by (the same in
     * every language). */
    static func unsupportedName(_ what: String?) -> String {
        switch what {
        case "reality": return "REALITY"
        case "flow": return "XTLS Vision"
        case "transport": return "gRPC / XHTTP / mKCP"
        case "encryption": return "VLESS Encryption"
        case "security": return "XTLS"
        case "insecure": return "allowInsecure"
        default: return what ?? ""
        }
    }

    // MARK: the headers

    static func ipv4Bytes(_ host: String) -> [UInt8]? {
        guard let m = match("^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$", host) else { return nil }
        let o = m.dropFirst().compactMap { $0.flatMap { Int($0) } }
        return o.count == 4 && o.allSatisfy { $0 <= 255 } ? o.map { UInt8($0) } : nil
    }

    /* "::" filled in, a trailing IPv4 part taken as its two groups; nil for
     * what is no IPv6 address. Never a lookup. */
    static func ipv6Bytes(_ host: String) -> [UInt8]? {
        guard host.contains(":") else { return nil }
        var h = host
        if let v4 = match("^(.*:)(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$", h) {
            let o = v4.dropFirst(2).compactMap { $0.flatMap { Int($0) } }
            guard o.count == 4, o.allSatisfy({ $0 <= 255 }) else { return nil }
            h = "\(v4[1] ?? "")\(String((o[0] << 8) | o[1], radix: 16)):\(String((o[2] << 8) | o[3], radix: 16))"
        }
        let halves = h.components(separatedBy: "::")
        guard halves.count <= 2 else { return nil }
        let a = halves[0].isEmpty ? [] : halves[0].components(separatedBy: ":")
        let b = halves.count == 2 && !halves[1].isEmpty ? halves[1].components(separatedBy: ":") : []
        let fill = halves.count == 2 ? 8 - a.count - b.count : 0
        guard fill >= 0, halves.count == 2 || a.count == 8 else { return nil }
        let groups = a + [String](repeating: "0", count: fill) + b
        guard groups.count == 8 else { return nil }
        var out: [UInt8] = []
        for g in groups {
            guard (1...4).contains(g.count), let v = UInt16(g, radix: 16) else { return nil }
            out += [UInt8(v >> 8), UInt8(v & 0xff)]
        }
        return out
    }

    private static func hexBytes(_ hex: String) -> [UInt8] {
        var out: [UInt8] = []
        var i = hex.startIndex
        while i < hex.endIndex, let j = hex.index(i, offsetBy: 2, limitedBy: hex.endIndex) {
            out.append(UInt8(hex[i..<j], radix: 16) ?? 0)
            i = j
        }
        return out
    }

    /* VLESS: what goes first on the connection, for a TCP connection to
     * host:port; nil for a name that cannot be written. */
    static func vlessHeader(idHex: String, host: String, port: Int) -> [UInt8]? {
        var o: [UInt8] = [0] + hexBytes(idHex) + [0, 1, UInt8((port >> 8) & 0xff), UInt8(port & 0xff)]
        if let v4 = ipv4Bytes(host) { o += [1] + v4 } else if let v6 = ipv6Bytes(host) { o += [3] + v6 } else {
            let n = Array(host.utf8)
            guard !n.isEmpty, n.count <= 255 else { return nil }
            o += [2, UInt8(n.count)] + n
        }
        return o
    }

    static func sha224Hex(_ text: String) -> String {
        let data = Array(text.utf8)
        var digest = [UInt8](repeating: 0, count: Int(CC_SHA224_DIGEST_LENGTH))
        _ = CC_SHA224(data, CC_LONG(data.count), &digest)
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    static func trojanHeader(password: String, host: String, port: Int) -> [UInt8]? {
        var o: [UInt8] = Array(sha224Hex(password).utf8) + [13, 10, 1]
        if let v4 = ipv4Bytes(host) { o += [1] + v4 } else if let v6 = ipv6Bytes(host) { o += [4] + v6 } else {
            let n = Array(host.utf8)
            guard !n.isEmpty, n.count <= 255 else { return nil }
            o += [3, UInt8(n.count)] + n
        }
        return o + [UInt8((port >> 8) & 0xff), UInt8(port & 0xff), 13, 10]
    }

    // MARK: WebSocket, the little of it a tunnel needs

    /* What a server answers to a key in the opening request. */
    static func wsAccept(_ key: String) -> String {
        Data(Insecure.SHA1.hash(data: Array((key + wsGuid).utf8))).base64EncodedString()
    }

    /* One binary message, masked (every client-to-server frame is). */
    static func wsFrame(_ data: [UInt8], opcode: UInt8 = 2) -> [UInt8] {
        let n = data.count
        var out: [UInt8] = [0x80 | opcode]
        if n < 126 { out.append(0x80 | UInt8(n)) } else if n < 65536 { out += [0x80 | 126, UInt8(n >> 8), UInt8(n & 0xff)] } else {
            out += [0x80 | 127, 0, 0, 0, 0, UInt8((n >> 24) & 0xff), UInt8((n >> 16) & 0xff), UInt8((n >> 8) & 0xff), UInt8(n & 0xff)]
        }
        var mask = [UInt8](repeating: 0, count: 4)
        if SecRandomCopyBytes(kSecRandomDefault, 4, &mask) != errSecSuccess { for i in 0..<4 { mask[i] = UInt8.random(in: 0...255) } }
        out += mask
        out.reserveCapacity(out.count + n)
        for i in 0..<n { out.append(data[i] ^ mask[i & 3]) }
        return out
    }

    struct BadFrame: Error {}

    /* Takes the server's bytes, gives back the payloads of its data frames
     * in order; onPing for a ping, closed set by a close frame. Throws on
     * what no server sends (a masked frame, a length beyond wsMaxFrame). */
    final class WsReader {
        private var buf: [UInt8] = []
        private let onPing: ([UInt8]) -> Void
        private(set) var closed = false

        init(onPing: @escaping ([UInt8]) -> Void = { _ in }) { self.onPing = onPing }

        func push(_ chunk: [UInt8]) throws -> [UInt8] {
            buf += chunk
            var out: [UInt8] = []
            var at = 0
            while !closed {
                let left = buf.count - at
                if left < 2 { break }
                let opcode = buf[at] & 0x0f
                if buf[at + 1] & 0x80 != 0 { throw BadFrame() }
                var n = Int(buf[at + 1] & 0x7f)
                var head = 2
                if n == 126 {
                    if left < 4 { break }
                    n = (Int(buf[at + 2]) << 8) | Int(buf[at + 3])
                    head = 4
                } else if n == 127 {
                    if left < 10 { break }
                    if buf[(at + 2)...(at + 5)].contains(where: { $0 != 0 }) || buf[at + 6] & 0x80 != 0 { throw BadFrame() }
                    n = (Int(buf[at + 6]) << 24) | (Int(buf[at + 7]) << 16) | (Int(buf[at + 8]) << 8) | Int(buf[at + 9])
                    head = 10
                }
                if n > Vless.wsMaxFrame { throw BadFrame() }
                if left < head + n { break }
                let from = at + head
                switch opcode {
                case 0, 1, 2: out += buf[from..<(from + n)]
                case 9: onPing(Array(buf[from..<(from + n)]))
                case 8: closed = true
                default: break
                }
                at = from + n
            }
            buf = at >= buf.count ? [] : Array(buf[at...])
            return out
        }
    }
}
