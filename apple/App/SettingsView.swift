import SwiftUI
#if os(iOS)
import UIKit
#endif

/* Settings: the technique, QUIC and IPv6 off, keeping protection on, your
 * own server, and the language (the system's own setting). A change that the
 * tunnel runs with starts protection again, if it is on. */
struct SettingsView: View {
    @EnvironmentObject private var controller: TunnelController
    @State private var settings = SettingsStore().load()
    // "Your own server": what is being typed, why it cannot be used.
    @State private var draft = ""
    @State private var serverError: String?
    @FocusState private var editingServer: Bool
    // "Block ads and trackers" and its exceptions (AdBlock.swift): told to
    // the running engine at once, no restart.
    @AppStorage(AdBlock.Key.on, store: AppGroup.defaults) private var adBlock = false
    @State private var allowText = AdBlock.allow().joined(separator: "\n")
    // "Count me in the live total" (Shared/OnlineCount.swift): on by default.
    @AppStorage(OnlineCount.key, store: AppGroup.defaults) private var countMe = true
    // "DNS server": the kind and address being typed, and the test's result.
    @State private var dnsKind = SettingsStore().load().dnsKind
    @State private var dnsText = SettingsStore().load().dnsServer
    @State private var dnsStrict = SettingsStore().load().dnsStrict
    @State private var dnsResult: (ok: Bool, text: String)?
    @State private var dnsTesting = false

