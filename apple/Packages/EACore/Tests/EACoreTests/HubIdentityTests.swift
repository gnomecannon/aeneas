import XCTest
@testable import EACore

/// Several people's hubs on one machine: /health with a key says whose hub it is (deploy/people.sh).
final class HubIdentityTests: XCTestCase {
    func testHealthCarriesNameAndColor() throws {
        let json = ##"{"ok":true,"version":"0.1.0","hub":{"name":"Jamie","color":"#7a5cc7"}}"##
        let h = try JSONDecoder().decode(HealthResponse.self, from: Data(json.utf8))
        XCTAssertEqual(h.hub?.label, "Jamie\u{2019}s hub")
        let rgb = try XCTUnwrap(h.hub?.rgb)
        XCTAssertEqual(rgb.0, 0x7a / 255.0, accuracy: 0.0001)
        XCTAssertEqual(rgb.2, 0xc7 / 255.0, accuracy: 0.0001)
    }

    func testSinglePersonHubShowsNothing() throws {
        // A hub with only the owner's name and no color is not one of several: no label.
        XCTAssertNil(HubIdentity(name: "Robin", color: nil).label)
        XCTAssertEqual(HubIdentity(name: nil, color: "#2f8f83").label, "This hub")
        // An older hub has no `hub` at all.
        let h = try JSONDecoder().decode(HealthResponse.self, from: Data(#"{"ok":true,"version":"0.1.0"}"#.utf8))
        XCTAssertNil(h.hub)
        XCTAssertNil(HubIdentity(name: "X", color: "blue").rgb)
    }

    func testPeopleOnThisMachine() throws {
        let list = try JSONDecoder().decode(HubsList.self, from: Data(##"{"available":false,"reason":"not_set_up","setup_command":"sudo bash x","admin_note":"admins can read","hubs":[]}"##.utf8))
        XCTAssertTrue(list.offered)
        let other = try JSONDecoder().decode(HubsList.self, from: Data(##"{"available":false,"reason":"not_owner","setup_command":"","admin_note":"","hubs":[]}"##.utf8))
        XCTAssertFalse(other.offered)
        let r = try JSONDecoder().decode(HubRequest.self, from: Data(##"{"state":"done","name":"Jamie","color":"#c27c2c","address":"https://h:8788","pairing":{"code":"ABCD-EFGH","app":"everythingapp://setup?code=x"}}"##.utf8))
        XCTAssertTrue(r.finished)
        XCTAssertEqual(r.pairing?.code, "ABCD-EFGH")
        XCTAssertFalse(try JSONDecoder().decode(HubRequest.self, from: Data(#"{"state":"working","step":"Installing"}"#.utf8)).finished)
    }
}
