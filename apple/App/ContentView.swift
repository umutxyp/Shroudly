import StoreKit
import SwiftUI

/* The main screen: the status, one big button, and the way to Settings and About. */
struct ContentView: View {
    @EnvironmentObject private var controller: TunnelController
    @Environment(\.scenePhase) private var scenePhase
    #if !os(tvOS)
    @Environment(\.requestReview) private var requestReview
    #endif
    @AppStorage("noticeSeen") private var noticeSeen = false
    @State private var showNotice = false
    @StateObject private var watch = NetworkWatch()
    @Environment(\.layoutDirection) private var direction
    @Environment(\.openURL) private var openURL
    // The card asking whether the user would like to help (HelpNudge).
    @State private var helpDue = false
    // What changed in this version, once after an update (WhatsNew).
    @State private var newsVersion: String?
    @State private var showNews = false
    // The engine's counters, asked every two seconds while on and in front.
    @State private var stats: EngineStats?
    // Read so the switch takes a new accent at once.
    @AppStorage(Accent.key) private var accentId = "logo"

    var body: some View {
        NavigationStack {
            ZStack {
                Theme.background.ignoresSafeArea()
                // Scrolls only when it does not fit: a small iPhone (SE) with
                // a notice and a long language; otherwise it fills the screen.
                GeometryReader { screen in
                ScrollView {
                // A wide, low screen (an unfolded iPhone Duo, Apple TV): the
                // status and its card side by side, so it all fits at once.
                let wide = screen.size.width > screen.size.height * 1.2 && (screen.size.height < 800 || Theme.isTV)
                VStack(spacing: wide ? 20 : 28) {
                    Spacer(minLength: wide ? 8 : 0)
                    if wide {
                        HStack(alignment: .center, spacing: 40) {
                            status
                            VStack(spacing: 14) {
                                card
                                statsView
                            }
                            .frame(maxWidth: 460)
                        }
                        .padding(.horizontal, 24)
                    } else {
                        status
                        card
                        statsView.frame(maxWidth: 520)
                    }
                    Spacer(minLength: wide ? 8 : 0)
                    tabs
                }
                .frame(maxWidth: wide ? .infinity : 520)
                .frame(minHeight: screen.size.height)
                .frame(maxWidth: .infinity)
                }
                .macScrollBarHidden()
                }
            }
            .navigationTitle("Shroudly")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
        }
        .sheet(isPresented: $showNotice) {
            NoticeView {
                noticeSeen = true
                showNotice = false
                Task { await controller.start() }
            }
        }
        // Looked at while the screen is open and protection is on.
        .task(id: controller.phase == .on && scenePhase == .active) {
            while !Task.isCancelled {
                await watch.refresh(protected: controller.phase == .on && scenePhase == .active)
                guard controller.phase == .on && scenePhase == .active else { return }
                try? await Task.sleep(nanoseconds: 5_000_000_000)
            }
        }
        .task(id: controller.phase == .on && scenePhase == .active) {
            guard controller.phase == .on, scenePhase == .active else { stats = nil; return }
            while !Task.isCancelled {
                if let s = await controller.stats() { stats = s }
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
        }
        .task(id: RatingPrompt.Moment(phase: controller.phase, active: scenePhase == .active)) {
            #if !os(tvOS)
            await RatingPrompt.maybeAsk(controller: controller, active: scenePhase == .active) { requestReview() }
            #endif
        }
        // Each time the app comes to the front: the help card's turn, and,
        // after an update, what changed.
        .task(id: scenePhase == .active) {
            guard scenePhase == .active else { return }
            helpDue = HelpNudge.due()
            let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""
            #if DEBUG
            switch UserDefaults.standard.string(forKey: "ShroudlyScreen") {
            case "help": helpDue = true
            case "whatsnew": newsVersion = version; showNews = true; return
            default: break
            }
            #endif
            if !version.isEmpty, let v = WhatsNew.pending(current: version, usedBefore: noticeSeen) {
                newsVersion = v
                showNews = true
            }
        }
        .alert(tr("whatsNewTitle", ["version": newsVersion ?? ""]), isPresented: $showNews) {
            Button(tr("whatsNewOk")) { WhatsNew.seen() }
        } message: {
            Text(WhatsNew.lines(tr("whatsNewApple")))
        }
    }

    /* The button and what it says. */
    private var status: some View {
        VStack(spacing: 28) {
            Orb(phase: phase, warn: watch.ownServerDown != nil || watch.national != nil) { toggle() }
            VStack(spacing: 8) {
                Text(title)
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(.white)
                Text(controller.notice ?? subtitle)
                    .font(.callout)
                    .foregroundStyle(controller.notice == nil ? Theme.secondaryText : .orange)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 24)
                // A copy that may not make a VPN: how to install one that can.
                if controller.vpnNotAllowed {
                    Link(tr("appleInstallHelp"), destination: VpnErrors.installHelp)
                        .font(.callout.weight(.semibold))
                }
            }
        }
    }

