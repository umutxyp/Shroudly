import Foundation
#if os(macOS)
import UserNotifications
#endif

/* A site that only the last way out (Tor) opened, said to the user: it is
 * slower, and some sites ask Tor's visitors for a captcha. A notification on
 * the Mac (the only Apple system with Tor), in the words the app left in
 * the shared settings (TunnelController, TorNotice.textKey). Once per site
 * while protection is on, and at most once every 15 minutes. */
enum TorNotice {
    static let textKey = "torUsedText"
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
        lock.lock(); told.removeAll(); lastAt = nil; lock.unlock()
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
final class TorRoute {
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
        let lines = bridges["snowflake"] ?? []
        var args = ["--SocksPort", "127.0.0.1:\(port)", "--DataDirectory", dir.path, "--ClientOnly", "1", "--AvoidDiskWrites", "1",
                    "--UseBridges", "1", "--Log", "err stderr", "--GeoIPFile", "", "--GeoIPv6File", "", "--DisableNetwork", "0"]
        args += plugins
        for l in (lines.isEmpty ? allLines() : lines) { args += ["--Bridge", l] }
        stage = lines.isEmpty ? "all" : "snowflake"
        let fd = args.withCStrings { shroudly_tor_start($0, Int32(args.count)) }
        guard fd >= 0 else { fail("Tor could not start (\(fd))"); return }
        started = true
        control = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        state = .starting; progress = 0
        log("The last way out: starting Tor through Snowflake, for sites nothing else opened")
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
            log("The last way out is ready: Tor through \(stage == "snowflake" ? "Snowflake" : "its bridges")")
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
                self.send("SETCONF " + self.allLines().map { "Bridge=\"\($0.replacingOccurrences(of: "\"", with: ""))\"" }.joined(separator: " "))
                self.armStall()
            } else {
                self.fail("Tor did not get through (\(self.progress)%)")
            }
        }
        stallTimer = w
        queue.asyncAfter(deadline: .now() + Self.stall, execute: w)
    }

    private func armIdle() {
        idleTimer?.cancel()
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + 60, repeating: 60)
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
