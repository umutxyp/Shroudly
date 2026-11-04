import Foundation
import Network

/*
 * A DNS server of the user's own (Settings, "DNS server", issue #34), in
 * place of the built-in encrypted routes: Android's CustomDns.kt, the
 * desktop's electron/custom-dns.js.
 *
 *   doh   https://host:port/path   DNS over HTTPS (HTTP/1.1)
 *   dot   host:port, 853 if none   DNS over TLS
 *   tcp   host:port, 53 if none    plain DNS over TCP, where a network
 *                                  blocks or forges UDP port 53
 *   udp   host:port, 53 if none    plain DNS
 *
 * DoH and DoT go through the engine when it is up (the name in the
 * handshake is split like any other site's), plain DNS straight out; with
 * the user's own server everything goes through the engine, plain DNS over
 * TCP (issue #67). A server given by name is looked up through the built-in
 * encrypted routes (bootstrap), never the network's DNS, and connected to by
 * address, its certificate checked against the name. Nothing is logged or
 * stored. One connection per question: lookups are few, the engine caches.
 */
struct DnsSpec: Equatable {
    let kind: String
    let host: String
    let port: Int
    var path: String = ""
}

enum CustomDns {
    static let kinds = ["doh", "dot", "tcp", "udp"]
    static let ports = ["doh": 443, "dot": 853, "tcp": 53, "udp": 53]
    /* What each kind's field shows, and its error messages say (Android's). */
    static let examples = ["doh": "https://dns.google/dns-query", "dot": "dns.quad9.net", "tcp": "8.8.8.8", "udp": "1.1.1.1"]
    static let timeout: TimeInterval = 2.5
    static let udpResend: TimeInterval = 0.8
    /* Not answering twice in a row: the built-in routes answer this long. */
    static let rest: TimeInterval = 30

    enum Key {
        static let kind = "customDnsKind"
        static let server = "customDnsServer"
        static let strict = "customDnsStrict"
    }

    /* The server in use, or nil (automatic, or one that cannot be used). */
    static func current(_ d: UserDefaults = AppGroup.defaults) -> DnsSpec? {
        guard let k = d.string(forKey: Key.kind), let t = d.string(forKey: Key.server) else { return nil }
        return parse(k, t).spec
    }

    static func strict(_ d: UserDefaults = AppGroup.defaults) -> Bool { current(d) != nil && d.bool(forKey: Key.strict) }

    /* An IPv4 or IPv6 address as typed (no lookup is made). */
    static func isIp(_ h: String) -> Bool {
        let s = h.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        return IPv4Address(s) != nil || (s.contains(":") && IPv6Address(s) != nil)
    }

    private static func hostOk(_ h: String) -> Bool {
        if isIp(h) { return true }
        guard h.range(of: "^[0-9.]+$", options: .regularExpression) == nil else { return false }
        return h.range(of: "^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$",
                       options: [.regularExpression, .caseInsensitive]) != nil
    }

