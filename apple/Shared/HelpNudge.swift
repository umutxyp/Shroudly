import Foundation

/*
 * When the main screen asks whether the user would like to help people in
 * censored countries (its card; "Show me" opens Psiphon's Conduit,
 * HelpOthers), with the desktop's and Android's numbers
 * (components/helpNudge.js, HelpNudge.kt): first after a few days of use,
 * then, after each "Not now", a week later, then two weeks, four, eight:
 * every refusal doubles the wait. Kept in the app's own defaults, so an
 * update keeps where it was.
 *
 * Not asked where Tor itself is blocked (a shutdown seen there, else the time
 * zone): there the user is among the people who need the help, a helper
 * there could not reach the other side anyway, and taking part could put
 * them at risk.
 */
enum HelpNudge {
    static let day: TimeInterval = 24 * 60 * 60
    static let firstDays = 3.0
    static let waitDays = 7.0
    // Past ten refusals the wait stops growing (about twenty years).
    static let maxDoublings = 10
    static let notFrom: Set<String> = ["BY", "CN", "IR", "MM", "RU", "TM"]
    // Those countries' time zones (electron/national-net.js, ZONES).
    static let zones: [String: String] = {
        var z: [String: String] = [:]
        let byCountry: [String: [String]] = [
            "BY": ["Europe/Minsk"],
            "CN": ["Asia/Shanghai", "Asia/Urumqi", "Asia/Chongqing", "Asia/Harbin"],
            "IR": ["Asia/Tehran"],
            "MM": ["Asia/Yangon", "Asia/Rangoon"],
            "RU": ["Europe/Moscow", "Europe/Kaliningrad", "Europe/Samara", "Europe/Volgograd", "Europe/Saratov", "Europe/Ulyanovsk",
                   "Europe/Astrakhan", "Europe/Kirov", "Asia/Yekaterinburg", "Asia/Omsk", "Asia/Novosibirsk", "Asia/Barnaul", "Asia/Tomsk",
                   "Asia/Novokuznetsk", "Asia/Krasnoyarsk", "Asia/Irkutsk", "Asia/Chita", "Asia/Yakutsk", "Asia/Khandyga", "Asia/Vladivostok",
                   "Asia/Ust-Nera", "Asia/Magadan", "Asia/Sakhalin", "Asia/Srednekolymsk", "Asia/Kamchatka", "Asia/Anadyr"],
            "TM": ["Asia/Ashgabat"],
        ]
        for (country, list) in byCountry { for zone in list { z[zone] = country } }
        return z
    }()

    struct State: Equatable {
        var first: TimeInterval
        var next: TimeInterval
        var refusals: Int
        var accepted: TimeInterval = 0
    }

    static func begin(_ state: State?, now: TimeInterval) -> State {
        state ?? State(first: now, next: now + firstDays * day, refusals: 0)
    }

    static func isDue(_ state: State?, now: TimeInterval, country: String?) -> Bool {
        guard let state else { return false }
        if let country, notFrom.contains(country.uppercased()) { return false }
        return now >= state.next
    }

    private static func wait(_ n: Int) -> TimeInterval {
        waitDays * day * pow(2, Double(min(max(n, 0), maxDoublings)))
    }

    /* "Not now": a week after the first, twice as long after each next one. */
    static func refuse(_ s: State, now: TimeInterval) -> State {
        var n = s
        n.refusals += 1
        n.next = now + wait(n.refusals - 1)
        return n
    }

    /* "Show me": asked again only once the next wait is over. */
    static func accept(_ s: State, now: TimeInterval) -> State {
        var n = s
        n.accepted = now
        n.next = now + wait(s.refusals)
        return n
    }

    /* Where the user is, as far as the app can tell: a shutdown seen there
     * (NetworkWatch keeps it), else the time zone's country among those above. */
    static func country(remembered: String?, zone: String = TimeZone.current.identifier) -> String? {
        remembered ?? zones[zone]
    }

    private enum Key {
        static let first = "helpNudgeFirst"
        static let next = "helpNudgeNext"
        static let refusals = "helpNudgeRefusals"
        static let accepted = "helpNudgeAccepted"
    }

    static let homeCountryKey = "homeCountry"

    static func load(_ d: UserDefaults = .standard) -> State? {
        guard d.object(forKey: Key.next) != nil else { return nil }
        return State(first: d.double(forKey: Key.first), next: d.double(forKey: Key.next),
                     refusals: d.integer(forKey: Key.refusals), accepted: d.double(forKey: Key.accepted))
    }

    static func save(_ s: State, _ d: UserDefaults = .standard) {
        d.set(s.first, forKey: Key.first)
        d.set(s.next, forKey: Key.next)
        d.set(s.refusals, forKey: Key.refusals)
        d.set(s.accepted, forKey: Key.accepted)
    }

    /* Due now, for this user; the first look starts the count. */
    static func due(_ d: UserDefaults = .standard, now: TimeInterval = Date().timeIntervalSince1970) -> Bool {
        let kept = load(d)
        let s = begin(kept, now: now)
        if kept == nil { save(s, d) }
        return isDue(s, now: now, country: country(remembered: d.string(forKey: homeCountryKey)))
    }

    static func refused(_ d: UserDefaults = .standard, now: TimeInterval = Date().timeIntervalSince1970) {
        save(refuse(begin(load(d), now: now), now: now), d)
    }

    static func accepted(_ d: UserDefaults = .standard, now: TimeInterval = Date().timeIntervalSince1970) {
        save(accept(begin(load(d), now: now), now: now), d)
    }
}
