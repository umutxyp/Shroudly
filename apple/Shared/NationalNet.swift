import Foundation

/*
 * "Only this country's network works": the connection to the rest of the
 * world cut while sites inside the country still open, as in Iran's
 * shutdowns. Asked only while protection is on and the world's control
 * addresses (1.1.1.1, 8.8.8.8, 9.9.9.9, their own certificates checked) all
 * fail: then large sites hosted inside their own countries, all at once. One
 * that answers with its own valid certificate says the country's network is
 * up; a sign-in page (a hotel's, a cafe's) cannot show a site's certificate,
 * so it is not taken for one. The same sites as the desktop
 * (electron/national-net.js) and Android (NationalNet.kt).
 */
enum NationalNet {
    static let domestic: KeyValuePairs<String, [String]> = [
        "IR": ["www.digikala.com", "www.aparat.com", "divar.ir", "www.zoomit.ir", "www.shaparak.ir"],
        "RU": ["ya.ru", "vk.com", "www.gosuslugi.ru"],
        "BY": ["www.belta.by", "onliner.by"],
        "KZ": ["egov.kz", "kaspi.kz"],
        "UZ": ["my.gov.uz", "kun.uz"],
        "TM": ["turkmenportal.com"],
        "AZ": ["www.azertag.az"],
        "CN": ["www.baidu.com", "www.qq.com"],
        "TR": ["www.turkiye.gov.tr"],
        "PK": ["www.ptcl.com.pk"],
        "IQ": ["www.ina.iq"],
        "ET": ["www.ethiotelecom.et"],
        "MM": ["www.mpt.com.mm"],
    ]

    static let control = ["1.1.1.1", "8.8.8.8", "9.9.9.9"]

    /* The guide in the app's language (Shutdowns-<code> in the wiki). */
    static func guideURL(language: String) -> URL {
        let code = language.lowercased().split(whereSeparator: { $0 == "-" || $0 == "_" }).first.map(String.init) ?? "en"
        let known: Set<String> = ["am", "ar", "az", "be", "bn", "de", "en", "es", "fa", "fr", "he", "hi", "id", "ja", "kk", "ku", "ky",
                                  "ms", "my", "ps", "pt", "ru", "tg", "th", "tk", "tr", "uk", "ur", "uz", "vi", "zh"]
        let c = code == "iw" ? "he" : code == "in" ? "id" : code
        return URL(string: "https://github.com/umutxyp/Shroudly/wiki/Shutdowns-\(known.contains(c) ? c : "en")")!
    }

    /* Whether https://host/ answers at all, its certificate checked. */
    static func answers(_ host: String, timeout: TimeInterval = 5, session: URLSession = .shared) async -> Bool {
        guard let url = URL(string: "https://\(host)/") else { return false }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: timeout)
        req.httpMethod = "HEAD"
        do {
            _ = try await session.data(for: req)
            return true
        } catch {
            return false
        }
    }

    /* The country whose own network answers while the world does not, or
     * nil (the world answers, or nothing does). `reach` stands in for the
     * network in tests. */
    static func check(reach: @escaping (String) async -> Bool = { await answers($0) }) async -> String? {
        let world = await withTaskGroup(of: Bool.self) { g -> Bool in
            for a in control { g.addTask { await reach(a) } }
            for await ok in g where ok { g.cancelAll(); return true }
            return false
        }
        if world { return nil }
        return await withTaskGroup(of: String?.self) { g -> String? in
            for (cc, hosts) in domestic { for h in hosts { g.addTask { await reach(h) ? cc : nil } } }
            for await cc in g where cc != nil { g.cancelAll(); return cc }
            return nil
        }
    }
}
