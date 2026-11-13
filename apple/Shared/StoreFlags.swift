import Foundation

/*
 * Whether this copy is live on its store, from stores.json at the root of
 * the repository's main branch:
 *
 *   { "play": { "live": true }, "appStore": { "live": false }, "macAppStore": { "live": false } }
 *
 * The app asks for a rating only once its store page is live (RatingSchedule):
 * before that, a review build or one waiting for release would ask in vain.
 * The answer is kept for cacheSeconds; a fetch that fails, times out or
 * gives anything else counts as not live, and is tried again next time.
 */
enum StoreFlags {
    static let url = URL(string: "https://raw.githubusercontent.com/umutxyp/Shroudly/main/stores.json")!
    static let timeout: TimeInterval = 5
    static let cacheSeconds: TimeInterval = 12 * 3600

    /* This copy's store: the App Store on iPhone and iPad, the Mac App Store on a Mac. */
    static var storeKey: String {
        #if os(macOS)
        return "macAppStore"
        #else
        return "appStore"
        #endif
    }

    /* stores.json's word on one store: live only when it says exactly true. */
    static func live(in data: Data, store: String) -> Bool {
        guard let all = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let entry = all[store] as? [String: Any],
              let live = entry["live"] as? Bool else { return false }
        return live
    }
}

final class StoreFlagCache {
    typealias Fetch = (URL, TimeInterval) async throws -> Data

    private enum Key {
        static let live = "storeLive"
        static let at = "storeLiveAt"
    }

    private let defaults: UserDefaults
    private let fetch: Fetch
    private let now: () -> Date
    private let store: String

    init(defaults: UserDefaults = AppGroup.defaults, store: String = StoreFlags.storeKey,
         now: @escaping () -> Date = Date.init, fetch: @escaping Fetch = StoreFlagCache.download) {
        self.defaults = defaults
        self.store = store
        self.now = now
        self.fetch = fetch
    }

    func isLive() async -> Bool {
        let t = now()
        if let at = defaults.object(forKey: Key.at) as? Date,
           at <= t, t.timeIntervalSince(at) < StoreFlags.cacheSeconds {
            return defaults.bool(forKey: Key.live)
        }
        guard let data = try? await fetch(StoreFlags.url, StoreFlags.timeout) else { return false }
        let live = StoreFlags.live(in: data, store: store)
        defaults.set(live, forKey: Key.live)
        defaults.set(t, forKey: Key.at)
        return live
    }

    /* A plain GET with no cookies, cache or credentials; anything but a 200 fails. */
    static func download(_ url: URL, _ timeout: TimeInterval) async throws -> Data {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = timeout
        config.timeoutIntervalForResource = timeout
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        let session = URLSession(configuration: config)
        defer { session.finishTasksAndInvalidate() }
        let (data, response) = try await session.data(from: url)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
        return data
    }
}

/*
 * The App Store copy and its updates (the owner's word, 2026-11-13), as on
 * Android: a copy the App Store installed is asked to update as soon as the
 * store has a newer version, each time the window comes to the front
 * (askEvery apart at the least, so a "later" still reaches the window), with
 * protection left on: on a censored network the update itself may need
 * Shroudly. Any other copy on iPhone and iPad (an .ipa through TrollStore or
 * a developer account) is offered the App Store, never pushed: some devices
 * cannot reach it. A "not now" waits moveFirstWaitDays, then twice as long
 * each time. Nothing while stores.json says the listing is not live; never
 * on Apple TV. Pure, for the tests; StoreUpdateCheck (App) does the asking.
 */
enum StoreUpdate {
    enum Source: Equatable { case appStore, testing, other }

    static let pageURL = URL(string: "https://apps.apple.com/app/id6830329471")!
    #if os(macOS)
    static let lookupURL = URL(string: "https://itunes.apple.com/lookup?bundleId=me.codeshare.shroudly&entity=macSoftware")!
    #else
    static let lookupURL = URL(string: "https://itunes.apple.com/lookup?bundleId=me.codeshare.shroudly")!
    #endif
    static let askEvery: TimeInterval = 120
    static let checkEvery: TimeInterval = 3600
    static let moveFirstWaitDays = 14

    /* The copy's source from its receipt's file name: the App Store's is
     * "receipt", TestFlight's "sandboxReceipt"; none at all for an .ipa put
     * on the device another way. */
    static func source(receiptName: String?, receiptExists: Bool) -> Source {
        guard receiptExists, let n = receiptName else { return .other }
        return n == "sandboxReceipt" ? .testing : .appStore
    }

    /* "2.6.76" newer than "2.6.75"; numbers compared one by one, missing ones 0. */
    static func newer(_ a: String, than b: String) -> Bool {
        let x = a.split(separator: ".").map { Int($0) ?? 0 }, y = b.split(separator: ".").map { Int($0) ?? 0 }
        for i in 0..<max(x.count, y.count) {
            let p = i < x.count ? x[i] : 0, q = i < y.count ? y[i] : 0
            if p != q { return p > q }
        }
        return false
    }

    /* The App Store's version in an iTunes lookup answer; nil when it has none. */
    static func version(inLookup data: Data) -> String? {
        guard let all = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let results = all["results"] as? [[String: Any]],
              let v = results.first?["version"] as? String, !v.isEmpty else { return nil }
        return v
    }

    /* Days to wait after the n-th "not now" (n >= 1): 14, 28, 56... */
    static func moveWaitDays(afterNoes n: Int) -> Int {
        guard n >= 1 else { return 0 }
        return moveFirstWaitDays << min(n - 1, 16)
    }

    /* Due again: never done, long enough ago, or a time in the future (the clock set back). */
    static func due(_ last: Date?, now: Date, every: TimeInterval) -> Bool {
        guard let last else { return true }
        return last > now || now.timeIntervalSince(last) >= every
    }
}
