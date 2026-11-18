import CryptoKit
import XCTest

/* Remote settings: only a signed, understood, newer file; rules by platform,
 * country and version; engine arguments only from the allow-list. The same
 * as electron/remote-config.js and Android's RemoteConfig. */
final class RemoteConfigTests: XCTestCase {
    private let key = P256.Signing.PrivateKey()
    private var pub: String { key.publicKey.derRepresentation.base64EncodedString() }
    private func sign(_ t: String) -> String { (try! key.signature(for: Data(t.utf8))).derRepresentation.base64EncodedString() }

    func testOnlyASignedFileChecks() {
        let f = #"{"v":1,"serial":2,"set":{"quicOff":false}}"#
        XCTAssertTrue(RemoteConfig.verify(f, sig: sign(f), key: pub))
        XCTAssertFalse(RemoteConfig.verify(f + " ", sig: sign(f), key: pub))
        XCTAssertFalse(RemoteConfig.verify(f, sig: sign(f)), "another key: the apps' own")
    }

    func testOnlyNewerFilesAreKept() throws {
        let d = try XCTUnwrap(UserDefaults(suiteName: "remote-test-\(UUID().uuidString)"))
        // Signed with the test's key, not the apps': refused.
        let f = #"{"v":1,"serial":2}"#
        XCTAssertFalse(RemoteConfig.offer(f, sig: sign(f), d))
        XCTAssertEqual(RemoteConfig.serial(d), 0)
    }

    func testEachSourceInTurnUntilOneGivesAUsableFile() async {
        let f3 = #"{"v":1,"serial":3,"set":{"quicOff":true}}"#
        let f1 = #"{"v":1,"serial":1}"#
        XCTAssertEqual(RemoteConfig.worth(f3, sig: sign(f3), inUse: 2, key: pub), .new)
        XCTAssertEqual(RemoteConfig.worth(f3, sig: sign(f3), inUse: 3, key: pub), .same)
        XCTAssertEqual(RemoteConfig.worth(f1, sig: sign(f1), inUse: 3, key: pub), .unusable, "older")
        XCTAssertEqual(RemoteConfig.worth(f3 + " ", sig: sign(f3), inUse: 2, key: pub), .unusable, "signed wrong")
        XCTAssertEqual(RemoteConfig.worth("<html>", sig: sign(f3), inUse: 2, key: pub), .unusable, "a portal's page")

        let take: (String, String) -> RemoteConfig.Take = { RemoteConfig.worth($0, sig: $1, inUse: 2, key: self.pub) }
        var asked: [String] = []
        // The first source's file and signature do not match: the mirror is asked.
        var got = await RemoteConfig.ask(["a", "b"], fetch: { src -> (String, String)? in asked.append(src); return (src == "a" ? f3 + " " : f3, self.sign(f3)) }, take: take)
        XCTAssertEqual(got, .new); XCTAssertEqual(asked, ["a", "b"])
        // A usable one from the first: the mirror is not asked.
        asked = []
        got = await RemoteConfig.ask(["a", "b"], fetch: { src -> (String, String)? in asked.append(src); return (f3, self.sign(f3)) }, take: take)
        XCTAssertEqual(got, .new); XCTAssertEqual(asked, ["a"])
        // Unusable from both; no answer from either.
        got = await RemoteConfig.ask(["a", "b"], fetch: { _ -> (String, String)? in (f1, self.sign(f1)) }, take: take)
        XCTAssertEqual(got, .unusable)
        got = await RemoteConfig.ask(["a", "b"], fetch: { _ -> (String, String)? in nil }, take: take)
        XCTAssertNil(got)

        let now: TimeInterval = 2_000_000_000
        XCTAssertEqual(RemoteConfig.checkedAt(.new, now: now), now)
        XCTAssertEqual(RemoteConfig.checkedAt(.same, now: now), now)
        XCTAssertEqual(RemoteConfig.checkedAt(.unusable, now: now), now - 5 * 3600)
        XCTAssertNil(RemoteConfig.checkedAt(nil, now: now))
    }

    func testRulesAndArguments() {
        let c = RemoteConfig.parse(#"{"v":1,"serial":4,"set":{"reportOffer":"fault"},"rules":[{"when":{"platform":["ios"],"country":["IR"]},"set":{"reportOffer":"always"}},{"when":{"appMin":"2.6.90"},"set":{"reportOffer":"never"}}]}"#)
        XCTAssertEqual(RemoteConfig.reportOffer(RemoteConfig.effective(c, .init(platform: "ios", country: "ir", app: "2.6.81"))), "always")
        XCTAssertEqual(RemoteConfig.reportOffer(RemoteConfig.effective(c, .init(platform: "macos", country: "IR", app: "2.6.81"))), "fault")
        XCTAssertEqual(RemoteConfig.reportOffer(RemoteConfig.effective(c, .init(platform: "macos", country: "TR", app: "2.6.100"))), "never")
        XCTAssertNil(RemoteConfig.parse(#"{"v":1,"serial":3,"expires":"2020-01-01T00:00:00Z"}"#))
        XCTAssertEqual(RemoteConfig.engineArgs(["--strategy", "fake(ttl=4),split(sni)", "--upstream-file", "/x", "--port", "1", "--drop-quic", "--decoy-name", "www.digikala.com", "--decoy-name", "bad name"]),
                       ["--strategy", "fake(ttl=4),split(sni)", "--drop-quic", "--decoy-name", "www.digikala.com"])
        XCTAssertEqual(RemoteConfig.torBridges(["torBridges": ["snowflake": ["snowflake 192.0.2.3:80 ABC", "obfs4 x"], "bad kind!": ["x"]]]), ["snowflake": ["snowflake 192.0.2.3:80 ABC"]])
    }

    func testARestartOnlyWhenWhatTheTunnelUsesChanges() {
        let empty = RemoteConfig.engineKey([:])
        XCTAssertEqual(empty, RemoteConfig.engineKey(["reportOffer": "never"]))
        XCTAssertEqual(empty, RemoteConfig.engineKey(["engineArgs": ["--port", "1"]]))
        XCTAssertNotEqual(empty, RemoteConfig.engineKey(["engineArgs": ["--drop-quic"]]))
        XCTAssertNotEqual(empty, RemoteConfig.engineKey(["torAllowed": false]))
    }

    func testTheRepositorysFileIsSigned() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../..").standardized
        let text = try String(contentsOf: root.appendingPathComponent("remote.json"), encoding: .utf8)
        let sig = try String(contentsOf: root.appendingPathComponent("remote.json.sig"), encoding: .utf8)
        XCTAssertTrue(RemoteConfig.verify(text, sig: sig), "remote.json on main checks with the apps' key")
    }
}
