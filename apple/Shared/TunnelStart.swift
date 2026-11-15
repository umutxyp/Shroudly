import Foundation

/* What the app passes when it starts the tunnel itself (the app, a widget, a
 * shortcut), so the tunnel can tell a start of the system's own from one
 * asked for: the system starts it with no options. */
enum TunnelStart {
    static let key = "by"
    static let byApp: [String: NSObject] = [key: "app" as NSString]

    static func isByApp(_ options: [String: NSObject]?) -> Bool {
        (options?[key] as? String) == "app"
    }
}
