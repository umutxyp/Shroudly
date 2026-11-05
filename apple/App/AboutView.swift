import SwiftUI

/* About: the version, who makes it, open source, the privacy policy and
 * "Share logs". As in the Google Play copy, the source code is linked, not
 * the downloads of other platforms. */
struct AboutView: View {
    static let notices = Bundle.main.url(forResource: "Notices", withExtension: "txt")
        .flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? ""

    @EnvironmentObject private var controller: TunnelController
    @State private var logs = ""
    #if !os(tvOS)
    @ObservedObject private var snowflake = Snowflake.shared
    @AppStorage(Snowflake.key) private var snowflakeOn = false
    #endif

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
            Section {
                NavigationLink {
                    FollowView()
                } label: {
                    Label(tr("followTitle"), systemImage: "person.2")
                }
            }
            Section(tr("openSourceTitle")) {
                Text(tr("openSourceDesc")).font(.footnote).foregroundStyle(Theme.secondaryText)
                WebLink(url: Ids.repoURL) { Label(tr("linkSourceCode"), systemImage: "chevron.left.forwardslash.chevron.right") }
                WebLink(url: Ids.privacyURL) { Label(tr("androidPrivacyPolicy"), systemImage: "hand.raised") }
                WebLink(url: Ids.releasesURL) { Label(tr("linkReleases"), systemImage: "doc.text") }
                // The licences of what is built in (Notices.txt, as Android's res/raw/notices.txt).
                NavigationLink {
                    ScrollView {
                        Text(Self.notices)
                            .font(.caption.monospaced())
                            .foregroundStyle(Theme.secondaryText)
                            #if !os(tvOS)
                            .textSelection(.enabled)
                            #endif
                            .padding()
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .background(Theme.background)
                    .navigationTitle(tr("openSourceTitle"))
                } label: {
                    Label(tr("openSourceTitle"), systemImage: "doc.plaintext")
                }
            }
            // Help people in censored countries: an app made for it, which
            // keeps running on its own (Psiphon's Conduit).
            Section(tr("helpOthers")) {
                #if !os(tvOS)
                // Shroudly itself (Snowflake.swift), while it runs.
                Toggle(isOn: Binding(get: { snowflakeOn }, set: { on in
                    snowflakeOn = on
                    snowflake.sync(active: on)
                })) {
                    Labelled(title: tr("snowflakeDevice"), detail: tr("snowflakeWhenApple"))
                }
                if let line = snowflake.line {
                    Text(line).font(.footnote).foregroundStyle(snowflake.state == .unreachable ? .orange : Theme.secondaryText)
                }
                Text(tr("snowflakeHow")).font(.footnote).foregroundStyle(Theme.secondaryText)
                #endif
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
        #if !os(tvOS)
        .onAppear { snowflake.sync(active: snowflakeOn) }
        #endif
    }
}

/* Follow Shroudly: Codeshare's accounts, then its developer's. The same list
 * as the desktop's (components/follow.json, tests/net/follow.test.js) and
 * Android's (FollowActivity). On Apple TV, which opens no links, each shows
 * its address to open on a phone or computer (WebLink). */
struct FollowView: View {
    struct Account: Identifiable {
        let name: String
        let handle: String
        let url: String
        var id: String { url }
    }

    static let codeshare: [Account] = [
        Account(name: "Instagram", handle: "@codeshareme", url: "https://instagram.com/codeshareme"),
        Account(name: "X", handle: "@codeshareme", url: "https://x.com/codeshareme"),
        Account(name: "Discord", handle: "Codeshare", url: "https://discord.gg/BhdgVfsFVC"),
        Account(name: "LinkedIn", handle: "codeshareme", url: "https://www.linkedin.com/company/codeshareme"),
        Account(name: "Facebook", handle: "codeshareme", url: "https://www.facebook.com/codeshareme"),
        Account(name: "GitHub", handle: "codeshareme", url: "https://github.com/codeshareme"),
        Account(name: "codeshare.me", handle: "codeshare.me", url: "https://codeshare.me"),
    ]
    static let developer: [Account] = [
        Account(name: "Instagram", handle: "@umutxyp", url: "https://instagram.com/umutxyp"),
        Account(name: "YouTube", handle: "@umutxyp", url: "https://youtube.com/@umutxyp"),
        Account(name: "TikTok", handle: "@umutxyp", url: "https://tiktok.com/@umutxyp"),
        Account(name: "X", handle: "@devbayraktar", url: "https://x.com/devbayraktar"),
        Account(name: "Telegram", handle: "@umutxyp", url: "https://t.me/umutxyp"),
        Account(name: "GitHub", handle: "umutxyp", url: "https://github.com/umutxyp"),
        Account(name: "LinkedIn", handle: "umutxyp", url: "https://linkedin.com/in/umutxyp"),
        Account(name: "Facebook", handle: "umutxyp", url: "https://facebook.com/umutxyp"),
    ]

    var body: some View {
        Form {
            Section {
                Text(tr("followDesc")).font(.footnote).foregroundStyle(Theme.secondaryText)
                #if os(tvOS)
                Text(tr("followTv")).font(.footnote).foregroundStyle(Theme.secondaryText)
                #endif
            }
            Section(tr("followCodeshare")) { rows(Self.codeshare) }
            Section(tr("followDeveloper")) { rows(Self.developer) }
        }
        .navigationTitle(tr("followTitle"))
    }

    @ViewBuilder private func rows(_ list: [Account]) -> some View {
        ForEach(list) { a in
            if let u = URL(string: a.url) {
                WebLink(url: u) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(a.name)
                        #if !os(tvOS)
                        Text(a.handle).font(.caption).foregroundStyle(Theme.secondaryText)
                        #endif
                    }
                }
            }
        }
    }
}
