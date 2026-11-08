import XCTest

/* The forwarder's choices; the lookups themselves go to the internet and
 * are not made here. */
final class DohForwarderTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    func testRoutesAreByAddressOnly() {
        let all = DohForwarder.routes()
        XCTAssertEqual(Set(all.map(\.id)).count, all.count)
        XCTAssertEqual(Set(all.map(\.op)), ["cloudflare", "google", "adguard", "opendns", "dnssb"])
        for r in all {
            XCTAssertEqual(r.url.path, "/dns-query")
            XCTAssertFalse(r.names.isEmpty)
            XCTAssertNotNil(r.url.host)
        }
        XCTAssertEqual(all.first { $0.ip.contains(":") }?.url.absoluteString, "https://[2606:4700:4700::1111]/dns-query")
    }

    func testWaves() {
        XCTAssertEqual((0..<9).map { Int((DohForwarder.startDelay($0) * 100).rounded()) }, [0, 25, 25, 90, 90, 90, 155, 155, 155])
        XCTAssertLessThan(DohForwarder.answerBy, DohForwarder.engineWait)
    }

    func testPlanPrefersTheRememberedThenAnotherOperator() {
        let all = DohForwarder.routes()
        let plan = DohForwarder.plan(all, preferred: "google-2", now: now)
        XCTAssertEqual(plan.first?.id, "google-2")
        XCTAssertNotEqual(plan[1].op, "google")
        XCTAssertEqual(plan.count, all.count)
    }

    func testGoogleNamesAskGoogleFirst() {
        for n in ["docs.google.com", "lh7-rt.googleusercontent.com", "i.ytimg.com", "www.gstatic.com."] { XCTAssertTrue(DohForwarder.googleName(n), n) }
        for n in ["notgoogle.com", "google.com.evil.example", "roblox.com"] { XCTAssertFalse(DohForwarder.googleName(n), n) }
        let q = Dns.query("docs.google.com", type: 1, id: 7)
        XCTAssertEqual(DohForwarder.questionName(q), "docs.google.com")
        var all = DohForwarder.routes()
        let first = DohForwarder.googleFirst(all, now: now)
        XCTAssertEqual(DohForwarder.plan(all, preferred: first, now: now).first?.op, "google")
        for i in all.indices where all[i].op == "google" { all[i].restUntil = now.addingTimeInterval(60) }
        XCTAssertNil(DohForwarder.googleFirst(all, now: now))
    }

    func testRestingRoutesAreLeftOut() {
        var all = DohForwarder.routes()
        all[0].restUntil = now.addingTimeInterval(60)
        let plan = DohForwarder.plan(all, preferred: all[0].id, now: now)
        XCTAssertFalse(plan.contains { $0.id == all[0].id })
        XCTAssertEqual(plan.count, all.count - 1)
    }

    func testEverythingRestingStillTriesTheThreeThatWakeSoonest() {
        var all = DohForwarder.routes()
        for i in all.indices { all[i].restUntil = now.addingTimeInterval(Double(100 + i)) }
        all[5].restUntil = now.addingTimeInterval(1)
        let plan = DohForwarder.plan(all, preferred: nil, now: now)
        XCTAssertEqual(plan.count, 3)
        XCTAssertEqual(plan.first?.id, all[5].id)
    }

    func testFasterRoutesFirst() {
        var all = DohForwarder.routes()
        let slow = all.firstIndex { $0.id == "cloudflare-1" }!
        let fast = all.firstIndex { $0.id == "dnssb-2" }!
        all[slow].ewma = 1.5
        all[fast].ewma = 0.05
        let plan = DohForwarder.plan(all, preferred: nil, now: now)
        XCTAssertEqual(plan.first?.id, "dnssb-2")
        XCTAssertEqual(plan.last?.id, "cloudflare-1")
    }
}
