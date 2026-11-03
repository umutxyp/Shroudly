import Foundation

/*
 * The app group the app and its packet tunnel share: the settings (the
 * group's UserDefaults) and the log files (the group's folder).
 *
 * Its name is in both Info.plists (ShroudlyAppGroup), from the build setting
 * SHROUDLY_APP_GROUP (Config/Shroudly.xcconfig): group.me.codeshare.shroudly
 * on iOS, and on macOS the team's prefix with the bundle id, as the Mac App
 * Store wants it. Without the entitlement (an unsigned build, the tests)
 * there is no group: the process's own defaults and a temporary folder stand
 * in, so nothing fails, it is just not shared.
 */
enum AppGroup {
    static var identifier: String? {
        guard let id = Bundle.main.object(forInfoDictionaryKey: "ShroudlyAppGroup") as? String,
              !id.isEmpty, !id.hasPrefix("."), !id.contains("$(") else { return nil }
        return id
    }

    static var defaults: UserDefaults {
        identifier.flatMap { UserDefaults(suiteName: $0) } ?? .standard
    }

    /* The shared folder; created when missing. */
    static var folder: URL {
        let fm = FileManager.default
        let url = identifier.flatMap { fm.containerURL(forSecurityApplicationGroupIdentifier: $0) }
            ?? fm.temporaryDirectory.appendingPathComponent("Shroudly", isDirectory: true)
        try? fm.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
}

/* Bundle ids, and where the app and the tunnel agree on names. */
enum Ids {
    static let app = "me.codeshare.shroudly"
    static let tunnel = "me.codeshare.shroudly.tunnel"
    static let repoURL = URL(string: "https://github.com/umutxyp/Shroudly")!
    static let privacyURL = URL(string: "https://codeshare.me/projects/shroudly/privacy")!
}
