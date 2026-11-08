import XCTest
@testable import EACore

/// The hub sends preference and info rules in their own list; online, Today and Week drew none of them.
final class PlannerPreferencesTests: XCTestCase {
    func testPreferencesFoldIntoCommitmentsOnce() throws {
        let json = """
        {"date":"2026-11-05","now":null,"next":[],"blocks":[],"commitments":[{"rule_id":"gym","title":"Gym","start":"2026-11-05T18:00:00.000Z","end":"2026-11-05T19:00:00.000Z","type":"commitment"}],
         "preferences":[{"rule_id":"focus","title":"Focus","start":"2026-11-05T14:00:00.000Z","end":"2026-11-05T16:00:00.000Z","type":"preference"},
                        {"rule_id":"custody","title":"Pepper week","start":"2026-11-05T05:00:00.000Z","end":"2026-11-06T05:00:00.000Z","type":"info"}],
         "reminders_due":[],"watches_due_soon":[],"captures_unprocessed":0,"free_slots":[],"digest":""}
        """
        var t = try JSONCoding.decode(PlannerToday.self, from: Data(json.utf8))
        t.commitments = t.commitments.folding(t.preferences)
        XCTAssertEqual(t.commitments.map(\.rule_id), ["custody", "focus", "gym"])
        XCTAssertEqual(t.commitments.folding(t.preferences).count, 3, "folded twice, nothing doubles")
        // An answer from an older hub has no preferences list at all.
        let old = try JSONCoding.decode(PlannerToday.self, from: Data(json.replacingOccurrences(of: "\"preferences\"", with: "\"other\"").utf8))
        XCTAssertNil(old.preferences)
    }

    func testVaultEntryDecodesTheHubsIsoTime() throws {
        let json = #"[{"path":"Inbox/a.md","hash":"abc","mtime":"2026-11-05T07:00:00.000Z","size":12}]"#
        let v = try JSONCoding.decode([HubClient.VaultEntry].self, from: Data(json.utf8))
        XCTAssertEqual(v.first?.mtime, "2026-11-05T07:00:00.000Z")
    }
}
