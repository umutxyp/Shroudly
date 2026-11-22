import CryptoKit
import XCTest

/* VLESS and Trojan for "Your own server" on iPhone, iPad and Mac
 * (Shared/Vless.swift, Tunnel/VlessClient.swift), the Apple side of
 * tests/net/vless.test.js and VlessTest.kt:
 *   - the links the desktop and Android take, read the same way, and the
 *     same names for the kinds that are not carried; the key never shown
 *   - the headers are the very bytes the desktop and Android write
 *     (tests/net/fixtures/vless-vectors.json)
 *   - WebSocket frames, written and read back cut anywhere
 *   - the tunnel's client carries connections through a server of each kind
 *     written here from the protocols' descriptions (plain TCP, a WebSocket,
 *     HTTPUpgrade): whole in both directions, a server that speaks first, a
 *     wrong key, a server that is not there, an answer that is not this
 *     protocol's
 *   - with TLS, against real sites: a certificate for another name is
 *     refused as "tls", and a site that is no such server as "protocol" */
final class VlessTests: XCTestCase {
    private let id = "0f6c2c1e-7a53-4d0b-9c1d-5b8a3e2f4a67"
    private var idHex: String { id.replacingOccurrences(of: "-", with: "") }
    private func hexOf(_ b: [UInt8]) -> String { b.map { String(format: "%02x", $0) }.joined() }

    func testLinksAreReadAsOnTheDesktop() {
        let p = Vless.parse("vless://\(id)@edge.example.net:443?path=%2Fd917409a2b69662b&security=tls&encryption=none&insecure=0&host=edge.example.net&type=ws&allowInsecure=0&sni=edge.example.net#Cloady").link
        XCTAssertEqual(p, VlessLink(kind: "vless", host: "edge.example.net", port: 443, id: idHex, password: "", net: "ws", tls: true,
                                    sni: "edge.example.net", wsHost: "edge.example.net", path: "/d917409a2b69662b", alpn: [], name: "Cloady"))
        XCTAssertEqual(p.map(Vless.describe), "VLESS edge.example.net:443 (WebSocket + TLS)")
        let q = Vless.parse("vless://\(id)@1.2.3.4:80?type=ws&path=/ws%3Fed%3D2048&host=cdn.example.org#x%20y").link
        XCTAssertEqual(q?.tls, false)
        XCTAssertEqual(q?.path, "/ws")
        XCTAssertEqual(q?.wsHost, "cdn.example.org")
        XCTAssertEqual(q?.name, "x y")
        XCTAssertEqual(Vless.parse("vless://\(id)@host.example:443?type=ws&path=/a?x=1&ed=2560&security=tls").link?.path, "/a?x=1")
        XCTAssertEqual(Vless.parse("vless://\(id)@host.example:443?type=ws&path=%2Fa%3Fed%3D2560%26x%3D1&security=tls").link?.path, "/a?x=1")
        let r = Vless.parse("vless://\(id)@[2001:db8::1]:8443?security=tls&sni=v.example.com&alpn=h2,http/1.1").link
        XCTAssertEqual(r?.net, "tcp")
        XCTAssertEqual(r?.host, "2001:db8::1")
        XCTAssertEqual(r?.port, 8443)
        XCTAssertEqual(r?.alpn, ["h2", "http/1.1"])
        XCTAssertEqual(r?.path, "/")
        let h = Vless.parse("vless://\(id)@h.example:443?type=httpupgrade&security=tls&path=up&host=h.example").link
        XCTAssertEqual(h?.net, "httpupgrade")
        XCTAssertEqual(h?.path, "/up")
        let t = Vless.parse("trojan://p%40ss%3Aword@t.example:443?type=ws&path=/t&sni=t.example#T").link
        XCTAssertEqual(t?.kind, "trojan")
        XCTAssertEqual(t?.password, "p@ss:word")
        XCTAssertEqual(t?.tls, true)
        XCTAssertNotNil(Vless.parse("  VLESS://\(id.uppercased())@H.example:443?TYPE=ws&Security=TLS  ").link)
    }

