import Foundation
import Security
#if canImport(WidgetKit) && !os(tvOS)
import WidgetKit
#endif

/* What the widgets and the Control Center switch show: whether protection
 * is on and since when, written by the app and the packet tunnel as it
 * changes (the widgets cannot ask the system themselves). Kept in a
 * keychain group the three share (ShroudlyKeychainGroup in their
 * Info.plists, keychain-access-groups in their entitlements), which needs no
 * setup on Apple's side beyond the team's own profiles. An unsigned build
 * has no group: the process's own defaults stand in. */
enum WidgetState {
    private static let service = "me.codeshare.shroudly.widget"
    private static let account = "state"

    private static var group: String? {
        guard let g = Bundle.main.object(forInfoDictionaryKey: "ShroudlyKeychainGroup") as? String,
              !g.isEmpty, !g.hasPrefix("."), !g.contains("$(") else { return nil }
        return g
    }

    private struct State: Codable { var on: Bool; var since: Double }

    private static func base() -> [String: Any] {
        var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                kSecAttrService as String: service,
                                kSecAttrAccount as String: account]
        if let group { q[kSecAttrAccessGroup as String] = group }
        #if os(macOS)
        q[kSecUseDataProtectionKeychain as String] = true
        #endif
        return q
    }

    private static func read() -> State? {
        guard group != nil else {
            let d = UserDefaults.standard
            return d.object(forKey: "widgetOn") == nil ? nil : State(on: d.bool(forKey: "widgetOn"), since: d.double(forKey: "widgetSince"))
        }
        var q = base()
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return try? JSONDecoder().decode(State.self, from: d)
    }

    private static func write(_ s: State) {
        guard group != nil else {
            UserDefaults.standard.set(s.on, forKey: "widgetOn")
            UserDefaults.standard.set(s.since, forKey: "widgetSince")
            return
        }
        guard let data = try? JSONEncoder().encode(s) else { return }
        let q = base()
        let attrs: [String: Any] = [kSecValueData as String: data,
                                    kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock]
        if SecItemUpdate(q as CFDictionary, attrs as CFDictionary) == errSecItemNotFound {
            SecItemAdd(q.merging(attrs) { $1 } as CFDictionary, nil)
        }
    }

    static var on: Bool { read()?.on ?? false }
    static var since: Date? {
        guard let s = read(), s.on, s.since > 0 else { return nil }
        return Date(timeIntervalSince1970: s.since)
    }

    static func set(on: Bool, since: Date? = nil) {
        #if os(tvOS)
        return
        #else
        let old = read()
        guard old?.on != on || (on && since != nil && old?.since == 0) else { return }
        write(State(on: on, since: on ? (since ?? Date()).timeIntervalSince1970 : 0))
        #if canImport(WidgetKit)
        WidgetCenter.shared.reloadAllTimelines()
        #if os(iOS)
        if #available(iOS 18.0, *) { ControlCenter.shared.reloadAllControls() }
        #endif
        #endif
        #endif
    }
}
