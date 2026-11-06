import XCTest
import CryptoKit

/* 2.6.60, "Something not working?" (Report): the same limits, references,
 * gzip and proof of work as the desktop (tests/net/report.test.js), Android
 * (ReportTest.kt) and the server (codeshare.me, server/shroudly/report.ts). */
final class ReportTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_794_000_000)
    private func ref(_ n: Int) -> String { String(format: "SR-AAAA-BBBB-%04d", n) }

    func testHistoryKeepsSixtyDaysNewestFirst() {
        let l = Report.history([
            .init(ref: ref(1), at: now.addingTimeInterval(-61 * Report.day)),
            .init(ref: ref(2), at: now.addingTimeInterval(-2 * Report.day)),
            .init(ref: ref(3), at: now.addingTimeInterval(-Report.hour / 2)),
            .init(ref: "nonsense", at: now),
        ], now: now)
        XCTAssertEqual(l.map(\.ref), [ref(3), ref(2)])
    }

    func testOneAnHourThreeADay() {
        XCTAssertEqual(Report.wait([], now: now).seconds, 0)
        let w = Report.wait([.init(ref: ref(1), at: now.addingTimeInterval(-20 * 60))], now: now)
        XCTAssertEqual(w.seconds, 40 * 60, accuracy: 0.5)
        XCTAssertEqual(w.limit, "hour")
        let d = Report.wait([.init(ref: ref(1), at: now.addingTimeInterval(-2 * Report.hour)),
                             .init(ref: ref(2), at: now.addingTimeInterval(-5 * Report.hour)),
                             .init(ref: ref(3), at: now.addingTimeInterval(-9 * Report.hour))], now: now)
        XCTAssertEqual(d.limit, "day")
        XCTAssertEqual(d.seconds, 15 * Report.hour, accuracy: 0.5)
    }

    func testCharactersAsTheServerCounts() {
        XCTAssertEqual(Report.chars("  ab😀 "), 3)
        XCTAssertEqual(Report.whatMin, 50)
        XCTAssertEqual(Report.whatMax, 1000)
    }

    func testGzipHasTheRightTrailer() {
        let data = Data("line 1\nçğü line 2\n".utf8)
        let gz = Report.gzip(data)!
        XCTAssertEqual(Array(gz.prefix(3)), [0x1F, 0x8B, 0x08])
        let crc = gz.subdata(in: gz.count - 8 ..< gz.count - 4).withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }
        XCTAssertEqual(UInt32(littleEndian: crc), Report.crc32(data))
        XCTAssertEqual(Report.crc32(Data("123456789".utf8)), 0xCBF4_3926)
    }

    func testProofOfWorkTheServerTakes() {
        let body = "{\"v\":1}"
        let p = Report.proofOfWork(body, now: now)
        let parts = p.split(separator: ".").map(String.init)
        XCTAssertEqual(parts[0], "1794000000")
        let bh = SHA256.hash(data: Data(body.utf8)).map { String(format: "%02x", $0) }.joined()
        let h = Array(SHA256.hash(data: Data("shroudly-report-v1\n\(parts[0])\n\(bh)\n\(parts[1])".utf8)))
        XCTAssertTrue(h[0] == 0 && h[1] == 0 && (h[2] & 0xC0) == 0)
    }
}
