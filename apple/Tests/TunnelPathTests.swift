import XCTest

/*
 * The packet tunnel's whole path on this machine, without a real tunnel
 * (one needs a signed app and a device): hev-socks5-tunnel reads and writes
 * packets on one end of a socket pair, as it does on the utun descriptor
 * (each packet headed with its address family, as utun frames them), with
 * the settings the tunnel gives it (TunnelConfig), in front of the engine.
 *
 *   test (raw IPv4) -> hev -> engine (SOCKS5, password) -> echo server
 *
 * A DNS question to the tunnel's DNS server gets a stand-in address; a TCP
 * connection to it reaches, by name through the engine, a server on this
 * machine, and what is sent comes back.
 */
final class TunnelPathTests: XCTestCase {
    private let me = "198.18.0.1"
    private var app: Int32 = -1
    private var tun: Int32 = -1

    override func setUp() {
        var pair: [Int32] = [-1, -1]
        XCTAssertEqual(socketpair(AF_UNIX, SOCK_DGRAM, 0, &pair), 0)
        app = pair[0]
        tun = pair[1]
    }

    override func tearDown() {
        close(app)
        close(tun)
    }

    func testDnsAndTcpThroughHevAndTheEngine() throws {
        let echo = try EchoServer()
        defer { echo.stop() }
        let e = try TestEngine()
        defer { e.engine.stop() }
        let hev = Hev()
        let mapped = TunnelConfig.mappedNetwork(generation: 1)
        XCTAssertTrue(hev.start(config: TunnelConfig.yaml(socksPort: e.port, user: e.auth.user, pass: e.auth.pass, mapped: mapped), tunFd: tun))
        defer { XCTAssertTrue(hev.stop()) }

        // The name, asked of the tunnel's DNS server.
        writePacket(udp(src: me, dst: TunnelConfig.dnsV4, sport: 53000, dport: 53, payload: Dns.query("localhost", id: 7)))
        var addr: String?
        try readPackets(seconds: 5) { p in
            guard p.proto == 17, p.payload.count > 8 else { return false }
            addr = Dns.addressesV4(Array(p.payload[8...])).first
            return true
        }
        let stand = try XCTUnwrap(addr, "no answer from the tunnel's DNS")
        XCTAssertTrue(stand.hasPrefix("198.19.64."), "a stand-in address from \(mapped): \(stand)")

        // A TCP connection to it, as an app makes one.
        let sport = 40000, seq: UInt32 = 1000
        writePacket(tcp(src: me, dst: stand, sport: sport, dport: echo.port, seq: seq, ack: 0, flags: 0x02, payload: []))
        var theirs: UInt32 = 0
        try readPackets(seconds: 5) { p in
            guard p.proto == 6, p.tcpFlags & 0x12 == 0x12 else { return false }
            theirs = p.seq
            return true
        }
        let hello = Array("hello through the tunnel".utf8)
        writePacket(tcp(src: me, dst: stand, sport: sport, dport: echo.port, seq: seq + 1, ack: theirs + 1, flags: 0x18, payload: hello))
        var got: [UInt8] = []
        try readPackets(seconds: 10) { p in
            guard p.proto == 6, p.payload.count > p.tcpHeaderLength else { return false }
            got += p.payload[p.tcpHeaderLength...]
            return got.count >= hello.count
        }
        XCTAssertEqual(String(decoding: got, as: UTF8.self), "hello through the tunnel")
        writePacket(tcp(src: me, dst: stand, sport: sport, dport: echo.port, seq: seq + 1 + UInt32(hello.count), ack: 0, flags: 0x04, payload: []))
        XCTAssertGreaterThan(hev.stats().txPackets, 0)
    }

    // MARK: packets

    private struct Packet {
        let proto: UInt8
        let seq: UInt32
        let tcpFlags: UInt8
        let tcpHeaderLength: Int
        /* What follows the IP header (the UDP or TCP header and its data). */
        let payload: [UInt8]
    }

    private func writePacket(_ ip: [UInt8]) {
        // utun's framing: the address family, in network order.
        let frame: [UInt8] = [0, 0, 0, UInt8(AF_INET)] + ip
        _ = frame.withUnsafeBufferPointer { write(app, $0.baseAddress, $0.count) }
    }

