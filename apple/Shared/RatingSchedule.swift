import Foundation

/*
 * When Shroudly may ask for a rating, with Apple's own prompt only
 * (StoreKit's requestReview; a prompt of our own is against App Store
 * guideline 5.6.1). The system shows it at most three times a year and may
 * show nothing at all; this decides when it is worth asking:
 *  - the copy is live on the App Store (the remote flag, StoreFlags), so a
 *    rating can be given at all;
 *  - Shroudly has been installed for minInstalledDays, and protection has
 *    come on successfully on minGoodDays different days: it has worked for
 *    this user, more than once;
 *  - protection is on and working right now: a good moment, never right
 *    after a failure;
 *  - not asked before in this run of the app, and the back-off is over:
 *    after the first request firstWaitDays, after each further one twice as
 *    long as the time before (14, 28, 56, 112... days).
 */
struct RatingState: Codable, Equatable {
    /* The first launch. */
    var installedAt: Date?
    /* Local days (yyyy-MM-dd) protection came on successfully, most recent
     * last; only the last few are kept. */
    var goodDays: [String] = []
    /* Requests made so far, and the last one. */
    var requests = 0
    var lastRequestAt: Date?
}

enum RatingSchedule {
    static let minInstalledDays = 3
    static let minGoodDays = 3
    static let firstWaitDays = 14
    static let keptDays = 10

    /* Days to wait after the n-th request (n >= 1): 14, 28, 56, 112... */
    static func waitDays(afterRequests n: Int) -> Int {
        guard n >= 1 else { return 0 }
        return firstWaitDays << min(n - 1, 16)
    }

    /* The earliest time the next request may be made, by the back-off alone. */
    static func nextAllowed(_ s: RatingState) -> Date? {
        guard s.requests > 0, let last = s.lastRequestAt else { return nil }
        return last.addingTimeInterval(TimeInterval(waitDays(afterRequests: s.requests)) * 86400)
    }

    static func shouldAsk(_ s: RatingState, now: Date, protectionWorking: Bool, storeLive: Bool,
                          askedThisSession: Bool) -> Bool {
        guard storeLive, protectionWorking, !askedThisSession else { return false }
        guard let installed = s.installedAt,
              now.timeIntervalSince(installed) >= TimeInterval(minInstalledDays) * 86400 else { return false }
        guard Set(s.goodDays).count >= minGoodDays else { return false }
        if let next = nextAllowed(s), now < next { return false }
        return true
    }

    static func day(_ date: Date, calendar: Calendar = .current) -> String {
        let c = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    /* Protection came on successfully at `date`. */
    static func recordGoodStart(_ s: inout RatingState, at date: Date, calendar: Calendar = .current) {
        let d = day(date, calendar: calendar)
        guard !s.goodDays.contains(d) else { return }
        s.goodDays.append(d)
        if s.goodDays.count > keptDays { s.goodDays.removeFirst(s.goodDays.count - keptDays) }
    }

    static func recordRequest(_ s: inout RatingState, at date: Date) {
        s.requests += 1
        s.lastRequestAt = date
    }
}

/* The schedule's state in the app group's defaults: the tunnel records the
 * good starts, the app the rest. */
final class RatingStore {
    private static let key = "ratingState"
    private let defaults: UserDefaults

    init(defaults: UserDefaults = AppGroup.defaults) {
        self.defaults = defaults
    }

    func load() -> RatingState {
        guard let data = defaults.data(forKey: Self.key),
              let s = try? JSONDecoder().decode(RatingState.self, from: data) else { return RatingState() }
        return s
    }

    func update(_ change: (inout RatingState) -> Void) {
        var s = load()
        change(&s)
        if let data = try? JSONEncoder().encode(s) { defaults.set(data, forKey: Self.key) }
    }

    /* The first launch is remembered once. */
    func noteLaunch(now: Date = Date()) {
        if load().installedAt == nil { update { $0.installedAt = now } }
    }
}
