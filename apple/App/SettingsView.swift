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
