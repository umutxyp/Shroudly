import XCTest

/* The Snowflake page the Apple app runs (App/Snowflake/) is the desktop's
 * (electron/snowflake/), byte for byte: one proxy, tested once. */
final class SnowflakeFilesTests: XCTestCase {
    func testSameAsTheDesktops() throws {
        let apple = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let repo = apple.deletingLastPathComponent()
        for f in ["proxy.html", "proxy.js"] {
            let a = try Data(contentsOf: apple.appendingPathComponent("App/Snowflake/\(f)"))
            let d = try Data(contentsOf: repo.appendingPathComponent("electron/snowflake/\(f)"))
            XCTAssertEqual(a, d, "\(f): copy electron/snowflake/\(f) to apple/App/Snowflake/")
        }
    }
}
