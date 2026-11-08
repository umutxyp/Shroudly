import SwiftUI

#if os(tvOS)
/*
 * Apple TV's counters: large tiles of the same size, read from the sofa.
 * Protection shows four (the speeds, connections, time on); Stats shows
 * them all, as the desktop's Stats tab (components/StatsPanel.js).
 */
struct TVStats: View {
    let on: Bool
    let since: Date?
    let stats: EngineStats?
    var full = false

    @State private var down = 0.0
    @State private var up = 0.0
    @State private var last: (at: Date, down: Int64, up: Int64)?

    var body: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 28), count: full ? 3 : 2), spacing: 28) {
            if full, on, let online = stats?.online {
                Tile(icon: "person.2", label: tr("onlineNow"), value: online.formatted(.number), tint: Theme.ok)
            }
            Tile(icon: "arrow.down", label: tr("download"), value: on ? "\(Self.bytes(down))/s" : "0 B/s", tint: Theme.accent)
            Tile(icon: "arrow.up", label: tr("upload"), value: on ? "\(Self.bytes(up))/s" : "0 B/s")
            Tile(icon: "link", label: tr("connections"), value: on ? (stats?.active ?? 0).formatted(.number) : "0",
                 sub: tr("totalCount", ["count": on ? (stats?.total ?? 0).formatted(.number) : "0"]))
            if full {
                Tile(icon: "checkmark.shield", label: tr("bypassed"), value: on ? (stats?.desync ?? 0).formatted(.number) : "0")
                Tile(icon: "cylinder", label: tr("dataTransferred"),
                     value: Self.bytes(on ? Double((stats?.down ?? 0) + (stats?.up ?? 0)) : 0))
            }
            Tile(icon: "clock", label: tr("uptime"), value: nil, since: on ? since : nil)
            if full, on, let ads = stats?.blocked, ads > 0 {
                Tile(icon: "checkmark.shield", label: tr("adsBlocked"), value: ads.formatted(.number))
            }
        }
        .onChange(of: stats) { s in sample(s) }
        .onChange(of: on) { _ in down = 0; up = 0; last = nil }
    }

    /* The speeds: what the counters grew by since the last answer. */
    private func sample(_ s: EngineStats?) {
        guard let s else { return }
        let now = Date()
        if let l = last {
            let dt = max(0.5, now.timeIntervalSince(l.at))
            down = Double(max(0, s.down - l.down)) / dt
            up = Double(max(0, s.up - l.up)) / dt
        }
        last = (now, s.down, s.up)
    }

    /* As the desktop writes them: 0 B, 512 B, 1.5 KB, 23 MB. */
    static func bytes(_ n: Double) -> String {
        guard n > 0 else { return "0 B" }
        let units = ["B", "KB", "MB", "GB", "TB"]
        var v = n, i = 0
        while v >= 1024 && i < units.count - 1 { v /= 1024; i += 1 }
        return String(format: v < 10 && i > 0 ? "%.1f %@" : "%.0f %@", v, units[i])
    }

    private struct Tile: View {
        let icon: String
        let label: String
        let value: String?
        var sub: String? = nil
        var since: Date? = nil
        var tint: Color = Theme.text

        var body: some View {
            VStack(alignment: .leading, spacing: 10) {
                Label(label, systemImage: icon)
                    .font(.system(size: 26, weight: .medium))
                    .foregroundStyle(Theme.secondaryText)
                    .lineLimit(1)
                Group {
                    if let value {
                        Text(value)
                    } else if let since {
                        TimelineView(.periodic(from: since, by: 1)) { ctx in
                            Text(Self.duration(ctx.date.timeIntervalSince(since)))
                        }
                    } else {
                        Text("0:00")
                    }
                }
                .font(.system(size: 52, weight: .semibold).monospacedDigit())
                .foregroundStyle(tint)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
                Text(sub ?? " ")
                    .font(.system(size: 22))
                    .foregroundStyle(Theme.faintText)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(28)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 24))
            .overlay(RoundedRectangle(cornerRadius: 24).stroke(Theme.line, lineWidth: 1))
            .accessibilityElement(children: .combine)
        }

        static func duration(_ t: TimeInterval) -> String {
            let s = max(0, Int(t))
            return s >= 3600 ? String(format: "%d:%02d:%02d", s / 3600, s / 60 % 60, s % 60) : String(format: "%d:%02d", s / 60, s % 60)
        }
    }
}
#endif
