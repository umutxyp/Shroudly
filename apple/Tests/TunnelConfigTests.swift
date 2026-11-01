import XCTest

final class TunnelConfigTests: XCTestCase {
    func testYamlCarriesThePortCredentialsAndLimits() {
        let y = TunnelConfig.yaml(socksPort: 41234, user: "0123456789abcdef", pass: "00112233445566778899aabbccddeeff",
                                  mapped: "198.19.64.0")
        XCTAssertTrue(y.contains("  port: 41234\n  address: 127.0.0.1\n  udp: 'udp'\n  username: '0123456789abcdef'\n  password: '00112233445566778899aabbccddeeff'\nmapdns:"), y)
        XCTAssertTrue(y.contains("  address: 198.18.0.2\n  port: 53\n  network: 198.19.64.0\n  netmask: 255.255.192.0\n"), y)
        XCTAssertTrue(y.contains("max-session-count: \(TunnelConfig.maxSessions)\n"))
        XCTAssertTrue(y.contains("task-stack-size: 24576\n"))
        XCTAssertTrue(y.contains("tcp-buffer-size: 4096\n"))
        XCTAssertTrue(y.contains("tcp-read-write-timeout: 3600000\n"))
        XCTAssertFalse(y.contains("\t"))
    }

    func testYamlWithoutCredentials() {
        let y = TunnelConfig.yaml(socksPort: 1080)
        XCTAssertFalse(y.contains("username"))
        XCTAssertTrue(y.contains("udp: 'udp'\nmapdns:"))
    }

    func testEachTunnelGetsTheNextQuarter() {
        XCTAssertEqual((0..<6).map { TunnelConfig.mappedNetwork(generation: $0) },
                       ["198.19.0.0", "198.19.64.0", "198.19.128.0", "198.19.192.0", "198.19.0.0", "198.19.64.0"])
        XCTAssertEqual(TunnelConfig.mappedNetwork(generation: -1), "198.19.192.0")
        // Room for every cached name in a quarter.
        XCTAssertLessThan(TunnelConfig.cacheSize, 16384)
    }

    func testTheSessionCapFitsTheEnginesCap() {
        // The engine is built with MAX_CONNS=192 (Config/Shroudly.xcconfig):
        // hev's sessions and the engine's own lookups must fit.
        XCTAssertLessThanOrEqual(TunnelConfig.maxSessions, 192 - 32)
    }

    func testEngineArgs() {
        var s = AppSettings()
        var a = EngineArgs.make(port: 5555, dohPort: 6666, settings: s, authFile: "/tmp/a", blockIps: ["1.2.3.4", "5.6.7.8"])
        XCTAssertEqual(Array(a.prefix(7)), ["--listen", "127.0.0.1", "--port", "5555", "--strategy", "split(sni)", "--auto"])
        XCTAssertTrue(a.joined(separator: " ").contains("--doh --doh-port 6666 --auth-file /tmp/a --fake-net 198.18.0.0/15 --block-ip 1.2.3.4 --block-ip 5.6.7.8"))
        XCTAssertFalse(a.contains("--drop-quic"))
        XCTAssertFalse(a.contains("--ipv4-only"))
        XCTAssertFalse(a.contains("--adblock"), "no ad blocking in store copies")

        s.strategyId = "disorder-sni"
        s.quicOff = true
        s.ipv6Off = true
        a = EngineArgs.make(port: 5555, dohPort: 0, settings: s, authFile: nil, blockIps: [], fakeNet: nil)
        XCTAssertEqual(a, ["--listen", "127.0.0.1", "--port", "5555", "--strategy", "disorder(sni)", "--doh", "--drop-quic", "--ipv4-only"])
    }

    func testShownArgsCountBlockPages() {
        let a = EngineArgs.make(port: 1, dohPort: 2, settings: AppSettings(), authFile: nil, blockIps: ["1.1.1.1", "2.2.2.2", "3.3.3.3"])
        let shown = EngineArgs.shown(a)
        XCTAssertFalse(shown.contains("--block-ip"))
        XCTAssertTrue(shown.hasSuffix("(+3 known block pages)"))
    }

    func testBlockIpsList() {
        XCTAssertEqual(EngineArgs.blockIps(from: "# comment\n\n195.175.254.2\n  10.0.0.1 \n"), ["195.175.254.2", "10.0.0.1"])
    }

    func testSocksAuth() throws {
        let a = SocksAuth.random()
        XCTAssertTrue(SocksAuth.isToken(a.user))
        XCTAssertTrue(SocksAuth.isToken(a.pass))
        XCTAssertNotEqual(a, SocksAuth.random())
        XCTAssertFalse(SocksAuth.isToken("short"))
        XCTAssertFalse(SocksAuth.isToken("NOTHEX__"))
        let path = FileManager.default.temporaryDirectory.appendingPathComponent("auth-\(UUID().uuidString)").path
        defer { unlink(path) }
        try a.write(to: path)
        XCTAssertEqual(try String(contentsOfFile: path, encoding: .utf8), "\(a.user):\(a.pass)\n")
        let mode = try XCTUnwrap(FileManager.default.attributesOfItem(atPath: path)[.posixPermissions] as? NSNumber)
        XCTAssertEqual(mode.intValue & 0o777, 0o600)
    }
}
