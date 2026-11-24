import XCTest
@testable import EACore

final class ConnectionsTests: XCTestCase {
    func testDecodesGmailMailboxesAndSaysWhatTheirMailCameTo() throws {
        let json = """
        {"steam": {"connected": false, "hub_key": false}, "letterboxd": {"connected": false}, "health": {"last_import": null, "samples": 0, "total": 0},
         "google": {"app": true, "accounts": [
           {"email": "robin@example.com", "linked_at": "2026-11-03T12:00:00.000Z", "last_sync": null, "last_error": null, "listed": 52, "to_read": 12, "read": 40, "failed": 0, "filed": {"renewals": 3, "pet": 0, "events": 0}},
           {"email": "old@example.com", "listed": 0, "to_read": 0, "read": 1, "failed": 0, "filed": {"renewals": 0, "pet": 0, "events": 0}}
         ]}}
        """
        let c = try JSONCoding.decode(Connections.self, from: json)
        XCTAssertEqual(c.google?.app, true)
        XCTAssertEqual(c.google?.accounts.map(\.id), ["robin@example.com", "old@example.com"])
        XCTAssertEqual(c.google?.accounts[0].summary, "Filed 3 renewals from 40 messages read, 12 still to read.", "mail no longer fills Inventory")
        XCTAssertEqual(c.google?.accounts[1].summary, "Nothing filed yet from 1 message read.")
        XCTAssertNil(try JSONCoding.decode(Connections.self, from: #"{"steam": {"connected": false}, "letterboxd": {"connected": false}, "health": {"samples": 0, "total": 0}}"#).google, "an older hub has no Gmail")
    }

    /// A Confluence link whose sign-in Atlassian ended is still linked and offers Reconnect (gnomecannon/aeneas#24).
    func testAConfluenceLinkAtlassianEndedOffersReconnect() throws {
        let base = #"{"steam": {"connected": false}, "letterboxd": {"connected": false}, "health": {"samples": 0, "total": 0}, "atlassian": %@}"#
        let decode = { (a: String) in try JSONCoding.decode(Connections.self, from: base.replacingOccurrences(of: "%@", with: a)).atlassian! }
        let ended = try decode(#"{"connected": true, "app": true, "site_name": "example-studio", "spaces": ["STARFALL"], "last_error": "Atlassian ended the sign-in. Reconnect to go on reading Confluence; the chosen spaces stay.", "pages": 3, "expired": true}"#)
        XCTAssertTrue(ended.needsReconnect)
        XCTAssertEqual(ended.spaces, ["STARFALL"])
        XCTAssertFalse(try decode(#"{"connected": true, "app": true, "site_name": "example-studio", "spaces": [], "pages": 0, "expired": false}"#).needsReconnect)
        XCTAssertFalse(try decode(#"{"connected": true, "app": true, "site_name": "example-studio", "spaces": [], "pages": 0}"#).needsReconnect, "an older hub sends no mark")
        XCTAssertFalse(try decode(#"{"connected": false, "app": true}"#).needsReconnect)
    }

    /// Internet Accounts on the iPhone, iPad and Mac (gnomecannon/aeneas#23): every account decodes with its switches,
    /// Read only and what receipts came to; a hub from before it has none, and a Google sign-in has no Read only switch.
    func testDecodesInternetAccounts() throws {
        let json = """
        {"steam": {"connected": false}, "letterboxd": {"connected": false}, "health": {"samples": 0, "total": 0},
         "internet": [
           {"key": "icloud:jamie@example.com", "kind": "icloud", "email": "jamie@example.com", "linked_at": "2026-11-20T10:00:00Z", "last_sync": null, "last_error": null,
            "features": {"inbox": true, "receipts": true, "calendars": false}, "read_only": false, "receipts": {"listed": 4, "to_read": 1, "read": 3, "failed": 0, "filed": {"renewals": 2, "pet": 0, "events": 0}}},
           {"key": "imap:robin@example.org", "kind": "imap", "email": "robin@example.org", "host": "imap.example.org", "port": 993, "user": "robin",
            "features": {"inbox": true, "receipts": false, "calendars": null}, "read_only": true},
           {"key": "alex@example.com", "kind": "google", "email": "alex@example.com", "features": {"inbox": null, "receipts": true, "calendars": null}, "read_only": true}
         ]}
        """
        let c = try JSONCoding.decode(Connections.self, from: json)
        let a = try XCTUnwrap(c.internet)
        XCTAssertEqual(a.map(\.id), ["icloud:jamie@example.com", "imap:robin@example.org", "alex@example.com"])
        XCTAssertEqual(a[0].receipts?.summary, "Filed 2 renewals from 3 messages read, 1 still to read.")
        XCTAssertEqual(a[0].summary(mail: true, calendars: true, receipts: true, reminders: true), "Mail, Reminders, Receipts")
        XCTAssertEqual(a[1].kindLabel, "imap.example.org:993")
        XCTAssertEqual(a[1].summary(mail: true, calendars: true, receipts: true, reminders: false), "Mail, read only")
        XCTAssertEqual(a.map(\.hasReadOnlySwitch), [true, true, false])
        XCTAssertNil(a[2].features.inbox, "Sign in with Google reads only: no Mail screen")
        XCTAssertNil(try JSONCoding.decode(Connections.self, from: #"{"steam": {"connected": false}, "letterboxd": {"connected": false}, "health": {"samples": 0, "total": 0}}"#).internet)
        // A hub from before Read only says nothing: no switch the hub would not keep.
        XCTAssertFalse(InternetAccount(key: "icloud:jamie@example.com", kind: "icloud", email: "jamie@example.com", features: .init(inbox: true)).hasReadOnlySwitch)
    }

    /// The app asks before the last thing an account does goes off: the hub then removes it (web lastUseOff).
    func testTheLastUseOfAnAccountIsKnown() {
        let f = InternetAccount.Features(inbox: true, receipts: false, calendars: nil)
        XCTAssertTrue(f.lastUseOff(inbox: false))
        XCTAssertFalse(InternetAccount.Features(inbox: true, receipts: true, calendars: nil).lastUseOff(inbox: false))
        XCTAssertFalse(f.lastUseOff(receipts: true), "switching on removes nothing")
        XCTAssertTrue(InternetAccount.Features(inbox: false, receipts: false, calendars: true).lastUseOff(calendars: false))
    }

    /// Switches, Read now, linking and Remove go to the hub's Internet Accounts routes, each value only when given.
    func testInternetAccountCallsGoToTheHub() async throws {
        let t = FakeTransport()
        t.responses = [(200, Data(#"{"inbox": true, "receipts": true, "read_only": true}"#.utf8)), (200, Data("{}".utf8)), (200, Data("{}".utf8)), (200, Data("{}".utf8)), (200, Data(#"{"message": "Removed."}"#.utf8))]
        let c = HubClient(transport: t)
        let r = try await c.setAccountFeatures(key: "imap:robin@example.org", readOnly: true)
        XCTAssertEqual(r.read_only, true)
        _ = try await c.readMailNow(account: "imap:robin@example.org")
        try await c.linkImap(email: "alex@example.com", password: "abcd efgh ijkl mnop", gmail: true, host: "ignored.example", port: 1)
        try await c.linkICloudMail(email: "jamie@example.com", password: "abcd-efgh-ijkl-mnop")
        let removed = try await c.removeAccount(key: "imap:robin@example.org")
        XCTAssertEqual(removed, "Removed.")
        XCTAssertEqual(t.calls.map { "\($0.method) \($0.path)" }, ["PUT connections/accounts/imap:robin@example.org", "POST connections/google/sync", "PUT connections/imap", "PUT connections/icloud", "DELETE connections/accounts/imap:robin@example.org"])
        let body = { (i: Int) in try JSONSerialization.jsonObject(with: t.calls[i].body ?? Data()) as? [String: Any] ?? [:] }
        XCTAssertEqual(try body(0) as NSDictionary, ["read_only": true] as NSDictionary, "only what changes is sent")
        XCTAssertEqual(try body(1) as NSDictionary, ["account": "imap:robin@example.org"] as NSDictionary)
        XCTAssertEqual(try body(2) as NSDictionary, ["email": "alex@example.com", "password": "abcd efgh ijkl mnop", "preset": "gmail"] as NSDictionary, "Gmail's server is the hub's to fill in")
    }

    /// Apple Reminders' switch is on the iCloud account in Settings, Connections, so Settings, Modules leaves it out.
    func testAModuleSwitchedElsewhereIsLeftOutOfModules() throws {
        let list = try JSONCoding.decode(ModulesResponse.self, from: #"{"modules": [{"id": "voice", "group": "On your devices", "on": true}, {"id": "apple_reminders", "group": "On your devices", "on": true, "switch_in": "connections"}]}"#).modules
        XCTAssertEqual(list.listedInModules.map(\.id), ["voice"])
        XCTAssertEqual(list.grouped.flatMap { $0.modules.map(\.id) }, ["voice"])
        XCTAssertTrue(list.isOn(.appleReminders), "still a module the devices obey")
    }
}
