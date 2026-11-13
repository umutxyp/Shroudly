import XCTest

final class StoreFlagsTests: XCTestCase {
    private let json = Data(#"{ "play": { "live": true }, "appStore": { "live": false }, "macAppStore": { "live": true } }"#.utf8)

    func testReadsEachStore() {
        XCTAssertTrue(StoreFlags.live(in: json, store: "play"))
        XCTAssertFalse(StoreFlags.live(in: json, store: "appStore"))
        XCTAssertTrue(StoreFlags.live(in: json, store: "macAppStore"))
    }

    func testAnythingElseIsNotLive() {
        XCTAssertFalse(StoreFlags.live(in: json, store: "elsewhere"))
        XCTAssertFalse(StoreFlags.live(in: Data("not json".utf8), store: "appStore"))
        XCTAssertFalse(StoreFlags.live(in: Data(#"{"appStore": {"live": "true"}}"#.utf8), store: "appStore"))
        XCTAssertFalse(StoreFlags.live(in: Data(#"{"appStore": true}"#.utf8), store: "appStore"))
        XCTAssertFalse(StoreFlags.live(in: Data(#"[1, 2]"#.utf8), store: "appStore"))
    }

    func testThisCopysStore() {
        #if os(macOS)
        XCTAssertEqual(StoreFlags.storeKey, "macAppStore")
        #else
        XCTAssertEqual(StoreFlags.storeKey, "appStore")
        #endif
        XCTAssertEqual(StoreFlags.url.absoluteString, "https://raw.githubusercontent.com/umutxyp/Shroudly/main/stores.json")
    }

    func testTheRepositorysFileHasTheAgreedShape() throws {
        // stores.json at the repository's root, as the app reads it from main.
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../stores.json")
        guard let data = try? Data(contentsOf: url) else { throw XCTSkip("the repository is not reachable from here") }
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        for store in ["play", "appStore", "macAppStore"] {
            let entry = try XCTUnwrap(obj[store] as? [String: Any], store)
            XCTAssertNotNil(entry["live"] as? Bool, store)
        }
    }

    private final class Clock {
        var now = Date(timeIntervalSince1970: 1_800_000_000)
    }

    private func cache(_ defaults: UserDefaults, _ clock: Clock, fetches: @escaping () throws -> Data) -> StoreFlagCache {
        StoreFlagCache(defaults: defaults, store: "appStore", now: { clock.now }) { url, timeout in
            XCTAssertEqual(url, StoreFlags.url)
            XCTAssertLessThanOrEqual(timeout, 10)
            return try fetches()
        }
    }

    func testCachesAnswersAndRetriesFailures() async {
        let suite = "me.codeshare.shroudly.tests.flags"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        defer { defaults.removePersistentDomain(forName: suite) }
        let clock = Clock()
        var calls = 0
        var answer: Data? = Data(#"{"appStore": {"live": true}}"#.utf8)
        let c = cache(defaults, clock) {
            calls += 1
            guard let a = answer else { throw URLError(.timedOut) }
            return a
        }

        let first = await c.isLive()
        XCTAssertTrue(first)
        XCTAssertEqual(calls, 1)
        // Within the cache's time: not asked again, even when it would fail.
        answer = nil
        clock.now.addTimeInterval(StoreFlags.cacheSeconds - 60)
        let cached = await c.isLive()
        XCTAssertTrue(cached)
        XCTAssertEqual(calls, 1)
        // Past it: asked again; a failure is not live, and not kept.
        clock.now.addTimeInterval(120)
        let failed = await c.isLive()
        XCTAssertFalse(failed)
        XCTAssertEqual(calls, 2)
        answer = Data(#"{"appStore": {"live": false}}"#.utf8)
        let notLive = await c.isLive()
        XCTAssertFalse(notLive)
        XCTAssertEqual(calls, 3)
        // A clock set back does not keep an old answer forever.
        clock.now.addTimeInterval(-StoreFlags.cacheSeconds * 10)
        answer = Data(#"{"appStore": {"live": true}}"#.utf8)
        let afterClockChange = await c.isLive()
        XCTAssertTrue(afterClockChange)
        XCTAssertEqual(calls, 4)
    }

    // The App Store copy's required update and the App Store offered to other copies (StoreUpdate).
    func testStoreUpdateSourceFromTheReceipt() {
        XCTAssertEqual(StoreUpdate.source(receiptName: "receipt", receiptExists: true), .appStore)
        XCTAssertEqual(StoreUpdate.source(receiptName: "sandboxReceipt", receiptExists: true), .testing)
        XCTAssertEqual(StoreUpdate.source(receiptName: "receipt", receiptExists: false), .other)
        XCTAssertEqual(StoreUpdate.source(receiptName: nil, receiptExists: false), .other)
    }

    func testStoreUpdateComparesVersionsByNumber() {
        XCTAssertTrue(StoreUpdate.newer("2.6.76", than: "2.6.75"))
        XCTAssertTrue(StoreUpdate.newer("2.6.100", than: "2.6.99"))
        XCTAssertTrue(StoreUpdate.newer("2.7", than: "2.6.99"))
        XCTAssertFalse(StoreUpdate.newer("2.6.75", than: "2.6.75"))
        XCTAssertFalse(StoreUpdate.newer("2.6.61", than: "2.6.76"))
        XCTAssertFalse(StoreUpdate.newer("2.6", than: "2.6.0"))
    }

    func testStoreUpdateReadsTheLookup() {
        let ok = Data(#"{"resultCount":1,"results":[{"version":"2.6.76","trackId":6830329471}]}"#.utf8)
        XCTAssertEqual(StoreUpdate.version(inLookup: ok), "2.6.76")
        XCTAssertNil(StoreUpdate.version(inLookup: Data(#"{"resultCount":0,"results":[]}"#.utf8)))
        XCTAssertNil(StoreUpdate.version(inLookup: Data("<html>".utf8)))
    }

    func testStoreUpdateAsksEachTimeButNotAtOnceAndOffersTheStoreLessOften() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        XCTAssertTrue(StoreUpdate.due(nil, now: now, every: StoreUpdate.askEvery))
        XCTAssertFalse(StoreUpdate.due(now.addingTimeInterval(-60), now: now, every: StoreUpdate.askEvery))
        XCTAssertTrue(StoreUpdate.due(now.addingTimeInterval(-121), now: now, every: StoreUpdate.askEvery))
        XCTAssertTrue(StoreUpdate.due(now.addingTimeInterval(3600), now: now, every: StoreUpdate.askEvery))
        XCTAssertEqual([1, 2, 3].map { StoreUpdate.moveWaitDays(afterNoes: $0) }, [14, 28, 56])
        XCTAssertEqual(StoreUpdate.moveWaitDays(afterNoes: 0), 0)
    }
}
