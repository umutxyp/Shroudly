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
        // Each list cleared first, so sending it all again is safe.
        let empty = ["BLOCK-CLEAR", "TOR-CLEAR", "ONLY-CLEAR", "ONLY-MODE 0"]
        XCTAssertEqual(Conns.commands(d), empty)
        Conns.set("b.example", blocked: true, d)
        Conns.set("a.example", blocked: true, d)
        XCTAssertEqual(Conns.commands(d), ["BLOCK-CLEAR", "BLOCK a.example", "BLOCK b.example", "TOR-CLEAR", "ONLY-CLEAR", "ONLY-MODE 0"])
        Conns.set("a.example", blocked: false, d)
        XCTAssertEqual(Conns.blocked(d), ["b.example"])
    }

    /* Through Tor (a site that turns the country away) and only listed sites. */
    func testTorSitesAndOnlyListed() {
        let d = UserDefaults(suiteName: "ConnsTests2")!
        d.removePersistentDomain(forName: "ConnsTests2")
        Conns.set("Build.NVIDIA.com.", tor: true, d)
        XCTAssertEqual(Conns.torSites(d), ["build.nvidia.com"])
        XCTAssertEqual(Conns.viaTor("api.build.nvidia.com", Conns.torSites(d)), "build.nvidia.com")
        XCTAssertNil(Conns.viaTor("nvidia.com", Conns.torSites(d)))
        Conns.setOnly(mode: true, text: "https://YouTube.com/watch\nyoutube.com\nnot a site\nx.com", d)
        XCTAssertEqual(Conns.onlySites(d), ["youtube.com", "x.com"])
        XCTAssertEqual(Conns.commands(d), ["BLOCK-CLEAR", "TOR-CLEAR", "TOR build.nvidia.com",
                                           "ONLY-CLEAR", "ONLY youtube.com", "ONLY x.com", "ONLY-MODE 1"])
        Conns.set("build.nvidia.com", tor: false, d)
        XCTAssertEqual(Conns.torSites(d), [])
    }

    func testShroudlysOwnNames() {
        XCTAssertTrue(Conns.isSystem("dns.google"))
        XCTAssertTrue(Conns.isSystem("snowflake-broker.torproject.net"))
        XCTAssertTrue(Conns.isSystem("my.server.example", own: "server.example"))
        XCTAssertFalse(Conns.isSystem("google.com"))
        XCTAssertFalse(Conns.isSystem("notgithub.com"))
    }

    /* Apps always through Tor: kept as ids, given to the engine as their
     * names and ranges after the typed sites, each once. */
    func testAppsThroughTor() {
        let d = UserDefaults(suiteName: "ConnsTests3")!
        d.removePersistentDomain(forName: "ConnsTests3")
        XCTAssertNil(Conns.set(app: "nosuch", tor: true, d))
        XCTAssertEqual(Conns.set(app: "telegram", tor: true, d), ["telegram"])
        Conns.set(app: "instagram", tor: true, d)
        XCTAssertEqual(Conns.torApps(d), ["instagram", "telegram"])
        Conns.set("geo.example", tor: true, d)
        let cmds = Conns.commands(d)
        XCTAssertTrue(cmds.contains("TOR geo.example") && cmds.contains("TOR instagram.com") && cmds.contains("TOR 149.154.160.0/20"))
        XCTAssertEqual(cmds.filter { $0 == "TOR fbcdn.net" }.count, 1)
        Conns.set(app: "instagram", tor: false, d)
        XCTAssertFalse(Conns.commands(d).contains("TOR instagram.com"))
        XCTAssertEqual(Conns.torApps(d), ["telegram"])
    }
}
