import XCTest

final class DnsTests: XCTestCase {
    func testQueryIsAQuery() {
        let q = Dns.query("Example.COM")
        XCTAssertTrue(Dns.isQuery(q))
        XCTAssertEqual(Dns.question(q)?.name, "example.com")
        XCTAssertEqual(Dns.question(q)?.type, 1)
        XCTAssertEqual(Dns.questionEnd(q), q.count)
        XCTAssertFalse(Dns.isQuery(Array(q.prefix(15))))
        var r = q
        r[2] |= 0x80
        XCTAssertFalse(Dns.isQuery(r), "a response is not a query")
    }

    func testNoRouteIsTheForwardersRefusal() throws {
        let q = Dns.query("example.com", id: 0xabcd)
        let r = try XCTUnwrap(Dns.noRouteReply(q))
        XCTAssertEqual(Array(r[0..<2]), [0xab, 0xcd])
        XCTAssertEqual(r[2] & 0x80, 0x80, "a response")
        XCTAssertEqual(r[3] & 0x0f, 5, "REFUSED")
        XCTAssertEqual(Array(r[4..<12]), [0, 1, 0, 0, 0, 0, 0, 1])
        // The OPT record with the option core/src/doh.h looks for (65001).
        let opt = Array(r[q.count...])
        XCTAssertEqual(opt, [0, 0, 41, 0x04, 0xd0, 0, 0, 0, 0, 0, 4, 0xfd, 0xe9, 0, 0])
        XCTAssertNil(Dns.noRouteReply([1, 2, 3]))
    }

    func testMatchAnswer() throws {
        let q = Dns.query("example.com", id: 0x0102)
        // The resolver's answer, with ID 0 (RFC 8484) and the name in other case.
        var a = Dns.query("EXAMPLE.com", id: 0)
        a[2] = 0x81; a[3] = 0x80
        a[7] = 1
        a += [0xc0, 12, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 93, 184, 215, 14]
        let m = try XCTUnwrap(Dns.matchAnswer(query: q, answer: a))
        XCTAssertEqual(Array(m[0..<2]), [0x01, 0x02])
        XCTAssertEqual(Dns.addressesV4(m), ["93.184.215.14"])
        XCTAssertNil(Dns.matchAnswer(query: q, answer: Dns.query("example.org")), "another question")
        XCTAssertNil(Dns.matchAnswer(query: q, answer: q), "not a response")
    }
}
