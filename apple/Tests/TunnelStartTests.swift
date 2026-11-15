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