    func testWhatCannotBeCarriedIsSaid() {
        func no(_ link: String) -> String {
            let p = Vless.parse(link)
            return p.link != nil ? "ok" : "\(p.error ?? "")\(p.what.map { ":\($0)" } ?? "")"
        }
        XCTAssertEqual(no("vless://\(id)@h.example:443?security=reality&pbk=abc&sid=01&fp=chrome&type=tcp&flow=xtls-rprx-vision"), "unsupported:reality")
        XCTAssertEqual(no("vless://\(id)@h.example:443?security=tls&flow=xtls-rprx-vision"), "unsupported:flow")
        XCTAssertEqual(no("vless://\(id)@h.example:443?security=tls&type=grpc&serviceName=x"), "unsupported:transport")
        XCTAssertEqual(no("vless://\(id)@h.example:443?security=tls&type=xhttp&path=/x"), "unsupported:transport")
        XCTAssertEqual(no("vless://\(id)@h.example:443?type=kcp"), "unsupported:transport")
        XCTAssertEqual(no("vless://\(id)@h.example:80?type=tcp&headerType=http"), "unsupported:transport")
        XCTAssertEqual(no("vless://\(id)@h.example:443?security=tls&encryption=mlkem768x25519plus.native.0rtt.abc"), "unsupported:encryption")
        XCTAssertEqual(no("vless://\(id)@h.example:443?security=xtls"), "unsupported:security")
        // A certificate that cannot be checked is not taken here.
        XCTAssertEqual(no("vless://\(id)@h.example:443?security=tls&allowInsecure=1"), "unsupported:insecure")
        XCTAssertEqual(no("trojan://pw@h.example:443?insecure=true"), "unsupported:insecure")
        for bad in ["vless://not-a-uuid@h.example:443", "vless://\(id)@h.example", "vless://\(id)@h.example:0", "vless://\(id)@h.example:99999",
                    "vless://@h.example:443", "trojan://@h.example:443", "vless://\(id)@h.example:443?type=ws&host=a%20b",
                    "vless://\(id)@h.example:443?type=ws&path=/a%0d%0aX:1", "vless://\(id)@h.example:443?sni=a%0ab", "ss://abc", ""] {
            XCTAssertEqual(no(bad), "format", bad)
        }
        for w in ["reality", "flow", "transport", "encryption", "security", "insecure"] {
            XCTAssertFalse(Vless.unsupportedName(w).isEmpty)
            XCTAssertNotEqual(Vless.unsupportedName(w), w)
        }
    }

    func testThroughOwnServerAndNeverTheKey() {
        let typed = "vless://\(id)@edge.example.net:443?type=ws&security=tls&path=/x&host=edge.example.net#Mine"
        let p = OwnServer.parse(typed)
        guard let l = p.link else { XCTFail("not read"); return }
        XCTAssertEqual(l.kind, "vless")
        XCTAssertEqual(l.host, "edge.example.net")
        XCTAssertEqual(l.port, 443)
        XCTAssertTrue(l.localClient)
        XCTAssertEqual(OwnServer.describe(l), "VLESS edge.example.net:443 (WebSocket + TLS)")
        XCTAssertEqual(OwnServer.masked(typed), "vless://••••@edge.example.net:443?type=ws&security=tls&path=/x&host=edge.example.net#Mine")
        XCTAssertFalse(OwnServer.masked(typed).contains(id))
        XCTAssertEqual(OwnServer.masked("trojan://my%20secret@t.example:443?sni=t.example"), "trojan://••••@t.example:443?sni=t.example")
        let auth = SocksAuth.random()
        XCTAssertEqual(OwnServer.engineLine(l, localPort: 4242, auth: auth), "socks5://\(auth.user):\(auth.pass)@127.0.0.1:4242")
        let bad = OwnServer.parse("vless://\(id)@h.example:443?security=reality&pbk=x")
        XCTAssertNil(bad.link)
        XCTAssertEqual(bad.error, "unsupported")
        XCTAssertEqual(bad.what, "reality")
        XCTAssertEqual(OwnServer.errorKey("unsupported"), "ownServerErrUnsupported")
        XCTAssertEqual(OwnServer.whyKey("cert"), "ownServerWhyCert")
        // The new lines are in the app's strings, in every language, with the place for the name.
        let loc = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../Localization").standardized
        let langs = ((try? FileManager.default.contentsOfDirectory(atPath: loc.path)) ?? []).filter { $0.hasSuffix(".lproj") }
        XCTAssertEqual(langs.count, 31)
        for l in langs {
            let text = (try? String(contentsOf: loc.appendingPathComponent(l).appendingPathComponent("Localizable.strings"), encoding: .utf8)) ?? ""
            XCTAssertTrue(text.contains("\"ownServerErrUnsupported\"") && text.contains("\"ownServerWhyCert\""), l)
        }
        XCTAssertEqual(OwnServer.describe(OwnServer.parse("trojan://pw@t.example:443").link!), "Trojan t.example:443 (TCP + TLS)")
    }

