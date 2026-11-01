import SwiftUI

/*
 * Shroudly for iPhone, iPad and Mac: one big Start/Stop, the status, a few
 * settings, and About. The work is done by the packet tunnel (Tunnel/), the
 * same engine the desktop and Android apps run.
 *
 * As in the Google Play copy: no ad blocking, no donation links, no update
 * check (the App Store updates it), and a rating is asked for only with
 * Apple's own prompt, at a good moment (RatingPrompt).
 */
@main
struct ShroudlyApp: App {
    @StateObject private var controller = TunnelController()

    init() {
        RatingStore().noteLaunch()
    }

    var body: some Scene {
        #if os(macOS)
        Window("Shroudly", id: "main") {
            root
        }
        .defaultSize(width: 420, height: 620)
        #else
        WindowGroup {
            root
        }
        #endif
    }

    private var root: some View {
        ContentView()
            .environmentObject(controller)
            .preferredColorScheme(.dark)
            .tint(Theme.accent)
            .task { await controller.load() }
    }
}
