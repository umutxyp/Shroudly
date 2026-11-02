import Foundation
import Network
import NetworkExtension
import ShroudlyNative

/*
 * The packet tunnel: every app's connections, through the engine.
 *
 *     apps -> tunnel (utun) -> hev-socks5-tunnel -> engine (SOCKS5 on 127.0.0.1)
 *          -> the network, with the engine's techniques
 *
 * As the Android app's VPN service does (ShroudlyVpnService.kt): the engine
 * and hev run on threads of this process; the engine resolves names over the
 * encrypted DNS forwarder (DohForwarder); hev answers the system's DNS with
 * stand-in addresses, so the engine sees every site's name (TunnelConfig).
 * This process's own connections (the engine's, the forwarder's) never go
 * through its tunnel.
 *
 * While it runs it is watched: an engine whose run returns is started again
 * on the port and with the password it had, so hev goes on as it was (up to
 * maxEngineRestarts in a row); a hev that stopped is started again once, with
 * the next stand-in range; an engine that stops answering cannot be ended
 * from inside the process, so protection ends with an error and the system
 * lets apps connect directly. The device is never left "Protected" with
 * nothing behind it.
 */
final class PacketTunnelProvider: NEPacketTunnelProvider {
    static let watchEvery: TimeInterval = 15
    /* An engine silent this long (it answers STATS every watchEvery) is hung. */
    static let hungAfter: TimeInterval = 50
    static let maxEngineRestarts = 5
    static let siteLines = 300

    private struct StartError: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    private let queue = DispatchQueue(label: "me.codeshare.shroudly.tunnel")
    private let fileLog = SharedLog(name: "tunnel.log")
    private let siteLock = NSLock()
    private var sites: [String] = []

    private var settings = AppSettings()
    private var doh: DohForwarder?
    private var engine: Engine?
    private var hev: Hev?
    private var auth: SocksAuth?
    private var port = 0
    private var dohPort = 0
    private var v6 = false
    private var engineRestarts = 0
    private var hevRestarts = 0
    private var watch: DispatchSourceTimer?
    private var paths: NWPathMonitor?
    private var pathChange: DispatchWorkItem?
    private var stopping = false
    // "Your own server": the line the engine gets, and the Shadowsocks client.
    private var upstreamLine: String?
    private var ssClient: ShadowsocksClient?

    // MARK: start and stop

    override func startTunnel(options: [String: NSObject]?, completionHandler: @escaping (Error?) -> Void) {
        queue.async { [self] in
            do {
                try bringUp()
                log("Protection on")
                completionHandler(nil)
            } catch {
                log("Start failed: \(error.localizedDescription)")
                tearDown()
                completionHandler(error)
            }
        }
    }

    override func stopTunnel(with reason: NEProviderStopReason, completionHandler: @escaping () -> Void) {
        queue.async { [self] in
            log("Stopping (reason \(reason.rawValue))")
            let clean = tearDown()
            completionHandler()
            // A run that would not return holds the engine's state in this
            // process: end the process, so the next start is a clean one.
            if !clean { DispatchQueue.global().asyncAfter(deadline: .now() + 1) { exit(0) } }
        }
    }

    private func bringUp() throws {
        stopping = false
        settings = SettingsStore().load()
        log("Starting: technique \(settings.strategy.id)\(settings.quicOff ? ", QUIC off" : "")\(settings.ipv6Off ? ", IPv6 off" : "")")
        clearOwnServerDown()
        try prepareOwnServer()

        let forwarder = DohForwarder(log: { [weak self] in self?.log($0) })
        doh = forwarder
        dohPort = try forwarder.start()

        port = try spawnEngine(keep: false)

        v6 = !settings.ipv6Off && underlyingHasIPv6()
        try apply(networkSettings(v6: v6))

        let fd = shroudly_tun_fd()
        guard fd >= 0 else { throw StartError(message: "no tunnel descriptor") }
        try startHev(fd: fd)

        RatingStore().update { RatingSchedule.recordGoodStart(&$0, at: Date()) }
        startWatching()
    }

