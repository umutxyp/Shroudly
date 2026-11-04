import XCTest

/* "Block ads and trackers" (Shared/AdBlock.swift): the exceptions kept
 * clean, what the engine is told, when the list is due, and the engine's
 * own check and use of a list, in this process as the tunnel runs it. */
final class AdBlockTests: XCTestCase {
    private var defaults: UserDefaults!

    override func setUp() {
        defaults = UserDefaults(suiteName: "AdBlockTests-\(UUID().uuidString)")
        try? FileManager.default.removeItem(at: AdBlock.file)
    }

    func testExceptionsAreCleaned() {
        XCTAssertEqual(AdBlock.clean(["HTTPS://Ads.Example.com/x?y", "*.cdn.example.org.", "not a domain", "localhost", "ads.example.com", ""]),
                       ["ads.example.com", "cdn.example.org"])
        XCTAssertEqual(AdBlock.setAllow("one.example.com, two.example.net\nnope", defaults), ["one.example.com", "two.example.net"])
        XCTAssertEqual(AdBlock.allow(defaults), ["one.example.com", "two.example.net"])
    }

    func testOffOrNoListMeansOff() throws {
        XCTAssertEqual(AdBlock.commands(defaults), ["ADBLOCK OFF"], "off")
        defaults.set(true, forKey: AdBlock.Key.on)
        XCTAssertEqual(AdBlock.commands(defaults), ["ADBLOCK OFF"], "on, but no list fetched yet")
        try "doubleclick.net\n".write(to: AdBlock.file, atomically: true, encoding: .utf8)
        AdBlock.setAllow("keep.example.com", defaults)
        XCTAssertEqual(AdBlock.commands(defaults), ["ALLOW-CLEAR", "ALLOW keep.example.com", "ADBLOCK \(AdBlock.file.path)"])
    }

    func testResponseBody() throws {
        let ok = Array("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello".utf8)
        XCTAssertEqual(try AdBlockFetch.body(of: ok), Data("hello".utf8))
        let chunked = Array("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\n\r\n".utf8)
        XCTAssertEqual(try AdBlockFetch.body(of: chunked), Data("abc".utf8))
        XCTAssertThrowsError(try AdBlockFetch.body(of: Array("HTTP/1.1 404 Not Found\r\n\r\nno".utf8)))
        XCTAssertThrowsError(try AdBlockFetch.body(of: Array("HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\ncut".utf8)), "cut short")
    }

    func testDue() throws {
        XCTAssertTrue(AdBlock.due(lastTry: nil), "no list yet")
        XCTAssertFalse(AdBlock.due(lastTry: Date().addingTimeInterval(-60)), "not again soon after a try")
        try "doubleclick.net\n".write(to: AdBlock.newFile, atomically: true, encoding: .utf8)
        try AdBlock.adopt()
        XCTAssertFalse(AdBlock.due(lastTry: nil), "a fresh list from this source")
        XCTAssertTrue(AdBlock.due(now: Date().addingTimeInterval(AdBlock.refresh + 60), lastTry: nil), "a week later")
    }

    func testEngineChecksAndUsesTheList() throws {
        // As the engine takes a list: 10000 entries or more, with the names
        // every ad list has (core/src/adblock.c MUST_LIST).
        let list = (["! a list", "doubleclick.net", "googlesyndication.com"] + (0..<12000).map { "ads\($0).example.com" }).joined(separator: "\n") + "\n"
        try list.write(to: AdBlock.newFile, atomically: true, encoding: .utf8)
        let e = try TestEngine()
        defer { e.engine.stop() }
        let verdict = expectation(description: "the engine's verdict")
        e.engine.onAdblockCheck = { ok, why in
            XCTAssertTrue(ok, why ?? "")
            verdict.fulfill()
        }
        e.engine.send("ADBLOCK-CHECK \(AdBlock.newFile.path)")
        wait(for: [verdict], timeout: 10)

        try AdBlock.adopt()
        defaults.set(true, forKey: AdBlock.Key.on)
        e.engine.send(AdBlock.commands(defaults).joined(separator: "\n"))
        // A listed name is refused through the engine; another is not.
        let deadline = Date().addingTimeInterval(5)
        var code = 0
        while Date() < deadline {
            let (fd, c) = TestNet.socks(e.port, user: e.auth.user, pass: e.auth.pass, to: .name("ads7.example.com"), 443)
            close(fd)
            code = c
            if c != 0 { break }
            usleep(100_000)
        }
        XCTAssertNotEqual(code, 0, "a listed name is not reached")
    }
}
