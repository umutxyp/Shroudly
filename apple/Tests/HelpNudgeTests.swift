import XCTest

/* 2.6.48: the card asking for help and its waits, what changed after an
 * update, the address sites see through your own server (issue #66), and a
 * copy signed without the VPN permission told as such (issue #65). */
final class HelpNudgeTests: XCTestCase {
    private let day = HelpNudge.day

    func testFirstAfterAFewDaysThenEachNoDoublesTheWait() {
        let s = HelpNudge.begin(nil, now: 1000)
        XCTAssertEqual(s.next, 1000 + 3 * day)
        XCTAssertFalse(HelpNudge.isDue(s, now: 1000 + 3 * day - 1, country: nil))
        XCTAssertTrue(HelpNudge.isDue(s, now: 1000 + 3 * day, country: nil))
        XCTAssertEqual(HelpNudge.begin(s, now: 9999), s, "a state kept is kept")
        var t = HelpNudge.refuse(s, now: 0)
        XCTAssertEqual(t.next, 7 * day)
        t = HelpNudge.refuse(t, now: 0)
        XCTAssertEqual(t.next, 14 * day)
        t = HelpNudge.refuse(t, now: 0)
        XCTAssertEqual(t.next, 28 * day)
        XCTAssertEqual(t.refusals, 3)
        let yes = HelpNudge.accept(t, now: 5)
        XCTAssertEqual(yes.next, 5 + 56 * day, "after a yes, the next wait in the row")
        XCTAssertEqual(yes.accepted, 5)
        var long = s
        for _ in 0..<40 { long = HelpNudge.refuse(long, now: 0) }
        XCTAssertEqual(long.next, 7 * day * 1024, "the wait stops growing")
    }

    func testNotAskedWhereTorIsBlocked() {
        let s = HelpNudge.State(first: 0, next: 0, refusals: 0)
        for c in ["IR", "ru", "CN", "TM", "BY", "MM"] { XCTAssertFalse(HelpNudge.isDue(s, now: 1, country: c), c) }
        for c in ["TR", "DE", "AZ"] { XCTAssertTrue(HelpNudge.isDue(s, now: 1, country: c), c) }
        XCTAssertEqual(HelpNudge.country(remembered: nil, zone: "Asia/Tehran"), "IR")
        XCTAssertEqual(HelpNudge.country(remembered: nil, zone: "Asia/Vladivostok"), "RU")
        XCTAssertNil(HelpNudge.country(remembered: nil, zone: "Europe/Istanbul"))
        XCTAssertEqual(HelpNudge.country(remembered: "IR", zone: "Europe/Berlin"), "IR", "a shutdown seen there wins")
    }

    func testTheDesktopsNumbers() throws {
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../components/helpNudge.js").standardized
        let js = try String(contentsOf: file, encoding: .utf8)
        XCTAssertTrue(js.contains("export const FIRST_DAYS = 3;") && js.contains("export const WAIT_DAYS = 7;") && js.contains("export const MAX_DOUBLINGS = 10;"))
        XCTAssertTrue(js.contains("export const NOT_FROM = ['BY', 'CN', 'IR', 'MM', 'RU', 'TM'];"))
        XCTAssertEqual(HelpNudge.notFrom, ["BY", "CN", "IR", "MM", "RU", "TM"])
        let zones = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../electron/national-net.js").standardized
        let nn = try String(contentsOf: zones, encoding: .utf8)
        for (zone, country) in HelpNudge.zones {
            XCTAssertTrue(nn.contains("'\(zone)'"), "\(zone) (\(country)) as the desktop lists it")
        }
    }

    func testKeptAcrossLaunches() throws {
        let d = try XCTUnwrap(UserDefaults(suiteName: "help-nudge-test-\(UUID().uuidString)"))
        XCTAssertNil(HelpNudge.load(d))
        XCTAssertFalse(HelpNudge.due(d, now: 100), "not on the first day")
        XCTAssertEqual(HelpNudge.load(d)?.next, 100 + 3 * day)
        XCTAssertTrue(HelpNudge.due(d, now: 100 + 3 * day))
        HelpNudge.refused(d, now: 100 + 3 * day)
        XCTAssertEqual(HelpNudge.load(d)?.refusals, 1)
        XCTAssertFalse(HelpNudge.due(d, now: 100 + 3 * day + 6 * day))
        XCTAssertTrue(HelpNudge.due(d, now: 100 + 10 * day))
        d.set("IR", forKey: HelpNudge.homeCountryKey)
        XCTAssertFalse(HelpNudge.due(d, now: 100 + 10 * day))
    }

