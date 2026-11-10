import SwiftUI
#if canImport(UIKit)
import UIKit
#endif
#if canImport(AppKit)
import AppKit
#endif

/*
 * "Something not working?" (under the status, ContentView): the user says
 * what went wrong, in 50 to 1000 characters, and it goes to the developer
 * with the app's log (Report). What is sent, where it goes and that our
 * server keeps none of it are said above Send, which waits for the user to
 * agree to send it, log included. One report an hour, three a day; the
 * references sent stay listed for 60 days. On iPhone, iPad, Mac and Apple TV
 * (with the remote alone). The same as the desktop's dialog and Android's.
 */
struct ReportView: View {
    @EnvironmentObject private var controller: TunnelController
    // What the main screen shows about the network (own server down, only
    // the country's network, the exit country): in the report too.
    @ObservedObject var watch: NetworkWatch
    @State private var fields = Report.Fields()
    @State private var agree = false
    @State private var sending = false
    @State private var sentRef: String?
    @State private var failure: String?
    @State private var past: [Report.Sent] = Report.load()
    @State private var copied: String?

    private static let privacy = URL(string: "https://codeshare.me/projects/shroudly/privacy")!

    private var count: Int { Report.chars(fields.what) }
    private var wait: Report.Wait { Report.wait(past) }
    private var canSend: Bool {
        agree && !sending && wait.seconds <= 0 && Report.problem(what: fields.what, site: fields.site, contact: fields.contact) == nil
    }

    private func rateText(_ limit: String?) -> String { tr(limit == "day" ? "reportRateDay" : "reportRateHour") }