    private func readPackets(seconds: TimeInterval, until done: (Packet) -> Bool) throws {
        let deadline = Date().addingTimeInterval(seconds)
        var buf = [UInt8](repeating: 0, count: 65536)
        while Date() < deadline {
            var p = pollfd(fd: app, events: Int16(POLLIN), revents: 0)
            guard poll(&p, 1, 200) > 0 else { continue }
            let n = read(app, &buf, buf.count)
            guard n > 24 else { continue }
            let ip = Array(buf[4..<n])
            guard ip[0] >> 4 == 4 else { continue }
            let ihl = Int(ip[0] & 0x0f) * 4
            let body = Array(ip[ihl...])
            let isTcp = ip[9] == 6 && body.count >= 20
            let packet = Packet(proto: ip[9],
                                seq: isTcp ? UInt32(body[4]) << 24 | UInt32(body[5]) << 16 | UInt32(body[6]) << 8 | UInt32(body[7]) : 0,
                                tcpFlags: isTcp ? body[13] : 0,
                                tcpHeaderLength: isTcp ? Int(body[12] >> 4) * 4 : 0,
                                payload: body)
            if done(packet) { return }
        }
        throw NSError(domain: "TunnelPathTests", code: 1, userInfo: [NSLocalizedDescriptionKey: "nothing came back in time"])
    }

    private func addr(_ s: String) -> [UInt8] { s.split(separator: ".").map { UInt8($0)! } }

    private func checksum(_ data: [UInt8]) -> UInt16 {
        var sum: UInt32 = 0
        var i = 0
        while i + 1 < data.count { sum += UInt32(data[i]) << 8 | UInt32(data[i + 1]); i += 2 }
        if i < data.count { sum += UInt32(data[i]) << 8 }
        while sum >> 16 != 0 { sum = (sum & 0xffff) + (sum >> 16) }
        return ~UInt16(sum)
    }

    private func ipv4(src: String, dst: String, proto: UInt8, body: [UInt8]) -> [UInt8] {
        let len = 20 + body.count
        var h: [UInt8] = [0x45, 0, UInt8(len >> 8), UInt8(len & 0xff), 0x12, 0x34, 0x40, 0, 64, proto, 0, 0] + addr(src) + addr(dst)
        let c = checksum(h)
        h[10] = UInt8(c >> 8); h[11] = UInt8(c & 0xff)
        return h + body
    }

    private func pseudo(_ src: String, _ dst: String, _ proto: UInt8, _ len: Int) -> [UInt8] {
        addr(src) + addr(dst) + [0, proto, UInt8(len >> 8), UInt8(len & 0xff)]
    }

    private func udp(src: String, dst: String, sport: Int, dport: Int, payload: [UInt8]) -> [UInt8] {
        let len = 8 + payload.count
        var u: [UInt8] = [UInt8(sport >> 8), UInt8(sport & 0xff), UInt8(dport >> 8), UInt8(dport & 0xff), UInt8(len >> 8), UInt8(len & 0xff), 0, 0] + payload
        let c = checksum(pseudo(src, dst, 17, len) + u)
        u[6] = UInt8(c >> 8); u[7] = UInt8(c & 0xff)
        return ipv4(src: src, dst: dst, proto: 17, body: u)
    }

    private func tcp(src: String, dst: String, sport: Int, dport: Int, seq: UInt32, ack: UInt32, flags: UInt8, payload: [UInt8]) -> [UInt8] {
        func be32(_ v: UInt32) -> [UInt8] { [UInt8(v >> 24), UInt8(v >> 16 & 0xff), UInt8(v >> 8 & 0xff), UInt8(v & 0xff)] }
        var t: [UInt8] = [UInt8(sport >> 8), UInt8(sport & 0xff), UInt8(dport >> 8), UInt8(dport & 0xff)]
        t += be32(seq) + be32(ack) + [0x50, flags, 0xff, 0xff, 0, 0, 0, 0] + payload
        let c = checksum(pseudo(src, dst, 6, t.count) + t)
        t[16] = UInt8(c >> 8); t[17] = UInt8(c & 0xff)
        return ipv4(src: src, dst: dst, proto: 6, body: t)
    }
}
