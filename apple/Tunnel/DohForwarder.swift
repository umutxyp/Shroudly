import Foundation
import Security

/*
 * Local DNS-over-HTTPS forwarder, the Apple side of the desktop's
 * electron/doh-forwarder.js and Android's DohForwarder.kt.
 *
 * The engine sends its lookups to 127.0.0.1:<port> (--doh-port) as plain DNS
 * over UDP; each one goes out as an RFC 8484 POST to public resolvers, so
 * names are encrypted on the wire and cannot be forged. The packet tunnel's
 * own connections never go through its tunnel, so these go straight out.
 *
 * No single resolver is relied on: five operators, by address, with no name
 * in the handshake (a filter has to know and block every address), over IPv4
 * and IPv6. URLSession speaks HTTP/2 and keeps connections open. A lookup
 * races the best route alone, then the next two, then three more at a time,
 * until one answers; routes that fail rest with a growing back-off, fast ones
 * go first, and the one that last worked is remembered.
 *
 * The engine waits engineWait for an answer and then asks plain DNS itself,
 * so a lookup is answered by answerBy or gets "no route" (Dns.noRouteReply),
 * which sends the engine on at once. No lookup is logged or stored.
 *
 * With the user's own server, DNS goes where everything else goes (issue
 * #67): every question through the engine's SOCKS5 port (this session's
 * user and password) and on through that server, TLS started on that
 * stream, so resolvers see the server's address, never this device's
 * connection; and nothing straight out while the engine is not up.
 */
final class DohForwarder: NSObject, URLSessionDelegate, @unchecked Sendable {
    struct Route {
        let id: String
        let op: String
        /* An IPv4 or IPv6 address, without brackets. */
        let ip: String
        /* Names the certificate may carry instead of the address. */
        let names: [String]
        var ewma: TimeInterval = 0
        var fails = 0
        var restUntil = Date.distantPast

        var url: URL { URL(string: "https://\(ip.contains(":") ? "[\(ip)]" : ip)/dns-query")! }
    }

    static let queryTimeout: TimeInterval = 2.5
    static let secondWave: TimeInterval = 0.25
    static let thirdWave: TimeInterval = 0.9
    static let nextWave: TimeInterval = 0.65
    static let waveSize = 3
    static let restBase: TimeInterval = 2
    static let restMax: TimeInterval = 300
    /* The engine's own wait (core/src/doh.c FWD_WAIT_MS), and our answer's deadline. */
    static let engineWait: TimeInterval = 4
    static let answerBy: TimeInterval = engineWait - 0.2

    private static let cloudflare = ["cloudflare-dns.com", "one.one.one.one"]
    private static let google = ["dns.google"]
    private static let adguard = ["unfiltered.adguard-dns.com", "dns.adguard-dns.com"]
    private static let opendns = ["doh.opendns.com", "dns.opendns.com"]
    private static let dnssb = ["doh.sb", "dns.sb"]

