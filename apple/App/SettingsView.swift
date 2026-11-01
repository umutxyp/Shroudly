import SwiftUI
#if os(iOS)
import UIKit
#endif

/* Settings: the technique, QUIC and IPv6 off, keeping protection on, and the
 * language (the system's own setting). A change that the tunnel runs with
 * starts protection again, if it is on. */
struct SettingsView: View {
    @EnvironmentObject private var controller: TunnelController
    @State private var settings = SettingsStore().load()

    var body: some View {
        Form {
            Section {
                Picker(tr("strategy"), selection: $settings.strategyId) {
                    ForEach(Strategies.all, id: \.id) { s in
                        Text(tr(s.labelKey)).tag(s.id)
                    }
                }
            }
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
        .scrollContentBackground(.hidden)
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
