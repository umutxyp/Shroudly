import StoreKit
import SwiftUI

/* The main screen: the status, one big button, and the way to Settings and About. */
struct ContentView: View {
    @EnvironmentObject private var controller: TunnelController
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.requestReview) private var requestReview
    @AppStorage("noticeSeen") private var noticeSeen = false
    @State private var showNotice = false

    var body: some View {
        NavigationStack {
            ZStack {
                Theme.background.ignoresSafeArea()
                VStack(spacing: 28) {
                    Spacer()
                    Orb(phase: controller.phase) { toggle() }
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
        .task(id: RatingPrompt.Moment(phase: controller.phase, active: scenePhase == .active)) {
            await RatingPrompt.maybeAsk(controller: controller, active: scenePhase == .active) { requestReview() }
        }
    }

    private var title: String {
        switch controller.phase {
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

/* The big round button: blue and glowing when protected, grey when not. */
private struct Orb: View {
    let phase: TunnelController.Phase
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack {
                Circle()
                    .fill(on ? Theme.accent.opacity(0.18) : Theme.card)
                    .frame(width: 210, height: 210)
                Circle()
                    .stroke(on ? Theme.accent : Theme.off, lineWidth: 4)
                    .frame(width: 180, height: 180)
                if phase == .starting || phase == .stopping {
                    ProgressView().controlSize(.large).tint(.white)
                } else {
                    Image(systemName: "power")
                        .font(.system(size: 64, weight: .medium))
                        .foregroundStyle(on ? Theme.accent : Theme.secondaryText)
                }
            }
            .shadow(color: on ? Theme.accent.opacity(0.45) : .clear, radius: 30)
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(phase == .stopping)
        .accessibilityLabel(on || phase == .starting ? tr("stop") : tr("start"))
    }

    private var on: Bool { phase == .on }
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
