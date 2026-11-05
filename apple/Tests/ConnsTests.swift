import XCTest

/* The Connections list (Shared/Conns.swift, issue #74): the engine's rows
 * read, names cleaned, blocks kept in the app group's settings and turned
 * into the engine's commands, Shroudly's own names known; and the engine
 * itself listing by name and refusing a blocked one. */
final class ConnsTests: XCTestCase {
    func testRowsRead() {
        let r = ConnRow(["host": "a.example", "active": 2, "conns": 5, "up": 10, "down": 20, "route": "tor", "blocked": 0, "refused": 0])
        XCTAssertEqual(r?.host, "a.example"); XCTAssertEqual(r?.active, 2); XCTAssertEqual(r?.down, 20); XCTAssertEqual(r?.route, "tor")
        XCTAssertNil(ConnRow(["active": 1]), "no name, no row")
    }

    func testNamesAndBlocks() {
        XCTAssertEqual(Conns.clean(" Tracker.Example. "), "tracker.example")
        XCTAssertNil(Conns.clean("bad name;"))
        let d = UserDefaults(suiteName: "ConnsTests")!
        d.removePersistentDomain(forName: "ConnsTests")
        XCTAssertEqual(Conns.commands(d), ["BLOCK-CLEAR"])
        Conns.set("b.example", blocked: true, d)
        Conns.set("a.example", blocked: true, d)
        XCTAssertEqual(Conns.commands(d), ["BLOCK-CLEAR", "BLOCK a.example", "BLOCK b.example"])
        Conns.set("a.example", blocked: false, d)
        XCTAssertEqual(Conns.blocked(d), ["b.example"])
    }

    func testShroudlysOwnNames() {
        XCTAssertTrue(Conns.isSystem("dns.google"))
        XCTAssertTrue(Conns.isSystem("snowflake-broker.torproject.net"))
        XCTAssertTrue(Conns.isSystem("my.server.example", own: "server.example"))
        XCTAssertFalse(Conns.isSystem("google.com"))
        XCTAssertFalse(Conns.isSystem("notgithub.com"))
    }
}
