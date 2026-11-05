import SwiftUI

/*
 * Connections (issue #74; the Connections cell under the switch opens it):
 * what went through Shroudly, by site, with the data each way, how many are
 * open now and how each went out; blocking a site ends its connections and
 * refuses new ones. Shroudly's own names are marked, and blocking one asks
 * first. Asked again every two seconds while on screen.
 */
struct ConnectionsView: View {
    @EnvironmentObject private var controller: TunnelController
    @State private var rows: [ConnRow] = []
    @State private var blocked: [String] = Conns.blocked()
    @State private var query = ""
    @State private var confirm: String?

    private var needle: String { query.trimmingCharacters(in: .whitespaces).lowercased() }
    private var own: String? { SettingsStore().load().ownServerLink?.host }

    var body: some View {
        List {
            Section {
                Text(tr("connsDesc")).font(.footnote).foregroundStyle(Theme.secondaryText)
            }
            if let typed = Conns.clean(needle), typed.contains("."), !blocked.contains(typed), !rows.contains(where: { $0.host == typed }) {
                Button(tr("connsBlockName", ["host": typed])) { block(typed, true); query = "" }
            }
            let shown = rows.filter { needle.isEmpty || $0.host.contains(needle) }.prefix(100)
            let only = blocked.filter { b in !rows.contains { $0.host == b } && (needle.isEmpty || b.contains(needle)) }
            if shown.isEmpty && only.isEmpty {
                Text(controller.phase == .on ? tr("connsEmpty") : tr("statsInactiveHint")).foregroundStyle(Theme.secondaryText)
            }
            ForEach(Array(shown)) { r in
                row(r.host, meta(r), r.blocked)
            }
            ForEach(only, id: \.self) { h in
                row(h, tr("connsBlocked"), true)
            }
        }
        .navigationTitle(tr("connsTitle"))
        #if !os(tvOS)
        .searchable(text: $query, prompt: tr("connsSearch"))
        #endif
        // The system adds its own Cancel, in the system's language.
        .confirmationDialog(confirm.map { tr("connsSystemConfirm", ["host": $0]) } ?? "",
                            isPresented: Binding(get: { confirm != nil }, set: { if !$0 { confirm = nil } }), titleVisibility: .visible) {
            Button(tr("connsBlock"), role: .destructive) { if let h = confirm { block(h, true, asked: true) } }
        }
        .task {
            while !Task.isCancelled {
                rows = await controller.conns()
                blocked = Conns.blocked()
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
        }
    }

    private func row(_ host: String, _ sub: String, _ isBlocked: Bool) -> some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(host).lineLimit(1).truncationMode(.middle)
                Text(sub).font(.caption).foregroundStyle(isBlocked ? Color.orange : Theme.secondaryText)
            }
            Spacer(minLength: 8)
            Button(isBlocked ? tr("connsAllow") : tr("connsBlock")) { block(host, !isBlocked) }
                .buttonStyle(.bordered)
        }
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

    private func block(_ host: String, _ on: Bool, asked: Bool = false) {
        if on && !asked && Conns.isSystem(host, own: own) { confirm = host; return }
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
