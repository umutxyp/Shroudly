#if !os(tvOS)
import SwiftUI
import WebKit

/*
 * "Help people in censored countries" inside Shroudly (About; off until the
 * user turns it on): a Snowflake proxy for the Tor network, the desktop's
 * very page (App/Snowflake/proxy.{html,js}, the same files as
 * electron/snowflake/, a test keeps them so) in a hidden web view of its
 * own, with nothing of the app's: the page gets its settings and reports
 * its counts through one message handler, and may reach only Tor's broker,
 * its NAT probe and its relays (a content rule list blocks the rest).
 *
 * It runs while the app runs: on iPhone and iPad while Shroudly is open
 * (the system stops apps in the background), on the Mac while it is running.
 * It connects directly, not through Shroudly's protection: it helps others,
 * it needs no techniques. Nothing is recorded of anyone; only how many are
 * helped now and since it was turned on.
 */
@MainActor
final class Snowflake: NSObject, ObservableObject, WKScriptMessageHandler {
    static let shared = Snowflake()
    static let key = "snowflakeOn"
    private static let natKey = "snowflakeNat"
    private static let natAtKey = "snowflakeNatAt"

    enum State: String { case off, starting, waiting, serving, unreachable, failed }

    @Published private(set) var state = State.off
    @Published private(set) var now = 0
    @Published private(set) var total = 0
    @Published private(set) var error: String?

    private var web: WKWebView?
    private var rules: WKContentRuleList?

    // Nor where Tor itself is blocked (HelpNudge.torBlockedHere).
    var enabled: Bool { UserDefaults.standard.bool(forKey: Self.key) && !HelpNudge.torBlockedHere() }

    /* The desktop's pageConfig (electron/snowflake.js). */
    private func config() -> [String: Any] {
        let d = UserDefaults.standard
        let nat = d.string(forKey: Self.natKey)
        return [
            "broker": "https://snowflake-broker.torproject.net/",
            "probe": "https://snowflake-broker.torproject.net:8443/probe",
            "defaultRelay": "wss://snowflake.torproject.net/",
            "relayPattern": "snowflake.torproject.net",
            "iceServers": [["urls": ["stun:stun.l.google.com:19302"]]],
            "natIceServers": [["urls": "stun:stun1.l.google.com:19302"]],
            "insecureRelay": false,
            "pollMs": 60_000,
            "minPollMs": 1000,
            "nat": nat == "unrestricted" || nat == "restricted" ? nat as Any : NSNull(),
            "natAt": d.double(forKey: Self.natAtKey),
        ]
    }

    /* Running exactly while it is on and the app may run it. */
    func sync(active: Bool) {
        if enabled && active { start() } else { stop() }
    }

    private func start() {
        guard web == nil else { return }
        state = .starting; now = 0; total = 0; error = nil
        Task { await load() }
    }

    func stop() {
        guard let w = web else { if state != .off { state = .off }; return }
        w.evaluateJavaScript("window.__shroudlyStop && window.__shroudlyStop()")
        w.configuration.userContentController.removeScriptMessageHandler(forName: "snowflake")
        w.stopLoading()
        w.removeFromSuperview()
        web = nil
        state = .off; now = 0
    }

    private func load() async {
        if rules == nil {
            // Only the page's own files and Tor's broker, probe and relays.
            let json = """
            [{"trigger":{"url-filter":".*"},"action":{"type":"block"}},
             {"trigger":{"url-filter":"^file:"},"action":{"type":"ignore-previous-rules"}},
             {"trigger":{"url-filter":"^https://snowflake-broker\\\\.torproject\\\\.net(:8443)?/"},"action":{"type":"ignore-previous-rules"}},
             {"trigger":{"url-filter":"^wss://([a-z0-9-]+\\\\.)*snowflake\\\\.torproject\\\\.net/"},"action":{"type":"ignore-previous-rules"}}]
            """
            rules = try? await WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "shroudly-snowflake", encodedContentRuleList: json)
        }
        guard state == .starting, web == nil,
              let page = Bundle.main.url(forResource: "proxy", withExtension: "html") else { return }
        let ucc = WKUserContentController()
        if let rules { ucc.add(rules) }
        ucc.add(self, name: "snowflake")
        let cfg = (try? JSONSerialization.data(withJSONObject: config())).map { String(decoding: $0, as: UTF8.self) } ?? "{}"
        // The page's only link to the app, as the desktop's preload gives it.
        let bridge = """
        window.snowflakeHost = {
          config: () => Promise.resolve(\(cfg)),
          report: (s) => window.webkit.messageHandlers.snowflake.postMessage(s),
          onStop: (fn) => { window.__shroudlyStop = fn; }
        };
        """
        ucc.addUserScript(WKUserScript(source: bridge, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let c = WKWebViewConfiguration()
        c.userContentController = ucc
        c.websiteDataStore = .nonPersistent()
        let w = WKWebView(frame: CGRect(x: 0, y: 0, width: 1, height: 1), configuration: c)
        w.isHidden = true
        #if os(iOS)
        // In the window, so the system does not hold its timers back.
        if let window = UIApplication.shared.connectedScenes.compactMap({ ($0 as? UIWindowScene)?.keyWindow }).first {
            window.addSubview(w)
        }
        #endif
        web = w
        w.loadFileURL(page, allowingReadAccessTo: page.deletingLastPathComponent())
    }

    nonisolated func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let s = message.body as? [String: Any] else { return }
        Task { @MainActor in
            guard web != nil else { return }
            let st = State(rawValue: s["state"] as? String ?? "") ?? .starting
            state = [.starting, .waiting, .serving, .unreachable].contains(st) ? st : .starting
            now = max(0, (s["now"] as? NSNumber)?.intValue ?? 0)
            total = max(total, (s["total"] as? NSNumber)?.intValue ?? 0)
            if let nat = s["nat"] as? String, nat == "unrestricted" || nat == "restricted",
               let at = (s["natAt"] as? NSNumber)?.doubleValue, at > 0 {
                UserDefaults.standard.set(nat, forKey: Self.natKey)
                UserDefaults.standard.set(at, forKey: Self.natAtKey)
            }
        }
    }

    /* The line under the switch, as the desktop's window says it. */
    var line: String? {
        switch state {
        case .off: return nil
        case .starting: return tr("snowflakeStarting")
        case .waiting: return now > 0 || total > 0 ? tr("snowflakeCounts", ["now": "\(now)", "total": "\(total)"]) : tr("snowflakeWaiting")
        case .serving: return tr("snowflakeCounts", ["now": "\(now)", "total": "\(total)"])
        case .unreachable: return tr("snowflakeUnreachable")
        case .failed: return tr("snowflakeFailed", ["error": error ?? "?"])
        }
    }
}
#endif
