import Foundation

/*
 * "Help people in censored countries" (About): a device helps best through
 * an app made for it, which keeps running on its own: Psiphon's Conduit, on
 * iPhone, iPad and Mac. Its page in the app's language where Conduit's site
 * has it (the Android app's HelpOthers.kt; Android also names Orbot's
 * Kindness Mode).
 */
enum HelpOthers {
    /* The languages of conduit.psiphon.ca that this app speaks too. */
    static let conduitLanguages: Set<String> = ["ar", "az", "de", "en", "es", "fa", "fr", "hi", "id", "ms", "my", "pt", "ru", "tr", "vi"]

    static func conduitURL(language: String) -> URL {
        let code = language.lowercased().split(whereSeparator: { $0 == "-" || $0 == "_" }).first.map(String.init) ?? "en"
        return URL(string: "https://conduit.psiphon.ca/\(conduitLanguages.contains(code) ? code : "en")/download")!
    }
}
