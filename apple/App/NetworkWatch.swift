import Foundation

/*
 * What the main screen says beside "Protected", while protection is on and
 * the app is open:
 *  - your own server not working: the tunnel says so (OwnServer.Down, from
 *    the engine), shown for 90 seconds after it last did, as on the desktop;
 *  - only this country's network working (NationalNet): looked at once a
 *    minute at most.
 */
@MainActor
final class NetworkWatch: ObservableObject {
    struct Down: Equatable {
        let server: String
        let why: String
    }

    @Published private(set) var ownServerDown: Down?
    @Published private(set) var national: String?
    private var nationalAt = Date.distantPast
    /* Debug builds: a warning shown as if protection were on, for
     * screenshots (-ShroudlyScreen warn-server | warn-national). */
    private(set) var preview = false

    init() {
        #if DEBUG
        switch UserDefaults.standard.string(forKey: "ShroudlyScreen") {
        case "warn-server": ownServerDown = Down(server: "SOCKS5 203.0.113.5:1080", why: "noAnswer"); preview = true
        case "warn-national": national = "IR"; preview = true
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
        }
    }
}