    /* Everything stopped, in order: hev first (no new connections), then the
     * engine, the forwarder. false when the engine's run did not return. */
    @discardableResult
    private func tearDown() -> Bool {
        stopping = true
        watch?.cancel(); watch = nil
        paths?.cancel(); paths = nil
        pathChange?.cancel(); pathChange = nil
        if let h = hev, !h.stop() { log("hev did not stop") }
        hev = nil
        var clean = true
        if let e = engine, !e.stop() {
            log("The engine did not stop")
            clean = false
        }
        engine = nil
        doh?.stop(); doh = nil
        ssClient?.stop(); ssClient = nil
        upstreamLine = nil
        clearOwnServerDown()
        return clean
    }

    // MARK: the engine

    /* Starts an engine and returns its port. A first start gets a new
     * password on a new free port; a restart (keep) asks for the port and the
     * password it had, so hev goes on as it was. */
    private func spawnEngine(keep: Bool) throws -> Int {
        let blockIps = Bundle.main.url(forResource: "block-ips", withExtension: "txt")
            .flatMap { try? String(contentsOf: $0, encoding: .utf8) }
            .map(EngineArgs.blockIps(from:)) ?? []
        let wanted = keep && port > 0 && auth != nil ? port : 0
        if wanted == 0 { auth = SocksAuth.random() }
        let authPath = FileManager.default.temporaryDirectory.appendingPathComponent("engine-auth").path
        for attempt in 0...3 {
            let p = attempt == 0 && wanted > 0 ? wanted : Engine.freePort()
            try auth!.write(to: authPath)
            let e = Engine(log: { [weak self] in self?.log($0) },
                           logSite: { [weak self] in self?.logSite($0) },
                           onExit: { [weak self] code in self?.queue.async { self?.engineExited(code) } })
            var upstreamPath: String?
            if let line = upstreamLine {
                let path = FileManager.default.temporaryDirectory.appendingPathComponent("engine-upstream").path
                try OwnServer.writeFile(line, to: path)
                upstreamPath = path
            }
            e.onUpstreamDown = { [weak self] why in self?.queue.async { self?.ownServerDown(why) } }
            let args = EngineArgs.make(port: p, dohPort: dohPort, settings: settings, authFile: authPath, blockIps: blockIps, upstreamFile: upstreamPath)
            let ok = e.start(args: args)
            // Read once, at its start: the secrets are not left lying in a file.
            unlink(authPath)
            if let upstreamPath { unlink(upstreamPath) }
            if ok {
                engine = e
                return p
            }
            let err = e.lastError ?? "engine failed to start"
            if e.running { throw StartError(message: "the engine did not stop after a failed start: \(err)") }
            if !err.contains("listen failed") || attempt == 3 { throw StartError(message: err) }
            if p == wanted {
                // Someone else has the old port now: a new port, a new password,
                // and hev is told of both.
                log("Port \(wanted) is taken now; the engine gets another one")
                auth = SocksAuth.random()
            }
        }
        throw StartError(message: "engine failed to start")
    }

    // MARK: your own server

    /* The user's own server, when one is set: Shadowsocks through this
     * tunnel's own client (a SOCKS5 server on 127.0.0.1 with this session's
     * user and password), the others as they are. */
    private func prepareOwnServer() throws {
        ssClient?.stop(); ssClient = nil
        upstreamLine = nil
        guard let link = settings.ownServerLink else { return }
        if link.kind == "ss" {
            let a = SocksAuth.random()
            let c = ShadowsocksClient(link: link, auth: a, log: { [weak self] in self?.log($0) })
            let p = try c.start()
            ssClient = c
            upstreamLine = OwnServer.engineLine(link, localPort: p, auth: a)
        } else {
            upstreamLine = OwnServer.engineLine(link)
        }
        log("Your own server: \(OwnServer.describe(link)); every site goes through it")
    }