    private var statsView: some View {
        StatsView(on: phase == .on, since: watch.preview ? Self.previewSince : controller.connectedSince,
                  stats: watch.preview ? Self.previewStats : stats)
    }

    /* Debug builds' screenshots: believable numbers instead of dashes. */
    private static let previewSince = Date().addingTimeInterval(-(42 * 60 + 17))
    private static let previewStats = EngineStats(["conns_active": 14, "conns_total": 386, "bytes_down": 248_000_000, "bytes_up": 19_400_000, "online": 1_204])

    private var hasCard: Bool {
        phase == .on && (watch.ownServerDown != nil || watch.national != nil || (helpDue && controller.notice == nil && !Theme.isTV))
    }

    /* The one card under the status, when there is one. */
    @ViewBuilder private var card: some View {
        if phase == .on, let down = watch.ownServerDown {
            Warning(title: tr("ownServerDown"),
                    text: tr("ownServerDownBody", ["server": down.server, "why": OwnServer.whyText(down.why),
                                                   "path": "\(tr("navSettings")) \(direction == .rightToLeft ? "←" : "→") \(tr("ownServer"))"]))
        } else if phase == .on, watch.national != nil {
            Warning(title: tr("nationalOnlyTitle"), text: tr("nationalOnlyBody"),
                    link: (tr("nationalOnlyHelp"), NationalNet.guideURL(language: Bundle.main.preferredLocalizations.first ?? "en")))
        } else if phase == .on, helpDue, controller.notice == nil, !Theme.isTV {
            HelpCard(later: {
                HelpNudge.refused()
                helpDue = false
            }, show: {
                HelpNudge.accepted()
                helpDue = false
                openURL(HelpOthers.conduitURL(language: Bundle.main.preferredLocalizations.first ?? "en"))
            })
        }
    }

    private var tabs: some View {
        HStack(spacing: 12) {
            NavigationLink { SettingsView() } label: {
                Tab(icon: "gearshape", text: tr("navSettings"))
            }
            NavigationLink { AboutView() } label: {
                Tab(icon: "info.circle", text: tr("navInfo"))
            }
        }
        .buttonStyle(.plain)
        .frame(maxWidth: 520)
        .padding(.horizontal, 16)
        .padding(.bottom, 12)
    }

    /* Under the status: the address sites see while it works through your
     * own server (issue #66), else the tagline. */
    private var subtitle: String {
        if phase == .on, let ip = watch.exit, watch.ownServerDown == nil, watch.national == nil {
            return tr("ownServerExit", ["ip": ip])
        }
        return tr("tagline")
    }

    /* The tunnel's phase; "on" for a debug build's warning screenshots. */
    private var phase: TunnelController.Phase { watch.preview ? .on : controller.phase }

    private var title: String {
        switch phase {
        case .off: return tr("notProtected")
        case .starting: return tr("starting")
        case .on: return tr("protected")
        case .stopping: return tr("stopping")
        }
    }

