import Foundation

/*
 * The app's text: the desktop's strings (locales/<language>.json, 31 languages), made
 * into Localization/<language>.lproj/Localizable.strings by
 * scripts/gen-strings.js, which takes every key the Swift sources pass to tr().
 * Placeholders stay {name} and are filled in from args. The language is the
 * system's, or the one chosen for Shroudly alone in the system's settings.
 */
func tr(_ key: String, _ args: [String: String] = [:], bundle: Bundle = .main) -> String {
    var s = bundle.localizedString(forKey: key, value: nil, table: "Localizable")
    for (name, value) in args {
        s = s.replacingOccurrences(of: "{\(name)}", with: value)
    }
    return s
}
