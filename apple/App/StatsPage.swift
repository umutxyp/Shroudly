import SwiftUI

#if !os(tvOS)
/*
 * The Stats tab, as the desktop app's (components/StatsPanel.js): before
 * protection starts a line saying where the numbers come from; the people
 * online now; download and upload as they go, each with its last minute
 * drawn; connections, what got through, data and uptime two by two; and
 * Connections by site under them, with search and blocking (issue #74).
 * The counters come from ContentView, asked every two seconds while on.
 */
struct StatsPage: View {
    let on: Bool
    let since: Date?
    let stats: EngineStats?

    @State private var down: [Double] = []
    @State private var up: [Double] = []
    @State private var last: (at: Date, down: Int64, up: Int64)?

    var body: some View {
        ScrollView {
            VStack(spacing: 12) {
                if !on {
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: "info.circle").foregroundStyle(Theme.accent)
                        Text(tr("statsInactiveHint"))
                            .foregroundStyle(Theme.secondaryText)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .font(.system(size: 13))
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                    .background(Theme.accent.opacity(0.12), in: RoundedRectangle(cornerRadius: Theme.radiusSmall))
                    .overlay(RoundedRectangle(cornerRadius: Theme.radiusSmall).stroke(Theme.accent.opacity(0.38), lineWidth: 1))
                }
                online
                rates
                // Two by two while each counter has the room its words need,
                // one under the other once they would be squeezed (Pair).
                Pair(a: Counter(icon: "link", label: tr("connections"), value: on ? number(stats?.active ?? 0) : "0",
                                sub: tr("totalCount", ["count": on ? number(stats?.total ?? 0) : "0"])),
                     b: Counter(icon: "checkmark.shield", label: tr("bypassed"), value: on ? number(stats?.desync ?? 0) : "0", sub: " "))
                Pair(a: Counter(icon: "cylinder", label: tr("dataTransferred"),
                                value: Self.bytes(on ? Double((stats?.down ?? 0) + (stats?.up ?? 0)) : 0)),
                     b: Counter(icon: "clock", label: tr("uptime"), value: nil, since: on ? since : nil))
                if on, let ads = stats?.blocked, ads > 0 {
                    Counter(icon: "checkmark.shield", label: tr("adsBlocked"), value: number(ads))
                }
                ConnectionsSection(on: on)
            }
            .frame(maxWidth: 560)
            .padding(16)
            .frame(maxWidth: .infinity)
        }
        .macScrollBarHidden()
        .onChange(of: stats) { s in sample(s) }
        .onChange(of: on) { _ in down = []; up = []; last = nil }
    }

    /* The people using Shroudly now, worldwide (the tunnel's live count). */
    private var online: some View {
        HStack(spacing: 12) {
            ZStack(alignment: .topTrailing) {
                Image(systemName: "person.2")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Theme.ok)
                    .frame(width: 36, height: 36)
                    .background(Theme.ok.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
                Circle().fill(Theme.ok).frame(width: 9, height: 9)
                    .overlay(Circle().stroke(Theme.card, lineWidth: 2))
                    .offset(x: 2, y: -2)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(tr("onlineNow")).font(.system(size: 12.5, weight: .medium)).foregroundStyle(Theme.secondaryText)
                Text(tr("onlineNowDesc")).font(.system(size: 11.5)).foregroundStyle(Theme.faintText)
            }
            Spacer(minLength: 8)
            Text(on ? (stats?.online.map { $0.formatted(.number) } ?? "—") : "—")
                .font(.system(size: 24, weight: .semibold).monospacedDigit())
                .foregroundStyle(Theme.text)
        }
        .padding(16)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: Theme.radius))
        .overlay(RoundedRectangle(cornerRadius: Theme.radius).stroke(Theme.line, lineWidth: 1))
    }

    private var rates: some View {
        VStack(spacing: 16) {
            Rate(icon: "arrow.down", label: tr("download"), value: rate(down.last), color: Theme.accent, data: down)
            Rate(icon: "arrow.up", label: tr("upload"), value: rate(up.last), color: Theme.secondaryText, data: up)
        }
        .padding(16)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: Theme.radius))
        .overlay(RoundedRectangle(cornerRadius: Theme.radius).stroke(Theme.line, lineWidth: 1))
    }

    /* Bytes a second from two readings in a row; the last 30 kept. */
    private func sample(_ s: EngineStats?) {
        guard on, let s else { return }
        let now = Date()
        if let l = last, now.timeIntervalSince(l.at) > 0.2 {
            let dt = now.timeIntervalSince(l.at)
            down.append(max(0, Double(s.down - l.down) / dt))
            up.append(max(0, Double(s.up - l.up) / dt))
            if down.count > 30 { down.removeFirst(down.count - 30) }
            if up.count > 30 { up.removeFirst(up.count - 30) }
        }
        last = (now, s.down, s.up)
    }

    private func rate(_ v: Double?) -> String { "\(Self.bytes(v ?? 0))/s" }

    /* As the desktop writes them (components/StatsPanel.js fmtBytes): 0 B,
     * 512 B, 1.5 KB, 23 MB. */
    static func bytes(_ n: Double) -> String {
        guard n > 0 else { return "0 B" }
        let units = ["B", "KB", "MB", "GB", "TB"]
        var v = n, i = 0
        while v >= 1024 && i < units.count - 1 { v /= 1024; i += 1 }
        return String(format: v < 10 && i > 0 ? "%.1f %@" : "%.0f %@", v, units[i])
    }

    private func number(_ v: Int64) -> String { v.formatted(.number) }

    private struct Rate: View {
        let icon: String
        let label: String
        let value: String
        let color: Color
        let data: [Double]

        var body: some View {
            VStack(spacing: 8) {
                HStack {
                    Label(label, systemImage: icon)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Theme.secondaryText)
                    Spacer()
                    Text(value)
                        .font(.system(size: 17, weight: .semibold).monospacedDigit())
                        .foregroundStyle(color)
                }
                Spark(data: data, color: color)
                    .frame(height: 34)
            }
        }
    }

    /* The last minute of a rate: a line over a dashed floor. */
    private struct Spark: View {
        let data: [Double]
        let color: Color

        var body: some View {
            GeometryReader { g in
                ZStack(alignment: .bottom) {
                    Path { p in
                        p.move(to: CGPoint(x: 0, y: g.size.height - 1))
                        p.addLine(to: CGPoint(x: g.size.width, y: g.size.height - 1))
                    }
                    .stroke(Theme.lineStrong, style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
                    if data.count > 1 {
                        let top = max(data.max() ?? 1, 1)
                        Path { p in
                            for (i, v) in data.enumerated() {
                                let x = g.size.width * CGFloat(i) / CGFloat(max(data.count - 1, 1))
                                let y = (g.size.height - 2) * (1 - CGFloat(v / top)) + 1
                                if i == 0 { p.move(to: CGPoint(x: x, y: y)) } else { p.addLine(to: CGPoint(x: x, y: y)) }
                            }
                        }
                        .stroke(color, style: StrokeStyle(lineWidth: 1.6, lineCap: .round, lineJoin: .round))
                    }
                }
            }
        }
    }

    /* Two boxes side by side while each still has the room its words need,
     * else one under the other: decided by what is in them, not the screen
     * (a large text size, a long language or a narrow phone). */
    private struct Pair<A: View, B: View>: View {
        let a: A
        let b: B

        var body: some View {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .top, spacing: 12) {
                    a.frame(minWidth: 140)
                    b.frame(minWidth: 140)
                }
                .fixedSize(horizontal: false, vertical: true)
                VStack(spacing: 12) { a; b }
            }
        }
    }

    private struct Counter: View {
        let icon: String
        let label: String
        let value: String?
        var sub: String? = nil
        var since: Date? = nil

        var body: some View {
            VStack(alignment: .leading, spacing: 6) {
                Label(label, systemImage: icon)
                    .font(.system(size: 13, weight: .medium))
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
                        Text("—")
                    }
                }
                .font(.system(size: 24, weight: .semibold).monospacedDigit())
                .foregroundStyle(Theme.text)
                .lineLimit(1)
                if let sub {
                    Text(sub)
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.faintText)
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .padding(16)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: Theme.radius))
            .overlay(RoundedRectangle(cornerRadius: Theme.radius).stroke(Theme.line, lineWidth: 1))
            .accessibilityElement(children: .combine)
        }

        /* 0:08, 12:34, 1:02:03, as the desktop and Android show it. */
        static func duration(_ t: TimeInterval) -> String {
            let s = max(0, Int(t))
            let h = s / 3600, m = (s % 3600) / 60, sec = s % 60
            return h > 0 ? String(format: "%d:%02d:%02d", h, m, sec) : String(format: "%d:%02d", m, sec)
        }
    }
}

