import AppIntents
import NetworkExtension

/*
 * Shortcuts and Siri: start or stop protection without opening the app
 * (Android's automation broadcasts, AutomationReceiver.kt). They act on the
 * VPN configuration the app saved; before the app has been opened once and
 * the VPN allowed there is none, and they say so.
 */
@available(iOS 16.0, macOS 13.0, tvOS 16.0, *)
struct StartProtection: AppIntent {
    static var title: LocalizedStringResource = "start"
    static var openAppWhenRun = false

    func perform() async throws -> some IntentResult {
        let m = try await ProtectionSwitch.manager()
        // "Keep protection on", as the app's own start sets it.
        if SettingsStore().load().keepOn && !m.isOnDemandEnabled {
            m.isOnDemandEnabled = true
            try await m.saveToPreferences()
        }
        if m.connection.status != .connected && m.connection.status != .connecting {
            try m.connection.startVPNTunnel()
        }
        return .result()
    }
}

@available(iOS 16.0, macOS 13.0, tvOS 16.0, *)
struct StopProtection: AppIntent {
    static var title: LocalizedStringResource = "stop"
    static var openAppWhenRun = false

    func perform() async throws -> some IntentResult {
        let m = try await ProtectionSwitch.manager()
        // "Keep protection on" would start it again at once: a stop asked for
        // is a stop, as the app's own button does it.
        if m.isOnDemandEnabled {
            m.isOnDemandEnabled = false
            try await m.saveToPreferences()
        }
        m.connection.stopVPNTunnel()
        return .result()
    }
}

@available(iOS 16.0, macOS 13.0, tvOS 16.0, *)
struct ShroudlyShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: StartProtection(), phrases: ["\(.applicationName) start", "Start \(.applicationName)"],
                    shortTitle: "start", systemImageName: "power")
        AppShortcut(intent: StopProtection(), phrases: ["\(.applicationName) stop", "Stop \(.applicationName)"],
                    shortTitle: "stop", systemImageName: "power.dotted")
    }
}
