import Foundation
#if os(macOS) || os(iOS)
import UserNotifications
#endif

/* A site that only the last way out (Tor) opened, said to the user: it is
 * slower, and some sites ask Tor's visitors for a captcha. A notification on
 * the Mac (the only Apple system with Tor), in the words the app left in
 * the shared settings (TunnelController, TorNotice.textKey). Once per site
 * while protection is on, and at most once every 15 minutes. */
enum TorNotice {
    static let textKey = "torUsedText"
    /* The words for a DNS profile or app in the way (TunnelController). */
    static let dnsTextKey = "dnsAroundText"
    static let every: TimeInterval = 15 * 60
    private static let lock = NSLock()
    private static var told = Set<String>()
    private static var lastAt: Date?

    /* Whether `host` is to be said now. */
    static func due(_ host: String, now: Date = Date()) -> Bool {
        lock.lock(); defer { lock.unlock() }
        let h = host.lowercased()
        guard !h.isEmpty, told.insert(h).inserted else { return false }
        if let l = lastAt, now.timeIntervalSince(l) < every { return false }
        lastAt = now
        return true
    }

    static func reset() {
        lock.lock(); told.removeAll(); lastAt = nil; askedAt = nil; lock.unlock()
    }

    /* A notification in the app's words (left under `key`), where the
     * system allows the app's notifications; on iPhone, iPad and Apple TV
     * the app's own card says it too (ContentView). */
    static func post(key: String, id: String) {
        #if os(macOS) || os(iOS)
        guard let text = AppGroup.defaults.string(forKey: key), !text.isEmpty else { return }
        let c = UNMutableNotificationContent()
        c.title = "Shroudly"
        c.body = text
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: c, trigger: nil)) { _ in }
        #endif
    }

    /* Tor is slow: before it first starts the user says yes (issue #77).
     * Until then a site that needs it is asked about: the app's card
     * (ContentView) and, so the user knows to look there, a notification,
     * at most every `askEvery`. The answer is kept in the app group. */
    static let askTextKey = "torAskText"
    static let approvedKey = "torApproved"
    static let askEvery: TimeInterval = 30 * 60
    private static var askedAt: Date?

    static func approved() -> Bool { AppGroup.defaults.bool(forKey: approvedKey) }

    /* "No" (or the last way out turned off in Settings) is kept, but not for
     * ever: a user in Iran who had said no once saw X and YouTube stay shut,
     * and nothing said that Tor was the one way left. A site no technique
     * opens asks again after `restFor` (the same card; "No" rests again);
     * one said before this version (no time kept) asks at the next such site. */
    static let restKey = "torAskRest"
    static let restFor: TimeInterval = 7 * 24 * 60 * 60

    static func restOver(restAt: TimeInterval, now: TimeInterval) -> Bool {
        restAt == 0 || now - restAt < 0 || now - restAt >= restFor
    }

    static func rest() { AppGroup.defaults.set(Date().timeIntervalSince1970, forKey: restKey) }

    /* Whether to ask again now; the rest starts over when it does. */
    static func askAgainDue() -> Bool {
        guard restOver(restAt: AppGroup.defaults.double(forKey: restKey), now: Date().timeIntervalSince1970) else { return false }
        rest()
        return true
    }

    /* Whether to say it now (pure but for the clock, for the tests). */
    static func askDue(now: Date = Date()) -> Bool {
        lock.lock(); defer { lock.unlock() }
        if let a = askedAt, now.timeIntervalSince(a) < askEvery { return false }
        askedAt = now
        return true
    }

    /* What the question names (an Iran Telegram report: "Open
     * 2001:4188:2:600:10:10:34:35 through Tor?", never answered, so Telegram
     * stayed shut): an app by its name where its servers are known (Telegram
     * for 149.154.167.92, t.me; RawAppsList), a site by its name, a bare
     * address only when nothing better came. A better one replaces the one
     * asked about; a worse one never does. Rank: 2 an app, 1 a name, 0 an
     * address, -1 nothing. The desktop's askLabel (raw-apps.js). */
    static func label(had: String?, hadRank: Int, host: String, appOf: (String) -> String? = appOf) -> (String, Int) {
        var h = host.trimmingCharacters(in: .whitespaces).lowercased()
        if h.hasPrefix("[") && h.hasSuffix("]") { h = String(h.dropFirst().dropLast()) }
        let cand: (String, Int)?
        if h.isEmpty { cand = nil }
        else if let app = appOf(h) { cand = (app, 2) }
        else { cand = (h, addrBytes(h) == nil ? 1 : 0) }
        guard let had, !had.isEmpty else { return cand ?? ("", -1) }
        if let cand, cand.1 > hadRank { return cand }
        return (had, hadRank)
    }

    /* The service an address or name belongs to (RawAppsList), or nil. */
    static func appOf(_ host: String) -> String? {
        let h = host.lowercased()
        if let a = addrBytes(h) {
            for (name, what) in RawAppsList.rows where !what.hasPrefix(".") {
                let parts = what.split(separator: "/")
                guard parts.count == 2, let bits = Int(parts[1]), let net = addrBytes(String(parts[0])), net.count == a.count else { continue }
                if prefixEq(a, net, bits) { return name }
            }
            return nil
        }
        for (name, what) in RawAppsList.rows where what.hasPrefix(".") {
            if h == String(what.dropFirst()) || h.hasSuffix(what) { return name }
        }
        return nil
    }

    static func addrBytes(_ s: String) -> [UInt8]? {
        var v4 = in_addr()
        if s.withCString({ inet_pton(AF_INET, $0, &v4) }) == 1 { return withUnsafeBytes(of: &v4) { Array($0) } }
        var v6 = in6_addr()
        if s.contains(":"), s.withCString({ inet_pton(AF_INET6, $0, &v6) }) == 1 { return withUnsafeBytes(of: &v6) { Array($0) } }
        return nil
    }

    private static func prefixEq(_ a: [UInt8], _ b: [UInt8], _ bits: Int) -> Bool {
        var left = bits, i = 0
        while left > 0 && i < a.count {
            let m: UInt8 = left >= 8 ? 0xff : UInt8((0xff << (8 - left)) & 0xff)
            if a[i] & m != b[i] & m { return false }
            left -= 8; i += 1
        }
        return true
    }

    /* again: a better name than the notice gave; said at once. */
    static func ask(_ host: String, again: Bool = false) {
        guard again || askDue() else { return }
        #if os(macOS) || os(iOS)
        guard let text = AppGroup.defaults.string(forKey: askTextKey), !text.isEmpty else { return }
        let c = UNMutableNotificationContent()
        c.title = "Shroudly"
        c.body = text.replacingOccurrences(of: "{host}", with: host.lowercased())
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "tor-ask", content: c, trigger: nil)) { _ in }
        #endif
    }

    static func used(_ host: String) {
        guard due(host) else { return }
        #if os(macOS)
        guard let text = AppGroup.defaults.string(forKey: textKey), !text.isEmpty else { return }
        let c = UNMutableNotificationContent()
        c.title = "Shroudly"
        c.body = text.replacingOccurrences(of: "{host}", with: host.lowercased())
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "tor-used", content: c, trigger: nil)) { _ in }
        #endif
    }
}

