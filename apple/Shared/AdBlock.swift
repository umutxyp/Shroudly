import Foundation

/*
 * "Block ads and trackers" (off by default), as on the desktop and Android
 * (AdBlock.kt). The blocking is the engine's (core/src/adblock.c): a lookup
 * of a listed name gets nothing, a connection to one is ended before
 * anything reaches the network. Here: the switch, the user's exceptions and
 * the list.
 *
 * The list is the compact one (adblock-compact.txt, the AdGuard DNS filter
 * alone, scripts/adblock-list/build.js): iOS ends a packet tunnel past about
 * 50 MB, and the full list takes some 8 MB more while it is read in. The
 * tunnel fetches it through the engine, has the engine check it
 * (ADBLOCK-CHECK) and only then puts it in use, once a week. A failed or
 * wrong download changes nothing.
 */
enum AdBlock {
    static let host = "raw.githubusercontent.com"
    static let path = "/umutxyp/Shroudly/site-list/adblock-compact.txt"
    static let maxBytes = 16 * 1024 * 1024         // the engine's ADB_MAX_FILE
    static let refresh: TimeInterval = 7 * 24 * 3600
    static let retry: TimeInterval = 30 * 60
    static let allowMax = 512                       // the engine's ADBLOCK_ALLOW_MAX

    enum Key {
        static let on = "adBlock"
        static let allow = "adBlockAllow"
    }

    static var file: URL { AppGroup.folder.appendingPathComponent("adblock-list.txt") }
    static var newFile: URL { AppGroup.folder.appendingPathComponent("adblock-list.new") }
    private static var sourceFile: URL { AppGroup.folder.appendingPathComponent("adblock-list.source") }
    static var sourceKey: String { host + path }

    static func enabled(_ d: UserDefaults = AppGroup.defaults) -> Bool { d.bool(forKey: Key.on) }

    static func allow(_ d: UserDefaults = AppGroup.defaults) -> [String] {
        clean((d.string(forKey: Key.allow) ?? "").components(separatedBy: "\n"))
    }

    /* The exceptions as typed: kept cleaned, and returned so. */
    @discardableResult
    static func setAllow(_ text: String, _ d: UserDefaults = AppGroup.defaults) -> [String] {
        let list = clean(text.components(separatedBy: CharacterSet(charactersIn: " \t\n\r,")))
        d.set(list.joined(separator: "\n"), forKey: Key.allow)
        return list
    }

    /* One domain each, any case; a scheme, "*.", a path or port, a trailing
     * dot left out; what is not a domain is dropped (AdBlock.clean). */
    static func clean(_ raw: [String]) -> [String] {
        var out: [String] = []
        var seen = Set<String>()
        for r in raw {
            var d = r.trimmingCharacters(in: .whitespaces).lowercased()
            if let s = d.range(of: "^[a-z]+://", options: .regularExpression) { d.removeSubrange(s) }
            if d.hasPrefix("*.") { d.removeFirst(2) }
            if let cut = d.firstIndex(where: { "/:?#".contains($0) }) { d = String(d[..<cut]) }
            while d.hasSuffix(".") { d.removeLast() }
            guard d.count <= 253, d.range(of: "^[a-z0-9_-]+(\\.[a-z0-9_-]+)+$", options: .regularExpression) != nil else { continue }
            if seen.insert(d).inserted { out.append(d) }
            if out.count == allowMax { break }
        }
        return out
    }

    /* The list to give the engine: on, and one has been fetched. */
    static func listFile(_ d: UserDefaults = AppGroup.defaults) -> URL? {
        guard enabled(d), let n = size(file), n > 0 else { return nil }
        return file
    }

    /* Time to fetch it (again): none yet, a week old, or one from another
     * source; lastTry: not again within half an hour of a failure. */
    static func due(now: Date = Date(), lastTry: Date?) -> Bool {
        if let lastTry, now.timeIntervalSince(lastTry) < retry, now >= lastTry { return false }
        if (try? String(contentsOf: sourceFile, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) != sourceKey { return true }
        guard let n = size(file), n > 0,
              let modified = (try? FileManager.default.attributesOfItem(atPath: file.path))?[.modificationDate] as? Date else { return true }
        return now.timeIntervalSince(modified) >= refresh
    }

    /* The fetched file, checked by the engine, becomes the list in use. */
    static func adopt() throws {
        let fm = FileManager.default
        if fm.fileExists(atPath: file.path) { try fm.removeItem(at: file) }
        try fm.moveItem(at: newFile, to: file)
        try (sourceKey + "\n").write(to: sourceFile, atomically: true, encoding: .utf8)
    }

    static func discard() { try? FileManager.default.removeItem(at: newFile) }

    /* What the running engine is told for the setting as it is now: no
     * restart, nothing dropped. */
    static func commands(_ d: UserDefaults = AppGroup.defaults) -> [String] {
        guard let list = listFile(d) else { return ["ADBLOCK OFF"] }
        return ["ALLOW-CLEAR"] + allow(d).map { "ALLOW \($0)" } + ["ADBLOCK \(list.path)"]
    }

    private static func size(_ url: URL) -> Int? {
        (try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? Int
    }
}
