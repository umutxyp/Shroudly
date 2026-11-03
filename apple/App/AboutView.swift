import SwiftUI

/* About: the version, who makes it, open source, the privacy policy and
 * "Share logs". As in the Google Play copy, the source code is linked, not
 * the downloads of other platforms. */
struct AboutView: View {
    @EnvironmentObject private var controller: TunnelController
    @State private var logs = ""

    var body: some View {
        Form {
            Section {
                HStack(spacing: 14) {
                    Image("Logo")
                        .resizable()
                        .frame(width: 56, height: 56)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Shroudly").font(.headline)
                        Text(tr("versionLabel", ["version": Diagnostics.version])).font(.footnote).foregroundStyle(Theme.secondaryText)
                        Text(tr("madeBy")).font(.footnote).foregroundStyle(Theme.secondaryText)
                    }
                }
            }
            Section(tr("openSourceTitle")) {
                Text(tr("openSourceDesc")).font(.footnote).foregroundStyle(Theme.secondaryText)
                WebLink(url: Ids.repoURL) { Label(tr("linkSourceCode"), systemImage: "chevron.left.forwardslash.chevron.right") }
                WebLink(url: Ids.privacyURL) { Label(tr("androidPrivacyPolicy"), systemImage: "hand.raised") }
            }
            // Help people in censored countries: an app made for it, which
            // keeps running on its own (Psiphon's Conduit).
            Section(tr("helpOthers")) {
                Text(tr("helpOthersBodyConduit")).font(.footnote).foregroundStyle(Theme.secondaryText)
                WebLink(url: HelpOthers.conduitURL(language: Bundle.main.preferredLocalizations.first ?? "en")) {
                    Label(tr("helpOthersConduit"), systemImage: "person.2.wave.2")
                }
            }
            #if !os(tvOS)
            Section {
                ShareLink(item: logs.isEmpty ? Diagnostics.header() : logs) {
                    Label(tr("androidShareLogs"), systemImage: "square.and.arrow.up")
                }
            }
            #endif
        }
        .formStyle(.grouped)
        .listBackgroundHidden()
        .background(Theme.background)
        .navigationTitle(tr("navInfo"))
        .task { logs = await Diagnostics.text(sites: controller.siteLog()) }
    }
}