    private func toggle() {
        if controller.phase == .off && !noticeSeen {
            showNotice = true
            return
        }
        Task {
            switch controller.phase {
            case .off: await controller.start()
            case .on, .starting: await controller.stop()
            case .stopping: break
            }
        }
    }
}

/* The big round button: blue and glowing when protected, grey when not,
 * amber when protected but your own server or the world does not answer. */
private struct Orb: View {
    let phase: TunnelController.Phase
    var warn = false
    let action: () -> Void

    private var tint: Color { on ? (warn ? .orange : Theme.accent) : Theme.off }

    var body: some View {
        Button(action: action) {
            ZStack {
                Circle()
                    .fill(on ? tint.opacity(0.18) : Theme.card)
                    .frame(width: 210, height: 210)
                Circle()
                    .stroke(tint, lineWidth: 4)
                    .frame(width: 180, height: 180)
                if phase == .starting || phase == .stopping {
                    ProgressView().controlSize(.large).tint(.white)
                } else {
                    Image(systemName: "power")
                        .font(.system(size: 64, weight: .medium))
                        .foregroundStyle(on ? tint : Theme.secondaryText)
                }
            }
            .shadow(color: on ? tint.opacity(0.45) : .clear, radius: 30)
            .contentShape(Circle())
        }
        #if os(tvOS)
        .buttonStyle(OrbFocus())
        #else
        .buttonStyle(.plain)
        #endif
        .disabled(phase == .stopping)
        .accessibilityLabel(on || phase == .starting ? tr("stop") : tr("start"))
    }

    private var on: Bool { phase == .on }
}

#if os(tvOS)
/* Apple TV: the remote's focus on the round switch, as a ring round it and a
 * little growth, instead of the system's square platter behind it. */
private struct OrbFocus: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { Ring(configuration: configuration) }

    private struct Ring: View {
        let configuration: ButtonStyle.Configuration
        @Environment(\.isFocused) private var focused

        var body: some View {
            configuration.label
                .overlay(Circle().stroke(Theme.accent, lineWidth: 6).frame(width: 232, height: 232).opacity(focused ? 1 : 0))
                .scaleEffect(configuration.isPressed ? 0.97 : (focused ? 1.08 : 1))
                .animation(.easeOut(duration: 0.15), value: focused)
        }
    }
}
#endif

/* A notice under the status: what is wrong, and where to read more. */
private struct Warning: View {
    let title: String
    let text: String
    var link: (String, URL)?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(title, systemImage: "exclamationmark.triangle.fill")
                .font(.callout.weight(.semibold))
                .foregroundStyle(.orange)
                .fixedSize(horizontal: false, vertical: true)
            Text(text)
                .font(.footnote)
                .foregroundStyle(Theme.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
            if let link {
                WebLink(url: link.1) { Text(link.0) }.font(.footnote.weight(.semibold))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 14))
        .padding(.horizontal, 16)
        .accessibilityElement(children: .combine)
    }
}

/* Whether the user would like to help people in censored countries: said
 * plainly, with "Not now" and the way to the app made for it (Conduit). */
private struct HelpCard: View {
    let later: () -> Void
    let show: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(tr("helpNudgeTitle"), systemImage: "person.2.wave.2")
                .font(.callout.weight(.semibold))
                .foregroundStyle(.white)
            Text(tr("helpNudgeBodyPhone"))
                .font(.footnote)
                .foregroundStyle(Theme.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 12) {
                Spacer()
                Button(tr("supportBannerLater"), action: later)
                    .foregroundStyle(Theme.secondaryText)
                Button(tr("helpNudgeShow"), action: show)
                    .buttonStyle(.borderedProminent)
            }
            .font(.footnote.weight(.semibold))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 14))
        .padding(.horizontal, 16)
    }
}

private struct Tab: View {
    let icon: String
    let text: String

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
            Text(text)
        }
        .font(.body.weight(.medium))
        .foregroundStyle(.white)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 14)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 14))
    }
}
