import XCTest

/* The last way out (Tunnel/TorRoute.swift): the bridges taken from the Tor
 * Project's bundle, Snowflake's rendezvous read off its line, and the engine
 * told only when nothing else carries everything already. */
final class TorRouteTests: XCTestCase {
    func testBridgesWellFormedLinesOnly() {
        let json = #"{"bridges":{"snowflake":["snowflake 192.0.2.3:80 2B28 url=https://x.example/ fronts=a.example,b.example ice=stun:s.example:3478","bad\nline"],"meek":["meek_lite 192.0.2.20:80 url=https://m.example front=f.example"],"evil":["x y"]}}"#
        let b = TorRoute.bridgesOf(Data(json.utf8))
        XCTAssertEqual(Set(b.keys), ["snowflake", "meek"])
        XCTAssertEqual(b["snowflake"]?.count, 1)
        XCTAssertEqual(TorRoute.param(b["snowflake"]![0], "url"), "https://x.example/")
        XCTAssertEqual(TorRoute.param(b["snowflake"]![0], "fronts"), "a.example,b.example")
        XCTAssertEqual(TorRoute.param(b["snowflake"]![0], "ice"), "stun:s.example:3478")
        XCTAssertNil(TorRoute.param(b["snowflake"]![0], "missing"))
    }

    func testTheBundlesListIsInTheTunnel() throws {
        // Fetched with the libraries (apple/scripts/fetch-tor.js); a build
        // without it has no last way out, and says so by `available`.
        guard let url = Bundle(for: Self.self).url(forResource: "tor-bridges", withExtension: "json")
                ?? Bundle.main.url(forResource: "tor-bridges", withExtension: "json") else { throw XCTSkip("no tor-bridges.json in this build") }
        let b = TorRoute.bridgesOf(try Data(contentsOf: url))
        XCTAssertFalse(b["snowflake"]?.isEmpty ?? true, "the bundle's Snowflake bridges")
    }

    func testEngineToldOnlyWithoutOwnServer() {
        let s = AppSettings()
        XCTAssertTrue(s.torLastResort, "on unless turned off")
        let a = EngineArgs.make(port: 1, dohPort: 2, settings: s, authFile: nil, blockIps: [], fallbackFile: "/tmp/fb")
        XCTAssertEqual(Array(a.suffix(2)), ["--fallback-file", "/tmp/fb"])
        let own = EngineArgs.make(port: 1, dohPort: 2, settings: s, authFile: nil, blockIps: [], upstreamFile: "/tmp/up", fallbackFile: "/tmp/fb")
        XCTAssertFalse(own.contains("--fallback-file"), "the user's own server carries everything")
        XCTAssertTrue(own.contains("--upstream-file"))
    }

    func testSettingKeptAndPartOfTheTunnel() {
        let d = UserDefaults(suiteName: "TorRouteTests")!
        d.removePersistentDomain(forName: "TorRouteTests")
        let store = SettingsStore(defaults: d)
        XCTAssertTrue(store.load().torLastResort)
        var s = store.load()
        s.torLastResort = false
        store.save(s)
        XCTAssertFalse(store.load().torLastResort)
        XCTAssertFalse(s.sameTunnel(as: AppSettings()), "a change restarts the tunnel")
    }

    func testOnlyOnTheMac() {
        #if os(macOS)
        // The libraries are there in a build that fetched them.
        _ = TorRoute.available
        #else
        XCTAssertFalse(TorRoute.available, "an iPhone's or Apple TV's tunnel has no room for Tor")
        #endif
    }

    func testThisCountrysBridgesFirstAndRemembered() {
        // As shroudly.codeshare.me/v1/bridges answers (tests/net/tor-route.test.js, TorRouteTest.kt).
        let json = #"{"country":"ru","bridges":{"webtunnel":["webtunnel [2001:db8::1]:443 FFFF url=https://w.example/x ver=0.0.1","bad\nline"],"obfs4":["obfs4 198.51.100.7:4444 BBBB cert=y iat-mode=0"],"other":["x"]}}"#
        let c = TorRoute.countryBridgesOf(Data(json.utf8))
        XCTAssertNotNil(c)
        let bundled = ["obfs4": ["obfs4 203.0.113.1:443 A cert=x iat-mode=0"], "snowflake": ["snowflake 192.0.2.3:80 X"]]
        let m = TorRoute.mergeBridges(c, bundled)
        XCTAssertEqual(Set(m.keys), ["webtunnel", "obfs4", "snowflake"])
        XCTAssertEqual(m["obfs4"], ["obfs4 198.51.100.7:4444 BBBB cert=y iat-mode=0", "obfs4 203.0.113.1:443 A cert=x iat-mode=0"])
        XCTAssertEqual(m["webtunnel"]?.count, 1, "a line with a newline is dropped")
        let lines = TorRoute.countryLines(m)
        XCTAssertTrue(lines[0].hasPrefix("webtunnel "))
        XCTAssertEqual(lines.last, "snowflake 192.0.2.3:80 X")
        XCTAssertTrue(TorRoute.mergeBridges(nil, [:]).isEmpty)
        XCTAssertNil(TorRoute.countryBridgesOf(Data("<html>".utf8)))

        let d = UserDefaults(suiteName: "TorRouteCountry")!
        d.removePersistentDomain(forName: "TorRouteCountry")
        XCTAssertNil(TorRoute.remembered(d))
        let now = Date()
        TorRoute.remember(c, d, now: now)
        XCTAssertEqual(TorRoute.remembered(d, now: now.addingTimeInterval(60))?["obfs4"], c?["obfs4"])
        XCTAssertNil(TorRoute.remembered(d, now: now.addingTimeInterval(TorRoute.countryKeep + 1)), "not after a day")
        TorRoute.remember(nil, d)
        XCTAssertNil(TorRoute.remembered(d), "forgotten when they no longer get through")
    }
}
