import Foundation

/*
 * The log the app and its packet tunnel keep in the app group's folder, one
 * file each, for "Share logs". Lines that can name a site (the engine's own
 * text) are never written here; the tunnel keeps those in memory only
 * (Tunnel/PacketTunnelProvider.swift). A file past maxBytes keeps its last
 * keepLines lines.
 */
final class SharedLog {
    static let maxBytes = 256 * 1024
    static let keepLines = 1000

    let url: URL
    private let queue = DispatchQueue(label: "me.codeshare.shroudly.log")
    private let stamp: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd HH:mm:ss.SSS"
        return f
    }()

    init(name: String, folder: URL = AppGroup.folder) {
        url = folder.appendingPathComponent(name)
    }

    func write(_ line: String) {
        let text = "\(stamp.string(from: Date())) \(line)\n"
        #if DEBUG
        NSLog("%@", line)
        #endif
        queue.async { [url] in
            let data = Data(text.utf8)
            if let h = try? FileHandle(forWritingTo: url) {
                defer { try? h.close() }
                let end = h.seekToEndOfFile()
                h.write(data)
                if end + UInt64(data.count) > UInt64(SharedLog.maxBytes) { SharedLog.trim(url) }
            } else {
                try? data.write(to: url, options: .atomic)
            }
        }
    }

    /* The last n lines. */
    func tail(_ n: Int) -> [String] {
        queue.sync {
            guard let text = try? String(contentsOf: url, encoding: .utf8) else { return [] }
            return Array(text.split(separator: "\n", omittingEmptySubsequences: true).suffix(n).map(String.init))
        }
    }

    private static func trim(_ url: URL) {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return }
        let lines = text.split(separator: "\n", omittingEmptySubsequences: true).suffix(keepLines)
        try? (lines.joined(separator: "\n") + "\n").write(to: url, atomically: true, encoding: .utf8)
    }
}

/* What the app asks the running tunnel (NETunnelProviderSession
 * sendProviderMessage), and what it answers: JSON. */
enum ProviderMessage: String {
    /* {"engine": Bool, "tunnel": Bool}: both run and the engine answers. */
    case health
    /* {"lines": [String]}: the site lines kept in memory. */
    case siteLog
    /* {"stats": {...}}: the engine's counters a moment ago (its STATS line:
     * conns_active, conns_total, bytes_up, bytes_down, blocked). */
    case stats
    /* {}: "Block ads and trackers" or its exceptions changed: the running
     * engine is told, and the list fetched if it is due. */
    case adblock
    /* {}: "Count me in the live total" changed: counting starts, or stops
     * with a leave. */
    case count
    /* {"rows": [{...}]}: the Connections list (Shared/Conns.swift), as the
     * engine counts it. */
    case conns
    /* {}: the names blocked in the Connections list changed: the running
     * engine is given them again. */
    case blocks
    /* {}: the user said yes to Tor (ContentView's card, issue #77): the
     * last way out starts now, and is kept allowed (TorAsk.approvedKey). */
    case torYes
}
