import XCTest

final class SettingsTests: XCTestCase {
    private var defaults: UserDefaults!
    private let suite = "me.codeshare.shroudly.tests.settings"

    override func setUp() {
        defaults = UserDefaults(suiteName: suite)
        defaults.removePersistentDomain(forName: suite)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
    }

    func testDefaultsAreAutomaticWithEverythingOn() {
        let s = SettingsStore(defaults: defaults).load()
        XCTAssertEqual(s, AppSettings())
        XCTAssertEqual(s.strategy.id, "auto")
        XCTAssertTrue(s.strategy.auto)
        // QUIC off by default (2.6.65): over QUIC no technique works.
        XCTAssertTrue(s.quicOff)
        XCTAssertFalse(s.ipv6Off)
        XCTAssertFalse(s.keepOn)
    }

    func testRoundTrip() {
        let store = SettingsStore(defaults: defaults)
        let s = AppSettings(strategyId: "disorder-sni", quicOff: false, ipv6Off: true, keepOn: true)
        store.save(s)
        XCTAssertEqual(store.load(), s)
    }

    /* The old key held false for anyone whose settings were ever saved: that
     * is not a choice, so QUIC goes off; turning it back on is kept. */
    func testQuicOffFromTheOldKeyGoesOn() {
        defaults.set(false, forKey: "quicOff")
        XCTAssertTrue(SettingsStore(defaults: defaults).load().quicOff)
        var s = SettingsStore(defaults: defaults).load()
        s.quicOff = false
        SettingsStore(defaults: defaults).save(s)
        XCTAssertFalse(SettingsStore(defaults: defaults).load().quicOff)
    }

    func testUnknownStrategyIsAutomatic() {
        defaults.set("no-such-technique", forKey: "strategyId")
        XCTAssertEqual(SettingsStore(defaults: defaults).load().strategy.id, "auto")
        XCTAssertEqual(Strategies.byId(nil).id, "auto")
    }

    func testStrategiesAreTheDesktopsInItsOrder() {
        XCTAssertEqual(Strategies.all.map(\.id), ["auto", "split-sni", "disorder-sni", "split-sni-mid", "double-split", "split2", "none"])
        XCTAssertEqual(Strategies.all.filter(\.auto).map(\.id), ["auto"])
        XCTAssertEqual(Strategies.byId("double-split").spec, "split(1),split(sni)")
        XCTAssertEqual(Strategies.byId("none").spec, "none")
    }

    func testKeepOnAloneDoesNotRestartTheTunnel() {
        var a = AppSettings()
        var b = a
        b.keepOn = true
        XCTAssertTrue(a.sameTunnel(as: b))
        b.quicOff = false
        XCTAssertFalse(a.sameTunnel(as: b))
        a.strategyId = "split2"
        XCTAssertFalse(a.sameTunnel(as: AppSettings()))
    }
}
