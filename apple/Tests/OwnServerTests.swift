import CryptoKit
import XCTest

/* "Your own server" on iPhone, iPad and Mac (Shared/OwnServer.swift,
 * Tunnel/Shadowsocks.swift):
 *   - the links the desktop and Android take, and the same reasons for the
 *     ones they refuse; the password never shown
 *   - Shadowsocks writes the very bytes the desktop and Android write
 *     (tests/net/fixtures/ss-vectors.json, which the desktop's are checked
 *     against shadowsocks-libev with), and reads them back cut anywhere
 *   - the tunnel's client: a SOCKS5 server on 127.0.0.1 that only this
 *     session's user and password may use, carrying a connection through a
 *     Shadowsocks server and back */
final class OwnServerTests: XCTestCase {
    func testLinks() {
        let s = OwnServer.parse("socks5://alice:p%40ss@10.0.0.2:1080")
        XCTAssertEqual(s.link, OwnServerLink(kind: "socks5", host: "10.0.0.2", port: 1080, user: "alice", pass: "p@ss"))
        XCTAssertEqual(OwnServer.parse("http://proxy.example:3128/").link?.kind, "http")
        XCTAssertEqual(OwnServer.parse("SOCKS5H://h:1").link?.kind, "socks5")
        XCTAssertEqual(OwnServer.parse("1.2.3.4:1080").link, OwnServerLink(kind: "socks5", host: "1.2.3.4", port: 1080))
        XCTAssertEqual(OwnServer.parse("socks5://[2001:db8::1]:1080").link?.host, "2001:db8::1")
        // SIP002 and the older form, the same server.
        let sip = OwnServer.parse("ss://YWVzLTI1Ni1nY206c2VjcmV0@5.6.7.8:8388#home")
        XCTAssertEqual(sip.link, OwnServerLink(kind: "ss", host: "5.6.7.8", port: 8388, method: "aes-256-gcm", password: "secret", name: "home"))
        let old = OwnServer.parse("ss://YWVzLTI1Ni1nY206c2VjcmV0QDUuNi43Ljg6ODM4OA==")
        XCTAssertEqual(old.link?.method, "aes-256-gcm")
        XCTAssertEqual(old.link?.port, 8388)
        XCTAssertEqual(OwnServer.parse("ss://chacha20-ietf-poly1305:pw@h:1/?plugin=x").link?.method, "chacha20-ietf-poly1305")
        // Refused, with the reason the screen gives.
        XCTAssertEqual(OwnServer.parse("").error, "empty")
        XCTAssertEqual(OwnServer.parse("socks5://h").error, "format")
        XCTAssertEqual(OwnServer.parse("socks5://h:70000").error, "format")
        XCTAssertEqual(OwnServer.parse("socks5://a%3Ab:c@h:1").error, "user")
        XCTAssertEqual(OwnServer.parse("ss://cmM0LW1kNTpwdw@h:1").error, "method")
        XCTAssertEqual(OwnServer.parse("ss://cmM0LW1kNTpwdw@h:1").method, "rc4-md5")
        XCTAssertEqual(OwnServer.errorKey("method"), "ownServerErrMethod")
        XCTAssertEqual(OwnServer.errorKey("empty"), "ownServerErrFormat")
    }

    /* Every reason and every refusal the screen can show is in the app's
     * strings (a key chosen at run time is not one scripts/gen-strings.js
     * would find by itself). */
    func testEveryReasonIsInTheAppsStrings() throws {
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../Localization/en.lproj/Localizable.strings").standardized
        let strings = try String(contentsOf: file, encoding: .utf8)
        let keys = ["noAnswer", "auth", "asks", "refused", "protocol", "silent", "tls", "x"].map(OwnServer.whyKey)
            + ["method", "user", "format", "empty"].map(OwnServer.errorKey)
            + ["ownServerDown", "ownServerDownBody", "nationalOnlyTitle", "nationalOnlyBody", "nationalOnlyHelp", "helpOthers", "helpOthersBodyConduit", "helpOthersConduit"]
        for k in Set(keys) {
            XCTAssertTrue(strings.contains("\"\(k)\" = "), "\(k) is in the app's strings")
        }
    }

