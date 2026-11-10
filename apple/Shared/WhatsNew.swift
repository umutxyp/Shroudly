import CryptoKit
import Foundation

/*
 * After an update, the main screen says once what changed (whatsNewApple, a
 * line each, in the user's language), as the desktop and Android do: the
 * version last opened is kept, and an opening with another one leaves its
 * notes to be shown until they are closed. A new install shows nothing; one
 * from before 2.6.48, which kept no version, counts as updated once the user
 * has been through the first screen (noticeSeen).
 *
 * Notes already shown are not shown again, and no notes show nothing, as on
 * the desktop: a version whose notes were not rewritten showed the old ones
 * under the new number (2.6.65 to 2.6.70 all said 2.6.64's).
 */

enum WhatsNew {
    static let seenKey = "lastVersionSeen"
    static let pendingKey = "whatsNew"
    static let notesKey = "whatsNewNotes"

    /* The version whose notes to show now, or nil. */
    static func decide(lastSeen: String?, current: String, usedBefore: Bool, sameNotes: Bool = false) -> String? {
        if lastSeen == current { return nil }
        if sameNotes { return nil }
        if lastSeen == nil { return usedBefore ? current : nil }
        return current
    }

    static func pending(_ d: UserDefaults = .standard, current: String, usedBefore: Bool, notes: String) -> String? {
        let last = d.string(forKey: seenKey)
        if last != current {
            d.set(current, forKey: seenKey)
            let h = digest(notes)
            let same = h == nil || h == d.string(forKey: notesKey)
            if let h { d.set(h, forKey: notesKey) }
            if let show = decide(lastSeen: last, current: current, usedBefore: usedBefore, sameNotes: same) { d.set(show, forKey: pendingKey) }
        }
        return d.string(forKey: pendingKey)
    }

    static func seen(_ d: UserDefaults = .standard) { d.removeObject(forKey: pendingKey) }

    /* The notes as the strings give them; none when the key itself came
     * back (no such string): a version with nothing new here leaves them empty. */
    static func notes(_ text: String, key: String) -> String { text == key ? "" : text }

    /* The notes, as a short digest: the same notes, the same digest; nil for
     * no notes. */
    static func digest(_ text: String) -> String? {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return nil }
        return SHA256.hash(data: Data(t.utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
    }

    /* The notes as shown: one line each, a bullet before it. */
    static func lines(_ text: String) -> String {
        text.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.map { "• \($0)" }.joined(separator: "\n")
    }
}
