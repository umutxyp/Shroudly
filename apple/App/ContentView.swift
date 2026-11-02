import StoreKit
import SwiftUI

/* The main screen: the status, one big button, and the way to Settings and About. */
struct ContentView: View {
    @EnvironmentObject private var controller: TunnelController
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.requestReview) private var requestReview
    @AppStorage("noticeSeen") private var noticeSeen = false
    @State private var showNotice = false
    @StateObject private var watch = NetworkWatch()
    @Environment(\.layoutDirection) private var direction

    var body: some View {
        NavigationStack {
            ZStack {
                Theme.background.ignoresSafeArea()
                VStack(spacing: 28) {
                    Spacer()
                    Orb(phase: phase, warn: watch.ownServerDown != nil || watch.national != nil) { toggle() }
                    VStack(spacing: 8) {
                        Text(title)
                            .font(.title2.weight(.semibold))
                            .foregroundStyle(.white)
                        Text(controller.notice ?? tr("tagline"))
                            .font(.callout)
                            .foregroundStyle(controller.notice == nil ? Theme.secondaryText : .orange)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 24)
                    }
                    if phase == .on, let down = watch.ownServerDown {
                        Warning(title: tr("ownServerDown"),
                                text: tr("ownServerDownBody", ["server": down.server, "why": OwnServer.whyText(down.why),
                                                               "path": "\(tr("navSettings")) \(direction == .rightToLeft ? "←" : "→") \(tr("ownServer"))"]))
                    } else if phase == .on, watch.national != nil {
                        Warning(title: tr("nationalOnlyTitle"), text: tr("nationalOnlyBody"),
                                link: (tr("nationalOnlyHelp"), NationalNet.guideURL(language: Bundle.main.preferredLocalizations.first ?? "en")))
                    }
                    Spacer()
                    HStack(spacing: 12) {
                        NavigationLink { SettingsView() } label: {
                            Tab(icon: "gearshape", text: tr("navSettings"))
                        }
                        NavigationLink { AboutView() } label: {
                            Tab(icon: "info.circle", text: tr("navInfo"))
                        }
                    }
                    .buttonStyle(.plain)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 12)
                }
                .frame(maxWidth: 520)
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
        .task(id: RatingPrompt.Moment(phase: controller.phase, active: scenePhase == .active)) {
            await RatingPrompt.maybeAsk(controller: controller, active: scenePhase == .active) { requestReview() }
        }
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
        .buttonStyle(.plain)
        .disabled(phase == .stopping)
        .accessibilityLabel(on || phase == .starting ? tr("stop") : tr("start"))
    }

    private var on: Bool { phase == .on }
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
            Text(text)
                .font(.footnote)
                .foregroundStyle(Theme.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
            if let link {
                Link(link.0, destination: link.1).font(.footnote.weight(.semibold))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 14))
        .padding(.horizontal, 16)
        .accessibilityElement(children: .combine)
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
