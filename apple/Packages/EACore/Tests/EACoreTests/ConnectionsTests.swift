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
}