    private func ownServerDown(_ why: String?) {
        let d = AppGroup.defaults
        d.set(OwnServer.whyCode(why), forKey: OwnServer.Down.why)
        d.set(Date().timeIntervalSince1970, forKey: OwnServer.Down.at)
        d.set(settings.ownServerLink.map(OwnServer.describe) ?? "", forKey: OwnServer.Down.server)
    }

    private func clearOwnServerDown() {
        let d = AppGroup.defaults
        for k in [OwnServer.Down.why, OwnServer.Down.at, OwnServer.Down.server] { d.removeObject(forKey: k) }
    }

    private func engineExited(_ code: Int32) {
        guard !stopping else { return }
        log("The engine ended on its own (code \(code))")
        restartEngine()
    }

    private func restartEngine() {
        engineRestarts += 1
        guard engineRestarts <= Self.maxEngineRestarts else {
            return fail("the engine kept ending")
        }
        let oldPort = port, oldAuth = auth
        do {
            port = try spawnEngine(keep: true)
            if port != oldPort || auth != oldAuth {
                // hev still sends to the old port with the old password.
                restartHev()
            }
        } catch {
            fail("engine restart: \(error.localizedDescription)")
        }
    }

    // MARK: hev and the tunnel's settings

    private func startHev(fd: Int32) throws {
        let defaults = AppGroup.defaults
        let generation = defaults.integer(forKey: "mapGeneration") + 1
        defaults.set(generation, forKey: "mapGeneration")
        let mapped = TunnelConfig.mappedNetwork(generation: generation)
        let h = Hev()
        let config = TunnelConfig.yaml(socksPort: port, user: auth?.user, pass: auth?.pass, mapped: mapped)
        guard h.start(config: config, tunFd: fd) else { throw StartError(message: "tunnel stopped right after starting") }
        hev = h
        log("Tunnel started; stand-in addresses from \(mapped)")
    }

    private func restartHev() {
        hevRestarts += 1
        if let h = hev, !h.stop() { return fail("hev did not stop") }
        hev = nil
        let fd = shroudly_tun_fd()
        do {
            guard fd >= 0 else { throw StartError(message: "no tunnel descriptor") }
            try startHev(fd: fd)
        } catch {
            fail("tunnel restart: \(error.localizedDescription)")
        }
    }

    private func networkSettings(v6: Bool) -> NEPacketTunnelNetworkSettings {
        let s = NEPacketTunnelNetworkSettings(tunnelRemoteAddress: "127.0.0.1")
        s.mtu = NSNumber(value: TunnelConfig.mtu)
        let v4 = NEIPv4Settings(addresses: [TunnelConfig.addressV4], subnetMasks: ["255.255.255.255"])
        v4.includedRoutes = [NEIPv4Route.default()]
        s.ipv4Settings = v4
        // Without an IPv6 address and route, the system tells apps at once
        // that there is no IPv6, and they use IPv4.
        if v6 {
            let six = NEIPv6Settings(addresses: [TunnelConfig.addressV6], networkPrefixLengths: [128])
            six.includedRoutes = [NEIPv6Route.default()]
            s.ipv6Settings = six
        }
        let dns = NEDNSSettings(servers: [TunnelConfig.dnsV4])
        // Every name, not only some domains, is asked of the tunnel's DNS.
        dns.matchDomains = [""]
        s.dnsSettings = dns
        return s
    }

    private func apply(_ s: NEPacketTunnelNetworkSettings) throws {
        let done = DispatchSemaphore(value: 0)
        var failure: Error?
        setTunnelNetworkSettings(s) { error in
            failure = error
            done.signal()
        }
        if done.wait(timeout: .now() + 15) == .timedOut { throw StartError(message: "the system did not set up the tunnel") }
        if let failure { throw failure }
    }

