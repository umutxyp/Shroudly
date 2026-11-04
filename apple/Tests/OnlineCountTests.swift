import XCTest

/* The live count (Shared/OnlineCount.swift, Tunnel/Pinger.swift): the
 * desktop's request to the byte, its pace, and the server's answer read. */
final class OnlineCountTests: XCTestCase {
    func testRequestIsTheDesktops() {
        let r = String(decoding: OnlineCount.request("/v1/ping", body: OnlineCount.body("abc"), version: "2.6.52", acceptLanguage: "tr"), as: UTF8.self)
        XCTAssertEqual(r, "POST /v1/ping HTTP/1.1\r\nHost: shroudly.codeshare.me\r\nConnection: keep-alive\r\nContent-Length: 12\r\n" +
            "content-type: application/json\r\nSec-Fetch-Site: none\r\nSec-Fetch-Mode: no-cors\r\nSec-Fetch-Dest: empty\r\n" +
            "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Shroudly/2.6.52 " +
            "Chrome/150.0.7871.250 Electron/43.8.1 Safari/537.36\r\nAccept-Encoding: gzip, deflate, br, zstd\r\nAccept-Language: tr\r\n\r\n" +
            "{\"id\":\"abc\"}")
    }

    func testElectronIsTheDesktops() throws {
        // apple/Tests → the repository's package.json
        let pkg = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("package.json")
        let text = try String(contentsOf: pkg, encoding: .utf8)
        XCTAssertTrue(text.contains("\"electron\": \"\(OnlineCount.electron)\""), "package.json moved to another Electron: update OnlineCount.electron and .chrome")
    }

    func testPace() {
        XCTAssertEqual(OnlineCount.nextDelay("{\"ok\":true,\"interval\":120}"), 120)
        XCTAssertEqual(OnlineCount.nextDelay("{\"ok\":true}"), 60)
        XCTAssertEqual(OnlineCount.nextDelay("{\"interval\":5}"), 30)
        XCTAssertEqual(OnlineCount.nextDelay("{\"interval\":99999}"), 900)
        XCTAssertNil(OnlineCount.nextDelay("<html>"))
        XCTAssertEqual(OnlineCount.online(in: "{\"online\": 1204,\"interval\":60}"), 1204)
        XCTAssertNil(OnlineCount.online(in: "{}"))
    }

    func testChromiumLocale() {
        XCTAssertEqual(OnlineCount.chromiumLocale(["tr-TR"]), "tr")
        XCTAssertEqual(OnlineCount.chromiumLocale(["en-AU"]), "en-GB")
        XCTAssertEqual(OnlineCount.chromiumLocale(["en"]), "en-US")
        XCTAssertEqual(OnlineCount.chromiumLocale(["zh-Hant-HK"]), "zh-TW")
        XCTAssertEqual(OnlineCount.chromiumLocale(["es-MX"]), "es-419")
        XCTAssertEqual(OnlineCount.chromiumLocale(["pt-PT"]), "pt-PT")
        XCTAssertEqual(OnlineCount.chromiumLocale(["ky-KG", "ru-RU"]), "ru", "a language Chromium lacks: the next one")
        XCTAssertEqual(OnlineCount.chromiumLocale(["xx"]), "en-US")
    }

    func testAnswerReadKeepAliveAndGzip() throws {
        let plain = Array("HTTP/1.1 200 OK\r\nContent-Length: 13\r\n\r\n{\"online\":42}".utf8)
        XCTAssertEqual(Pinger.response(plain, ended: false)?.text, "{\"online\":42}", "ends by its length, the stream stays open")
        XCTAssertNil(Pinger.response(Array(plain.dropLast(3)), ended: false), "not all there yet")

        let json = Data("{\"online\":7}".utf8)
        let raw = try (json as NSData).compressed(using: .zlib) as Data
        var gz = Data([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3]) + raw
        gz += Data(repeating: 0, count: 8)   // CRC and size: not checked here
        let head = "HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: \(gz.count)\r\n\r\n"
        XCTAssertEqual(Pinger.response(Array(head.utf8) + [UInt8](gz), ended: false)?.text, "{\"online\":7}")
        let br = Array("HTTP/1.1 200 OK\r\nContent-Encoding: br\r\nContent-Length: 2\r\n\r\nxx".utf8)
        XCTAssertNotNil(Pinger.response(br, ended: false))
        XCTAssertNil(Pinger.response(br, ended: false)?.text, "Brotli cannot be read here")
    }
}