    func testTheDesktopsBytes() throws {
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../tests/net/fixtures/vless-vectors.json").standardized
        let json = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as! [String: Any]
        let v = json["vless"] as! [[String: Any]]
        XCTAssertGreaterThanOrEqual(v.count, 7)
        for c in v {
            let h = Vless.vlessHeader(idHex: c["id"] as! String, host: c["host"] as! String, port: c["port"] as! Int)
            XCTAssertEqual(h.map(hexOf), c["header"] as? String, c["host"] as! String)
        }
        for c in json["trojan"] as! [[String: Any]] {
            let h = Vless.trojanHeader(password: c["password"] as! String, host: c["host"] as! String, port: c["port"] as! Int)
            XCTAssertEqual(h.map(hexOf), c["header"] as? String, c["host"] as! String)
        }
        XCTAssertNil(Vless.ipv6Bytes("example.com"))
        XCTAssertNil(Vless.ipv6Bytes("1:2:3"))
        XCTAssertNil(Vless.ipv6Bytes("::g"))
        XCTAssertEqual(Vless.ipv6Bytes("::1").map(hexOf), "00000000000000000000000000000001")
        XCTAssertNil(Vless.vlessHeader(idHex: idHex, host: String(repeating: "a", count: 256), port: 1))
        XCTAssertEqual(Vless.sha224Hex("secret"), "95c7fbca92ac5083afda62a564a3d014fc3b72c9140e3cb99ea6bf12")
    }

    private static func serverFrame(_ data: [UInt8], opcode: UInt8 = 2) -> [UInt8] {
        let n = data.count
        if n < 126 { return [0x80 | opcode, UInt8(n)] + data }
        if n < 65536 { return [0x80 | opcode, 126, UInt8(n >> 8), UInt8(n & 0xff)] + data }
        return [0x80 | opcode, 127, 0, 0, 0, 0, UInt8((n >> 24) & 0xff), UInt8((n >> 16) & 0xff), UInt8((n >> 8) & 0xff), UInt8(n & 0xff)] + data
    }

