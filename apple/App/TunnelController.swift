import Foundation
import NetworkExtension

/*
 * The app's side of protection: the VPN configuration the system keeps for
 * Shroudly (NETunnelProviderManager), starting and stopping the packet
 * tunnel, and its status as the system reports it.
 *
 * The first Start adds the configuration, which the system asks the user to
 * allow once. "Keep protection on" is the system's on-demand rule: it starts
 * the tunnel again by itself after a restart or a drop, until Stop, which
 * turns the rule off first (or the system would start it again at once).
 *
 * A failure is said once (notice): a start that did not come up, or
 * protection that ended without the user stopping it, either by an error
 * (the tunnel then lets apps connect directly) or by the system, usually for
 * another VPN app.
 */
@MainActor
final class TunnelController: ObservableObject {
    enum Phase { case off, starting, on, stopping }

    @Published private(set) var phase: Phase = .off
    @Published private(set) var connectedSince: Date?
    @Published var notice: String?
    /* This copy may not make a VPN at all: signed without Apple's VPN
     * permission (VpnErrors, issue #65). The notice says so, with how to
     * install it properly. */
    @Published private(set) var vpnNotAllowed = false

    private var manager: NETunnelProviderManager?
    private var observer: NSObjectProtocol?
    private var lastStatus: NEVPNStatus = .invalid
    private var userStopped = false
    private let log = SharedLog(name: "app.log")
    private let store = SettingsStore()

    func load() async {
        do {
            let all = try await NETunnelProviderManager.loadAllFromPreferences()
            manager = all.first { ($0.protocolConfiguration as? NETunnelProviderProtocol)?.providerBundleIdentifier == Ids.tunnel }
        } catch {
            log.write("Reading the VPN configuration: \(error.localizedDescription)")
            if VpnErrors.missingPermission(error, reading: true) {
                vpnNotAllowed = true
                notice = tr("appleVpnNotSigned")
                log.write("This copy is signed without the VPN permission (Network Extension): iOS will not ask for it")
            }
        }
        observe()
        lastStatus = manager?.connection.status ?? .invalid
        update(manager?.connection.status ?? .invalid)
    }

    func start() async {
        notice = nil
        userStopped = false
        let m: NETunnelProviderManager
        do {
            m = try await prepared(keepOn: store.load().keepOn)
        } catch {
            log.write("Saving the VPN configuration: \(error.localizedDescription)")
            if vpnNotAllowed || VpnErrors.missingPermission(error, reading: false) {
                vpnNotAllowed = true
                notice = tr("appleVpnNotSigned")
            } else {
                notice = tr("androidVpnDenied")
            }
            return
        }
        do {
            try m.connection.startVPNTunnel()
            log.write("Start asked")
        } catch {
            log.write("Start: \(error.localizedDescription)")
            notice = "\(tr("startFailed")): \(error.localizedDescription)"
        }
    }

    func stop() async {
        guard let m = manager else { return }
        userStopped = true
        notice = nil
        if m.isOnDemandEnabled {
            m.isOnDemandEnabled = false
            try? await m.saveToPreferences()
        }
        m.connection.stopVPNTunnel()
        log.write("Stop asked")
    }

    /* The settings changed: the on-demand rule follows "keep protection on",
     * and a running tunnel is started again when what it runs with changed. */
    func settingsChanged(from old: AppSettings, to new: AppSettings) async {
        guard let m = manager else { return }
        if old.keepOn != new.keepOn, m.isEnabled {
            applyOnDemand(m, keepOn: new.keepOn && phase != .off)
            try? await m.saveToPreferences()
        }
        guard !old.sameTunnel(as: new), phase == .on || phase == .starting else { return }
        log.write("Settings changed: starting protection again")
        await restart()
    }