#if SHROUDLY_TOR
import IPtProxy
import ShroudlyNative
#endif

/*
 * The last way out (Settings, "When nothing else works: the Tor network"; on
 * unless turned off), as on the desktop and Android (electron/tor-route.js,
 * TorRoute.kt): Tor, reached through Snowflake, for a connection the engine
 * got nowhere with (core/src/engine.c, "the last way out", --fallback-file).
 *
 * A packet tunnel runs no program of its own, so both run inside it as
 * libraries: Tor on a thread (Native/tor_glue.c, Tor.xcframework) and the
 * pluggable transports (IPtProxy: Snowflake, and lyrebird's meek and obfs4),
 * each on a port of 127.0.0.1 that Tor reaches as a SOCKS proxy.
 *
 * The Mac only. Tor and Snowflake together take about 44 MB once Tor is
 * ready (measured on a Mac), and iOS ends a packet tunnel at about 50 MB
 * (Tests/MemoryTests.swift): on an iPhone or iPad the whole tunnel would be
 * ended, protection with it, which is worse than no last way out. Apple TV
 * has no build of either library. So the libraries are linked into the
 * Mac's tunnel alone, which builds this with SHROUDLY_TOR; `available` is
 * false everywhere else (the tests too).
 *
 * Tor starts the first time the engine needs it. It cannot be started twice
 * in one process, so it is never stopped either: its network is turned off
 * (DisableNetwork) when nothing has needed it for IDLE seconds and when the
 * tunnel stops, and on again when a site needs it.
 */