/*
 * Connections by site under the counters, as on the desktop: what went
 * through Shroudly since protection started, searchable, with Block and
 * Allow (ConnectionsView has the same rows for Apple TV's own screen).
 */
struct ConnectionsSection: View {
    let on: Bool
    @EnvironmentObject private var controller: TunnelController
    @State private var rows: [ConnRow] = []
    @State private var blocked: [String] = Conns.blocked()
    @State private var query = ""

    private var needle: String { query.trimmingCharacters(in: .whitespaces).lowercased() }
    private var own: String? { SettingsStore().load().ownServerLink?.host }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(tr("connsTitle")).font(.system(size: 13.5, weight: .semibold)).foregroundStyle(Theme.text)
            Text(tr("connsDesc")).font(.system(size: 12)).foregroundStyle(Theme.faintText)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(Theme.faintText)
                TextField(tr("connsSearch"), text: $query)
                    .textFieldStyle(.plain)
                    .font(.system(size: 13.5))
                    #if os(iOS)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    #endif
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .background(Theme.background, in: RoundedRectangle(cornerRadius: Theme.radiusSmall))
            .overlay(RoundedRectangle(cornerRadius: Theme.radiusSmall).stroke(Theme.line, lineWidth: 1))
            if let typed = Conns.clean(needle), typed.contains("."), !blocked.contains(typed), !rows.contains(where: { $0.host == typed }), !Conns.isSystem(typed, own: own) {
                Button(tr("connsBlockName", ["host": typed])) { block(typed, true); query = "" }
                    .buttonStyle(.plain)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.danger)
            }
            let shown = rows.filter { needle.isEmpty || $0.host.contains(needle) }.prefix(100)
            let only = blocked.filter { b in !rows.contains { $0.host == b } && (needle.isEmpty || b.contains(needle)) }
            if shown.isEmpty && only.isEmpty {
                Text(on ? tr("connsEmpty") : tr("statsInactiveHint"))
                    .font(.system(size: 12.5))
                    .foregroundStyle(Theme.faintText)
                    .padding(.vertical, 6)
            }
            VStack(spacing: 0) {
                ForEach(Array(shown)) { r in row(r.host, meta(r), r.blocked) }
                ForEach(only, id: \.self) { h in row(h, tr("connsBlocked"), true) }
            }
        }
        .padding(16)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: Theme.radius))
        .overlay(RoundedRectangle(cornerRadius: Theme.radius).stroke(Theme.line, lineWidth: 1))
        .task(id: on) {
            while !Task.isCancelled {
                rows = on ? await controller.conns() : []
                blocked = Conns.blocked()
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
        }
    }

    private func row(_ host: String, _ sub: String, _ isBlocked: Bool) -> some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(host).font(.system(size: 13)).foregroundStyle(Theme.text).lineLimit(1).truncationMode(.middle)
                Text(sub).font(.system(size: 11.5)).foregroundStyle(isBlocked ? Theme.warn : Theme.faintText).lineLimit(1)
            }
            Spacer(minLength: 8)
            if isBlocked || !Conns.isSystem(host, own: own) {
                Button(isBlocked ? tr("connsAllow") : tr("connsBlock")) { block(host, !isBlocked) }
                    .buttonStyle(.plain)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(isBlocked ? Theme.text : Theme.danger)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(Theme.cardRaised, in: RoundedRectangle(cornerRadius: 8))
            }
        }
        .padding(.vertical, 8)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.line).frame(height: 1) }
    }

    private func meta(_ r: ConnRow) -> String {
        if r.blocked { return tr("connsBlocked") + (r.refused > 0 ? " · " + tr("connsRefused", ["count": String(r.refused)]) : "") }
        var parts = ["↓ " + ByteCountFormatter.string(fromByteCount: r.down, countStyle: .binary),
                     "↑ " + ByteCountFormatter.string(fromByteCount: r.up, countStyle: .binary)]
        if r.active > 0 { parts.append(tr("connsOpen", ["count": String(r.active)])) }
        switch r.route {
        case "tor": parts.append(tr("connsRouteTor"))
        case "server": parts.append(tr("connsRouteServer"))
        case "technique": parts.append(tr("connsRouteTechnique"))
        default: break
        }
        if Conns.isSystem(r.host, own: own) { parts.append(tr("connsSystem")) }
        return parts.joined(separator: " · ")
    }

    private func block(_ host: String, _ on: Bool) {
        if on && Conns.isSystem(host, own: own) { return }
        guard let now = Conns.set(host, blocked: on) else { return }
        blocked = now
        rows = rows.map { r in
            guard r.host == host || r.host.hasSuffix("." + host) else { return r }
            var o = r.dictionary; o["blocked"] = on ? 1 : 0; if on { o["active"] = 0 }
            return ConnRow(o) ?? r
        }
        controller.blocksChanged()
    }
}
#endif
