import XCTest
@testable import EACore

/// Settings, Connections, App keys: which keys show, whether the hub has each, and what each says about itself.
final class AppKeysTests: XCTestCase {
    private func connections(_ json: String) throws -> Connections { try JSONCoding.decode(Connections.self, from: json) }
    private let base = #""letterboxd": {"connected": false}, "health": {"last_import": null, "samples": 0, "total": 0}"#

    func testAKeyShowsOnlyWhileItsModuleIsOnWithWhetherTheHubHasIt() throws {
        let c = try connections(#"{"steam": {"connected": false, "hub_key": true}, \#(base), "atlassian": {"connected": false, "app": false}, "google": {"app": true, "accounts": [{"email": "robin@larkspur.example"}]}}"#)
        let all = AppKey.shown(in: c) { _ in true }
        XCTAssertEqual(all.map(\.key.name), ["Google app", "Atlassian app", "Steam key"])
        XCTAssertEqual(all.map(\.added), [true, false, true])
        XCTAssertEqual(AppKey.shown(in: c) { $0 != .wiki }.map(\.id), ["google", "steam"], "Wiki off: no Atlassian app")
        XCTAssertEqual(AppKey.shown(in: c) { _ in false }, [])
        // The Google app serves only the older Google sign-in: with no mailbox signed in that way, it is not shown.
        let noSignIn = try connections(#"{"steam": {"connected": false, "hub_key": true}, \#(base), "atlassian": {"connected": false, "app": false}, "google": {"app": true, "accounts": []}}"#)
        XCTAssertEqual(AppKey.shown(in: noSignIn) { _ in true }.map(\.id), ["atlassian", "steam"])
        // Linked to Confluence means the hub has its Atlassian app.
        let linked = try connections(#"{"steam": {"connected": false}, \#(base), "atlassian": {"connected": true, "site_name": "example-studio"}}"#)
        XCTAssertEqual(AppKey.atlassian.added(in: linked) { _ in true }, true)
        // A hub too old to say whether it has a Google or Atlassian app shows neither.
        let older = try connections(#"{"steam": {"connected": false}, \#(base)}"#)
        XCTAssertEqual(AppKey.shown(in: older) { _ in true }.map { [$0.id: $0.added] }, [["steam": false]])
    }

    func testEveryKeySaysWhatItIsWhyItIsAskedForAndWhatWorksWithoutIt() {
        XCTAssertTrue(AppKey.intro.hasPrefix("These are optional."))
        XCTAssertEqual(AppKey.all.map(\.module), [.mail, .wiki, .games])
        for k in AppKey.all {
            for text in [AppKey.intro, k.purpose, k.what, k.why, k.uses, k.without, k.replacing] {
                XCTAssertFalse(text.isEmpty, k.name)
                XCTAssertFalse(text.contains("\u{2014}") || text.contains("\u{2013}") || text.contains("!"), text)
            }
        }
        XCTAssertTrue(AppKey.google.what.contains("gmail.readonly"))
        XCTAssertTrue(AppKey.google.without.contains("app password"), "Gmail with an app password needs no Google app")
        XCTAssertTrue(AppKey.steam.what.contains("steamcommunity.com/dev/apikey"))
        XCTAssertTrue(AppKey.steam.without.contains("Steam password changes"))
    }
}
