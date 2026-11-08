import XCTest
@testable import EACore

final class SyncDecodeTests: XCTestCase {
    private func row(_ seq: Int, _ kind: String) -> String {
        #"{"seq":\#(seq),"entity":{"id":"id-\#(seq)","kind":"\#(kind)","space":"personal","created_at":"2026-10-27T10:00:00.000Z","updated_at":"2026-10-27T10:00:00.000Z","deleted_at":null,"fields":{"name":"x"},"field_ts":{"name":"2026-10-27T10:00:00.000Z"}}}"#
    }

    func testEveryHubKindDecodes() throws {
        let kinds = ["capture", "note", "task", "reminder", "event", "log", "fact", "rule", "runbook", "ledger", "project", "device",
                     "watch", "plan_rule", "journal", "snippet", "pet_event", "sensor", "reading", "food_option", "inventory", "procedure",
                     "music_idea", "quiz", "monitor", "incident", "checklist", "application", "game"]
        let json = #"{"changes":[\#(kinds.enumerated().map { row($0.offset + 1, $0.element) }.joined(separator: ","))],"seq":29,"more":false}"#
        let r = try JSONCoding.decode(ChangesResponse.self, from: Data(json.utf8))
        XCTAssertEqual(r.changes.count, kinds.count)
        XCTAssertEqual(r.skipped, 0)
    }

    func testUnknownKindIsSkippedNotFatal() throws {
        let json = #"{"changes":[\#(row(1, "task")),\#(row(2, "kind_from_the_future")),\#(row(3, "note"))],"seq":3,"more":false}"#
        let r = try JSONCoding.decode(ChangesResponse.self, from: Data(json.utf8))
        XCTAssertEqual(r.changes.map(\.seq), [1, 3])
        XCTAssertEqual(r.skipped, 1)
        XCTAssertEqual(r.seq, 3, "the cursor still moves past the skipped row")
    }
}