final class TorRoute: @unchecked Sendable {  // its state is touched on `queue` only
    static let stall: TimeInterval = 90
    static let idle: TimeInterval = 15 * 60
    static let retry: TimeInterval = 10 * 60

    enum State: String { case off, starting, ready, failed }

    private(set) var state = State.off
    private(set) var progress = 0
    private let log: (String) -> Void
    private let queue = DispatchQueue(label: "me.codeshare.shroudly.tor")
    private var port = 0
    private var started = false
    private var stage = "snowflake"
    private var failedAt = Date.distantPast
    private var usedAt = Date()
    private var used: Int64 = 0
    private var stallTimer: DispatchWorkItem?
    private var idleTimer: DispatchSourceTimer?
    private var control: FileHandle?
    private var bridges: [String: [String]] = [:]
    /* The engine's count of connections Tor carried (its STATS line). */
    var usedCount: () -> Int64 = { 0 }
    /* The bridges the Tor Project gives for this country (fetchCountry,
     * set by the tunnel), tried when the bundle's got nowhere either. */
    var countryBridges: () async -> [String: [String]]? = { nil }
    private var country: (at: Date, bridges: [String: [String]])?
    /* This country's bridges got Tor through: kept in the app group, so the
     * next start goes to them first (as on the desktop and Android). */
    static let countryKey = "torCountryWorked"
    static let countryKeep: TimeInterval = 24 * 60 * 60

    init(log: @escaping (String) -> Void) {
        self.log = log
    }

    static var available: Bool {
        #if SHROUDLY_TOR
        return Bundle.main.url(forResource: "tor-bridges", withExtension: "json") != nil
        #else
        return false
        #endif
    }