    var body: some View {
        Form {
            Section {
                Text(tr("reportIntro"))
                Text(tr("reportSendDesc")).font(.footnote).foregroundStyle(Theme.secondaryText)
            }
            if let ref = sentRef {
                Section {
                    Text(tr("reportSent")).font(.headline).foregroundStyle(Theme.accent)
                    Text(ref).font(.title3.monospaced().weight(.semibold)).selectableText()
                    #if !os(tvOS)
                    Button { copy(ref) } label: {
                        Label(copied == ref ? tr("reportCopied") : tr("reportCopy"), systemImage: copied == ref ? "checkmark" : "doc.on.doc")
                    }
                    #endif
                    Text(tr("reportSentHint")).font(.footnote).foregroundStyle(Theme.secondaryText)
                }
            } else {
                Section {
                    TextField(tr("reportWhat"), text: Binding(get: { fields.what }, set: { v in
                        var u = String.UnicodeScalarView()
                        u.append(contentsOf: v.unicodeScalars.prefix(Report.whatMax))
                        fields.what = String(u)
                    }), axis: .vertical)
                    .lineLimit(5...12)
                    Text(tr("reportWhatHint")).font(.footnote).foregroundStyle(Theme.secondaryText)
                    Text("\(count) / \(Report.whatMax)")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(count > 0 && count < Report.whatMin ? .orange : Theme.secondaryText)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                    if count >= Report.whatMin && !Report.whatOk(fields.what) {
                        Text(tr("reportBadWhat")).font(.footnote).foregroundStyle(.orange)
                    }
                } header: {
                    Text(tr("reportWhat"))
                }
                Section {
                    TextField(tr("reportSite"), text: $fields.site)
                    TextField(tr("reportContact"), text: $fields.contact)
                        #if os(iOS) || os(tvOS)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        #endif
                        .autocorrectionDisabled()
                    if fields.contact.trimmingCharacters(in: .whitespaces).count > 3 && !Report.contactOk(fields.contact) {
                        Text(tr("reportBadContact")).font(.footnote).foregroundStyle(.orange)
                    }
                }
                // One box: the report with the log, and the privacy policy, a
                // link away. The provider and the country are never asked:
                // the report server takes them from the connection.
                Section {
                    Toggle(tr("reportAgree"), isOn: $agree)
                    WebLink(url: Self.privacy) { Text(tr("androidPrivacyPolicy")) }
                }
                Section {
                    if wait.seconds > 0 {
                        Text(rateText(wait.limit)).foregroundStyle(.orange)
                    } else if let f = failure {
                        Text(f).foregroundStyle(.orange)
                    }
                    Button {
                        Task { await submit() }
                    } label: {
                        HStack {
                            if sending { ProgressView() }
                            Text(sending ? tr("reportSending") : tr("reportSend")).fontWeight(.semibold)
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .disabled(!canSend)
                }
            }
            if !past.isEmpty {
                Section {
                    ForEach(past, id: \.ref) { s in
                        HStack {
                            Text(s.ref).font(.callout.monospaced()).selectableText()
                            Spacer()
                            Text(s.at, style: .date).font(.caption).foregroundStyle(Theme.secondaryText)
                        }
                        #if !os(tvOS)
                        .contentShape(Rectangle())
                        .onTapGesture { copy(s.ref) }
                        #else
                        .focusable()
                        #endif
                    }
                } header: {
                    Text(tr("reportPast"))
                } footer: {
                    Text(tr("reportPastHint"))
                }
            }
        }
        .formStyle(.grouped)
        .listBackgroundHidden()
        .background(Theme.background)
        #if os(tvOS)
        // Apple TV: the page's name is on its left (TVPage), not over it.
        .navigationTitle("")
        #else
        .navigationTitle(tr("reportTitle"))
        #endif
    }

    private var platform: String {
        #if os(tvOS)
        return "tvos"
        #elseif os(macOS)
        return "mac-store"
        #else
        return UIDevice.current.userInterfaceIdiom == .pad ? "ipados" : "ios"
        #endif
    }

    /* After the log, what the screen shows now and the settings, so the
     * problem can be seen at once (as on the desktop and Android): no
     * server link or address, only whether one is set. */
    private func situation() async -> String {
        let s = SettingsStore().load()
        let set = Report.settings(s, adBlock: AdBlock.enabled(), countMeIn: OnlineCount.enabled(),
                                  helpOthers: UserDefaults.standard.bool(forKey: "snowflakeOn") && !HelpNudge.torBlockedHere())  // Snowflake.key; no Snowflake on tvOS
        var lines = [
            "== Situation now ==",
            "Protection: \(controller.phase)\(controller.notice.map { "; notice: \($0)" } ?? "")",
            "VPN allowed: \(!controller.vpnNotAllowed)",
            "Last way out: \(controller.lastResort.map { "\($0.state) \($0.progress)%" } ?? "off")\(controller.torAsk.map { "; asking for \($0)" } ?? "")",
            "Network: own server \(watch.ownServerDown.map { "down (\($0.why))" } ?? "fine or not set"), only the country's network \(watch.national ?? "no"), exit country \(watch.exit ?? "-"), DNS going around \(controller.dnsAround)",
            "Settings (as they act): \(set.line)",
            "Changed from the defaults: \(set.changed.isEmpty ? "none" : set.changed.joined(separator: ", "))",
            "Locale: \(Locale.current.identifier), languages \(Locale.preferredLanguages.prefix(3).joined(separator: ","))",
        ]
        lines.append("== Connections this session ==")
        lines.append(Report.connsText(await controller.conns()))
        if let st = await controller.stats() {
            lines.append("Stats: active \(st.active), total \(st.total), up \(st.up), down \(st.down), blocked \(st.blocked)")
        }
        return lines.joined(separator: "\n")
    }

    private func submit() async {
        guard canSend else { return }
        sending = true
        failure = nil
        let log = await Diagnostics.text(sites: controller.siteLog()) + "\n\n" + (await situation()) + "\n"
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
        let os = ProcessInfo.processInfo.operatingSystemVersionString
        guard let body = Report.body(fields, version: version, platform: platform, os: os, device: Diagnostics.model,
                                     lang: Bundle.main.preferredLocalizations.first ?? "en", log: log) else {
            failure = tr("reportFailed"); sending = false; return
        }
        var outcome = await Report.send(body, app: "\(platform)/\(version)")
        #if os(macOS)
        // Not through the usual way, with Tor ready: once more through Tor
        // (Russia's networks slow Cloudflare, where codeshare.me is, down
        // until nothing gets through, other VPNs there with it).
        if case .failed(let e, _) = outcome, e == "network", controller.lastResort?.state == "ready" {
            let kept = Conns.torSites().contains(Report.host)
            Conns.set(Report.host, tor: true)
            controller.blocksChanged()
            try? await Task.sleep(nanoseconds: 800_000_000)
            outcome = await Report.send(body, app: "\(platform)/\(version)", timeout: 90)
            if !kept {
                Conns.set(Report.host, tor: false)
                controller.blocksChanged()
            }
        }
        #endif
        sending = false
        switch outcome {
        case .sent(let ref):
            Report.record(ref)
            sentRef = ref
        case .failed(let e, let limit):
            switch e {
            case "rate": failure = rateText(limit)
            case "contact": failure = tr("reportBadContact")
            case "what": failure = tr("reportBadWhat")
            case "site": failure = tr("reportBadSite")
            default: failure = tr("reportFailed")
            }
        }
        past = Report.load()
    }

    private func copy(_ ref: String) {
        #if os(iOS)
        UIPasteboard.general.string = ref
        #elseif os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(ref, forType: .string)
        #endif
        copied = ref
    }
}

private extension View {
    /* Selectable where the system has selection (not on Apple TV). */
    @ViewBuilder func selectableText() -> some View {
        #if os(tvOS)
        self
        #else
        self.textSelection(.enabled)
        #endif
    }
}
