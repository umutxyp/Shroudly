import XCTest

/* "Only this country's network works", your own server in the settings and
 * the engine's arguments, and the pages "Help people" opens. */
final class NationalNetTests: XCTestCase {
    func testOnlyWhenTheWorldDoesNotAnswer() async {
        // The world answers: nothing to say.
        let world = await NationalNet.check { host in host == "8.8.8.8" || host == "www.aparat.com" }
        XCTAssertNil(world)
        // The world cut, a site of Iran's answering: Iran.
        let iran = await NationalNet.check { host in host == "www.aparat.com" }
        XCTAssertEqual(iran, "IR")
        // Nothing answers at all: not a shutdown, no internet.
        let none = await NationalNet.check { _ in false }
        XCTAssertNil(none)
    }

    func testTheDesktopsSites() throws {
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../electron/national-net.js").standardized
        let js = try String(contentsOf: file, encoding: .utf8)
        for (cc, hosts) in NationalNet.domestic {
            let line = "  \(cc): [\(hosts.map { "'\($0)'" }.joined(separator: ", "))],"
            XCTAssertTrue(js.contains(line), "\(cc) as the desktop lists it: \(line)")
        }
        XCTAssertEqual(NationalNet.control, ["1.1.1.1", "8.8.8.8", "9.9.9.9"])
    }

    func testGuidesAndConduitInTheAppsLanguage() {
        XCTAssertEqual(NationalNet.guideURL(language: "fa").absoluteString, "https://github.com/umutxyp/Shroudly/wiki/Shutdowns-fa")
        XCTAssertEqual(NationalNet.guideURL(language: "zh-Hans").absoluteString, "https://github.com/umutxyp/Shroudly/wiki/Shutdowns-zh")
        XCTAssertEqual(NationalNet.guideURL(language: "pt-BR").absoluteString, "https://github.com/umutxyp/Shroudly/wiki/Shutdowns-pt")
        XCTAssertEqual(NationalNet.guideURL(language: "sw").absoluteString, "https://github.com/umutxyp/Shroudly/wiki/Shutdowns-en")
        XCTAssertEqual(HelpOthers.conduitURL(language: "fa").absoluteString, "https://conduit.psiphon.ca/fa/download")
        XCTAssertEqual(HelpOthers.conduitURL(language: "pt-BR").absoluteString, "https://conduit.psiphon.ca/pt/download")
        XCTAssertEqual(HelpOthers.conduitURL(language: "am").absoluteString, "https://conduit.psiphon.ca/en/download")
    }

    func testOwnServerInSettingsAndTheEnginesArguments() {
        let suite = "shroudly-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = SettingsStore(defaults: defaults)
        var s = store.load()
        XCTAssertEqual(s.ownServer, "")
        XCTAssertNil(s.ownServerLink)
        let before = s
        s.ownServer = "socks5://10.0.0.2:1080"
        store.save(s)
        XCTAssertEqual(store.load().ownServer, "socks5://10.0.0.2:1080")
        XCTAssertFalse(before.sameTunnel(as: s), "a new server starts the tunnel again")
        // The engine gets the file; none without a server.
        let a = EngineArgs.make(port: 1, dohPort: 2, settings: s, authFile: nil, blockIps: [], upstreamFile: "/tmp/up")
        XCTAssertEqual(Array(a.suffix(2)), ["--upstream-file", "/tmp/up"])
        XCTAssertFalse(EngineArgs.make(port: 1, dohPort: 2, settings: before, authFile: nil, blockIps: []).contains("--upstream-file"))
        // A link that cannot be used is no server at all.
        s.ownServer = "not a link"
        XCTAssertNil(s.ownServerLink)
    }

    func testTheUpstreamFileIsTheProcesssAlone() throws {
        let path = FileManager.default.temporaryDirectory.appendingPathComponent("up-\(UUID().uuidString)").path
        defer { unlink(path) }
        try OwnServer.writeFile("socks5://u:p@127.0.0.1:9", to: path)
        XCTAssertEqual(try String(contentsOfFile: path, encoding: .utf8), "socks5://u:p@127.0.0.1:9\n")
        let attrs = try FileManager.default.attributesOfItem(atPath: path)
        XCTAssertEqual((attrs[.posixPermissions] as? NSNumber)?.intValue, 0o600)
    }
}