    private func restart() async {
        guard let m = manager else { return }
        userStopped = true
        m.connection.stopVPNTunnel()
        for _ in 0..<50 where m.connection.status != .disconnected && m.connection.status != .invalid {
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        await start()
    }

    /* The engine and the tunnel run and the engine answers, as the tunnel says. */
    func healthy() async -> Bool {
        guard phase == .on, let session = manager?.connection as? NETunnelProviderSession else { return false }
        let data: Data? = await withCheckedContinuation { done in
            do {
                try session.sendProviderMessage(Data(ProviderMessage.health.rawValue.utf8)) { done.resume(returning: $0) }
            } catch {
                done.resume(returning: nil)
            }
        }
        guard let data, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
        return obj["engine"] as? Bool == true && obj["tunnel"] as? Bool == true
    }

    /* "Block ads and trackers" changed: the running tunnel is told (it
     * reads the setting from the app group). Nothing to do while off. */
    func adblockChanged() {
        guard phase == .on, let session = manager?.connection as? NETunnelProviderSession else { return }
        try? session.sendProviderMessage(Data(ProviderMessage.adblock.rawValue.utf8)) { _ in }
    }

    /* "Count me in the live total" changed: the running tunnel is told. */
    func countChanged() {
        guard phase == .on, let session = manager?.connection as? NETunnelProviderSession else { return }
        try? session.sendProviderMessage(Data(ProviderMessage.count.rawValue.utf8)) { _ in }
    }

    /* The engine's counters, while protection is on. */
    func stats() async -> EngineStats? {
        guard phase == .on, let session = manager?.connection as? NETunnelProviderSession else { return nil }
        let data: Data? = await withCheckedContinuation { done in
            do {
                try session.sendProviderMessage(Data(ProviderMessage.stats.rawValue.utf8)) { done.resume(returning: $0) }
            } catch {
                done.resume(returning: nil)
            }
        }
        guard let data, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let s = obj["stats"] as? [String: Any], !s.isEmpty else { return nil }
        return EngineStats(s)
    }

    /* The site lines the tunnel keeps in memory, for "Share logs". */
    func siteLog() async -> [String] {
        guard phase == .on, let session = manager?.connection as? NETunnelProviderSession else { return [] }
        let data: Data? = await withCheckedContinuation { done in
            do {
                try session.sendProviderMessage(Data(ProviderMessage.siteLog.rawValue.utf8)) { done.resume(returning: $0) }
            } catch {
                done.resume(returning: nil)
            }
        }
        guard let data, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [] }
        return obj["lines"] as? [String] ?? []
    }

    private func prepared(keepOn: Bool) async throws -> NETunnelProviderManager {
        let m = manager ?? NETunnelProviderManager()
        let p = (m.protocolConfiguration as? NETunnelProviderProtocol) ?? NETunnelProviderProtocol()
        p.providerBundleIdentifier = Ids.tunnel
        // What Settings → VPN shows under the name; there is no server.
        p.serverAddress = "Shroudly"
        p.disconnectOnSleep = false
        m.protocolConfiguration = p
        m.localizedDescription = "Shroudly"
        m.isEnabled = true
        applyOnDemand(m, keepOn: keepOn)
        try await m.saveToPreferences()
        // A configuration just saved has to be read back before it can start.
        try await m.loadFromPreferences()
        manager = m
        observe()
        return m
    }

    private func applyOnDemand(_ m: NETunnelProviderManager, keepOn: Bool) {
        let rule = NEOnDemandRuleConnect()
        rule.interfaceTypeMatch = .any
        m.onDemandRules = [rule]
        m.isOnDemandEnabled = keepOn
    }

    private func observe() {
        guard observer == nil else { return }
        observer = NotificationCenter.default.addObserver(forName: .NEVPNStatusDidChange, object: nil, queue: .main) { [weak self] note in
            guard let connection = note.object as? NEVPNConnection else { return }
            Task { @MainActor in
                guard let self, connection === self.manager?.connection else { return }
                self.update(connection.status)
            }
        }
    }

    private func update(_ status: NEVPNStatus) {
        let before = lastStatus
        lastStatus = status
        switch status {
        case .connecting:
            phase = .starting
        case .connected, .reasserting:
            phase = .on
            connectedSince = manager?.connection.connectedDate ?? connectedSince ?? Date()
            notice = nil
        case .disconnecting:
            phase = .stopping
        default:
            phase = .off
            connectedSince = nil
            if before != .invalid && before != .disconnected && !userStopped { explainStop(after: before) }
            userStopped = false
        }
    }

    /* Protection ended without Stop: why, as the system tells it. */
    private func explainStop(after before: NEVPNStatus) {
        guard let connection = manager?.connection else { return }
        connection.fetchLastDisconnectError { [weak self] error in
            Task { @MainActor in
                guard let self, self.phase == .off else { return }
                let detail = error.map { ": \($0.localizedDescription)" } ?? ""
                self.log.write("Protection ended\(detail)")
                if before == .connecting {
                    self.notice = "\(tr("startFailed"))\(detail)"
                } else {
                    self.notice = error == nil ? tr("appleVpnRevoked") : tr("androidProtectionLost")
                }
            }
        }
    }
}
