import XCTest

final class RatingScheduleTests: XCTestCase {
    private let day: TimeInterval = 86400
    private let t0 = Date(timeIntervalSince1970: 1_800_000_000)
    private var utc: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC")!
        return c
    }

    /* Installed long enough, protection good on three days: ready to ask. */
    private func ready() -> RatingState {
        var s = RatingState(installedAt: t0)
        for d in 0..<3 { RatingSchedule.recordGoodStart(&s, at: t0.addingTimeInterval(Double(d) * day), calendar: utc) }
        return s
    }

    private func ask(_ s: RatingState, at t: Date, working: Bool = true, live: Bool = true, asked: Bool = false) -> Bool {
        RatingSchedule.shouldAsk(s, now: t, protectionWorking: working, storeLive: live, askedThisSession: asked)
    }

    func testBackOffDoubles() {
        XCTAssertEqual(RatingSchedule.waitDays(afterRequests: 0), 0)
        XCTAssertEqual((1...6).map { RatingSchedule.waitDays(afterRequests: $0) }, [14, 28, 56, 112, 224, 448])
        // No overflow, however many.
        XCTAssertGreaterThan(RatingSchedule.waitDays(afterRequests: 1000), 0)
    }

    func testAsksOnlyWhenEverythingHolds() {
        let s = ready()
        let t = t0.addingTimeInterval(3 * day)
        XCTAssertTrue(ask(s, at: t))
        XCTAssertFalse(ask(s, at: t, working: false), "protection must be on and working")
        XCTAssertFalse(ask(s, at: t, live: false), "only once the store page is live")
        XCTAssertFalse(ask(s, at: t, asked: true), "once per run of the app")
    }

    func testInstalledAtLeastThreeDays() {
        let s = ready()
        XCTAssertFalse(ask(s, at: t0.addingTimeInterval(3 * day - 1)))
        XCTAssertTrue(ask(s, at: t0.addingTimeInterval(3 * day)))
        var never = s
        never.installedAt = nil
        XCTAssertFalse(ask(never, at: t0.addingTimeInterval(30 * day)))
    }

    func testThreeDifferentGoodDays() {
        var s = RatingState(installedAt: t0)
        let later = t0.addingTimeInterval(10 * day)
        // Many starts on one day count once.
        for h in 0..<10 { RatingSchedule.recordGoodStart(&s, at: t0.addingTimeInterval(Double(h) * 600), calendar: utc) }
        XCTAssertEqual(s.goodDays.count, 1)
        RatingSchedule.recordGoodStart(&s, at: t0.addingTimeInterval(day), calendar: utc)
        XCTAssertFalse(ask(s, at: later))
        RatingSchedule.recordGoodStart(&s, at: t0.addingTimeInterval(5 * day), calendar: utc)
        XCTAssertTrue(ask(s, at: later))
    }

    func testOnlyTheLastDaysAreKept() {
        var s = RatingState()
        for d in 0..<25 { RatingSchedule.recordGoodStart(&s, at: t0.addingTimeInterval(Double(d) * day), calendar: utc) }
        XCTAssertEqual(s.goodDays.count, RatingSchedule.keptDays)
        XCTAssertEqual(s.goodDays.last, RatingSchedule.day(t0.addingTimeInterval(24 * day), calendar: utc))
    }

    func testScheduleOfRequests() {
        var s = ready()
        var t = t0.addingTimeInterval(3 * day)
        var gaps: [Int] = []
        var last = t
        // Every hour for five years: each request is made as early as allowed.
        for _ in 0..<(5 * 365 * 24) {
            if ask(s, at: t) {
                if s.requests > 0 { gaps.append(Int((t.timeIntervalSince(last) / day).rounded())) }
                RatingSchedule.recordRequest(&s, at: t)
                last = t
            }
            t = t.addingTimeInterval(3600)
        }
        XCTAssertEqual(Array(gaps.prefix(5)), [14, 28, 56, 112, 224])
        XCTAssertEqual(RatingSchedule.nextAllowed(s), last.addingTimeInterval(Double(RatingSchedule.waitDays(afterRequests: s.requests)) * day))
    }

    func testStoreKeepsStateAndTheFirstLaunch() {
        let suite = "me.codeshare.shroudly.tests.rating"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = RatingStore(defaults: defaults)
        XCTAssertEqual(store.load(), RatingState())
        store.noteLaunch(now: t0)
        store.noteLaunch(now: t0.addingTimeInterval(5 * day))
        XCTAssertEqual(store.load().installedAt, t0)
        store.update { RatingSchedule.recordRequest(&$0, at: self.t0) }
        XCTAssertEqual(store.load().requests, 1)
        XCTAssertEqual(store.load().lastRequestAt, t0)
    }
}