    /* What the user typed for `kind`: the server, or what is wrong ("kind",
     * "empty", "url", "host", "port"), as on Android and the desktop. */
    static func parse(_ kind: String, _ text: String) -> (spec: DnsSpec?, error: String?) {
        guard kinds.contains(kind) else { return (nil, "kind") }
        var s = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return (nil, "empty") }
        let hasScheme = s.range(of: "^[a-z]+://", options: [.regularExpression, .caseInsensitive]) != nil
        if kind == "doh" {
            guard let u = URLComponents(string: hasScheme ? s : "https://\(s)"), u.scheme?.lowercased() == "https",
                  u.user == nil, u.password == nil else { return (nil, "url") }
            guard let rawHost = u.host, !rawHost.isEmpty else { return (nil, "host") }
            let host = rawHost.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
            guard hostOk(host) else { return (nil, "host") }
            let port = u.port ?? 443
            guard (1...65535).contains(port) else { return (nil, "port") }
            let p = u.percentEncodedPath
            let path = (p.isEmpty || p == "/" ? "/dns-query" : p) + (u.percentEncodedQuery.map { "?\($0)" } ?? "")
            return (DnsSpec(kind: kind, host: host, port: port, path: path), nil)
        }
        let scheme = ["dot": "^(tls|dot)://", "tcp": "^tcp://", "udp": "^(udp|dns)://"][kind]!
        if let r = s.range(of: scheme, options: [.regularExpression, .caseInsensitive]) { s.removeSubrange(r) }
        while s.hasSuffix("/") { s.removeLast() }
        if s.range(of: "^[a-z]+://", options: [.regularExpression, .caseInsensitive]) != nil { return (nil, "url") }
        var host = s
        var port = ports[kind]!
        if let m = s.range(of: "^\\[([^\\]]+)\\](:[0-9]+)?$", options: .regularExpression), m == s.startIndex..<s.endIndex {
            let close = s.firstIndex(of: "]")!
            host = String(s[s.index(after: s.startIndex)..<close])
            let rest = s[s.index(after: close)...]
            if rest.hasPrefix(":") { port = Int(rest.dropFirst()) ?? -1 }
        } else if s.filter({ $0 == ":" }).count == 1 {
            let parts = s.split(separator: ":", omittingEmptySubsequences: false)
            host = String(parts[0])
            port = Int(parts[1]) ?? -1
        }
        guard (1...65535).contains(port) else { return (nil, "port") }
        guard hostOk(host) else { return (nil, "host") }
        return (DnsSpec(kind: kind, host: host, port: port), nil)
    }

    /* The locale key of a parse error's message. */
    static func errorKey(_ e: String) -> String {
        ["empty": "dnsErrorEmpty", "url": "dnsErrorUrl", "host": "dnsErrorHost", "port": "dnsErrorPort"][e] ?? "dnsErrorUrl"
    }
}

/* One server's client. bootstrap: the server's IPv4 address by name, through
 * the built-in routes; engine: the engine's path while it runs; carried:
 * the user's own server is in use (everything through the engine). */
final class CustomDnsClient: @unchecked Sendable {
    let spec: DnsSpec
    private let bootstrap: (String) async -> String?
    private let engine: () -> EngineHTTPS.Path?
    private let carried: () -> Bool
    private let lock = NSLock()
    private var ip: String?
    private var ipAt = Date.distantPast
    private var fails = 0
    private var restUntil = Date.distantPast

    init(_ spec: DnsSpec, bootstrap: @escaping (String) async -> String?,
         engine: @escaping () -> EngineHTTPS.Path? = { nil }, carried: @escaping () -> Bool = { false }) {
        self.spec = spec
        self.bootstrap = bootstrap
        self.engine = engine
        self.carried = carried
    }

    /* Resting after failing twice in a row: the built-in routes answer. */
    var resting: Bool { lock.lock(); defer { lock.unlock() }; return Date() < restUntil }

    private var name: String? { CustomDns.isIp(spec.host) ? nil : spec.host }

    private func address() async throws -> String {
        if name == nil { return spec.host.trimmingCharacters(in: CharacterSet(charactersIn: "[]")) }
        lock.lock()
        if let ip, Date().timeIntervalSince(ipAt) < 600 { lock.unlock(); return ip }
        lock.unlock()
        guard let got = await bootstrap(spec.host) else { throw URLError(.cannotFindHost) }
        lock.lock(); ip = got; ipAt = Date(); lock.unlock()
        return got
    }

    /* The server's answer to one query (under the query's id), or throws. */
    func query(_ msg: [UInt8]) async throws -> [UInt8] {
        do {
            let a = try await withThrowingTaskGroup(of: [UInt8].self) { group in
                group.addTask { try await self.ask(msg) }
                group.addTask {
                    try await Task.sleep(nanoseconds: UInt64(CustomDns.timeout * 1e9))
                    throw URLError(.timedOut)
                }
                let first = try await group.next()!
                group.cancelAll()
                return first
            }
            lock.lock(); fails = 0; lock.unlock()
            return a
        } catch {
            lock.lock()
            fails += 1
            if fails >= 2 { restUntil = Date().addingTimeInterval(CustomDns.rest); fails = 0 }
            lock.unlock()
            throw error
        }
    }

