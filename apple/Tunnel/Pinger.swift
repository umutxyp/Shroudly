import Foundation

/*
 * The live count's pings from inside the packet tunnel (Shared/OnlineCount.swift
 * has the rules; Android's Pinger in OnlineCount.kt the same ones). Driven on
 * the tunnel's queue; the requests go through the engine.
 */
final class Pinger {
    private let queue: DispatchQueue
    /* The engine's SOCKS5 port and this session's password, while it runs. */
    private let path: () -> EngineHTTPS.Path?
    private let version: String
    private let acceptLanguage: String

    private var id: String?
    private var generation = 0
    private var next: DispatchWorkItem?
    private var lastDelay = OnlineCount.defaultInterval
    /* The total from the last answer while counted. */
    private(set) var online: Int?

    init(queue: DispatchQueue, version: String, path: @escaping () -> EngineHTTPS.Path?) {
        self.queue = queue
        self.path = path
        self.version = version
        acceptLanguage = OnlineCount.chromiumLocale(Locale.preferredLanguages)
    }

    var counting: Bool { id != nil }

    /* On the queue: counted exactly while both hold. Returns the id that has
     * just stopped being counted, to send a leave for. */
    @discardableResult
    func sync(share: Bool, on: Bool) -> String? {
        if share && on { start(); return nil }
        return stop()
    }

    private func start() {
        guard id == nil else { return }
        online = nil
        id = UUID().uuidString.lowercased()
        generation += 1
        lastDelay = OnlineCount.defaultInterval
        schedule(0, generation)
    }

    /* No more pings; the id that was counted, if any. */
    func stop() -> String? {
        guard let was = id else { return nil }
        id = nil
        online = nil
        generation += 1
        next?.cancel()
        next = nil
        return was
    }

    private func schedule(_ delay: TimeInterval, _ g: Int) {
        let w = DispatchWorkItem { [weak self] in self?.ping(g) }
        next = w
        queue.asyncAfter(deadline: .now() + delay, execute: w)
    }

    private func ping(_ g: Int) {
        guard g == generation, let current = id else { return }
        let p = path()
        Task { [self] in
            var delay = OnlineCount.retry
            var total: Int?
            if let p {
                do {
                    let answer = try await Pinger.post(OnlineCount.ping, OnlineCount.body(current), via: p, version: version,
                                                       acceptLanguage: acceptLanguage, timeout: OnlineCount.pingTimeout)
                    // An answer that cannot be read keeps the pace; one that
                    // is not the server's is a failure.
                    let pace = queue.sync { lastDelay }
                    let d: TimeInterval? = answer.map(OnlineCount.nextDelay) ?? pace
                    if let d { delay = d }
                    total = answer.flatMap(OnlineCount.online(in:))
                } catch {
                    // Offline or blocked: again soon.
                }
            }
            queue.async { [self] in
                guard g == generation else { return }
                if delay != OnlineCount.retry { lastDelay = delay }
                if let total { online = total }
                schedule(delay, g)
            }
        }
    }

    /* /v1/leave for an id no longer counted, through the path the engine
     * had; waits at most leaveTimeout. */
    func leave(_ id: String, via p: EngineHTTPS.Path) async {
        _ = try? await Pinger.post(OnlineCount.leave, OnlineCount.body(id), via: p, version: version,
                                   acceptLanguage: acceptLanguage, timeout: OnlineCount.leaveTimeout)
    }

    /* One request through the engine; the answer's text, nil when it is in an
     * encoding that cannot be read here (Brotli, Zstandard). */
    static func post(_ path: String, _ body: String, via p: EngineHTTPS.Path, version: String,
                     acceptLanguage: String, timeout t: TimeInterval) async throws -> String? {
        // Through the engine only, never straight out (OnlineCount.swift).
        let stream = try await EngineHTTPS.open(OnlineCount.host, via: p, timeout: t)
        defer { stream.close() }
        try await stream.write(OnlineCount.request(path, body: body, version: version, acceptLanguage: acceptLanguage), timeout: t)
        var got = [UInt8]()
        while true {
            let (d, eof) = try await stream.read(max: 16_384, timeout: t)
            if let d { got += d }
            if let r = response(got, ended: eof) { return r.text }
            guard got.count < OnlineCount.maxBody * 4, !eof else { throw URLError(.badServerResponse) }
        }
    }

    /* A whole 200 response's text (keep-alive: it ends by its length, not the
     * stream's end), or nil while it is not all there. */
    struct Answer { let text: String? }

    static func response(_ got: [UInt8], ended: Bool) -> Answer? {
        guard let end = (0..<max(0, got.count - 3)).first(where: { got[$0] == 13 && got[$0 + 1] == 10 && got[$0 + 2] == 13 && got[$0 + 3] == 10 }),
              let body = DohForwarder.http1Body(got, ended: ended) else { return nil }
        let head = String(decoding: got[..<end], as: UTF8.self).lowercased()
        let enc = head.components(separatedBy: "\r\n").first { $0.hasPrefix("content-encoding:") }?
            .dropFirst("content-encoding:".count).trimmingCharacters(in: .whitespaces) ?? ""
        return Answer(text: decode(Data(body), enc).map { String(decoding: $0, as: UTF8.self) })
    }

    static func decode(_ d: Data, _ encoding: String) -> Data? {
        switch encoding {
        case "", "identity": return d
        case "gzip", "x-gzip": return gunzip(d)
        case "deflate":
            // zlib's two-byte header and four-byte check around raw deflate.
            guard d.count > 6 else { return nil }
            return inflate(d.subdata(in: 2..<(d.count - 4)))
        default: return nil
        }
    }

    private static func gunzip(_ d: Data) -> Data? {
        let b = [UInt8](d)
        guard b.count > 18, b[0] == 0x1f, b[1] == 0x8b, b[2] == 8 else { return nil }
        let flags = b[3]
        var i = 10
        if flags & 4 != 0 { guard i + 2 <= b.count else { return nil }; i += 2 + Int(b[i]) | Int(b[i + 1]) << 8 }
        if flags & 8 != 0 { while i < b.count && b[i] != 0 { i += 1 }; i += 1 }
        if flags & 16 != 0 { while i < b.count && b[i] != 0 { i += 1 }; i += 1 }
        if flags & 2 != 0 { i += 2 }
        guard i < b.count - 8 else { return nil }
        return inflate(Data(b[i..<(b.count - 8)]))
    }

    private static func inflate(_ raw: Data) -> Data? {
        guard let out = try? (raw as NSData).decompressed(using: .zlib) as Data, out.count <= OnlineCount.maxBody else { return nil }
        return out
    }
}