    /* Whether the network underneath (not this tunnel) has IPv6, as far as
     * the system knows within a second. */
    private func underlyingHasIPv6() -> Bool {
        let monitor = NWPathMonitor(prohibitedInterfaceTypes: [.other])
        let got = DispatchSemaphore(value: 0)
        var v6 = false
        monitor.pathUpdateHandler = { path in
            v6 = path.status == .satisfied && path.supportsIPv6
            got.signal()
        }
        monitor.start(queue: DispatchQueue(label: "me.codeshare.shroudly.path-once"))
        _ = got.wait(timeout: .now() + 1)
        monitor.cancel()
        return v6
    }

    // MARK: watching

    private func startWatching() {
        engineRestarts = 0
        hevRestarts = 0
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + Self.watchEvery, repeating: Self.watchEvery)
        t.setEventHandler { [weak self] in self?.check() }
        t.resume()
        watch = t

        // IPv6 coming or going on the network underneath: the tunnel's
        // settings follow, once the network has been quiet for 3 seconds.
        let monitor = NWPathMonitor(prohibitedInterfaceTypes: [.other])
        monitor.pathUpdateHandler = { [weak self] path in self?.pathChanged(path) }
        monitor.start(queue: queue)
        paths = monitor
    }

    /* On the queue (the monitor runs there). */
    private func pathChanged(_ path: Network.NWPath) {
        let want = !settings.ipv6Off && path.status == .satisfied && path.supportsIPv6
        pathChange?.cancel()
        guard want != v6, !stopping else { return }
        let work = DispatchWorkItem { [weak self] in self?.ipv6Changed(want) }
        pathChange = work
        queue.asyncAfter(deadline: .now() + 3, execute: work)
    }

    private func ipv6Changed(_ want: Bool) {
        guard !stopping, want != v6 else { return }
        log("IPv6 \(want ? "came" : "went") on the network underneath")
        reasserting = true
        do {
            try apply(networkSettings(v6: want))
            v6 = want
        } catch {
            log("Tunnel settings: \(error.localizedDescription)")
        }
        reasserting = false
    }

    private func check() {
        guard !stopping, let e = engine else { return }
        if e.running {
            if Date().timeIntervalSince(e.lastOutputAt) > Self.hungAfter { return fail("the engine stopped answering") }
            e.send("STATS")
            // Up for a whole check: a later end starts the count anew.
            engineRestarts = 0
        }
        if let h = hev, !h.running {
            log("hev stopped")
            if hevRestarts >= 1 { return fail("hev kept stopping") }
            restartHev()
        }
    }

    /* Protection ends; the system tells the app, and apps connect directly. */
    private func fail(_ why: String) {
        guard !stopping else { return }
        log("Protection ends: \(why)")
        let clean = tearDown()
        cancelTunnelWithError(StartError(message: why))
        if !clean { DispatchQueue.global().asyncAfter(deadline: .now() + 2) { exit(0) } }
    }

    // MARK: the app's questions

    override func handleAppMessage(_ messageData: Data, completionHandler: ((Data?) -> Void)?) {
        let message = ProviderMessage(rawValue: String(decoding: messageData, as: UTF8.self))
        queue.async { [self] in
            var reply: [String: Any] = [:]
            switch message {
            case .health:
                let e = engine
                reply["engine"] = e?.running == true && Date().timeIntervalSince(e?.lastOutputAt ?? .distantPast) < Self.hungAfter
                reply["tunnel"] = hev?.running == true
            case .siteLog:
                siteLock.lock(); reply["lines"] = sites; siteLock.unlock()
            case nil:
                break
            }
            completionHandler?(try? JSONSerialization.data(withJSONObject: reply))
        }
    }

    // MARK: logs

    private func log(_ line: String) {
        fileLog.write(line)
    }

    /* Lines that can name a site: in memory only, for "Share logs". */
    private func logSite(_ line: String) {
        siteLock.lock()
        sites.append(line)
        if sites.count > Self.siteLines { sites.removeFirst(sites.count - Self.siteLines) }
        siteLock.unlock()
    }
}