    private func ask(_ msg: [UInt8]) async throws -> [UInt8] {
        let t = CustomDns.timeout
        let addr = try await address()
        let carried = self.carried()
        let path = engine()
        if carried && path == nil { throw URLError(.notConnectedToInternet) }   // waiting for the engine
        // Plain DNS through the engine (own server): over TCP, which it carries.
        let kind = carried && spec.kind == "udp" ? "tcp" : spec.kind
        if kind == "udp" { return try await udp(msg, addr) }
        let via: EngineHTTPS.Path? = kind == "tcp" ? (carried ? path : nil) : path
        let stream: EngineHTTPS.Stream
        do {
            stream = try await EngineHTTPS.open(addr, port: spec.port, via: addr.contains(":") && !carried ? nil : via,
                                                timeout: t, name: name ?? addr, tls: kind != "tcp")
        } catch is EngineHTTPS.Unsupported {
            if carried { throw URLError(.notConnectedToInternet) }
            stream = try await EngineHTTPS.open(addr, port: spec.port, via: nil, timeout: t, name: name ?? addr, tls: kind != "tcp")
        }
        defer { stream.close() }
        if kind == "doh" {
            let h = spec.host.contains(":") ? "[\(spec.host)]" : spec.host
            let head = "POST \(spec.path) HTTP/1.1\r\nHost: \(h)\r\nContent-Type: application/dns-message\r\n" +
                "Accept: application/dns-message\r\nContent-Length: \(msg.count)\r\nConnection: close\r\n\r\n"
            try await stream.write(Data(head.utf8) + Data(msg), timeout: t)
            var got = [UInt8]()
            while true {
                let (d, eof) = try await stream.read(max: 16_384, timeout: t)
                if let d { got += d }
                if let body = Http1.body(got, ended: eof) {
                    guard let a = Dns.matchAnswer(query: msg, answer: body) else { throw URLError(.badServerResponse) }
                    return a
                }
                guard !eof, got.count < 70_000 else { throw URLError(.badServerResponse) }
            }
        }
        // DoT and TCP: two bytes of length before each message.
        try await stream.write(Data([UInt8(msg.count >> 8), UInt8(msg.count & 0xff)] + msg), timeout: t)
        var got = [UInt8]()
        while true {
            let (d, eof) = try await stream.read(max: 16_384, timeout: t)
            if let d { got += d }
            // An answer to an earlier question that timed out may come first.
            while got.count >= 2 {
                let n = Int(got[0]) << 8 | Int(got[1])
                guard got.count >= 2 + n else { break }
                let body = Array(got[2..<(2 + n)])
                got.removeFirst(2 + n)
                if let a = Dns.matchAnswer(query: msg, answer: body) { return a }
            }
            if eof { throw URLError(.networkConnectionLost) }
        }
    }

    /* Plain DNS over UDP, sent again once after udpResend. */
    private func udp(_ msg: [UInt8], _ addr: String) async throws -> [UInt8] {
        let c = NWConnection(host: NWEndpoint.Host(addr), port: NWEndpoint.Port(rawValue: UInt16(spec.port))!, using: .udp)
        let q = DispatchQueue(label: "me.codeshare.shroudly.dns-udp")
        defer { c.cancel() }
        return try await withCheckedThrowingContinuation { (k: CheckedContinuation<[UInt8], Error>) in
            let lock = NSLock()
            var done = false
            func finish(_ r: Result<[UInt8], Error>) {
                lock.lock(); let first = !done; done = true; lock.unlock()
                if first { k.resume(with: r) }
            }
            func receive() {
                c.receiveMessage { data, _, _, error in
                    if let data, let a = Dns.matchAnswer(query: msg, answer: [UInt8](data)) { return finish(.success(a)) }
                    if error == nil { receive() }
                }
            }
            c.stateUpdateHandler = { state in
                if case .ready = state {
                    c.send(content: Data(msg), completion: .idempotent)
                    receive()
                    q.asyncAfter(deadline: .now() + CustomDns.udpResend) { c.send(content: Data(msg), completion: .idempotent) }
                } else if case .failed(let e) = state { finish(.failure(e)) }
            }
            c.start(queue: q)
            q.asyncAfter(deadline: .now() + CustomDns.timeout) { finish(.failure(URLError(.timedOut))) }
        }
    }
}