    func testWebSocketFrames() throws {
        var g = SystemRandomNumberGenerator()
        func random(_ n: Int) -> [UInt8] { (0..<n).map { _ in UInt8.random(in: 0...255, using: &g) } }
        for n in [0, 1, 125, 126, 127, 65535, 65536, 200_000] {
            let data = random(n)
            let f = Vless.wsFrame(data)
            XCTAssertEqual(f[0] & 0x8f, 0x82)
            XCTAssertNotEqual(f[1] & 0x80, 0)
            var len = Int(f[1] & 0x7f)
            var at = 2
            if len == 126 { len = (Int(f[2]) << 8) | Int(f[3]); at = 4 } else if len == 127 {
                len = (Int(f[6]) << 24) | (Int(f[7]) << 16) | (Int(f[8]) << 8) | Int(f[9]); at = 10
            }
            XCTAssertEqual(len, n)
            let body = (0..<n).map { f[at + 4 + $0] ^ f[at + ($0 & 3)] }
            XCTAssertEqual(body, data, "\(n)")
        }
        var pings: [String] = []
        let rd = Vless.WsReader(onPing: { pings.append(String(decoding: $0, as: UTF8.self)) })
        let parts = [random(5), random(300), random(70000)]
        let stream = Self.serverFrame(parts[0]) + Self.serverFrame(Array("p1".utf8), opcode: 9) + Self.serverFrame(parts[1]) + Self.serverFrame(parts[2]) + Self.serverFrame([], opcode: 10)
        var got: [UInt8] = []
        var i = 0
        while i < stream.count { got += try rd.push(Array(stream[i..<min(i + 777, stream.count)])); i += 777 }
        XCTAssertEqual(got, parts.reduce([], +))
        XCTAssertEqual(pings, ["p1"])
        XCTAssertFalse(rd.closed)
        _ = try rd.push(Self.serverFrame([], opcode: 8))
        XCTAssertTrue(rd.closed)
        XCTAssertThrowsError(try Vless.WsReader().push(Vless.wsFrame(Array("x".utf8))))
        XCTAssertThrowsError(try Vless.WsReader().push([0x82, 127, 0, 0, 0, 1, 0, 0, 0, 0]))
        XCTAssertThrowsError(try Vless.WsReader().push([0x82, 127, 0, 0, 0, 0, 0x7f, 0xff, 0xff, 0xff]))
        XCTAssertEqual(Vless.wsAccept("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")
    }

    func testTargetsOfARequest() {
        XCTAssertEqual(VlessClient.target([5, 1, 0, 1, 1, 2, 3, 4, 0, 80])?.host, "1.2.3.4")
        XCTAssertEqual(VlessClient.target([5, 1, 0, 1, 1, 2, 3, 4, 0, 80])?.port, 80)
        let name = VlessClient.target([5, 1, 0, 3, 11] + Array("example.com".utf8) + [1, 0xbb])
        XCTAssertEqual(name?.host, "example.com")
        XCTAssertEqual(name?.port, 443)
        let v6 = VlessClient.target([5, 1, 0, 4] + [0x20, 0x01, 0x0d, 0xb8] + [UInt8](repeating: 0, count: 11) + [1] + [0x20, 0xfb])
        XCTAssertEqual(v6?.host, "2001:db8:0:0:0:0:0:1")
        XCTAssertEqual(v6?.port, 8443)
        XCTAssertEqual(Vless.ipv6Bytes(v6?.host ?? "").map(hexOf), "20010db8000000000000000000000001")
        XCTAssertNil(VlessClient.target([5, 1, 0, 9, 0, 0, 0]))
    }

    // MARK: a server of each kind, for these tests only

    private final class FakeServer {
        private(set) var port = 0
        private let fd: Int32
        private let lock = NSLock()
        private var seenRequests: [String] = []
        private var seenHeads: [String] = []
        private var bad = 0
        private var unmaskedFrames = 0
        var requests: [String] { lock.lock(); defer { lock.unlock() }; return seenRequests }
        var heads: [String] { lock.lock(); defer { lock.unlock() }; return seenHeads }
        var badAuth: Int { lock.lock(); defer { lock.unlock() }; return bad }
        var unmasked: Int { lock.lock(); defer { lock.unlock() }; return unmaskedFrames }
        static let blob: [UInt8] = (0..<(1024 * 1024)).map { UInt8(truncatingIfNeeded: $0 &* 31 &+ ($0 >> 8)) }

        init(kind: String, net: String, idHex: String) throws {
            fd = Darwin.socket(AF_INET, SOCK_STREAM, 0)
            var a = TestNet.sockaddrV4("127.0.0.1", 0)
            var len = socklen_t(MemoryLayout<sockaddr_in>.size)
            let ok = withUnsafeMutablePointer(to: &a) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(fd, $0, len) == 0 && Darwin.getsockname(fd, $0, &len) == 0 } }
            guard ok, Darwin.listen(fd, 16) == 0 else { throw POSIXError(.EADDRINUSE) }
            port = Int(UInt16(bigEndian: a.sin_port))
            let l = fd
            Thread { [weak self] in
                while true {
                    let c = Darwin.accept(l, nil, nil)
                    if c < 0 { return }
                    var one: Int32 = 1
                    setsockopt(c, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
                    Thread { self?.serve(c, kind, net, idHex); Darwin.close(c) }.start()
                }
            }.start()
        }

        func stop() { Darwin.shutdown(fd, SHUT_RDWR); Darwin.close(fd) }

        private func note(_ f: () -> Void) { lock.lock(); f(); lock.unlock() }

        /* One piece of the client's bytes, out of its frames where there are any; nil at its end. */
        private func piece(_ c: Int32, _ ws: Bool) -> [UInt8]? {
            if !ws {
                var buf = [UInt8](repeating: 0, count: 32768)
                let n = Darwin.recv(c, &buf, buf.count, 0)
                return n <= 0 ? nil : Array(buf[0..<n])
            }
            while true {
                let h = TestNet.recv(c, 2)
                guard h.count == 2 else { return nil }
                let opcode = h[0] & 0x0f
                let masked = h[1] & 0x80 != 0
                if !masked { note { unmaskedFrames += 1 } }
                var n = Int(h[1] & 0x7f)
                if n == 126 { let e = TestNet.recv(c, 2); guard e.count == 2 else { return nil }; n = (Int(e[0]) << 8) | Int(e[1]) } else if n == 127 {
                    let e = TestNet.recv(c, 8); guard e.count == 8 else { return nil }
                    n = (Int(e[4]) << 24) | (Int(e[5]) << 16) | (Int(e[6]) << 8) | Int(e[7])
                }
                let mask = masked ? TestNet.recv(c, 4) : [0, 0, 0, 0]
                var body = TestNet.recv(c, n)
                guard mask.count == 4, body.count == n else { return nil }
                for i in body.indices { body[i] ^= mask[i & 3] }
                if opcode == 8 { return nil }
                if opcode == 0 || opcode == 2 { return body }
            }
        }

        private func serve(_ c: Int32, _ kind: String, _ net: String, _ idHex: String) {
            let ws = net == "ws"
            if net != "tcp" {
                var head: [UInt8] = []
                while !(head.count >= 4 && Array(head.suffix(4)) == [13, 10, 13, 10]) {
                    let b = TestNet.recv(c, 1)
                    guard b.count == 1, head.count < 8192 else { return }
                    head += b
                }
                let text = String(decoding: head, as: UTF8.self)
                note { seenHeads.append(text) }
                let key = text.components(separatedBy: "\r\n").first { $0.lowercased().hasPrefix("sec-websocket-key:") }
                    .map { $0.dropFirst("sec-websocket-key:".count).trimmingCharacters(in: .whitespaces) }
                guard text.hasPrefix("GET /tunnel HTTP/1.1\r\n"), !ws || key != nil else {
                    TestNet.send(c, Array("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".utf8))
                    return
                }
                let accept = ws ? "Sec-WebSocket-Accept: \(Data(Insecure.SHA1.hash(data: Array(((key ?? "") + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").utf8))).base64EncodedString())\r\n" : ""
                TestNet.send(c, Array("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\(accept)\r\n".utf8))
            }
            var buf: [UInt8] = []
            func exactly(_ n: Int) -> [UInt8]? {
                while buf.count < n { guard let p = piece(c, ws) else { return nil }; buf += p }
                let out = Array(buf.prefix(n))
                buf.removeFirst(n)
                return out
            }
            var host = ""
            var port = 0
            if kind == "vless" {
                guard let h = exactly(18) else { return }
                guard h[0] == 0, h[1..<17].map({ String(format: "%02x", $0) }).joined() == idHex else { note { bad += 1 }; return }
                guard exactly(Int(h[17])) != nil, let cmd = exactly(4), cmd[0] == 1 else { return }
                port = (Int(cmd[1]) << 8) | Int(cmd[2])
                switch cmd[3] {
                case 1: host = (exactly(4) ?? []).map { String($0) }.joined(separator: ".")
                case 2: guard let n = exactly(1), let name = exactly(Int(n[0])) else { return }; host = String(decoding: name, as: UTF8.self)
                default: host = (exactly(16) ?? []).map { String(format: "%02x", $0) }.joined()
                }
            } else {
                guard let h = exactly(58) else { return }
                guard String(decoding: h[0..<56], as: UTF8.self) == Vless.sha224Hex("the pass word"), h[56] == 13, h[57] == 10 else { note { bad += 1 }; return }
                guard let cmd = exactly(2), cmd[0] == 1 else { return }
                switch cmd[1] {
                case 1: host = (exactly(4) ?? []).map { String($0) }.joined(separator: ".")
                case 3: guard let n = exactly(1), let name = exactly(Int(n[0])) else { return }; host = String(decoding: name, as: UTF8.self)
                default: host = (exactly(16) ?? []).map { String(format: "%02x", $0) }.joined()
                }
                guard let pb = exactly(4) else { return }
                port = (Int(pb[0]) << 8) | Int(pb[1])
            }
            note { seenRequests.append("\(host):\(port)") }
            // VLESS answers with its version, a length, and that many bytes.
            var first: [UInt8] = kind == "vless" ? [0, 3, 1, 2, 3] : []
            func send(_ d: [UInt8]) {
                let all = first + d
                first = []
                if !ws { TestNet.send(c, all); return }
                var i = 0
                while i < all.count { TestNet.send(c, VlessTests.serverFrame(Array(all[i..<min(i + 1000, all.count)]))); i += 1000 }
            }
            if ws { TestNet.send(c, VlessTests.serverFrame(Array("hi".utf8), opcode: 9)) }
            switch host {
            case "banner.test":
                send(Array("220 hello\r\n".utf8))
                let got = buf.isEmpty ? (piece(c, ws) ?? []) : buf
                send(Array("got \(got.count)\r\n".utf8))
            case "giver.test":
                if buf.isEmpty { _ = piece(c, ws) }
                send(FakeServer.blob)
                // Closed only once the client has read it all: a close with
                // bytes of the client's still unread here (its pong) would
                // be a reset, and take the end of the blob with it.
                Darwin.shutdown(c, SHUT_WR)
                var drain = [UInt8](repeating: 0, count: 4096)
                while Darwin.recv(c, &drain, drain.count, 0) > 0 {}
            default:
                if !buf.isEmpty { send(Array("echo:".utf8) + buf); buf = [] }
                while let p = piece(c, ws) { send(Array("echo:".utf8) + p) }
            }
        }
    }

    private func through(_ kind: String, _ net: String, key: String? = nil, path: String = "/tunnel", _ body: (Int, SocksAuth, FakeServer, () -> [String]) throws -> Void) throws {
        let server = try FakeServer(kind: kind, net: net, idHex: idHex)
        defer { server.stop() }
        var link = VlessLink(kind: kind, host: "127.0.0.1", port: server.port, net: net, wsHost: "front.example", path: path)
        if kind == "vless" { link.id = key ?? idHex } else { link.password = key ?? "the pass word" }
        let auth = SocksAuth.random()
        let lock = NSLock()
        var errors: [String] = []
        let client = VlessClient(link: link, auth: auth, onError: { why in lock.lock(); errors.append(why); lock.unlock() })
        let port = try client.start()
        defer { client.stop() }
        try body(port, auth, server, { lock.lock(); defer { lock.unlock() }; return errors })
    }

    func testTheClientCarriesConnections() throws {
        for kind in ["vless", "trojan"] {
            for net in ["tcp", "ws", "httpupgrade"] {
                let label = "\(kind) over \(net)"
                try through(kind, net) { port, auth, server, errors in
                    // What goes up comes back.
                    var s = TestNet.socks(port, user: auth.user, pass: auth.pass, to: .name("echo.test"), 7)
                    XCTAssertEqual(s.code, 0, label)
                    TestNet.send(s.fd, Array("hello".utf8))
                    XCTAssertEqual(String(decoding: TestNet.recv(s.fd, 10), as: UTF8.self), "echo:hello", label)
                    TestNet.send(s.fd, Array("again".utf8))
                    XCTAssertEqual(String(decoding: TestNet.recv(s.fd, 10), as: UTF8.self), "echo:again", label)
                    close(s.fd)
                    // 1 MB down, whole and in order.
                    s = TestNet.socks(port, user: auth.user, pass: auth.pass, to: .name("giver.test"), 80)
                    XCTAssertEqual(s.code, 0, label)
                    TestNet.send(s.fd, Array("GET / HTTP/1.1\r\n\r\n".utf8))
                    let down = TestNet.recv(s.fd, FakeServer.blob.count)
                    XCTAssertEqual(down.count, FakeServer.blob.count, label)
                    XCTAssertTrue(down == FakeServer.blob, label)
                    close(s.fd)
                    // A server that speaks first: the header goes by itself.
                    s = TestNet.socks(port, user: auth.user, pass: auth.pass, to: .name("banner.test"), 25)
                    XCTAssertEqual(s.code, 0, label)
                    XCTAssertEqual(String(decoding: TestNet.recv(s.fd, 11), as: UTF8.self), "220 hello\r\n", label)
                    TestNet.send(s.fd, Array("EHLO x\r\n".utf8))
                    XCTAssertEqual(String(decoding: TestNet.recv(s.fd, 7), as: UTF8.self), "got 8\r\n", label)
                    close(s.fd)
                    XCTAssertEqual(server.requests, ["echo.test:7", "giver.test:80", "banner.test:25"], label)
                    XCTAssertEqual(server.badAuth, 0, label)
                    XCTAssertEqual(errors(), [], label)
                    if net != "tcp" {
                        XCTAssertTrue(server.heads.allSatisfy { $0.hasPrefix("GET /tunnel HTTP/1.1\r\n") && $0.contains("\r\nHost: front.example\r\n") && $0.contains("Mozilla/5.0") }, label)
                    }
                    if net == "ws" { XCTAssertEqual(server.unmasked, 0, label) }
                    // Another program without this session's password: refused, nothing sent on.
                    let bad = TestNet.socks(port, user: auth.user, pass: "wrong", to: .name("echo.test"), 7)
                    XCTAssertLessThan(bad.code, 0, label)
                    if bad.fd >= 0 { close(bad.fd) }
                    XCTAssertEqual(server.requests.count, 3, label)
                }
            }
        }
    }

    func testAWrongKeyGetsNothingBack() throws {
        for (kind, key) in [("vless", "00112233445566778899aabbccddeeff"), ("trojan", "not it")] {
            for net in ["tcp", "ws", "httpupgrade"] {
                try through(kind, net, key: key) { port, auth, server, _ in
                    let s = TestNet.socks(port, user: auth.user, pass: auth.pass, to: .name("echo.test"), 7)
                    XCTAssertEqual(s.code, 0)
                    TestNet.send(s.fd, Array("hello".utf8))
                    XCTAssertEqual(TestNet.recv(s.fd, 10).count, 0, "\(kind) over \(net)")
                    close(s.fd)
                    XCTAssertEqual(server.badAuth, 1, "\(kind) over \(net)")
                }
            }
        }
    }

    func testAnAnswerThatIsNotThisProtocols() throws {
        // A path the server does not know (its 404).
        for net in ["ws", "httpupgrade"] {
            try through("vless", net, path: "/elsewhere") { port, auth, _, errors in
                let s = TestNet.socks(port, user: auth.user, pass: auth.pass, to: .name("echo.test"), 7)
                XCTAssertEqual(s.code, 5, net)
                if s.fd >= 0 { close(s.fd) }
                XCTAssertEqual(errors(), ["protocol"], net)
            }
        }
    }

    func testAServerThatIsNotThere() throws {
        // A port nothing listens on.
        let probe = try EchoServer()
        let dead = probe.port
        probe.stop()
        usleep(200_000)
        let auth = SocksAuth.random()
        let lock = NSLock()
        var errors: [String] = []
        let client = VlessClient(link: VlessLink(kind: "vless", host: "127.0.0.1", port: dead, id: idHex, net: "ws"), auth: auth,
                                 onError: { why in lock.lock(); errors.append(why); lock.unlock() })
        let port = try client.start()
        defer { client.stop() }
        let s = TestNet.socks(port, user: auth.user, pass: auth.pass, to: .name("echo.test"), 7)
        XCTAssertEqual(s.code, 5)
        if s.fd >= 0 { close(s.fd) }
        lock.lock(); defer { lock.unlock() }
        XCTAssertEqual(errors, ["noAnswer"])
    }

    /* With TLS, against real sites (skipped where there is no network): the
     * system's own TLS is what checks the server. */
    private func real(_ host: String, sni: String = "", _ expect: String) throws {
        let auth = SocksAuth.random()
        let lock = NSLock()
        var errors: [String] = []
        let link = VlessLink(kind: "vless", host: host, port: 443, id: idHex, net: "ws", tls: true, sni: sni, path: "/shroudly-test-\(UUID().uuidString)")
        let client = VlessClient(link: link, auth: auth, onError: { why in lock.lock(); errors.append(why); lock.unlock() })
        let port = try client.start()
        defer { client.stop() }
        let fd = TestNet.connect(port, timeout: 25)
        guard fd >= 0 else { XCTFail("the client is not listening"); return }
        defer { close(fd) }
        TestNet.send(fd, [5, 1, 2])
        _ = TestNet.recv(fd, 2)
        TestNet.send(fd, [1, UInt8(auth.user.utf8.count)] + Array(auth.user.utf8) + [UInt8(auth.pass.utf8.count)] + Array(auth.pass.utf8))
        _ = TestNet.recv(fd, 2)
        TestNet.send(fd, [5, 1, 0, 3, 11] + Array("example.com".utf8) + [1, 0xbb])
        let answer = TestNet.recv(fd, 10)
        lock.lock(); let got = errors; lock.unlock()
        if got == ["noAnswer"] || answer.isEmpty { throw XCTSkip("no way to \(host) from here") }
        XCTAssertEqual(answer.count == 10 ? answer[1] : 255, 5, host)
        XCTAssertEqual(got, [expect], host)
    }

    func testTlsARealSiteThatIsNoSuchServer() throws {
        // Its certificate is good, its answer to the opening request is not a WebSocket's.
        try real("example.com", "protocol")
    }

    /* A link's address is often an IP, with the site's name in sni: the
     * certificate is checked for that name, not for the address. */
    func testTlsAnAddressWithTheNameInSni() throws {
        var hints = addrinfo()
        hints.ai_family = AF_INET
        hints.ai_socktype = SOCK_STREAM
        var res: UnsafeMutablePointer<addrinfo>?
        guard getaddrinfo("example.com", nil, &hints, &res) == 0, let first = res else { throw XCTSkip("example.com does not resolve here") }
        defer { freeaddrinfo(res) }
        var name = [CChar](repeating: 0, count: Int(NI_MAXHOST))
        guard getnameinfo(first.pointee.ai_addr, first.pointee.ai_addrlen, &name, socklen_t(name.count), nil, 0, NI_NUMERICHOST) == 0 else { throw XCTSkip("no address") }
        let ip = String(cString: name)
        XCTAssertNotNil(Vless.ipv4Bytes(ip), ip)
        // With the name in sni: the certificate is good (the answer is then the site's own "no").
        try real(ip, sni: "example.com", "protocol")
        // Without it the certificate is not one for the bare address.
        try real(ip, "tls")
    }

    func testTlsACertificateForAnotherName() throws {
        // The site's own certificate, asked for under a name it is not for.
        // (Not a name under example.org: the site's certificate is for those too.)
        try real("example.com", sni: "wrong-name.shroudly-test.invalid", "tls")
    }
}
