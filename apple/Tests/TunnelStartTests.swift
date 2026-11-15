import XCTest

/* The tunnel tells a start the app asked for from one of the system's own. */
final class TunnelStartTests: XCTestCase {
    func testByAppOrBySystem() {
        XCTAssertTrue(TunnelStart.isByApp(TunnelStart.byApp))
        XCTAssertFalse(TunnelStart.isByApp(nil), "the system starts it with no options")
        XCTAssertFalse(TunnelStart.isByApp([:]))
        XCTAssertFalse(TunnelStart.isByApp(["by": "other" as NSString]))
    }
}

/* "Something not working?" only after Shroudly itself went wrong, for a day. */
final class ReportOfferTests: XCTestCase {
    func testOnlyAfterOwnFaultForADay() {
        let day = Report.faultShows
        XCTAssertFalse(Report.offered(faultAt: 0, lastSentAt: 0, now: 1_000_000))
        XCTAssertTrue(Report.offered(faultAt: 1_000_000, lastSentAt: 0, now: 1_003_600))
        XCTAssertFalse(Report.offered(faultAt: 1_000_000, lastSentAt: 0, now: 1_000_000 + day))
        XCTAssertFalse(Report.offered(faultAt: 1_000_000, lastSentAt: 1_500_000, now: 2_000_000))
        XCTAssertTrue(Report.offered(faultAt: 3_000_000, lastSentAt: 1_500_000, now: 3_010_000))
    }
}
