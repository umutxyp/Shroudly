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