    static func routes() -> [Route] {
        [
            Route(id: "cloudflare-1", op: "cloudflare", ip: "1.1.1.1", names: cloudflare),
            Route(id: "google-1", op: "google", ip: "8.8.8.8", names: google),
            Route(id: "adguard-1", op: "adguard", ip: "94.140.14.140", names: adguard),
            Route(id: "opendns-1", op: "opendns", ip: "208.67.222.222", names: opendns),
            Route(id: "dnssb-1", op: "dnssb", ip: "185.222.222.222", names: dnssb),
            Route(id: "cloudflare-2", op: "cloudflare", ip: "1.0.0.1", names: cloudflare),
            Route(id: "google-2", op: "google", ip: "8.8.4.4", names: google),
            Route(id: "adguard-2", op: "adguard", ip: "94.140.14.141", names: adguard),
            Route(id: "opendns-2", op: "opendns", ip: "208.67.220.220", names: opendns),
            Route(id: "dnssb-2", op: "dnssb", ip: "45.11.45.11", names: dnssb),
            Route(id: "cloudflare-3", op: "cloudflare", ip: "162.159.36.1", names: cloudflare),
            Route(id: "cloudflare-4", op: "cloudflare", ip: "162.159.46.1", names: cloudflare),
            // The same operators over IPv6, last among equals: these rest
            // after failing once where the network has no IPv6.
            Route(id: "cloudflare-6a", op: "cloudflare", ip: "2606:4700:4700::1111", names: cloudflare),
            Route(id: "google-6a", op: "google", ip: "2001:4860:4860::8888", names: google),
            Route(id: "adguard-6a", op: "adguard", ip: "2a10:50c0::1:ff", names: adguard),
            Route(id: "opendns-6a", op: "opendns", ip: "2620:119:35::35", names: opendns),
            Route(id: "cloudflare-6b", op: "cloudflare", ip: "2606:4700:4700::1001", names: cloudflare),
            Route(id: "google-6b", op: "google", ip: "2001:4860:4860::8844", names: google),
        ]
    }

    /* When the i-th route of a plan is asked, from the start of the lookup. */
    static func startDelay(_ i: Int) -> TimeInterval {
        if i == 0 { return 0 }
        if i <= 2 { return secondWave }
        return thirdWave + TimeInterval((i - 3) / waveSize) * nextWave
    }

    /* The order to try routes in: the remembered one, then measured speed
     * (untried counts as average), resting routes last; then the best of
     * another operator moves up to second. Everything resting: the three
     * that wake soonest. */
    /* Google's own names: images in Google Docs, YouTube's videos and
     * thumbnails, Google's static files. Google's resolver sends the asking
     * network's subnet on to Google's name servers (ECS), so they answer with
     * the servers close to the user; the others answer for wherever their own
     * server stands. As the desktop (electron/doh-forwarder.js) and Android. */
    static let googleDomains = ["google.com", "googleusercontent.com", "gstatic.com", "googleapis.com", "ggpht.com",
                         "googlevideo.com", "ytimg.com", "youtube.com", "youtu.be", "gvt1.com", "gvt2.com", "1e100.net"]
    static func googleName(_ name: String) -> Bool {
        var n = name.lowercased()
        if n.hasSuffix(".") { n.removeLast() }
        return !n.isEmpty && googleDomains.contains { n == $0 || n.hasSuffix("." + $0) }
    }

    /* The question's name in a DNS message, or "". */
    static func questionName(_ m: [UInt8]) -> String {
        var labels: [String] = []
        var p = 12
        while p < m.count, m[p] > 0, m[p] < 64, p + 1 + Int(m[p]) <= m.count {
            labels.append(String(decoding: m[(p + 1)..<(p + 1 + Int(m[p]))], as: UTF8.self))
            p += 1 + Int(m[p])
        }
        return labels.joined(separator: ".")
    }

    /* The quickest Google route that is not resting, to go first. */
    static func googleFirst(_ all: [Route], now: Date) -> String? {
        all.filter { $0.op == "google" && $0.restUntil <= now }.min { ($0.ewma > 0 ? $0.ewma : 0.4) < ($1.ewma > 0 ? $1.ewma : 0.4) }?.id
    }

    static func plan(_ all: [Route], preferred: String?, now: Date) -> [Route] {
        func score(_ r: Route) -> TimeInterval {
            r.restUntil > now ? 1_000_000 + r.restUntil.timeIntervalSince(now) : (r.ewma > 0 ? r.ewma : 0.4)
        }
        let ordered = all.sorted { a, b in
            let pa = a.id == preferred && a.restUntil <= now
            let pb = b.id == preferred && b.restUntil <= now
            if pa != pb { return pa }
            return score(a) < score(b)
        }
        let awake = ordered.filter { $0.restUntil <= now }
        var plan = awake.isEmpty ? Array(ordered.prefix(3)) : awake
        if plan.count > 2, let i = plan.indices.dropFirst().first(where: { plan[$0].op != plan[0].op }) {
            plan.insert(plan.remove(at: i), at: 1)
        }
        return plan
    }

