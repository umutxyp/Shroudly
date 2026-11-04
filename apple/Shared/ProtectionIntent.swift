import AppIntents
import NetworkExtension

/*
 * Protection on or off, for the widgets' switch and the Control Center
 * control (Widgets/), as the app's own button does it. On iPhone and iPad it
 * runs in the app's process (LiveActivityIntent: in the background, the app
 * is not opened), which holds the VPN configuration; the widget only shows.
 */
@available(iOS 17.0, macOS 14.0, tvOS 17.0, *)
struct SetProtection: SetValueIntent {
    static var title: LocalizedStringResource = "start"
    static var openAppWhenRun = false
    static var isDiscoverable = false

    @Parameter(title: "start")
    var value: Bool

    init() {}
    init(_ on: Bool) { value = on }

    func perform() async throws -> some IntentResult {
        let m = try await ProtectionSwitch.manager()
        if value {
            if SettingsStore().load().keepOn && !m.isOnDemandEnabled {
                m.isOnDemandEnabled = true
                try await m.saveToPreferences()
            }
            if m.connection.status != .connected && m.connection.status != .connecting { try m.connection.startVPNTunnel() }
        } else {
            // "Keep protection on" would start it again at once: a stop asked
            // for is a stop.
            if m.isOnDemandEnabled {
                m.isOnDemandEnabled = false
                try await m.saveToPreferences()
            }
            m.connection.stopVPNTunnel()
        }
        WidgetState.set(on: value)
        return .result()
    }
}

#if os(iOS)
import ActivityKit
@available(iOS 17.0, *)
extension SetProtection: LiveActivityIntent {}
#endif

enum ProtectionSwitch {
    struct NotSetUp: LocalizedError {
        var errorDescription: String? { tr("startFailed") }
    }

    /* The app's own VPN configuration (saved the first time the app starts
     * protection and the VPN is allowed). */
    static func manager() async throws -> NETunnelProviderManager {
        let all = try await NETunnelProviderManager.loadAllFromPreferences()
        guard let m = all.first(where: { ($0.protocolConfiguration as? NETunnelProviderProtocol)?.providerBundleIdentifier == Ids.tunnel }) else {
            throw NotSetUp()
        }
        return m
    }
}
