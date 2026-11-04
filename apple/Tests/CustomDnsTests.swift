import XCTest

/* "DNS server" (Shared/CustomDns.swift): what is typed, read as Android and
 * the desktop read it, and each kind asked for real. */
final class CustomDnsTests: XCTestCase {
    func testParse() {
        XCTAssertEqual(CustomDns.parse("doh", "https://dns.google/dns-query").spec, DnsSpec(kind: "doh", host: "dns.google", port: 443, path: "/dns-query"))
        XCTAssertEqual(CustomDns.parse("doh", "dns.nextdns.io/abc123").spec?.path, "/abc123")
        XCTAssertEqual(CustomDns.parse("doh", "https://1.1.1.1").spec?.path, "/dns-query")
        XCTAssertEqual(CustomDns.parse("doh", "http://dns.google/dns-query").error, "url")
        XCTAssertEqual(CustomDns.parse("dot", "tls://dns.quad9.net").spec, DnsSpec(kind: "dot", host: "dns.quad9.net", port: 853))
        XCTAssertEqual(CustomDns.parse("tcp", "8.8.8.8:5353").spec?.port, 5353)
        XCTAssertEqual(CustomDns.parse("udp", "[2606:4700:4700::1111]:53").spec?.host, "2606:4700:4700::1111")
        XCTAssertEqual(CustomDns.parse("udp", "300.1.1.1").error, "host")
        XCTAssertEqual(CustomDns.parse("udp", "1.1.1.1:99999").error, "port")
        XCTAssertEqual(CustomDns.parse("tcp", "  ").error, "empty")
        XCTAssertEqual(CustomDns.parse("tcp", "https://x.example").error, "url")
    }

    private func ask(_ kind: String, _ text: String, engine: EngineHTTPS.Path? = nil) async throws -> [String] {
        let spec = try XCTUnwrap(CustomDns.parse(kind, text).spec)
        let c = CustomDnsClient(spec, bootstrap: { name in
            // As the tunnel does: the server's own name through a resolver by address.
            let b = CustomDnsClient(DnsSpec(kind: "udp", host: "1.1.1.1", port: 53), bootstrap: { _ in nil })
            return Dns.addressesV4((try? await b.query(Dns.query(name, type: 1, id: 7))) ?? []).first
        }, engine: { engine })
        let a = try await c.query(Dns.query("example.com", type: 1, id: 4242))
        XCTAssertEqual(a[0], 0x10); XCTAssertEqual(a[1], 0x92, "under the query's id")
        return Dns.addressesV4(a)
    }

    func testEachKindAnswers() async throws {
        for (k, t) in [("doh", "https://dns.google/dns-query"), ("dot", "dns.quad9.net"), ("tcp", "8.8.8.8"), ("udp", "1.1.1.1")] {
            let got = try await ask(k, t)
            XCTAssertFalse(got.isEmpty, "\(k) \(t)")
        }
    }

    func testDohThroughTheEngine() async throws {
        let e = try TestEngine()
        defer { e.engine.stop() }
        let got = try await ask("doh", "https://cloudflare-dns.com/dns-query", engine: EngineHTTPS.Path(port: e.port, user: e.auth.user, pass: e.auth.pass))
        XCTAssertFalse(got.isEmpty)
    }
}
