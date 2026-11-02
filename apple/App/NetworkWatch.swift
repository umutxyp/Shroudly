import Foundation

/*
 * What the main screen says beside "Protected", while protection is on and
 * the app is open:
 *  - your own server not working: the tunnel says so (OwnServer.Down, from
 *    the engine), shown for 90 seconds after it last did, as on the desktop;
 *  - only this country's network working (NationalNet): looked at once a
 *    minute at most; the country is kept (HelpNudge asks no one there);
 *  - working through your own server: the address sites see (issue #66),
 *    looked at every ten minutes, a minute after a look that got nothing.
 */
@MainActor
final class NetworkWatch: ObservableObject {
    struct Down: Equatable {
        let server: String
        let why: String
    }

    @Published private(set) var ownServerDown: Down?
    @Published private(set) var national: String?
    @Published private(set) var exit: String?
    private var nationalAt = Date.distantPast
    private var exitAt = Date.distantPast
    /* Debug builds: a warning shown as if protection were on, for
     * screenshots (-ShroudlyScreen warn-server | warn-national). */
    private(set) var preview = false

    init() {
        #if DEBUG
        switch UserDefaults.standard.string(forKey: "ShroudlyScreen") {
        case "warn-server": ownServerDown = Down(server: "SOCKS5 203.0.113.5:1080", why: "noAnswer"); preview = true
        case "warn-national": national = "IR"; preview = true
        case "exit": exit = "203.0.113.7"; preview = true
        case "help", "whatsnew": preview = true
        default: break
        }
        #endif
    }

    func refresh(protected: Bool) async {
        if preview { return }
        guard protected else {
            ownServerDown = nil
            national = nil
            nationalAt = .distantPast
            exit = nil
            exitAt = .distantPast
            return
        }
        let d = AppGroup.defaults
        let at = d.double(forKey: OwnServer.Down.at)
        if at > 0, Date().timeIntervalSince1970 - at < OwnServer.Down.shownFor, let why = d.string(forKey: OwnServer.Down.why) {
            ownServerDown = Down(server: d.string(forKey: OwnServer.Down.server) ?? "", why: why)
        } else {
            ownServerDown = nil
        }
        if Date().timeIntervalSince(nationalAt) >= 60 {
            nationalAt = Date()
            national = await NationalNet.check()
            if let national { UserDefaults.standard.set(national, forKey: HelpNudge.homeCountryKey) }
        }
        if SettingsStore().load().ownServer.isEmpty || ownServerDown != nil {
            exit = nil
            exitAt = .distantPast
        } else if Date().timeIntervalSince(exitAt) >= (exit == nil ? 60 : 600) {
            exitAt = Date()
            exit = await OwnServer.exitAddress()
        }
    }
}
