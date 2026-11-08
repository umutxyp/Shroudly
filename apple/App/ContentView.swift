import StoreKit
import SwiftUI
import UniformTypeIdentifiers

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
    #if !os(tvOS)
    // The tab shown (the desktop app's six, at the bottom).
    @State private var tab: MainTab = .protection
    #else
    // Apple TV's tab along the top.
    @State private var tvTab = 0
    #endif
    #if os(macOS)
    // The window following the system's sidebar of tabs (macOS 15 and later).
    @State private var fit = MacWindowFit()
    #endif
    // Read so the switch takes a new accent at once.
    @AppStorage(Accent.key) private var accentId = Accent.defaultId

    var body: some View {
        layout
        #if os(macOS)
        // The page as the desktop's window, with room for the sidebar.
        .frame(minWidth: 360, idealWidth: 460 + (MacWindowFit.hasSidebar ? 220 : 0),
               maxWidth: 720 + (MacWindowFit.hasSidebar ? 220 : 0))
        #endif
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
            #if os(iOS)
            // Helping censored people runs while the app is in front.
            Snowflake.shared.sync(active: scenePhase == .active)
            #elseif os(macOS)
            Snowflake.shared.sync(active: true)
            #endif
            guard scenePhase == .active else { return }
            helpDue = HelpNudge.due()
            let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""
            #if DEBUG
            #if os(tvOS)
            switch UserDefaults.standard.string(forKey: "ShroudlyTab") {
            case "stats": tvTab = 1
            case "settings": tvTab = 2
            case "follow": tvTab = 3
            case "about": tvTab = 4
            default: break
            }
            #endif
            #if !os(tvOS)
            // Screenshots of each tab (a debug build only): -ShroudlyTab stats|settings|logs|follow|about.
            switch UserDefaults.standard.string(forKey: "ShroudlyTab") {
            case "stats": tab = .stats
            case "settings": tab = .settings
            case "logs": tab = .logs
            case "follow": tab = .follow
            case "about": tab = .about
            default: break
            }
            #endif
            switch UserDefaults.standard.string(forKey: "ShroudlyScreen") {
            case "help": helpDue = true
            case "whatsnew": newsVersion = version; showNews = true; return
            case "on", "off": return
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

    /* The Mac's small window: tighter spacing (Orb.size too). */
    #if os(macOS)
    static let compact = true
    #else
    static let compact = false
    #endif

    /* Apple TV: its own layout, for the remote's focus. iPhone, iPad and the
     * Mac: the desktop app's pages (components/ControlPanel.js, app/page.js),
     * the logo, name and status over each, in the system's own tabs. */
    @ViewBuilder private var layout: some View {
        #if os(tvOS)
        // Apple TV: the system's tabs along the top, as Apple TV apps have
        // them, with the desktop's pages in them.
        TabView(selection: $tvTab) {
            // The icons alone along the top, their names read out.
            NavigationStack { tvHome }
                .tabItem { Image("TabMark").accessibilityLabel(tr("navProtection")) }.tag(0)
            NavigationStack { tvStats }
                .tabItem { Image(systemName: "chart.bar").accessibilityLabel(tr("navStats")) }.tag(1)
            NavigationStack { TVPage(title: tr("navSettings"), symbol: "gearshape") { SettingsView() } }
                .tabItem { Image(systemName: "gearshape").accessibilityLabel(tr("navSettings")) }.tag(2)
            NavigationStack { TVPage(title: tr("followTitle"), symbol: "person.2", text: "\(tr("followDesc"))\n\n\(tr("followTv"))") { FollowView() } }
                .tabItem { Image(systemName: "person.2").accessibilityLabel(tr("navFollow")) }.tag(3)
            NavigationStack { TVPage(title: "Shroudly", text: "\(tr("versionLabel", ["version": Diagnostics.version]))\n\(tr("madeBy"))") { AboutView() } }
                .tabItem { Image(systemName: "info.circle").accessibilityLabel(tr("navInfo")) }.tag(4)
        }
        #else
        // iPhone, iPad and the Mac: the system's own tabs, Liquid Glass on
        // iOS, iPadOS and macOS 26: along the bottom on iPhone (icons only,
        // press and slide along them as in Apple's apps), a bar that turns
        // into a sidebar on iPad, the sidebar on the Mac. Each tab keeps
        // the desktop's header over its page.
        if #available(iOS 18.0, macOS 15.0, *) {
            TabView(selection: $tab) {
                ForEach(MainTab.shown, id: \.self) { t in
                    Tab(value: t) { tabScreen(t) } label: { tabLabel(t) }
                }
            }
            .tabViewStyle(.sidebarAdaptable)
            .modifier(TabBarMinimize())
        } else {
            TabView(selection: $tab) {
                ForEach(MainTab.shown, id: \.self) { t in
                    tabScreen(t).tabItem { tabLabel(t) }.tag(t)
                }
            }
        }
        #endif
    }

    #if os(tvOS)
    /* Apple TV's Protection: the logo and status on top, the orb (the
     * remote's switch) and what it says beside the card and the counters. */
    private var tvHome: some View {
        ZStack {
            Theme.background.ignoresSafeArea()
            HStack(alignment: .center, spacing: 90) {
                status
                    .frame(width: 560)
                VStack(spacing: 24) {
                    card
                    tvCounters(full: false)
                }
                .frame(maxWidth: 900)
            }
            .padding(.horizontal, 90)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    /* Apple TV's Stats: every counter in tiles of the same size. */
    private var tvStats: some View {
        ZStack {
            Theme.background.ignoresSafeArea()
            tvCounters(full: true)
                .frame(maxWidth: 1500)
                .padding(.horizontal, 90)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func tvCounters(full: Bool) -> some View {
        TVStats(on: phase == .on, since: watch.preview ? Self.previewSince : controller.connectedSince,
                stats: watch.preview ? Self.previewStats : stats, full: full)
    }
    #endif

    #if !os(tvOS)
    /* The desktop app's tabs (app/page.js), in its order. */
    enum MainTab: CaseIterable {
        case protection, stats, settings, logs, follow, about

        /* The tabs at the bottom: on iPhone and iPad, Logs is a row of About
         * instead, so the bar keeps room for each name; the Mac has all six. */
        static var shown: [MainTab] {
            #if os(iOS)
            return allCases.filter { $0 != .logs }
            #else
            return allCases
            #endif
        }

        var icon: String {
            switch self {
            case .protection: return "shield"
            case .stats: return "chart.bar"
            case .settings: return "gearshape"
            case .logs: return "list.bullet.rectangle"
            case .follow: return "person.2"
            case .about: return "info.circle"
            }
        }

        var title: String {
            switch self {
            case .protection: return tr("navProtection")
            case .stats: return tr("navStats")
            case .settings: return tr("navSettings")
            case .logs: return tr("navLogs")
            case .follow: return tr("navFollow")
            case .about: return tr("navInfo")
            }
        }
    }

    /* The logo, the name and the tagline, and whether it is on. */
    private var header: some View {
        HStack(spacing: 12) {
            Image("Logo")
                .resizable()
                .scaledToFit()
                .frame(width: 34, height: 34)
            VStack(alignment: .leading, spacing: 1) {
                Text("Shroudly")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Theme.text)
                Text(tr("tagline"))
                    .font(.system(size: 12.5))
                    .foregroundStyle(Theme.secondaryText)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            StatusPill(phase: phase, warn: watch.ownServerDown != nil || watch.national != nil)
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 12)
    }

    /* One tab: the header, a line, and its page, in a stack of its own
     * (what a page opens stays in its tab). */
    private func tabScreen(_ t: MainTab) -> some View {
        NavigationStack {
            ZStack {
                Theme.background.ignoresSafeArea()
                VStack(spacing: 0) {
                    header
                    Rectangle().fill(Theme.line).frame(height: 1)
                    page(t).frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .navigationTitle("Shroudly")
            #if os(iOS)
            .toolbar(.hidden, for: .navigationBar)
            #endif
            #if os(macOS)
            // The window follows the sidebar (MacWindowFit), once it is there.
            .onAppear { DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { fit.attach() } }
            #endif
        }
    }

    /* A tab's icon and name: the icon alone in the iPhone's bar (VoiceOver
     * says the name), both in the iPad's bar and in a sidebar. */
    @ViewBuilder private func tabLabel(_ t: MainTab) -> some View {
        #if os(iOS)
        // Protection is Shroudly's own logo, in one colour (TabMark, made by
        // scripts/logo/make-tab.py), tinted by the bar as the symbols are.
        let label = Label { Text(t.title) } icon: { t == .protection ? Image("TabMark") : Image(systemName: t.icon) }
        if UIDevice.current.userInterfaceIdiom == .phone {
            label.labelStyle(.iconOnly)
        } else {
            label
        }
        #else
        // The Mac's sidebar: the logo at a sidebar icon's size.
        Label {
            Text(t.title)
        } icon: {
            if t == .protection {
                Image("TabMark").resizable().scaledToFit().frame(width: 17, height: 17)
            } else {
                Image(systemName: t.icon)
            }
        }
        #endif
    }

    @ViewBuilder private func page(_ t: MainTab) -> some View {
        switch t {
        case .protection: home
        case .stats:
            StatsPage(on: phase == .on, since: watch.preview ? Self.previewSince : controller.connectedSince,
                      stats: watch.preview ? Self.previewStats : stats)
        case .settings: SettingsView()
        case .logs: LogsView()
        case .follow: FollowView()
        case .about: AboutView()
        }
    }

    /* The Protection tab: the shield, what it says, the one button, and
     * "Something not working?", as on the desktop. */
    private var home: some View {
        GeometryReader { screen in
            ScrollView {
                VStack(spacing: Self.compact ? 18 : 24) {
                    Spacer(minLength: 0)
                    #if os(iOS)
                    // iPhone and iPad: the orb is the switch.
                    VStack(spacing: 4) {
                        PowerOrb(look: orbLook, size: 176) { toggle() }
                            .accessibilityLabel(controller.phase == .off ? tr("start") : tr("stop"))
                        Text(phase == .off ? tr("tapToStart") : phase == .on ? tr("tapToStop") : " ")
                            .font(.system(size: 12.5, weight: .medium))
                            .foregroundStyle(Theme.faintText)
                            .textCase(.uppercase)
                            .kerning(0.6)
                    }
                    // A firm tap when it is on, a light one when off.
                    .onChange(of: controller.phase) { new in
                        if new == .on { Feel.on() } else if new == .off { Feel.off() }
                    }
                    #else
                    PowerOrb(look: orbLook, size: 150)
                    #endif
                    VStack(spacing: 6) {
                        Text(title)
                            .font(.system(size: 24, weight: .semibold))
                            .foregroundStyle(Theme.text)
                            .multilineTextAlignment(.center)
                        Text(controller.notice ?? homeSubtitle)
                            .font(.system(size: 13.5))
                            .foregroundStyle(controller.notice == nil ? Theme.secondaryText : Theme.warn)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 24)
                        if controller.vpnNotAllowed {
                            Link(tr("appleInstallHelp"), destination: VpnErrors.installHelp)
                                .font(.callout.weight(.semibold))
                        }
                    }
                    card
                        .frame(maxWidth: 440)
                        .padding(.horizontal, 16)
                    #if os(macOS)
                    // The Mac keeps the desktop's button.
                    MainButton(phase: controller.phase) { toggle() }
                        .frame(maxWidth: 320)
                        .padding(.horizontal, 24)
                    #endif
                    NavigationLink { ReportView(watch: watch) } label: {
                        Label(tr("reportLink"), systemImage: "ladybug")
                            .font(.system(size: 14, weight: .medium))
                            .foregroundStyle(Theme.text.opacity(0.85))
                    }
                    .buttonStyle(.plain)
                    Spacer(minLength: 0)
                    footer
                }
                .frame(maxWidth: .infinity)
                .frame(minHeight: screen.size.height)
            }
            .macScrollBarHidden()
        }
    }

    /* Under the title: the desktop's words for the state, or what the
     * engine is doing now (your own server, the last way out). */
    private var homeSubtitle: String {
        let s = subtitle
        if s != tr("tagline") { return s }
        return phase == .on ? tr("dpiBypassRunning") : tr("dpiBypassStopped")
    }

    /* "A Codeshare product", as under the desktop's tabs: here at the foot
     * of Protection, the system's tabs having no room under them. */
    private var footer: some View {
        let parts = tr("footerProduct").components(separatedBy: "{brand}")
        return (Text(parts.first ?? "") + Text("Codeshare").fontWeight(.semibold).foregroundColor(Theme.text.opacity(0.85))
                + Text(parts.count > 1 ? parts[1] : ""))
            .font(.system(size: 12))
            .foregroundStyle(Theme.faintText)
            .padding(.vertical, 7)
    }
    #endif

    /* The button and what it says. */
    private var status: some View {
        VStack(spacing: Self.compact ? 18 : 28) {
            PowerOrb(look: orbLook, size: 250) { toggle() }
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
                // "Something not working?": always here, under the status
                // (ReportView).
                NavigationLink { ReportView(watch: watch) } label: {
                    Label(tr("reportLink"), systemImage: "exclamationmark.bubble")
                        .font(.callout.weight(.medium))
                        .foregroundStyle(Theme.accent)
                }
                .buttonStyle(.plain)
            }
        }
    }

    /* Debug builds' screenshots: believable numbers instead of dashes. */
    private static let previewSince = Date().addingTimeInterval(-(42 * 60 + 17))
    private static let previewStats = EngineStats(["conns_active": 14, "conns_total": 386, "blocked": 37, "bytes_down": 248_000_000, "bytes_up": 19_400_000, "online": 1_204])

    private var hasCard: Bool {
        phase == .on && (watch.ownServerDown != nil || watch.national != nil || controller.dnsAround || controller.torAsk != nil || (helpDue && controller.notice == nil && !Theme.isTV))
    }

    /* The one card under the status, when there is one. */
    @ViewBuilder private var card: some View {
        if phase == .on, let down = watch.ownServerDown {
            Warning(title: tr("ownServerDown"),
                    text: tr("ownServerDownBody", ["server": down.server, "why": OwnServer.whyText(down.why),
                                                   "path": "\(tr("navSettings")) \(direction == .rightToLeft ? "←" : "→") \(tr("ownServer"))"]))
        } else if phase == .on, let host = controller.torAsk {
            // A site needs Tor; asked here, never in a window of its own (issue #77).
            TorAskCard(host: host.isEmpty ? "…" : host,
                       yes: { Task { await controller.answerTor(true) } },
                       no: { Task { await controller.answerTor(false) } })
        } else if phase == .on, controller.dnsAround {
            // A DNS profile or app answers apps' lookups before the tunnel.
            Warning(title: tr("dnsAroundTitle"), text: tr("dnsAroundApple"))
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

    /* Under the status: the address sites see while it works through your
     * own server (issue #66), else the tagline. */
    private var subtitle: String {
        if phase == .on, let ip = watch.exit, watch.ownServerDown == nil, watch.national == nil {
            return tr("ownServerExit", ["ip": ip])
        }
        // The last way out (Tunnel/TorRoute.swift) at work.
        if phase == .on, let lr = controller.lastResort, watch.ownServerDown == nil, watch.national == nil {
            switch lr.state {
            case "ready": return tr("lastResortReady")
            case "failed": return tr("lastResortFailed")
            default: return tr("lastResortStarting", ["progress": String(lr.progress)])
            }
        }
        // Just started: an app that was open before may hold its old
        // connections; said for the first two minutes.
        if phase == .on, let since = controller.connectedSince, Date().timeIntervalSince(since) < 120,
           watch.ownServerDown == nil, watch.national == nil {
            return tr("reopenAppsHint")
        }
        return tr("tagline")
    }

    /* The tunnel's phase; "on" for a debug build's warning screenshots. */
    private var phase: TunnelController.Phase { watch.preview ? .on : controller.phase }

    /* The orb's look: amber when on but your own server or the world does
     * not answer. */
    private var orbLook: PowerOrb.Look {
        switch phase {
        case .off: return .off
        case .starting, .stopping: return .busy
        case .on: return watch.ownServerDown != nil || watch.national != nil ? .warn : .on
        }
    }

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

/* A site no technique opened can go through Tor, much more slowly: asked,
 * with "No" and "Use Tor" (issue #77). */
private struct TorAskCard: View {
    let host: String
    let yes: () -> Void
    let no: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(tr("torAskTitle", ["host": host]), systemImage: "network")
                .font(.callout.weight(.semibold))
                .foregroundStyle(.white)
                .fixedSize(horizontal: false, vertical: true)
            Text(tr("torAskCard", ["host": host]))
                .font(.footnote)
                .foregroundStyle(Theme.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 12) {
                Spacer()
                Button(tr("torAskNo"), action: no)
                    .foregroundStyle(Theme.secondaryText)
                Button(tr("torAskYes"), action: yes)
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

#if !os(tvOS)
/* The desktop's status pill (app/page.js): a dot and Active / Inactive. */
private struct StatusPill: View {
    let phase: TunnelController.Phase
    var warn = false

    private var color: Color {
        switch phase {
        case .on: return warn ? Theme.warn : Theme.ok
        case .starting, .stopping: return Theme.warn
        case .off: return Theme.danger
        }
    }

    var body: some View {
        HStack(spacing: 7) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(phase == .on ? tr("active") : phase == .off ? tr("inactive") : (phase == .starting ? tr("starting") : tr("stopping")))
                .font(.system(size: 13, weight: .medium))
                .lineLimit(1)
        }
        .foregroundStyle(color)
        .padding(.horizontal, 11)
        .padding(.vertical, 6)
        .background(color.opacity(0.12), in: Capsule())
    }
}

/* The desktop's one button: "Start protection" in the accent, "Stop
 * protection" quieter once on. */
private struct MainButton: View {
    let phase: TunnelController.Phase
    let action: () -> Void

    private var on: Bool { phase == .on || phase == .starting }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                if phase == .starting || phase == .stopping {
                    ProgressView().controlSize(.small).tint(on ? Theme.text : Theme.background)
                } else {
                    Image(systemName: "power").font(.system(size: 16, weight: .semibold))
                }
                Text(phase == .starting ? tr("starting") : phase == .stopping ? tr("stopping") : (on ? tr("stop") : tr("start")))
                    .font(.system(size: 16, weight: .semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            .foregroundStyle(on ? Theme.text : Theme.background)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .background(on ? Theme.cardRaised : Theme.accent, in: RoundedRectangle(cornerRadius: Theme.radius))
            .overlay(RoundedRectangle(cornerRadius: Theme.radius).stroke(on ? Theme.lineStrong : .clear, lineWidth: 1))
            .contentShape(RoundedRectangle(cornerRadius: Theme.radius))
        }
        .buttonStyle(.plain)
        .disabled(phase == .stopping)
    }
}

/* The desktop's Logs tab (components/LogsPanel.js): the app's and the
 * tunnel's last lines, newest last, with the desktop's filters (the level
 * read from the words, as these lines carry none), the count, Copy, and
 * Save to a file. */
struct LogsView: View {
    enum Level: String, CaseIterable { case all, info, success, warning, error
        var title: String {
            switch self {
            case .all: return tr("logAll")
            case .info: return tr("logInfo")
            case .success: return tr("logSuccess")
            case .warning: return tr("logWarning")
            case .error: return tr("logError")
            }
        }
        var color: Color {
            switch self {
            case .all: return Theme.secondaryText
            case .info: return Theme.accent
            case .success: return Theme.ok
            case .warning: return Theme.warn
            case .error: return Theme.danger
            }
        }

        static func of(_ line: String) -> Level {
            let l = line.lowercased()
            if l.contains("error") || l.contains("failed") || l.contains("protection ends") || l.contains("could not") { return .error }
            if l.contains("blocked") || l.contains("warning") || l.contains("not reachable") || l.contains("cannot") || l.contains("did not") { return .warning }
            if l.contains("protection on") || l.contains("is ready") || l.contains("listening") || l.contains("opened") || l.contains("allowed") { return .success }
            return .info
        }
    }

    @State private var lines: [String] = []
    @State private var level: Level = .all
    @State private var copied = false
    @State private var saving = false
    @State private var saved: Bool?

    private var shown: [String] { level == .all ? lines : lines.filter { Level.of($0) == level } }

    var body: some View {
        VStack(spacing: 12) {
            ScrollView(.horizontal) {
                HStack(spacing: 6) {
                    ForEach(Level.allCases, id: \.self) { l in
                        Button { level = l } label: {
                            HStack(spacing: 6) {
                                if l != .all { Circle().fill(l.color).frame(width: 6, height: 6) }
                                Text(l.title)
                            }
                            .font(.system(size: 12.5, weight: .medium))
                            .foregroundStyle(level == l ? Theme.accent : Theme.secondaryText)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 6)
                            .background(level == l ? Theme.accent.opacity(0.12) : Theme.card, in: Capsule())
                            .overlay(Capsule().stroke(level == l ? Theme.accent.opacity(0.38) : Theme.line, lineWidth: 1))
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .scrollIndicators(.never)
            Group {
                if shown.isEmpty {
                    VStack(spacing: 10) {
                        Image(systemName: "list.bullet.rectangle").font(.system(size: 26, weight: .light))
                        Text(lines.isEmpty ? tr("noLogs") : tr("noLogsFiltered")).font(.system(size: 13))
                    }
                    .foregroundStyle(Theme.faintText)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    ScrollViewReader { reader in
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 6) {
                                ForEach(Array(shown.enumerated()), id: \.offset) { i, line in
                                    HStack(alignment: .top, spacing: 8) {
                                        Circle().fill(Level.of(line).color).frame(width: 6, height: 6).padding(.top, 5)
                                        Text(line)
                                            .font(.system(size: 11.5, design: .monospaced))
                                            .foregroundStyle(Theme.secondaryText)
                                            .textSelection(.enabled)
                                            .frame(maxWidth: .infinity, alignment: .leading)
                                    }
                                    .id(i)
                                }
                            }
                            .padding(14)
                        }
                        .scrollIndicators(.never)
                        .onChange(of: shown.count) { n in if n > 0 { reader.scrollTo(n - 1, anchor: .bottom) } }
                        .onAppear { if !shown.isEmpty { reader.scrollTo(shown.count - 1, anchor: .bottom) } }
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: Theme.radius))
            .overlay(RoundedRectangle(cornerRadius: Theme.radius).stroke(Theme.line, lineWidth: 1))
            HStack(spacing: 8) {
                Text(tr("logEntries", ["count": String(shown.count)]))
                    .font(.system(size: 12.5))
                    .foregroundStyle(Theme.faintText)
                Spacer(minLength: 6)
                small(copied ? tr("logsCopied") : tr("copyLogs"), icon: copied ? "checkmark" : "doc.on.doc") {
                    copy(shown.joined(separator: "\n"))
                    copied = true
                }
                small(saved == true ? tr("logsSaved") : saved == false ? tr("logsSaveFailed") : tr("saveLogs"), icon: "square.and.arrow.down") {
                    saving = true
                }
            }
        }
        .padding(16)
        .fileExporter(isPresented: $saving, document: LogFile(text: Diagnostics.text(sites: [])), contentType: .plainText,
                      defaultFilename: "shroudly-log.txt") { result in
            if case .success = result { saved = true } else { saved = false }
        }
        .task {
            while !Task.isCancelled {
                lines = Array((SharedLog(name: "app.log").tail(200) + SharedLog(name: "tunnel.log").tail(400)).sorted().suffix(500))
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
        }
    }

    private func small(_ title: String, icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: icon)
                .font(.system(size: 12.5, weight: .medium))
                .lineLimit(1)
                .minimumScaleFactor(0.75)
                .foregroundStyle(Theme.secondaryText)
                .padding(.horizontal, 11)
                .padding(.vertical, 7)
                .background(Theme.card, in: RoundedRectangle(cornerRadius: Theme.radiusSmall))
                .overlay(RoundedRectangle(cornerRadius: Theme.radiusSmall).stroke(Theme.line, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private func copy(_ s: String) {
        #if os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(s, forType: .string)
        #else
        UIPasteboard.general.string = s
        #endif
    }
}

/* The log as a text file for Save logs. */
struct LogFile: FileDocument {
    static var readableContentTypes: [UTType] { [.plainText] }
    var text: String
    init(text: String) { self.text = text }
    init(configuration: ReadConfiguration) throws {
        text = configuration.file.regularFileContents.flatMap { String(data: $0, encoding: .utf8) } ?? ""
    }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: Data(text.utf8))
    }
}
#endif

#if !os(tvOS)
/* iOS 26: the tab bar draws in to one button while a page scrolls down, as
 * in Apple's own apps, and comes back on the way up. */
private struct TabBarMinimize: ViewModifier {
    func body(content: Content) -> some View {
        #if os(iOS)
        if #available(iOS 26.0, *) {
            content.tabBarMinimizeBehavior(.onScrollDown)
        } else {
            content
        }
        #else
        content
        #endif
    }
}
#endif

#if os(macOS)
/* The Mac's window follows the sidebar: hidden with its button, the window
 * narrows by the sidebar's width instead of the page widening; shown again,
 * it widens back as the sidebar slides in, the page staying as it was. The
 * sidebar is AppKit's (NSSplitViewItem), watched as it collapses. A sidebar
 * that folds away because the user drags the window narrower is left so. */
final class MacWindowFit {
    static var hasSidebar: Bool {
        if #available(macOS 15.0, *) { return true }
        return false
    }

    private var watch: NSKeyValueObservation?
    private var width: CGFloat = 0

    /* Find the window's sidebar and follow it (once, when it is there). */
    func attach() {
        guard Self.hasSidebar, watch == nil else { return }
        guard let win = NSApp.windows.first(where: { $0.identifier?.rawValue.hasPrefix("shroudly-window") == true && $0.isVisible }) ?? NSApp.mainWindow,
              let root = win.contentView, let item = Self.sidebarItem(in: root) else { return }
        if !item.isCollapsed { width = item.viewController.view.frame.width }
        watch = item.observe(\.isCollapsed, options: [.new]) { [weak self, weak win] item, change in
            guard let self, let win, let collapsed = change.newValue else { return }
            DispatchQueue.main.async { self.follow(win, item, collapsed) }
        }
    }

    private func follow(_ win: NSWindow, _ item: NSSplitViewItem, _ collapsed: Bool) {
        // Folded by a narrower window: nothing to follow.
        guard !win.inLiveResize else { return }
        if collapsed {
            if width <= 0 { width = 220 }
        } else {
            let w = item.viewController.view.frame.width
            if w > 60 { width = w } else if width <= 0 { width = 220 }
        }
        var frame = win.frame
        frame.size.width += collapsed ? -width : width
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.25
            ctx.allowsImplicitAnimation = true
            win.animator().setFrame(frame, display: true)
        }
        // The width it settles at, for the next time.
        if !collapsed {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
                let w = item.viewController.view.frame.width
                if w > 60 { self?.width = w }
            }
        }
    }

    private static func sidebarItem(in view: NSView) -> NSSplitViewItem? {
        if let split = view as? NSSplitView, let vc = split.delegate as? NSSplitViewController,
           let item = vc.splitViewItems.first(where: { $0.behavior == .sidebar }) {
            return item
        }
        for sub in view.subviews {
            if let item = sidebarItem(in: sub) { return item }
        }
        return nil
    }
}
#endif