    private let log: (String) -> Void
    private let defaults: UserDefaults
    private let lock = NSLock()
    private var routes = DohForwarder.routes()
    private var preferred: String?
    private var fd: Int32 = -1
    private var stopped = false
    private var session: URLSession!
    /* The engine's port and this session's password, for throughEngine. */
    struct EnginePath: Equatable {
        let port: Int
        let user: String
        let pass: String
    }
    private var carried = false
    private var engine: EnginePath?
    private let trust = EngineTrust()
    private lazy var streamSession: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil
        config.httpCookieStorage = nil
        config.urlCredentialStorage = nil
        config.connectionProxyDictionary = [:]
        return URLSession(configuration: config, delegate: trust, delegateQueue: nil)
    }()

    // "DNS server" (Shared/CustomDns.swift): asked first when set; the
    // engine's path for it whenever the engine runs, own server or not.
    private var custom: CustomDnsClient?
    private var customStrict = false
    private var running: EnginePath?

    func useCustom(_ spec: DnsSpec?, strict: Bool) {
        let c = spec.map { spec in
            CustomDnsClient(spec, bootstrap: { [weak self] name in await self?.lookupBuiltIn(name) },
                            engine: { [weak self] in
                                guard let self else { return nil }
                                self.lock.lock(); defer { self.lock.unlock() }
                                return self.running.map { EngineHTTPS.Path(port: $0.port, user: $0.user, pass: $0.pass) }
                            },
                            carried: { [weak self] in
                                guard let self else { return false }
                                self.lock.lock(); defer { self.lock.unlock() }
                                return self.carried
                            })
        }
        lock.lock(); custom = c; customStrict = strict && c != nil; lock.unlock()
    }

    /* The engine's port and password while it runs (nil when it stops). */
    func engineUp(_ path: EnginePath?) {
        lock.lock(); running = path; lock.unlock()
    }

    /* A name's IPv4 address through the built-in routes only (the user's
     * server's own name: never the network's DNS, never itself). */
    func lookupBuiltIn(_ name: String) async -> String? {
        let q = Dns.query(name, type: 1, id: UInt16.random(in: 1...0xfffe))
        return Dns.addressesV4(await resolveBuiltIn(q)).first
    }

    /* on: a server of the user's own is set; path: the engine, once up. */
    func throughEngine(_ on: Bool, _ path: EnginePath?) {
        lock.lock(); defer { lock.unlock() }
        carried = on
        engine = on ? path : nil
    }

    init(log: @escaping (String) -> Void, defaults: UserDefaults = AppGroup.defaults) {
        self.log = log
        self.defaults = defaults
        super.init()
        preferred = defaults.string(forKey: "dohPreferred")
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = DohForwarder.queryTimeout
        config.timeoutIntervalForResource = DohForwarder.queryTimeout
        config.httpMaximumConnectionsPerHost = 2
        config.urlCache = nil
        config.httpCookieStorage = nil
        config.urlCredentialStorage = nil
        config.connectionProxyDictionary = [:]
        config.waitsForConnectivity = false
        session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }

    /* Opens the forwarder's port on 127.0.0.1 and starts answering. */
    func start() throws -> Int {
        let s = socket(AF_INET, SOCK_DGRAM, 0)
        guard s >= 0 else { throw POSIXError(.EIO) }
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        let bound = withUnsafeMutablePointer(to: &addr) { p in
            p.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(s, $0, len) == 0 && getsockname(s, $0, &len) == 0 }
        }
        guard bound else { Darwin.close(s); throw POSIXError(.EADDRINUSE) }
        // Wake every half second to notice stop().
        var tv = timeval(tv_sec: 0, tv_usec: 500_000)
        setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        lock.lock(); fd = s; stopped = false; lock.unlock()
        let t = Thread { [weak self] in self?.receive(s) }
        t.name = "doh"
        t.start()
        return Int(UInt16(bigEndian: addr.sin_port))
    }

    func stop() {
        lock.lock()
        stopped = true
        lock.unlock()
        session.invalidateAndCancel()
    }

    private func receive(_ s: Int32) {
        var buf = [UInt8](repeating: 0, count: 4096)
        while true {
            lock.lock(); let done = stopped; lock.unlock()
            if done { break }
            var from = sockaddr_storage()
            var fromLen = socklen_t(MemoryLayout<sockaddr_storage>.size)
            let n = withUnsafeMutablePointer(to: &from) { p in
                p.withMemoryRebound(to: sockaddr.self, capacity: 1) { recvfrom(s, &buf, buf.count, 0, $0, &fromLen) }
            }
            if n <= 0 { continue }
            let query = Array(buf[0..<n])
            guard Dns.isQuery(query) else { continue }
            let client = from
            Task { [weak self] in
                guard let self else { return }
                let reply = await self.resolve(query)
                self.send(reply, to: client, len: fromLen, on: s)
            }
        }
        Darwin.close(s)
    }

    private func send(_ reply: [UInt8], to client: sockaddr_storage, len: socklen_t, on s: Int32) {
        lock.lock(); let done = stopped; lock.unlock()
        if done { return }
        var to = client
        _ = withUnsafeMutablePointer(to: &to) { p in
            p.withMemoryRebound(to: sockaddr.self, capacity: 1) { sendto(s, reply, reply.count, 0, $0, len) }
        }
    }

    private enum Outcome { case answer([UInt8], String), failed, deadline }

    private func currentPlan(google: Bool = false) -> [Route] {
        lock.lock(); defer { lock.unlock() }
        let now = Date()
        let usable = carried ? routes.filter { !$0.ip.contains(":") } : routes
        let first = google ? (DohForwarder.googleFirst(usable, now: now) ?? preferred) : preferred
        let plan = DohForwarder.plan(routes, preferred: first, now: now)
        // Through the engine: the IPv4 routes, which its SOCKS5 port takes.
        return carried ? plan.filter { !$0.ip.contains(":") } : plan
    }

    /* The answer to one query, or "no route": the user's DNS server first
     * when one is set (alone with "Only this server"), else the built-in
     * routes. */
    func resolve(_ query: [UInt8]) async -> [UInt8] {
        lock.lock()
        let c = custom, strict = customStrict
        lock.unlock()
        if let c, strict || !c.resting {
            if let a = try? await c.query(query) { return a }
            if strict { return Dns.noRouteReply(query) ?? query }
        }
        return await resolveBuiltIn(query)
    }

    private func resolveBuiltIn(_ query: [UInt8]) async -> [UInt8] {
        let noRoute = Dns.noRouteReply(query) ?? query
        // A server of the user's own, the engine not up yet: "no route" at
        // once, so the engine does not wait; nothing straight out.
        lock.lock()
        let waiting = carried && engine == nil
        lock.unlock()
        if waiting { return noRoute }
        let google = DohForwarder.googleName(DohForwarder.questionName(query))
        let plan = currentPlan(google: google)
        // RFC 8484: ID 0, so caches along the way can share the answer.
        var wire = query
        wire[0] = 0; wire[1] = 0
        return await withTaskGroup(of: Outcome.self) { group in
            var asked = 0
            for (i, r) in plan.enumerated() {
                let delay = DohForwarder.startDelay(i)
                if delay >= DohForwarder.answerBy - 0.5 { break }
                asked += 1
                group.addTask { [self] in
                    if delay > 0 {
                        do { try await Task.sleep(nanoseconds: UInt64(delay * 1e9)) } catch { return .failed }
                    }
                    return await ask(r, wire, query)
                }
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: UInt64(DohForwarder.answerBy * 1e9))
                return .deadline
            }
            var failed = 0
            for await outcome in group {
                switch outcome {
                case .answer(let a, let id):
                    group.cancelAll()
                    // A Google name answered by Google says nothing about
                    // the best route for every other name.
                    if !google { remember(id) }
                    return a
                case .failed:
                    failed += 1
                    if failed >= asked { group.cancelAll(); return noRoute }
                case .deadline:
                    group.cancelAll()
                    return noRoute
                }
            }
            return noRoute
        }
    }

    private func ask(_ r: Route, _ wire: [UInt8], _ query: [UInt8]) async -> Outcome {
        lock.lock()
        let carried = self.carried, path = engine
        lock.unlock()
        if carried {
            // Not up yet, or an IPv6 route (its SOCKS5 port takes IPv4
            // here): nothing, and the route is not held against it.
            guard let path, !r.ip.contains(":") else { return .failed }
            return await viaEngine(r, wire, query, path)
        }
        var req = URLRequest(url: r.url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: DohForwarder.queryTimeout)
        req.httpMethod = "POST"
        req.setValue("application/dns-message", forHTTPHeaderField: "Content-Type")
        req.setValue("application/dns-message", forHTTPHeaderField: "Accept")
        req.httpBody = Data(wire)
        let began = Date()
        do {
            let (data, response) = try await session.data(for: req)
            guard (response as? HTTPURLResponse)?.statusCode == 200,
                  let answer = Dns.matchAnswer(query: query, answer: Array(data)) else {
                failed(r.id)
                return .failed
            }
            succeeded(r.id, Date().timeIntervalSince(began))
            return .answer(answer, r.id)
        } catch {
            if !Task.isCancelled { failed(r.id) }
            return .failed
        }
    }

    /* One question through the engine: SOCKS5 with this session's
     * password to the resolver's address, TLS on that stream (checked
     * against the resolver's address or names, EngineTrust), HTTP/1.1. */
    private func viaEngine(_ r: Route, _ wire: [UInt8], _ query: [UInt8], _ e: EnginePath) async -> Outcome {
        let began = Date()
        let t = DohForwarder.queryTimeout
        let task = streamSession.streamTask(withHostName: "127.0.0.1", port: e.port)
        trust.expect(task.taskIdentifier, ip: r.ip, names: r.names)
        task.resume()
        defer { trust.forget(task.taskIdentifier); task.cancel() }
        do {
            let user = Array(e.user.utf8), pass = Array(e.pass.utf8)
            let addr = r.ip.split(separator: ".").compactMap { UInt8($0) }
            guard addr.count == 4, user.count < 256, pass.count < 256 else { return .failed }
            try await task.write(Data([5, 1, 2]), timeout: t)
            guard try await DohForwarder.read(task, 2, t) == [5, 2] else { throw URLError(.cannotConnectToHost) }
            try await task.write(Data([1, UInt8(user.count)] + user + [UInt8(pass.count)] + pass), timeout: t)
            guard try await DohForwarder.read(task, 2, t) == [1, 0] else { throw URLError(.userAuthenticationRequired) }
            try await task.write(Data([5, 1, 0, 1] + addr + [1, 187]), timeout: t)
            let head = try await DohForwarder.read(task, 5, t)
            guard head.count == 5, head[1] == 0 else { throw URLError(.cannotConnectToHost) }
            _ = try await DohForwarder.read(task, head[3] == 1 ? 5 : head[3] == 4 ? 17 : Int(head[4]) + 2, t)
            task.startSecureConnection()
            let req = "POST /dns-query HTTP/1.1\r\nHost: \(r.ip)\r\nContent-Type: application/dns-message\r\n" +
                "Accept: application/dns-message\r\nContent-Length: \(wire.count)\r\nConnection: close\r\n\r\n"
            try await task.write(Data(Array(req.utf8) + wire), timeout: t)
            var got = [UInt8]()
            var body: [UInt8]?
            while body == nil && got.count < 70_000 {
                let (d, eof) = try await task.readData(ofMinLength: 1, maxLength: 16_384, timeout: t)
                if let d { got += d }
                body = DohForwarder.http1Body(got, ended: eof)
                if eof { break }
            }
            guard let body, let answer = Dns.matchAnswer(query: query, answer: body) else {
                failed(r.id)
                return .failed
            }
            succeeded(r.id, Date().timeIntervalSince(began))
            return .answer(answer, r.id)
        } catch {
            if !Task.isCancelled { failed(r.id) }
            return .failed
        }
    }

    /* Exactly n bytes from the stream, or fewer if it ended. */
    static func read(_ task: URLSessionStreamTask, _ n: Int, _ t: TimeInterval) async throws -> [UInt8] {
        var got = [UInt8]()
        while got.count < n {
            let (d, eof) = try await task.readData(ofMinLength: 1, maxLength: n - got.count, timeout: t)
            if let d { got += d }
            if eof { break }
        }
        return got
    }

    /* An HTTP/1.1 response's body once it is all there (Shared/Http1.swift). */
    static func http1Body(_ b: [UInt8], ended: Bool) -> [UInt8]? { Http1.body(b, ended: ended) }

    private func succeeded(_ id: String, _ took: TimeInterval) {
        lock.lock(); defer { lock.unlock() }
        guard let i = routes.firstIndex(where: { $0.id == id }) else { return }
        routes[i].ewma = routes[i].ewma == 0 ? took : (routes[i].ewma * 7 + took * 3) / 10
        routes[i].fails = 0
        routes[i].restUntil = .distantPast
    }

    private func failed(_ id: String) {
        lock.lock(); defer { lock.unlock() }
        guard let i = routes.firstIndex(where: { $0.id == id }) else { return }
        routes[i].fails += 1
        let rest = min(DohForwarder.restMax, DohForwarder.restBase * pow(2, Double(min(routes[i].fails - 1, 20))))
        routes[i].restUntil = Date().addingTimeInterval(rest)
    }

    private func remember(_ id: String) {
        lock.lock()
        let changed = preferred != id
        preferred = id
        lock.unlock()
        if changed {
            defaults.set(id, forKey: "dohPreferred")
            log("Encrypted DNS: answering through \(id)")
        }
    }

    /* The certificate must be valid for the address, or for one of the
     * operator's names: some carry only their names. */
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        let host = challenge.protectionSpace.host.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        lock.lock()
        let names = routes.first { $0.ip == host }?.names ?? []
        lock.unlock()
        for name in [host] + names {
            SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, name as CFString))
            if SecTrustEvaluateWithError(trust, nil) {
                completionHandler(.useCredential, URLCredential(trust: trust))
                return
            }
        }
        completionHandler(.cancelAuthenticationChallenge, nil)
    }
}

/* The resolver's certificate on a stream through the engine: the stream's
 * host is 127.0.0.1, so it is checked against the address or the names of
 * the resolver this stream was opened for. Server trust reaches a task's
 * delegate here, as no session-level method takes it. */
final class EngineTrust: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var expected: [Int: [String]] = [:]

    func expect(_ id: Int, ip: String, names: [String]) {
        lock.lock(); defer { lock.unlock() }
        expected[id] = [ip] + names
    }

    func forget(_ id: Int) {
        lock.lock(); defer { lock.unlock() }
        expected[id] = nil
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        lock.lock()
        let names = expected[task.taskIdentifier] ?? []
        lock.unlock()
        for name in names {
            SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, name as CFString))
            if SecTrustEvaluateWithError(trust, nil) {
                completionHandler(.useCredential, URLCredential(trust: trust))
                return
            }
        }
        completionHandler(.cancelAuthenticationChallenge, nil)
    }
}