    func testNeverThePassword() {
        let l = OwnServer.parse("socks5://alice:secret@10.0.0.2:1080").link!
        XCTAssertEqual(OwnServer.describe(l), "SOCKS5 10.0.0.2:1080")
        XCTAssertEqual(OwnServer.masked("socks5://alice:secret@10.0.0.2:1080"), "socks5://alice:••••@10.0.0.2:1080")
        XCTAssertEqual(OwnServer.masked("ss://YWVzLTI1Ni1nY206c2VjcmV0@5.6.7.8:8388#home"), "ss://••••@5.6.7.8:8388#home")
        XCTAssertEqual(OwnServer.masked("ss://YWVzLTI1Ni1nY206c2VjcmV0QDUuNi43Ljg6ODM4OA=="), "ss://••••")
        XCTAssertFalse(OwnServer.masked("http://u:secret@h:1").contains("secret"))
        // The engine's line: the server itself, or the tunnel's own client.
        XCTAssertEqual(OwnServer.engineLine(l), "socks5://alice:secret@10.0.0.2:1080")
        let ss = OwnServer.parse("ss://YWVzLTI1Ni1nY206c2VjcmV0@5.6.7.8:8388").link!
        XCTAssertEqual(OwnServer.engineLine(ss, localPort: 4242, auth: SocksAuth(user: "u0", pass: "p0")), "socks5://u0:p0@127.0.0.1:4242")
        XCTAssertEqual(OwnServer.whyKey(OwnServer.whyCode("refused the user name or password")), "ownServerWhyAuth")
        XCTAssertEqual(OwnServer.whyKey(OwnServer.whyCode("anything else")), "ownServerWhyProtocol")
    }

    private func hex(_ s: String) -> [UInt8] {
        var out: [UInt8] = []
        var i = s.startIndex
        while i < s.endIndex {
            let j = s.index(i, offsetBy: 2)
            out.append(UInt8(s[i..<j], radix: 16)!)
            i = j
        }
        return out
    }

    private func hexOf(_ b: [UInt8]) -> String { b.map { String(format: "%02x", $0) }.joined() }

    func testTheDesktopsBytes() throws {
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../tests/net/fixtures/ss-vectors.json").standardized
        let json = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as! [String: Any]
        let password = json["password"] as! String
        let p = json["plaintext"] as! [Any]
        let plain: [[UInt8]] = [hex(p[0] as! String), hex(p[1] as! String), [UInt8](repeating: 0x61, count: 17000)]
        let methods = json["methods"] as! [String: [String: Any]]
        XCTAssertEqual(Set(methods.keys), Set(OwnServer.methods.keys))
        for (method, v) in methods {
            let key = Shadowsocks.masterKey(password, OwnServer.methods[method]!)
            XCTAssertEqual(hexOf(key), v["key"] as? String, method)
            let e = Shadowsocks.Encoder(method: method, key: key, salt: hex(v["salt"] as! String))
            let w = plain.map { e.encode($0) }
            let wire = v["wire"] as! [Any]
            XCTAssertEqual(hexOf(w[0]), wire[0] as? String, method)
            XCTAssertEqual(hexOf(w[1]), wire[1] as? String, method)
            let third = wire[2] as! [String: Any]
            XCTAssertEqual(hexOf(Array(SHA256.hash(data: w[2]))), third["sha256"] as? String, method)
            XCTAssertEqual(w[2].count, third["length"] as? Int, method)
            // Read back, cut at any byte.
            let all = w.reduce([], +)
            let d = Shadowsocks.Decoder(method: method, key: key)
            var back: [UInt8] = []
            var i = 0
            while i < all.count { back += d.push(Array(all[i..<min(i + 777, all.count)])); i += 777 }
            XCTAssertFalse(d.bad, method)
            XCTAssertEqual(back, plain.reduce([], +), method)
            // Another password: nothing authenticates, nothing passed on.
            let other = Shadowsocks.Decoder(method: method, key: Shadowsocks.masterKey("other", key.count))
            XCTAssertEqual(other.push(all).count, 0)
            XCTAssertTrue(other.bad, method)
        }
    }

    func testTargets() {
        XCTAssertEqual(Shadowsocks.encodeTarget(host: "example.com", port: 443), [3, 11] + Array("example.com".utf8) + [1, 0xbb])
        XCTAssertEqual(Shadowsocks.encodeTarget(host: "1.2.3.4", port: 80), [1, 1, 2, 3, 4, 0, 80])
        XCTAssertEqual(Shadowsocks.encodeTarget(host: "::1", port: 1)?.count, 1 + 16 + 2)
        XCTAssertNil(Shadowsocks.encodeTarget(host: String(repeating: "a", count: 256), port: 1))
    }

