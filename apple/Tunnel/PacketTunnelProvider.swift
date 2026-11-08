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
    static let siteLines = 3000

    private struct StartError: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    private let queue = DispatchQueue(label: "me.codeshare.shroudly.tunnel")
    // The last way out (TorRoute): Tor, for sites nothing else opened.
    /* Apps' lookups go around the tunnel (Engine.onDnsAround); reset at stop. */
    private var dnsAround = false
    /* A site needs Tor and the user has not said yes yet (TorNotice.ask):
     * its name, for the app's card; nil when nothing is asked. */
    private var torAsk: String?
    private lazy var torRoute: TorRoute = {
        let t = TorRoute(log: { [weak self] in self?.log($0) })
        t.usedCount = { [weak self] in ((self?.engine?.lastStats?["fallback"]) as? NSNumber)?.int64Value ?? 0 }
        return t
    }()
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
    // "Block ads and trackers": when the list was last fetched or tried,
    // whether a fetch runs, and the engine's verdict being waited for.
    private var adblockTried: Date?
    private var adblockFetching = false
    private var adblockVerdict: CheckedContinuation<(Bool, String?), Never>?
    // The live count (Pinger.swift): pings while on and counted.
    private lazy var pinger = Pinger(queue: queue,
                                     version: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0",
                                     path: { [weak self] in self?.enginePath })

    // MARK: start and stop

    override func startTunnel(options: [String: NSObject]?, completionHandler: @escaping (Error?) -> Void) {
        queue.async { [self] in
            do {
                try bringUp()
                log("Protection on")
                WidgetState.set(on: true)
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
            // The user's Stop: out of the live count at once (the desktop's
            // leave); an end of any other kind lets the id expire.
            if reason == .userInitiated, let p = enginePath, let id = pinger.stop() {
                let done = DispatchSemaphore(value: 0)
                Task { await pinger.leave(id, via: p); done.signal() }
                _ = done.wait(timeout: .now() + OnlineCount.leaveTimeout + 0.2)
            }
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
        // With the user's own server, DNS through it too, never straight
        // out, from the first question (issue #67).
        forwarder.throughEngine(settings.ownServerLink != nil, nil)
        forwarder.useCustom(CustomDns.current(), strict: CustomDns.strict())
        if let c = CustomDns.current() {
            log("DNS server: \(c.kind) \(CustomDns.isIp(c.host) ? "by address" : "by name")\(CustomDns.strict() ? ", only this server" : "")")
        }
        doh = forwarder
        dohPort = try forwarder.start()

        port = try spawnEngine(keep: false)

        v6 = !settings.ipv6Off && underlyingHasIPv6()
        try apply(networkSettings(v6: v6))

        if settings.proxyOnly {
            // The Mac's proxy points at the engine; nothing comes into the
            // tunnel, so no hev.
            log("Shroudly is the Mac's proxy on 127.0.0.1:\(port): apps that use the system proxy go through it, the others straight (Settings: all apps through Shroudly)")
        } else {
            let fd = shroudly_tun_fd()
            guard fd >= 0 else { throw StartError(message: "no tunnel descriptor") }
            try startHev(fd: fd)
        }

        RatingStore().update { RatingSchedule.recordGoodStart(&$0, at: Date()) }
        startWatching()
    }

    /* Everything stopped, in order: hev first (no new connections), then the
     * engine, the forwarder. false when the engine's run did not return. */
    @discardableResult
    private func tearDown() -> Bool {
        stopping = true
        WidgetState.set(on: false)
        _ = pinger.stop()
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
        torRoute.stop()
        TorNotice.reset()
        dnsAround = false
        torAsk = nil
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
            // The last way out (TorRoute), unless turned off or the user's own
            // server carries everything; Tor itself starts when first needed.
            var fallbackPath: String?
            if upstreamPath == nil && settings.torLastResort {
                let path = FileManager.default.temporaryDirectory.appendingPathComponent("engine-fallback").path
                if torRoute.prepare(file: path) { fallbackPath = path }
            }
            e.onDnsAround = { [weak self] _ in
                guard let self else { return }
                self.queue.async { self.dnsAround = true }
                TorNotice.post(key: TorNotice.dnsTextKey, id: "dns-around")
            }
            // The last way out turned off by the user, on a Mac that has it:
            // a site no technique opens asks again, now and then
            // (TorNotice.askAgainDue); "Use Tor" turns it on again.
            if upstreamPath == nil && !settings.torLastResort && TorRoute.available {
                e.onBlocked = { [weak self] host in
                    guard let self else { return }
                    self.queue.async {
                        guard self.torAsk == nil, TorNotice.askAgainDue() else { return }
                        self.log("The last way out is off and a site stays shut; asking again whether to use Tor")
                        self.torAsk = host.lowercased()
                        TorNotice.ask(host)
                    }
                }
            }
            e.onFallback = { [weak self] ok, what, host in
                guard let self else { return }
                if ok { self.logSite("\(what): no technique got through; opened through the last way out (Tor)"); TorNotice.used(what) }
                else if what != "file unusable" {
                    // Tor only once the user said yes (issue #77); until then asked.
                    if TorNotice.approved() { self.torRoute.need() }
                    else {
                        self.queue.async {
                            if self.torAsk == nil { self.log("The last way out: a site needs Tor; asking before it starts") }
                            self.torAsk = host.isEmpty ? (self.torAsk ?? "") : host.lowercased()
                        }
                        TorNotice.ask(host)
                    }
                }
            }
            let args = EngineArgs.make(port: p, dohPort: dohPort, settings: settings, authFile: authPath, blockIps: blockIps, upstreamFile: upstreamPath,
                                       fallbackFile: fallbackPath, httpOpen: settings.proxyOnly)
            let ok = e.start(args: args)
            // Read once, at its start: the secrets are not left lying in a file.
            unlink(authPath)
            if let upstreamPath { unlink(upstreamPath) }
            if let fallbackPath { unlink(fallbackPath) }
            if ok {
                engine = e
                if let a = auth { doh?.engineUp(DohForwarder.EnginePath(port: p, user: a.user, pass: a.pass)) }
                e.onAdblockCheck = { [weak self] ok, why in self?.queue.async { self?.adblockChecked(ok, why) } }
                queue.async { [weak self] in
                    self?.applyBlocks()
                    self?.applyAdblock(fetchAfter: 8)
                    self?.pinger.sync(share: OnlineCount.enabled(), on: true)
                }
                if settings.ownServerLink != nil, let a = auth {
                    doh?.throughEngine(true, DohForwarder.EnginePath(port: p, user: a.user, pass: a.pass))
                }
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

    /* The engine's SOCKS5 port and this session's password, while it runs. */
    private var enginePath: EngineHTTPS.Path? {
        guard engine != nil, !stopping, port > 0, let a = auth else { return nil }
        return EngineHTTPS.Path(port: port, user: a.user, pass: a.pass)
    }

    // MARK: the Connections list

    /* The names the user blocked (Shared/Conns.swift), into the running
     * engine: their open connections end, new ones are refused. */
    private func applyBlocks() {
        guard !stopping, let e = engine else { return }
        let cmds = Conns.commands()
        e.send(cmds.joined(separator: "\n"))
        var said: [String] = []
        let b = Conns.blocked().count, t = Conns.torSites().count
        if b > 0 { said.append("\(b) name\(b == 1 ? "" : "s") you blocked are refused") }
        if t > 0 { said.append("\(t) site\(t == 1 ? "" : "s") you send through Tor go there first") }
        if Conns.onlyMode() { said.append("only the \(Conns.onlySites().count) listed sites are worked on, the rest go out as they are") }
        if !said.isEmpty { log("Connections: " + said.joined(separator: "; ")) }
    }

    // MARK: block ads and trackers

    /* The setting as it is now, into the running engine (no restart), and the
     * list fetched after `fetchAfter` seconds if it is due. */
    private func applyAdblock(fetchAfter: TimeInterval) {
        guard !stopping, let e = engine else { return }
        e.send(AdBlock.commands().joined(separator: "\n"))
        guard AdBlock.enabled(), !adblockFetching, AdBlock.due(lastTry: adblockTried) else { return }
        adblockFetching = true
        queue.asyncAfter(deadline: .now() + fetchAfter) { [weak self] in
            Task { await self?.fetchAdblock() }
        }
    }

    private func fetchAdblock() async {
        let snapshot: (Int, SocksAuth?, Bool) = queue.sync { (port, auth, engine != nil && !stopping) }
        defer { queue.async { self.adblockFetching = false } }
        guard snapshot.2, let a = snapshot.1, AdBlock.enabled() else { return }
        queue.sync { adblockTried = Date() }
        log("Ad blocking: fetching the list")
        do {
            try await AdBlockFetch.fetch(via: EngineHTTPS.Path(port: snapshot.0, user: a.user, pass: a.pass))
        } catch {
            log("Ad blocking: the list could not be fetched (\(error.localizedDescription)); Shroudly tries again later")
            return
        }
        let (ok, why) = await withCheckedContinuation { (c: CheckedContinuation<(Bool, String?), Never>) in
            queue.async { [self] in
                guard let e = engine else { return c.resume(returning: (false, "no engine")) }
                adblockVerdict = c
                e.send("ADBLOCK-CHECK \(AdBlock.newFile.path)")
                queue.asyncAfter(deadline: .now() + 30) { [self] in adblockChecked(false, "no answer") }
            }
        }
        guard ok else {
            AdBlock.discard()
            log("Ad blocking: the list fetched is not one to use (\(why ?? "?"))")
            return
        }
        do { try AdBlock.adopt() } catch {
            log("Ad blocking: the list could not be kept (\(error.localizedDescription))")
            return
        }
        queue.async { [self] in
            guard !stopping, let e = engine else { return }
            e.send(AdBlock.commands().joined(separator: "\n"))
        }
    }

    /* On the queue: the engine's verdict, to whoever waits for it (once). */
    private func adblockChecked(_ ok: Bool, _ why: String?) {
        guard let c = adblockVerdict else { return }
        adblockVerdict = nil
        c.resume(returning: (ok, why))
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
            if settings.proxyOnly {
                // The Mac's proxy names the port: set again when it moved.
                if port != oldPort { try apply(networkSettings(v6: v6)) }
            } else if port != oldPort || auth != oldAuth {
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
        if settings.proxyOnly {
            // The Mac (AppSettings.proxyOnly): no route into the tunnel, the
            // engine as the system's HTTP and HTTPS proxy, as the desktop app
            // sets it; this Mac's own and local addresses go straight.
            let v4 = NEIPv4Settings(addresses: [TunnelConfig.addressV4], subnetMasks: ["255.255.255.255"])
            v4.includedRoutes = []
            s.ipv4Settings = v4
            let p = NEProxySettings()
            let server = NEProxyServer(address: "127.0.0.1", port: port)
            p.httpEnabled = true
            p.httpServer = server
            p.httpsEnabled = true
            p.httpsServer = server
            p.excludeSimpleHostnames = true
            p.exceptionList = ["localhost", "*.local", "127.0.0.1", "::1", "169.254.0.0/16", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]
            // Every name, not only some domains (the tunnel is not the
            // default route here).
            p.matchDomains = [""]
            s.proxySettings = p
            return s
        }
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
        // A few seconds of leeway: the system wakes for it together with
        // other work instead of on its own (battery), and a hung engine is
        // still found within half a minute.
        t.schedule(deadline: .now() + Self.watchEvery, repeating: Self.watchEvery, leeway: .seconds(5))
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
                reply["tunnel"] = settings.proxyOnly || hev?.running == true
            case .siteLog:
                siteLock.lock(); reply["lines"] = sites; siteLock.unlock()
            case .conns:
                // Asked fresh, as the stats are.
                engine?.send("CONNS")
                queue.asyncAfter(deadline: .now() + 0.3) { [self] in
                    completionHandler?(try? JSONSerialization.data(withJSONObject: ["rows": engine?.lastConns ?? []]))
                }
                return
            case .blocks:
                applyBlocks()
            case .torYes:
                torAsk = nil
                log("The last way out: allowed by the user; Tor starts and stays allowed")
                if engine != nil && !stopping { torRoute.need() }
            case .adblock:
                applyAdblock(fetchAfter: 0)
            case .count:
                let path = enginePath
                if let id = pinger.sync(share: OnlineCount.enabled(), on: engine != nil && !stopping), let path {
                    Task { await pinger.leave(id, via: path) }
                }
            case .stats:
                // Asked fresh; the engine answers within a few milliseconds.
                engine?.send("STATS")
                queue.asyncAfter(deadline: .now() + 0.3) { [self] in
                    var s = (engine?.lastStats ?? [:]).filter { $0.value is NSNumber }
                    if let n = pinger.online { s["online"] = n }
                    var out: [String: Any] = ["stats": s]
                    // The last way out at work, for a line under the status.
                    if let t = torRoute.status { out["lastResort"] = t }
                    // A DNS profile or app goes around the tunnel (ContentView's card).
                    if dnsAround { out["dnsAround"] = true }
                    // A site needs Tor, not yet allowed (ContentView's card).
                    if let a = torAsk { out["torAsk"] = a }
                    completionHandler?(try? JSONSerialization.data(withJSONObject: out))
                }
                return
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
