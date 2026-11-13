import XCTest

/* The engine (core/), built for this platform, inside this process as the
 * packet tunnel runs it (Tunnel/Engine.swift, Native/engine_glue.c): it
 * starts, answers as a SOCKS5 proxy with the session's password, refuses a
 * stand-in address at once, stops, and starts again in the same process. */
final class EngineTests: XCTestCase {
    func testRelaysThroughSocks5AndStops() throws {
        let echo = try EchoServer()
        defer { echo.stop() }
        let e = try TestEngine()
        XCTAssertTrue(e.engine.running)

        let (fd, code) = TestNet.socks(e.port, user: e.auth.user, pass: e.auth.pass, to: .ipv4("127.0.0.1"), echo.port)
        defer { close(fd) }
        XCTAssertEqual(code, 0, "CONNECT through the engine")
        TestNet.send(fd, Array("ping through Shroudly".utf8))
        XCTAssertEqual(String(decoding: TestNet.recv(fd, 21), as: UTF8.self), "ping through Shroudly")

        XCTAssertTrue(e.engine.stop())
        XCTAssertFalse(e.engine.running)
        XCTAssertEqual(TestNet.connect(e.port, timeout: 1), -1, "its port is closed")
    }

    func testRefusesAnotherPassword() throws {
        let e = try TestEngine()
        defer { e.engine.stop() }
        let (fd, code) = TestNet.socks(e.port, user: e.auth.user, pass: "0000000000000000", to: .ipv4("127.0.0.1"), 9)
        defer { close(fd) }
        XCTAssertLessThan(code, 0, "the login is refused")
    }

    /* A stand-in address that outlived its mapping (core/src/engine.c,
     * standin_name): taken at once, so that the name in the app's first
     * bytes can be read; an app that sends nothing is let go, and the
     * address itself is never dialled. */
    func testStandInAddressesAreNeverDialled() throws {
        let e = try TestEngine()
        defer { e.engine.stop() }
        let began = Date()
        let (fd, code) = TestNet.socks(e.port, user: e.auth.user, pass: e.auth.pass, to: .ipv4("198.19.1.2"), 443)
        defer { close(fd) }
        XCTAssertEqual(code, 0, "--fake-net takes it without trying the address")
        var tv = timeval(tv_sec: 3, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        var byte: UInt8 = 0
        let n = recv(fd, &byte, 1, 0)
        XCTAssertEqual(n, 0, "nothing sent, no name: the connection is closed")
        XCTAssertLessThan(Date().timeIntervalSince(began), 2, "and soon")
    }

    func testRunsAgainInTheSameProcess() throws {
        for _ in 0..<3 {
            let e = try TestEngine()
            XCTAssertTrue(e.engine.stop())
        }
    }

    func testStatsAnswer() throws {
        let e = try TestEngine()
        defer { e.engine.stop() }
        e.engine.send("STATS")
        let deadline = Date().addingTimeInterval(5)
        while e.engine.lastStats == nil && Date() < deadline { usleep(50_000) }
        XCTAssertNotNil(e.engine.lastStats)
    }
}