    /* A Shadowsocks server on 127.0.0.1: reads the target and what follows,
     * and answers "echo:" and what came, sealed. */
    private final class FakeServer {
        private(set) var port = 0
        private let fd: Int32
        var target: [UInt8] = []

        init(method: String, password: String) throws {
            fd = Darwin.socket(AF_INET, SOCK_STREAM, 0)
            var a = TestNet.sockaddrV4("127.0.0.1", 0)
            var len = socklen_t(MemoryLayout<sockaddr_in>.size)
            let ok = withUnsafeMutablePointer(to: &a) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(fd, $0, len) == 0 && Darwin.getsockname(fd, $0, &len) == 0 } }
            guard ok, Darwin.listen(fd, 4) == 0 else { throw POSIXError(.EADDRINUSE) }
            port = Int(UInt16(bigEndian: a.sin_port))
            let key = Shadowsocks.masterKey(password, OwnServer.methods[method]!)
            let l = fd
            Thread { [weak self] in
                while true {
                    let c = Darwin.accept(l, nil, nil)
                    if c < 0 { return }
                    var one: Int32 = 1
                    setsockopt(c, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
                    let d = Shadowsocks.Decoder(method: method, key: key)
                    let e = Shadowsocks.Encoder(method: method, key: key)
                    var got: [UInt8] = []
                    var buf = [UInt8](repeating: 0, count: 4096)
                    while true {
                        let n = Darwin.recv(c, &buf, buf.count, 0)
                        if n <= 0 { break }
                        got += d.push(Array(buf[0..<n]))
                        if d.bad { break }
                        // example.com:443 is 1 + 1 + 11 + 2 bytes, then "hello".
                        if got.count >= 15 + 5 {
                            self?.target = Array(got.prefix(15))
                            TestNet.send(c, e.encode(Array("echo:".utf8) + Array(got[15...])))
                            got = []
                        }
                    }
                    Darwin.close(c)
                }
            }.start()
        }

        func stop() { Darwin.shutdown(fd, SHUT_RDWR); Darwin.close(fd) }
    }

    func testTheClientCarriesAConnection() throws {
        for method in ["chacha20-ietf-poly1305", "aes-256-gcm", "aes-128-gcm"] {
            let server = try FakeServer(method: method, password: "pw-\(method)")
            defer { server.stop() }
            let auth = SocksAuth.random()
            let link = OwnServerLink(kind: "ss", host: "127.0.0.1", port: server.port, method: method, password: "pw-\(method)")
            let client = ShadowsocksClient(link: link, auth: auth)
            let port = try client.start()
            defer { client.stop() }
            let s = TestNet.socks(port, user: auth.user, pass: auth.pass, to: .name("example.com"), 443)
            XCTAssertEqual(s.code, 0, method)
            TestNet.send(s.fd, Array("hello".utf8))
            XCTAssertEqual(String(decoding: TestNet.recv(s.fd, 10), as: UTF8.self), "echo:hello", method)
            XCTAssertEqual(server.target, Shadowsocks.encodeTarget(host: "example.com", port: 443), method)
            close(s.fd)
            // Another program on this computer, without this session's password: refused.
            let bad = TestNet.socks(port, user: auth.user, pass: "wrong", to: .name("example.com"), 443)
            XCTAssertLessThan(bad.code, 0, method)
            if bad.fd >= 0 { close(bad.fd) }
        }
    }

    func testAWrongPasswordGetsNothingBack() throws {
        let server = try FakeServer(method: "aes-256-gcm", password: "right")
        defer { server.stop() }
        let auth = SocksAuth.random()
        let client = ShadowsocksClient(link: OwnServerLink(kind: "ss", host: "127.0.0.1", port: server.port, method: "aes-256-gcm", password: "wrong"), auth: auth)
        let port = try client.start()
        defer { client.stop() }
        let s = TestNet.socks(port, user: auth.user, pass: auth.pass, to: .name("example.com"), 443)
        TestNet.send(s.fd, Array("hello".utf8))
        XCTAssertEqual(TestNet.recv(s.fd, 10).count, 0)
        close(s.fd)
    }
}
