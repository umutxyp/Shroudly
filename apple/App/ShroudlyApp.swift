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
        #if DEBUG
        // Screenshots of the screens (a debug build only): an own server as
        // if saved (-ShroudlyOwnServer <link>).
        if let link = UserDefaults.standard.string(forKey: "ShroudlyOwnServer") {
            let store = SettingsStore()
            var s = store.load()
            s.ownServer = link
            store.save(s)
        }
        #endif
    }

    // The accent chosen in Settings: the whole app follows it at once.
    @AppStorage(Accent.key) private var accent = "logo"

    var body: some Scene {
        #if os(macOS)
        // A small Mac window the size of the desktop app's own width (480 by 680),
        // never the whole height of the screen.
        Window("Shroudly", id: "main") {
            root.frame(width: 480, height: 680)
        }
        .windowResizability(.contentSize)
        #else
        WindowGroup {
            root
        }
        #endif
    }

    private var root: some View {
        screen
            .environmentObject(controller)
            .preferredColorScheme(.dark)
            .tint(Accent.color(accent))
            .task { await controller.load() }
    }

    /* The main screen; in a debug build, -ShroudlyScreen settings|about opens
     * that one instead, for screenshots. */
    @ViewBuilder private var screen: some View {
        #if DEBUG
        switch UserDefaults.standard.string(forKey: "ShroudlyScreen") {
        case "settings": NavigationStack { SettingsView() }
        case "about": NavigationStack { AboutView() }
        default: ContentView()
        }
        #else
        ContentView()
        #endif
    }
}
