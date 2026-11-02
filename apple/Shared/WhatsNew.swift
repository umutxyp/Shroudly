import Foundation

/*
 * After an update, the main screen says once what changed (whatsNewApple, a
 * line each, in the user's language), as the desktop and Android do: the
 * version last opened is kept, and an opening with another one leaves its
 * notes to be shown until they are closed. A new install shows nothing; one
 * from before 2.6.48, which kept no version, counts as updated once the user
 * has been through the first screen (noticeSeen).
 */
enum WhatsNew {
    static let seenKey = "lastVersionSeen"
    static let pendingKey = "whatsNew"

    /* The version whose notes to show now, or nil. */
    static func decide(lastSeen: String?, current: String, usedBefore: Bool) -> String? {
        if lastSeen == current { return nil }
        if lastSeen == nil { return usedBefore ? current : nil }
        return current
    }

    static func pending(_ d: UserDefaults = .standard, current: String, usedBefore: Bool) -> String? {
        let last = d.string(forKey: seenKey)
        if last != current {
            d.set(current, forKey: seenKey)
            if let show = decide(lastSeen: last, current: current, usedBefore: usedBefore) { d.set(show, forKey: pendingKey) }
        }
        return d.string(forKey: pendingKey)
    }

    static func seen(_ d: UserDefaults = .standard) { d.removeObject(forKey: pendingKey) }

    /* The notes as shown: one line each, a bullet before it. */
    static func lines(_ text: String) -> String {
        text.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.map { "• \($0)" }.joined(separator: "\n")
    }
}