    var body: some View {
        Form {
            Section {
                Picker(tr("strategy"), selection: $settings.strategyId) {
                    ForEach(Strategies.all, id: \.id) { s in
                        Text(tr(s.labelKey)).tag(s.id)
                    }
                }
            }
            #if !os(tvOS)
            Section(tr("accentColour")) {
                AccentPicker()
            }
            #endif
            Section(tr("androidNetworkSection")) {
                Toggle(isOn: $settings.quicOff) {
                    Labelled(title: tr("androidQuicOff"), detail: tr("androidQuicOffDesc"))
                }
                Toggle(isOn: $settings.ipv6Off) {
                    Labelled(title: tr("androidIpv6Off"), detail: tr("androidIpv6OffDesc"))
                }
                Toggle(isOn: $settings.keepOn) {
                    Labelled(title: tr("appleKeepOn"), detail: tr("appleKeepOnDesc"))
                }
                // The last way out (Tunnel/TorRoute.swift): the Mac only
                // (iOS ends a tunnel that big; Apple TV has no Tor).
                #if os(macOS)
                Toggle(isOn: $settings.torLastResort) {
                    Labelled(title: tr("lastResort"), detail: settings.ownServer.isEmpty ? tr("lastResortDesc") : tr("lastResortOwnServer"))
                }
                #endif
            }
            Section {
                Toggle(isOn: $countMe) {
                    Labelled(title: tr("shareOnlineCount"), detail: tr("shareOnlineCountDesc"))
                }
                .onChange(of: countMe) { _ in controller.countChanged() }
            }
            Section {
                Toggle(isOn: $adBlock) {
                    Labelled(title: tr("adBlock"), detail: tr("adBlockDesc"))
                }
                .onChange(of: adBlock) { _ in controller.adblockChanged() }
                if adBlock {
                    #if os(tvOS)
                    TextField(tr("adBlockAllow"), text: $allowText)
                        .onSubmit { saveAllow() }
                    #else
                    VStack(alignment: .leading, spacing: 6) {
                        Text(tr("adBlockAllow"))
                        Text(tr("adBlockAllowDesc"))
                            .font(.footnote)
                            .foregroundStyle(Theme.secondaryText)
                            .fixedSize(horizontal: false, vertical: true)
                        TextEditor(text: $allowText)
                            .font(.callout.monospaced())
                            .frame(minHeight: 70)
                            .scrollContentBackground(.hidden)
                            .autocorrectionDisabled()
                            #if os(iOS)
                            .textInputAutocapitalization(.never)
                            .keyboardType(.URL)
                            #endif
                    }
                    Button(tr("dnsServerUse")) { saveAllow() }
                        .disabled(AdBlock.clean(allowText.components(separatedBy: CharacterSet(charactersIn: " \t\n\r,"))) == AdBlock.allow())
                    #endif
                }
            }
            Section {
                Text(tr("dnsServerDesc"))
                    .font(.footnote)
                    .foregroundStyle(Theme.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
                Picker(tr("dnsServer"), selection: $dnsKind) {
                    Text(tr("dnsServerAuto")).tag("auto")
                    Text(tr("dnsKindDoh")).tag("doh")
                    Text(tr("dnsKindDot")).tag("dot")
                    Text(tr("dnsKindTcp")).tag("tcp")
                    Text(tr("dnsKindUdp")).tag("udp")
                }
                .onChange(of: dnsKind) { k in
                    dnsResult = nil
                    if k == "auto" { settings.dnsKind = "auto"; settings.dnsServer = ""; dnsText = "" }
                }
                if dnsKind != "auto" {
                    TextField(CustomDns.examples[dnsKind] ?? "", text: $dnsText)
                        .font(.callout.monospaced())
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                        #endif
                        .onSubmit { Task { await useDns(anyway: false) } }
                    Toggle(isOn: $dnsStrict) {
                        Labelled(title: tr("dnsServerStrict"), detail: tr("dnsServerStrictDesc"))
                    }
                    .onChange(of: dnsStrict) { on in
                        // The server in use: alone or not, at once.
                        if settings.dnsKind == dnsKind && !settings.dnsServer.isEmpty { settings.dnsStrict = on }
                    }
                    HStack {
                        Button(tr("dnsServerUse")) { Task { await useDns(anyway: false) } }
                            .disabled(dnsTesting || dnsText.trimmingCharacters(in: .whitespaces).isEmpty)
                        if dnsTesting { ProgressView().controlSize(.small) }
                        if dnsResult?.ok == false {
                            Spacer()
                            Button(tr("dnsServerUseAnyway")) { Task { await useDns(anyway: true) } }
                        }
                    }
                    if let r = dnsResult {
                        Text(r.text)
                            .font(.footnote)
                            .foregroundStyle(r.ok ? Theme.secondaryText : .orange)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            } header: {
                Text(tr("dnsServer"))
            }
            Section {
                Text(tr("ownServerDesc"))
                    .font(.footnote)
                    .foregroundStyle(Theme.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
                // The saved link with its password covered while it is not
                // being edited: the screen may be seen by others.
                TextField("socks5://… · ss://…", text: Binding(
                    get: { editingServer || settings.ownServer.isEmpty ? draft : OwnServer.masked(settings.ownServer) },
                    set: { draft = $0; serverError = nil }))
                    .focused($editingServer)
                    .font(.callout.monospaced())
                    .autocorrectionDisabled()
                    #if os(iOS)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.URL)
                    #endif
                    .onSubmit { useServer() }
                    .onChange(of: editingServer) { on in
                        if on && draft.isEmpty { draft = settings.ownServer }
                    }
                Button(tr("dnsServerUse")) { useServer() }
                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || draft == settings.ownServer)
                if let serverError {
                    Text(serverError)
                        .font(.footnote)
                        .foregroundStyle(.orange)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let link = settings.ownServerLink {
                    Text(tr("ownServerInUse", ["server": OwnServer.describe(link)]))
                        .font(.footnote)
                    Button(tr("ownServerOff"), role: .destructive) {
                        settings.ownServer = ""
                        draft = ""
                        serverError = nil
                        editingServer = false
                    }
                }
            } header: {
                Text(tr("ownServer"))
            }
            Section(tr("language")) {
                Labelled(title: tr("languageSystem"), detail: tr("appleLanguageDesc"))
                #if os(iOS)
                Button(tr("appleOpenSettings")) {
                    if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                }
                #endif
            }
        }
        .formStyle(.grouped)
        .listBackgroundHidden()
        .background(Theme.background)
        .navigationTitle(tr("navSettings"))
        .onChange(of: settings) { new in
            let store = SettingsStore()
            let old = store.load()
            guard old != new else { return }
            store.save(new)
            Task { await controller.settingsChanged(from: old, to: new) }
        }
    }
}

extension SettingsView {
    /* The server typed, asked for example.com (by the system's lookup for
     * its name: the app is not the tunnel); used when it answers, or anyway. */
    private func useDns(anyway: Bool) async {
        let p = CustomDns.parse(dnsKind, dnsText)
        guard let spec = p.spec else {
            dnsResult = (false, tr(CustomDns.errorKey(p.error ?? "url"), ["example": CustomDns.examples[dnsKind] ?? ""]))
            return
        }
        if !anyway {
            dnsTesting = true
            defer { dnsTesting = false }
            let c = CustomDnsClient(spec, bootstrap: { name in await Self.systemLookup(name) })
            let began = Date()
            do {
                let a = try await c.query(Dns.query("example.com", type: 1, id: UInt16.random(in: 1...0xfffe)))
                let ms = Int(Date().timeIntervalSince(began) * 1000)
                dnsResult = (true, tr("dnsServerOk", ["ms": String(ms), "address": Dns.addressesV4(a).first ?? "–"]))
            } catch {
                dnsResult = (false, tr("dnsServerFails", ["error": error.localizedDescription]))
                return
            }
        }
        settings.dnsKind = dnsKind
        settings.dnsServer = dnsText.trimmingCharacters(in: .whitespacesAndNewlines)
        settings.dnsStrict = dnsStrict
    }

    private static func systemLookup(_ name: String) async -> String? {
        await withCheckedContinuation { k in
            DispatchQueue.global().async {
                var hints = addrinfo(ai_flags: 0, ai_family: AF_INET, ai_socktype: SOCK_STREAM, ai_protocol: 0, ai_addrlen: 0, ai_canonname: nil, ai_addr: nil, ai_next: nil)
                var res: UnsafeMutablePointer<addrinfo>?
                guard getaddrinfo(name, nil, &hints, &res) == 0, let r = res else { return k.resume(returning: nil) }
                defer { freeaddrinfo(res) }
                var buf = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
                let ok = r.pointee.ai_addr.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { sin in
                    var a = sin.pointee.sin_addr
                    return inet_ntop(AF_INET, &a, &buf, socklen_t(INET_ADDRSTRLEN)) != nil
                }
                k.resume(returning: ok ? String(cString: buf) : nil)
            }
        }
    }

    /* The exceptions as typed, cleaned, kept and told to the engine. */
    private func saveAllow() {
        allowText = AdBlock.setAllow(allowText).joined(separator: "\n")
        controller.adblockChanged()
    }

    /* The link typed, used when it is one Shroudly can use; else why not. */
    private func useServer() {
        let typed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let p = OwnServer.parse(typed)
        if let error = p.error {
            serverError = OwnServer.errorText(error, method: p.method)
            return
        }
        serverError = nil
        settings.ownServer = typed
        draft = ""
        editingServer = false
    }
}

struct Labelled: View {
    let title: String
    let detail: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
            Text(detail)
                .font(.footnote)
                .foregroundStyle(Theme.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 2)
    }
}
