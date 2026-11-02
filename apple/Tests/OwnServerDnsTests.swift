import XCTest

/* Issue #67: with "Your own server", the tunnel's encrypted DNS went straight
 * out to the resolvers from the device's own connection. Now, with a server
 * set, every question goes through the engine's SOCKS5 port (this session's
 * user and password) and on through that server, with TLS on that stream,
 * and nothing goes straight out before the engine is up. */
final class OwnServerDnsTests: XCTestCase {
    private func defaults() -> UserDefaults { UserDefaults(suiteName: "own-server-dns-\(UUID().uuidString)")! }

    func testNothingStraightOutBeforeTheEngineIsUp() async {
        let d = DohForwarder(log: { _ in }, defaults: defaults())
        d.throughEngine(true, nil)
        let q = Dns.query("example.com", type: 1, id: 7)
        let began = Date()
        let a = await d.resolve(q)
        XCTAssertEqual(a, Dns.noRouteReply(q), "no answer rather than a resolver straight out")
        XCTAssertLessThan(Date().timeIntervalSince(began), 1, "and at once: nothing was tried")
    }

    func testAResponsesBody() {
        let ok = Array("HTTP/1.1 200 OK\r\nContent-Type: application/dns-message\r\nContent-Length: 3\r\n\r\nabcde".utf8)
        XCTAssertEqual(DohForwarder.http1Body(ok, ended: false), Array("abc".utf8))
        let short = Array("HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\nabc".utf8)
        XCTAssertNil(DohForwarder.http1Body(short, ended: false))
        let chunked = Array("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n".utf8)
        XCTAssertEqual(DohForwarder.http1Body(chunked, ended: false), Array("abcde".utf8))
        let untilEnd = Array("HTTP/1.1 200 OK\r\n\r\nxyz".utf8)
        XCTAssertNil(DohForwarder.http1Body(untilEnd, ended: false))
        XCTAssertEqual(DohForwarder.http1Body(untilEnd, ended: true), Array("xyz".utf8))
        XCTAssertNil(DohForwarder.http1Body(Array("HTTP/1.1 400 Bad\r\nContent-Length: 0\r\n\r\n".utf8), ended: true))
    }

    /* The engine's SOCKS5 port, standing in: a user name and password asked
     * for, each target recorded, and connected on to it for real. */
    final class SocksStandIn: @unchecked Sendable {
        let fd: Int32
        let port: Int
        private let lock = NSLock()
        private var seen: [String] = []
        var targets: [String] { lock.lock(); defer { lock.unlock() }; return seen }

        init(user: String, pass: String) {
            let listener = socket(AF_INET, SOCK_STREAM, 0)
            var a = TestNet.sockaddrV4("127.0.0.1", 0)
            _ = withUnsafePointer(to: &a) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(listener, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
            listen(listener, 16)
            var len = socklen_t(MemoryLayout<sockaddr_in>.size)
            _ = withUnsafeMutablePointer(to: &a) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(listener, $0, &len) } }
            fd = listener
            port = Int(UInt16(bigEndian: a.sin_port))
            Thread.detachNewThread { [self] in
                while true {
                    let c = accept(listener, nil, nil)
                    if c < 0 { return }
                    Thread.detachNewThread { [self] in self.serve(c, user: user, pass: pass) }
                }
            }
        }

        private func serve(_ c: Int32, user: String, pass: String) {
            var one: Int32 = 1
            setsockopt(c, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
            let hello = TestNet.recv(c, 2)
            guard hello.count == 2 else { close(c); return }
            _ = TestNet.recv(c, Int(hello[1]))
            TestNet.send(c, [5, 2])
            let v = TestNet.recv(c, 2)
            guard v.count == 2 else { close(c); return }
            let u = TestNet.recv(c, Int(v[1]))
            let pl = TestNet.recv(c, 1)
            let p = TestNet.recv(c, Int(pl.first ?? 0))
            guard String(decoding: u, as: UTF8.self) == user, String(decoding: p, as: UTF8.self) == pass else {
                TestNet.send(c, [1, 1]); close(c); return
            }
            TestNet.send(c, [1, 0])
            let req = TestNet.recv(c, 10)
            guard req.count == 10, req[3] == 1 else { close(c); return }
            let ip = req[4..<8].map(String.init).joined(separator: ".")
            let port = Int(req[8]) << 8 | Int(req[9])
            lock.lock(); seen.append("\(ip):\(port)"); lock.unlock()
            let up = socket(AF_INET, SOCK_STREAM, 0)
            setsockopt(up, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
            var to = TestNet.sockaddrV4(ip, port)
            let r = withUnsafePointer(to: &to) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(up, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
            guard r == 0 else { TestNet.send(c, [5, 5, 0, 1, 0, 0, 0, 0, 0, 0]); close(c); close(up); return }
            TestNet.send(c, [5, 0, 0, 1, 0, 0, 0, 0, 0, 0])
            let pump = { (from: Int32, to: Int32) in
                var buf = [UInt8](repeating: 0, count: 16_384)
                while true {
                    let n = buf.withUnsafeMutableBytes { Darwin.recv(from, $0.baseAddress, $0.count, 0) }
                    if n <= 0 { break }
                    TestNet.send(to, Array(buf[0..<n]))
                }
                shutdown(to, SHUT_WR)
            }
            Thread.detachNewThread { pump(up, c) }
            pump(c, up)
        }

        func stop() { close(fd) }
    }

    func testEveryQuestionThroughTheEngine() async throws {
        let standIn = SocksStandIn(user: "0123456789abcdef", pass: "fedcba98765432100123456789abcdef")
        defer { standIn.stop() }
        let d = DohForwarder(log: { _ in }, defaults: defaults())
        d.throughEngine(true, DohForwarder.EnginePath(port: standIn.port, user: "0123456789abcdef", pass: "fedcba98765432100123456789abcdef"))
        let q = Dns.query("example.com", type: 1, id: 9)
        let a = await d.resolve(q)
        XCTAssertNotEqual(a, Dns.noRouteReply(q), "answered through the engine (\(standIn.targets))")
        XCTAssertEqual(Array(a.prefix(2)), Array(q.prefix(2)), "the answer to this question")
        let ips = Set(DohForwarder.routes().map { "\($0.ip):443" })
        XCTAssertFalse(standIn.targets.isEmpty)
        XCTAssertTrue(standIn.targets.allSatisfy { ips.contains($0) }, "every connection a resolver's, through the engine: \(standIn.targets)")

        // A wrong password: no answer, and nothing straight out instead.
        let wrong = DohForwarder(log: { _ in }, defaults: defaults())
        wrong.throughEngine(true, DohForwarder.EnginePath(port: standIn.port, user: "0123456789abcdef", pass: "00000000000000000000000000000000"))
        let b = await wrong.resolve(q)
        XCTAssertEqual(b, Dns.noRouteReply(q))
    }

    func testTheTunnelTurnsItOnWithTheServer() throws {
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../Tunnel/PacketTunnelProvider.swift").standardized
        let src = try String(contentsOf: file, encoding: .utf8)
        XCTAssertTrue(src.contains("forwarder.throughEngine(settings.ownServerLink != nil, nil)"))
        XCTAssertTrue(src.contains("doh?.throughEngine(true, DohForwarder.EnginePath(port: p, user: a.user, pass: a.pass))"))
    }
}