    func testWhatChangedOnceAfterAnUpdate() throws {
        XCTAssertNil(WhatsNew.decide(lastSeen: nil, current: "2.6.48", usedBefore: false), "a new install: nothing")
        XCTAssertEqual(WhatsNew.decide(lastSeen: nil, current: "2.6.48", usedBefore: true), "2.6.48", "from before 2.6.48")
        XCTAssertEqual(WhatsNew.decide(lastSeen: "2.6.47", current: "2.6.48", usedBefore: true), "2.6.48")
        XCTAssertNil(WhatsNew.decide(lastSeen: "2.6.48", current: "2.6.48", usedBefore: true))
        let d = try XCTUnwrap(UserDefaults(suiteName: "whats-new-test-\(UUID().uuidString)"))
        XCTAssertEqual(WhatsNew.pending(d, current: "2.6.48", usedBefore: true, notes: "a"), "2.6.48")
        XCTAssertEqual(WhatsNew.pending(d, current: "2.6.48", usedBefore: true, notes: "a"), "2.6.48", "until it is closed")
        WhatsNew.seen(d)
        XCTAssertNil(WhatsNew.pending(d, current: "2.6.48", usedBefore: true, notes: "a"))
        XCTAssertEqual(WhatsNew.pending(d, current: "2.6.49", usedBefore: true, notes: "b"), "2.6.49")
        WhatsNew.seen(d)
        // A version whose notes were not rewritten: the old ones are not shown
        // again under its number (2.6.65 to 2.6.70 said 2.6.64's); none, nothing.
        XCTAssertNil(WhatsNew.pending(d, current: "2.6.50", usedBefore: true, notes: "b"), "the same notes: not again")
        XCTAssertNil(WhatsNew.pending(d, current: "2.6.51", usedBefore: true, notes: "  "), "no notes: nothing")
        XCTAssertEqual(WhatsNew.pending(d, current: "2.6.52", usedBefore: true, notes: "c"), "2.6.52", "new notes: shown")
        XCTAssertEqual(WhatsNew.lines(" one \n\ntwo\n"), "• one\n• two")
        XCTAssertEqual(WhatsNew.notes("whatsNewApple", key: "whatsNewApple"), "", "the key itself: no notes")
        XCTAssertEqual(WhatsNew.notes("", key: "whatsNewApple"), "")
        WhatsNew.seen(d)
        XCTAssertNil(WhatsNew.pending(d, current: "2.6.72", usedBefore: true, notes: ""), "a version with nothing new here: no window")
    }

    func testTheAddressSitesSee() {
        XCTAssertEqual(OwnServer.traceIp("fl=1\nh=cloudflare.com\nip=203.0.113.7\nts=1\n"), "203.0.113.7")
        XCTAssertEqual(OwnServer.traceIp("ip=2001:db8::1\r\nts=1"), "2001:db8::1")
        XCTAssertNil(OwnServer.traceIp("h=x\nvisit_scheme=https\n"))
        // Its country (issue #60): the flag and the name in the app's language.
        XCTAssertEqual(OwnServer.traceLoc("ip=1.2.3.4\nloc=IT\ntls=TLSv1.3\n"), "IT")
        XCTAssertNil(OwnServer.traceLoc("loc=XX\n"))
        XCTAssertEqual(OwnServer.withPlace("80.174.118.60", "IT", language: "en"), "80.174.118.60 · \u{1F1EE}\u{1F1F9} Italy")
        XCTAssertEqual(OwnServer.withPlace("1.2.3.4", nil, language: "en"), "1.2.3.4")
        XCTAssertNil(OwnServer.traceIp("ip=999.1.1.1\n"))
        XCTAssertNil(OwnServer.traceIp("ip=<script>\n"))
        XCTAssertNil(OwnServer.traceIp("xip=1.2.3.4\n"))
    }

    func testACopyWithoutTheVpnPermission() {
        // #65: reading fails with Network Extension's own "permission denied".
        XCTAssertTrue(VpnErrors.missingPermission(domain: "NEConfigurationErrorDomain", code: 10, text: "permission denied", reading: true))
        XCTAssertTrue(VpnErrors.missingPermission(domain: "NEVPNErrorDomain", code: 5, text: "permission denied", reading: true))
        XCTAssertTrue(VpnErrors.missingPermission(domain: "NEConfigurationErrorDomain", code: 10, text: "", reading: false))
        // The user saying no to iOS's question: not a copy that cannot.
        XCTAssertFalse(VpnErrors.missingPermission(domain: "NEVPNErrorDomain", code: 5, text: "permission denied", reading: false))
        XCTAssertFalse(VpnErrors.missingPermission(domain: "NSURLErrorDomain", code: -1001, text: "timed out", reading: true))
        XCTAssertEqual(VpnErrors.installHelp.absoluteString, "https://github.com/umutxyp/Shroudly#iphone-and-ipad")
    }

    func testNotOfferedWhereTorItselfIsBlocked() {
        for c in ["IR", "ir", "RU", "CN", "BY", "TM", "MM"] { XCTAssertTrue(HelpNudge.torBlocked(c), c) }
        for c in ["TR", "DE", "PK"] { XCTAssertFalse(HelpNudge.torBlocked(c), c) }
        XCTAssertFalse(HelpNudge.torBlocked(nil))
    }
}
