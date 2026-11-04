import SwiftUI

/* The engine's counters as the app shows them (Android's stats cards). */
struct EngineStats: Equatable {
    var active: Int64 = 0
    var total: Int64 = 0
    var up: Int64 = 0
    var down: Int64 = 0
    var blocked: Int64 = 0
    /* How many apps are online now (the live count), when counted. */
    var online: Int64?

    init(_ d: [String: Any]) {
        func n(_ k: String) -> Int64 { (d[k] as? NSNumber)?.int64Value ?? 0 }
        active = n("conns_active"); total = n("conns_total")
        up = n("bytes_up"); down = n("bytes_down"); blocked = n("blocked")
        online = (d["online"] as? NSNumber)?.int64Value
    }
}

/* Under the switch: connections, how long it has been on, what went down
 * and up. Before protection starts, a line saying where the numbers come from. */
struct StatsView: View {
    #if os(macOS)
    static let oneRow = true
    #else
    static let oneRow = false
    #endif

    let on: Bool
    let since: Date?
    let stats: EngineStats?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(tr("navStats"))
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Theme.secondaryText)
                .padding(.horizontal, 4)
            if !on {
                Label(tr("statsInactiveHint"), systemImage: "info.circle")
                    .font(.footnote)
                    .foregroundStyle(Theme.secondaryText)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                    .background(Theme.card, in: RoundedRectangle(cornerRadius: 14))
            }
            // The Mac's small window: the four in one row, so a notice fits too.
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: Self.oneRow ? 4 : 2), spacing: 10) {
                Cell(icon: "link", title: tr("connections"), value: on ? number(stats?.active) : "–", sub: on ? totalLine : nil)
                Cell(icon: "clock", title: tr("uptime"), value: nil, sub: nil, since: on ? since : nil)
                Cell(icon: "arrow.down", title: tr("download"), value: on ? bytes(stats?.down) : "–", sub: nil)
                Cell(icon: "arrow.up", title: tr("upload"), value: on ? bytes(stats?.up) : "–", sub: nil)
            }
            if on, let n = stats?.online {
                Text("\(tr("onlineNow")): \(n.formatted(.number))")
                    .font(.footnote)
                    .foregroundStyle(Theme.secondaryText)
                    .padding(.horizontal, 4)
            }
        }
        .padding(.horizontal, 16)
    }

    private var totalLine: String? {
        guard let s = stats else { return nil }
        let total = tr("totalCount", ["count": number(s.total)])
        return s.blocked > 0 ? "\(total) · \(tr("adsBlocked")): \(number(s.blocked))" : total
    }

    private func number(_ v: Int64?) -> String {
        guard let v else { return "–" }
        return v.formatted(.number)
    }

    private func bytes(_ v: Int64?) -> String {
        guard let v else { return "–" }
        return ByteCountFormatter.string(fromByteCount: v, countStyle: .binary)
    }

    private struct Cell: View {
        let icon: String
        let title: String
        let value: String?
        let sub: String?
        var since: Date? = nil

        var body: some View {
            VStack(alignment: .leading, spacing: 6) {
                Label(title, systemImage: icon)
                    .font(StatsView.oneRow ? .caption2 : .footnote)
                    .foregroundStyle(Theme.secondaryText)
                    .lineLimit(StatsView.oneRow ? 2 : 1)
                    .fixedSize(horizontal: false, vertical: StatsView.oneRow)
                Group {
                    if let value {
                        Text(value)
                    } else if let since {
                        // Ticks every second without asking the tunnel.
                        TimelineView(.periodic(from: since, by: 1)) { ctx in
                            Text(Self.duration(ctx.date.timeIntervalSince(since)))
                        }
                    } else {
                        Text("–")
                    }
                }
                .font((StatsView.oneRow ? Font.callout : Font.title3).weight(.semibold).monospacedDigit())
                .foregroundStyle(.white)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
                if let sub {
                    Text(sub)
                        .font(.caption2)
                        .foregroundStyle(Theme.secondaryText)
                        .lineLimit(2)
                }
            }
            .frame(maxWidth: .infinity, minHeight: StatsView.oneRow ? 44 : 64, alignment: .topLeading)
            .padding(StatsView.oneRow ? 9 : 12)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 14))
            .accessibilityElement(children: .combine)
        }

        /* 0:08, 12:34, 1:02:03 (Android's Format.duration). */
        static func duration(_ t: TimeInterval) -> String {
            let s = max(0, Int(t))
            let h = s / 3600, m = (s % 3600) / 60, sec = s % 60
            return h > 0 ? String(format: "%d:%02d:%02d", h, m, sec) : String(format: "%d:%02d", m, sec)
        }
    }
}
