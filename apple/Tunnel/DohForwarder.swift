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

    private func currentPlan() -> [Route] {
        lock.lock(); defer { lock.unlock() }
        return DohForwarder.plan(routes, preferred: preferred, now: Date())
    }

    /* The answer to one query, or "no route". */
    func resolve(_ query: [UInt8]) async -> [UInt8] {
        let noRoute = Dns.noRouteReply(query) ?? query
        let plan = currentPlan()
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
                    remember(id)
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
