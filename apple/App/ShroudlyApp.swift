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
    @AppStorage(Accent.key) private var accent = Accent.defaultId

    var body: some Scene {
        #if os(macOS)
        // The desktop app's window (electron/main.js, launch.js): its page 460
        // by 760, with the system's sidebar of tabs beside it on macOS 15 and
        // later. The id is new with the sidebar, so a size an earlier version
        // saved is not reused.
        Window("Shroudly", id: "shroudly-window-2") {
            // The width: ContentView's, with the sidebar or without it.
            root.frame(minHeight: 532, idealHeight: 732, maxHeight: 1072)
        }
        .defaultSize(width: 460 + (MacWindowFit.hasSidebar ? 220 : 0), height: 760)
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
            .task {
                #if os(macOS)
                // The logo chosen in Settings, on the Dock (it forgets it when the app quits).
                Logos.apply()
                #endif
                await controller.load()
                #if DEBUG
                // A test on a Mac (a debug build only): protection started at
                // launch (-ShroudlyStart YES), or stopped (-ShroudlyStop YES), no click needed.
                if UserDefaults.standard.bool(forKey: "ShroudlyStart") { await controller.start() }
                if UserDefaults.standard.bool(forKey: "ShroudlyStop") { await controller.stop() }
                #endif
            }
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