    /* The bundle's bridges by transport, well-formed lines only. */
    static func bridgesOf(_ data: Data) -> [String: [String]] {
        guard let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let b = o["bridges"] as? [String: Any] else { return [:] }
        var out: [String: [String]] = [:]
        for k in ["snowflake", "meek", "obfs4", "webtunnel"] {
            let lines = (b[k] as? [String] ?? []).filter { l in
                l.count < 2000 && l.range(of: #"^[a-z_0-9]+ [^\r\n]+$"#, options: .regularExpression) != nil
            }
            if !lines.isEmpty { out[k] = lines }
        }
        return out
    }

    /* The lines shroudly.codeshare.me/v1/bridges gives: { country, bridges }. */
    static func countryBridgesOf(_ data: Data) -> [String: [String]]? {
        guard let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let b = o["bridges"] as? [String: Any] else { return nil }
        var out: [String: [String]] = [:]
        for (k, v) in b { if let a = v as? [String] { out[k] = a } }
        return out
    }

    /* The order this country's bridges are tried in, as electron/tor-route.js. */
    static let countryOrder = ["webtunnel", "obfs4", "snowflake", "meek"]

    /* This country's well-formed lines first (8 a transport at most), then
     * the bundle's, without repeats (electron/tor-route.js, mergeBridges). */
    static func mergeBridges(_ country: [String: [String]]?, _ bundled: [String: [String]]) -> [String: [String]] {
        var out: [String: [String]] = [:]
        for kind in countryOrder {
            let theirs = (country?[kind] ?? []).filter { $0.hasPrefix("\(kind) ") && $0.count < 2000 && !$0.contains("\r") && !$0.contains("\n") }.prefix(8)
            var seen = Set<String>()
            let all = (Array(theirs) + (bundled[kind] ?? [])).filter { seen.insert($0).inserted }
            if !all.isEmpty { out[kind] = all }
        }
        return out
    }

    static func countryLines(_ m: [String: [String]]) -> [String] {
        countryOrder.flatMap { m[$0] ?? [] }
    }

    /* This country's bridges from shroudly.codeshare.me, through the engine
     * (EngineHTTPS: by name, a technique where it is blocked), else straight
     * where the system has no proxy configurations. nil when none came. */
    static func fetchCountry(via e: EngineHTTPS.Path?) async -> [String: [String]]? {
        let host = "shroudly.codeshare.me", t: TimeInterval = 20
        do {
            let s: EngineHTTPS.Stream
            do { s = try await EngineHTTPS.open(host, via: e, timeout: t) } catch is EngineHTTPS.Unsupported {
                s = try await EngineHTTPS.open(host, via: nil, timeout: t)
            }
            defer { s.close() }
            let req = "GET /v1/bridges HTTP/1.1\r\nHost: \(host)\r\nUser-Agent: Shroudly\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n"
            try await s.write(Data(req.utf8), timeout: t)
            return countryBridgesOf(try AdBlockFetch.body(of: try await s.readAll(max: 256 * 1024, timeout: t)))
        } catch {
            return nil
        }
    }

    /* This country's bridges, kept when they last got Tor through (within
     * countryKeep); nil when they did not, or too long ago. */
    static func remembered(_ d: UserDefaults = AppGroup.defaults, now: Date = Date()) -> [String: [String]]? {
        guard let data = d.data(forKey: countryKey),
              let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let at = o["at"] as? Double, now.timeIntervalSince1970 - at >= 0, now.timeIntervalSince1970 - at < countryKeep,
              let b = o["bridges"] as? [String: [String]], !mergeBridges(b, [:]).isEmpty else { return nil }
        return b
    }

    static func remember(_ b: [String: [String]]?, _ d: UserDefaults = AppGroup.defaults, now: Date = Date()) {
        guard let b, let data = try? JSONSerialization.data(withJSONObject: ["at": now.timeIntervalSince1970, "bridges": b]) else {
            d.removeObject(forKey: countryKey); return
        }
        d.set(data, forKey: countryKey)
    }

    /* A key=value of a bridge line ("url=", "fronts=", "ice="). */
    static func param(_ line: String, _ key: String) -> String? {
        line.split(separator: " ").first { $0.hasPrefix("\(key)=") }.map { String($0.dropFirst(key.count + 1)) }
    }

    /* Before each engine start: the line naming Tor's port to the engine,
     * written to `file`; Tor starts later, when first needed. */
    func prepare(file: String) -> Bool {
        guard Self.available else { return false }
        if port == 0 { port = Engine.freePort() }
        do { try "socks5://127.0.0.1:\(port)\n".write(toFile: file, atomically: true, encoding: .utf8) } catch { return false }
        return true
    }

    /* The engine had a connection for it and nothing was listening. */
    func need() {
        queue.async { [self] in
            guard Self.available, port > 0 else { return }
            if state == .failed && Date().timeIntervalSince(failedAt) < Self.retry { return }
            if state == .starting || state == .ready { return }
            if started { network(on: true); return }
            start()
        }
    }

    #if SHROUDLY_TOR
    private var pt: IPtProxyController?

    private func start() {
        guard let url = Bundle.main.url(forResource: "tor-bridges", withExtension: "json"),
              let data = try? Data(contentsOf: url) else { return }
        bridges = Self.bridgesOf(data)
        let dir = AppGroup.folder.appendingPathComponent("tor", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let ptDir = dir.appendingPathComponent("pt_state").path
        try? FileManager.default.createDirectory(atPath: ptDir, withIntermediateDirectories: true)
        guard let c = IPtProxyController(ptDir, enableLogging: false, unsafeLogging: false, logLevel: "ERROR", transportEvents: nil) else {
            fail("the transports could not start"); return
        }
        pt = c
        // Snowflake's rendezvous as the bundle's own line has it.
        if let sf = bridges["snowflake"]?.first {
            if let u = Self.param(sf, "url") { c.snowflakeBrokerUrl = u }
            if let f = Self.param(sf, "fronts") ?? Self.param(sf, "front") { c.snowflakeFrontDomains = f }
            if let i = Self.param(sf, "ice") { c.snowflakeIceServers = i }
        }
        // One volunteer kept ready beside the one in use (issue #73), as on
        // the desktop and Android.
        c.snowflakeMaxPeers = 2
        var plugins: [String] = []
        for (name, kinds) in [(IPtProxySnowflake, ["snowflake"]), (IPtProxyObfs4, ["obfs4"]), (IPtProxyMeekLite, ["meek_lite"]), (IPtProxyWebtunnel, ["webtunnel"])] {
            do { try c.start(name, proxy: nil) } catch { log("The last way out: \(name) could not start (\(error.localizedDescription))"); continue }
            let p = c.port(name)
            if p > 0 { for k in kinds { plugins += ["--ClientTransportPlugin", "\(k) socks5 127.0.0.1:\(p)"] } }
        }
        // This country's bridges first when they got Tor through last time.
        let known = Self.remembered()
        if let known { country = (Date(), known) }
        let lines = known.map { Self.countryLines(Self.mergeBridges($0, bridges)) } ?? bridges["snowflake"] ?? []
        var args = ["--SocksPort", "127.0.0.1:\(port)", "--DataDirectory", dir.path, "--ClientOnly", "1", "--AvoidDiskWrites", "1",
                    "--UseBridges", "1", "--Log", "err stderr", "--GeoIPFile", "", "--GeoIPv6File", "", "--DisableNetwork", "0"]
        args += plugins
        for l in (lines.isEmpty ? allLines() : lines) { args += ["--Bridge", l] }
        stage = known != nil ? "country" : lines.isEmpty ? "all" : "snowflake"
        let fd = args.withCStrings { shroudly_tor_start($0, Int32(args.count)) }
        guard fd >= 0 else { fail("Tor could not start (\(fd))"); return }
        started = true
        control = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        state = .starting; progress = 0
        log(known != nil ? "The last way out: starting Tor through this country's bridges, which got through last time"
                         : "The last way out: starting Tor through Snowflake, for sites nothing else opened")
        send("SETEVENTS STATUS_CLIENT")
        Thread { [weak self] in self?.readControl() }.start()
        armStall()
    }
    #else
    private func start() {}
    #endif

    private func allLines() -> [String] {
        ["snowflake", "meek", "obfs4", "webtunnel"].flatMap { bridges[$0] ?? [] }
    }

    private func send(_ cmd: String) {
        try? control?.write(contentsOf: Data("\(cmd)\r\n".utf8))
    }

    /* Tor's control connection: the bootstrap's progress, from its events. */
    private func readControl() {
        guard let h = control else { return }
        var pending = Data()
        while true {
            let chunk = h.availableData
            if chunk.isEmpty { break }
            pending.append(chunk)
            while let nl = pending.firstIndex(of: 0x0a) {
                let line = String(decoding: pending[pending.startIndex..<nl], as: UTF8.self)
                pending.removeSubrange(pending.startIndex...nl)
                if let r = line.range(of: #"BOOTSTRAP PROGRESS=(\d+)"#, options: .regularExpression),
                   let n = Int(line[r].split(separator: "=").last ?? "") {
                    queue.async { [self] in progressed(n) }
                }
            }
        }
    }

    private func progressed(_ n: Int) {
        guard state == .starting, n > progress else { return }
        progress = n
        armStall()
        if n >= 100 {
            state = .ready
            stallTimer?.cancel()
            usedAt = Date(); used = usedCount()
            armIdle()
            if stage == "country" { Self.remember(country?.bridges) }
            log("The last way out is ready: Tor through \(stage == "snowflake" ? "Snowflake" : stage == "country" ? "this country's bridges" : "its bridges")")
        }
    }

    private func armStall() {
        stallTimer?.cancel()
        let w = DispatchWorkItem { [weak self] in
            guard let self, self.state == .starting else { return }
            if self.stage == "snowflake" {
                // Snowflake did not get through: every bridge the bundle has.
                self.stage = "all"
                self.log("The last way out: Snowflake did not get through; trying Tor's other ways (meek, obfs4) with it")
                self.setBridges(self.allLines())
                self.armStall()
            } else if self.stage == "all" {
                self.tryCountry()
            } else {
                if self.stage == "country" { Self.remember(nil) }
                self.fail("Tor did not get through (\(self.progress)%)")
            }
        }
        stallTimer = w
        queue.asyncAfter(deadline: .now() + Self.stall, execute: w)
    }

    private func setBridges(_ lines: [String]) {
        send("SETCONF " + lines.map { "Bridge=\"\($0.replacingOccurrences(of: "\"", with: ""))\"" }.joined(separator: " "))
    }

    /* The bundle's bridges got nowhere either (the Tor Project's own list is
     * blocked in some countries): the bridges it gives for this country,
     * fetched once (kept 6 hours), then the bundle's behind them. */
    private func tryCountry() {
        let pct = progress
        let cached = country.flatMap { Date().timeIntervalSince($0.at) < 6 * 60 * 60 ? $0.bridges : nil }
        let fetch = countryBridges
        Task { [weak self] in
            let c: [String: [String]]?
            if let cached { c = cached } else { c = await fetch() }
            self?.queue.async { [weak self] in
                guard let self, self.state == .starting, self.stage == "all" else { return }
                if cached == nil, let c { self.country = (Date(), c) }
                let extra = Self.mergeBridges(c, [:])
                guard !extra.isEmpty else { self.fail("Tor did not get through (\(pct)%)"); return }
                self.stage = "country"
                self.log("The last way out: Tor's own bridges did not get through either; trying the bridges the Tor Project gives for this country (" +
                         Self.countryOrder.filter { extra[$0] != nil }.joined(separator: ", ") + ")")
                self.setBridges(Self.countryLines(Self.mergeBridges(c, self.bridges)))
                self.armStall()
            }
        }
    }

    private func armIdle() {
        idleTimer?.cancel()
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + 60, repeating: 60, leeway: .seconds(10))
        t.setEventHandler { [weak self] in
            guard let self, self.state == .ready else { return }
            let n = self.usedCount()
            if n > self.used { self.used = n; self.usedAt = Date() } else if n < self.used { self.used = n }
            if Date().timeIntervalSince(self.usedAt) >= Self.idle {
                self.log("The last way out: nothing has needed Tor for a while; its network is off until a site needs it again")
                self.network(on: false)
            }
        }
        idleTimer = t
        t.resume()
    }

    /* Tor's network on (when a site needs it again) or off (idle, stopped). */
    private func network(on: Bool) {
        guard started else { return }
        send("SETCONF DisableNetwork=\(on ? 0 : 1)")
        if on {
            state = .starting; progress = 0
            log("The last way out: Tor's network on again for a site nothing else opened")
            armStall()
        } else {
            state = .off; progress = 0
            stallTimer?.cancel(); idleTimer?.cancel(); idleTimer = nil
        }
    }

    private func fail(_ why: String) {
        if started { send("SETCONF DisableNetwork=1") }
        stallTimer?.cancel(); idleTimer?.cancel(); idleTimer = nil
        state = .failed
        failedAt = Date()
        log("The last way out: \(why); tried again when a site needs it, in \(Int(Self.retry / 60)) minutes at the earliest")
    }

    /* With the tunnel: Tor's network off (Tor itself ends with the process). */
    func stop() {
        queue.sync { if state != .off && state != .failed { network(on: false) } }
    }

    /* What the window shows: { state, progress } while it is not off. */
    var status: [String: Any]? {
        queue.sync { state == .off ? nil : ["state": state.rawValue, "progress": progress] }
    }
}

private extension Array where Element == String {
    /* The strings as C strings for the duration of `body`. */
    func withCStrings<R>(_ body: (UnsafePointer<UnsafePointer<CChar>?>) -> R) -> R {
        let c: [UnsafePointer<CChar>?] = map { UnsafePointer(strdup($0)) }
        defer { for p in c { free(UnsafeMutablePointer(mutating: p)) } }
        return c.withUnsafeBufferPointer { body($0.baseAddress!) }
    }
}
