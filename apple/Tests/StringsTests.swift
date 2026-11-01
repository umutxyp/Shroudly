import XCTest

/* The strings scripts/gen-strings.js made from locales/<language>.json, as they are
 * in the built bundle: every language there, with the same keys and the same
 * placeholders as English, and tr() filling them in. That the files match
 * locales/<language>.json is gen-strings.js --check's part (CI). */
final class StringsTests: XCTestCase {
    private let bundle = Bundle(for: StringsTests.self)
    private let languages = ["en", "am", "ar", "az", "be", "bn", "de", "es", "fa", "fr", "he", "hi", "id", "ja", "kk", "ku",
                             "ky", "ms", "my", "ps", "pt-BR", "ru", "tg", "th", "tk", "tr", "uk", "ur", "uz", "vi", "zh-Hans"]

    private func table(_ lang: String, _ name: String = "Localizable") throws -> [String: String] {
        let path = try XCTUnwrap(bundle.path(forResource: name, ofType: "strings", inDirectory: nil, forLocalization: lang),
                                 "\(lang): no \(name).strings")
        return try XCTUnwrap(NSDictionary(contentsOfFile: path) as? [String: String], "\(lang): unreadable")
    }

    private func placeholders(_ s: String) -> Set<String> {
        let re = try! NSRegularExpression(pattern: "\\{(\\w+)\\}")
        return Set(re.matches(in: s, range: NSRange(s.startIndex..., in: s)).map { (s as NSString).substring(with: $0.range(at: 1)) })
    }

    func testEveryLanguageIsThere() {
        XCTAssertEqual(Set(bundle.localizations.filter { $0 != "Base" }), Set(languages))
    }

    func testSameKeysAndPlaceholdersAsEnglish() throws {
        let en = try table("en")
        XCTAssertGreaterThan(en.count, 30)
        for lang in languages {
            let t = try table(lang)
            XCTAssertEqual(Set(t.keys), Set(en.keys), lang)
            for (k, v) in t {
                XCTAssertFalse(v.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, "\(lang).\(k) is empty")
                XCTAssertEqual(placeholders(v), placeholders(en[k] ?? ""), "\(lang).\(k)")
            }
            let info = try table(lang, "InfoPlist")
            XCTAssertNotNil(info["NSLocalNetworkUsageDescription"], lang)
        }
    }

    func testEveryKeyTheAppUsesIsThere() throws {
        let en = try table("en")
        var used = ["tagline", "protected", "notProtected", "starting", "stopping", "start", "stop", "startFailed",
                    "androidVpnDenied", "androidProtectionLost", "appleVpnRevoked", "navSettings", "navInfo", "strategy",
                    "androidQuicOff", "androidIpv6Off", "appleKeepOn", "appleKeepOnDesc", "language", "languageSystem",
                    "appleLanguageDesc", "appleOpenSettings", "versionLabel", "madeBy", "androidPrivacyPolicy", "androidShareLogs",
                    "appleNoticeTitle", "appleNoticeBody", "appleNoticeContinue"]
        used += Strategies.all.map(\.labelKey)
        for k in used { XCTAssertNotNil(en[k], k) }
    }

    func testTrFillsPlaceholders() throws {
        // One language's folder, whatever this machine's language is.
        let en = try XCTUnwrap(bundle.path(forResource: "en", ofType: "lproj").flatMap(Bundle.init(path:)))
        XCTAssertEqual(tr("versionLabel", ["version": "2.6.44"], bundle: en), "Version 2.6.44")
        XCTAssertEqual(tr("protected", bundle: en), "Protected")
        let trk = try XCTUnwrap(bundle.path(forResource: "tr", ofType: "lproj").flatMap(Bundle.init(path:)))
        XCTAssertEqual(tr("versionLabel", ["version": "2.6.44"], bundle: trk), "Sürüm 2.6.44")
        // A key that is not there comes back as itself rather than as nothing.
        XCTAssertEqual(tr("noSuchKey", bundle: en), "noSuchKey")
    }

    func testRightToLeftLanguagesAreThere() throws {
        for lang in ["ar", "fa", "he", "ur", "ps"] {
            XCTAssertEqual(Locale.Language(identifier: lang).characterDirection, .rightToLeft, lang)
            XCTAssertNotEqual(try table(lang)["protected"], try table("en")["protected"], lang)
        }
    }
}
