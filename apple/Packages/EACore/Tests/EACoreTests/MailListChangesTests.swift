import XCTest
@testable import EACore

/// `GET /mail?since=` answers (since 2026-11-25): the whole list, or the changes put into the copy (Mail.applyChanges).
final class MailListChangesTests: XCTestCase {
    private func msg(_ id: String, _ at: String, seen: Bool = false, back: String? = nil) -> String {
        #"{"id":"\#(id)","at":"\#(at)","from":{"name":"Alex","address":"alex@example.com"},"subject":"\#(id)","preview":"","automated":false,"bundle":null,"state":"inbox","pinned":false,"seen":\#(seen)\#(back.map { #","back_at":"\#($0)""# } ?? ""),"mailbox":"robin@example.com"}"#
    }
    private func answer(_ json: String) throws -> MailListAnswer { try JSONCoding.decode(MailListAnswer.self, from: json) }

    func testChangesGoIntoTheCopyInTheListsOrderAndLength() throws {
        let full = try answer(#"{"messages":[\#(msg("c", "2026-11-25T10:00:00.000Z")),\#(msg("b", "2026-11-25T09:00:00.000Z")),\#(msg("a", "2026-11-25T08:00:00.000Z"))],"logos":{"a.example":"<svg/>"},"mailboxes":[],"cursor":"c1","max":3}"#)
        XCTAssertNil(full.changed)
        XCTAssertEqual(full.cursor, "c1")
        let copy = try XCTUnwrap(Mail.applyChanges(nil, full))
        XCTAssertEqual(copy.messages.map(\.id), ["c", "b", "a"])
        let changes = try answer(#"{"changed":[\#(msg("a", "2026-11-25T08:00:00.000Z", seen: true)),\#(msg("d", "2026-11-25T07:00:00.000Z")),\#(msg("e", "2026-11-25T11:00:00.000Z", back: "2026-11-25T11:30:00.000Z")),\#(msg("p", "2026-11-25T10:00:00.000Z"))],"gone":["b"],"mailboxes":[],"cursor":"c2","max":4}"#)
        XCTAssertEqual(changes.list.messages, [], "an answer of changes has no list of its own")
        XCTAssertFalse(changes.hasLogos)
        let next = try XCTUnwrap(Mail.applyChanges(copy, changes))
        XCTAssertEqual(next.messages.map(\.id), ["e", "c", "p", "a"], "newest first, equal times by id, cut to the length")
        XCTAssertEqual(next.messages.first { $0.id == "a" }?.seen, true)
        XCTAssertEqual(next.logos, ["a.example": "<svg/>"], "logos stay when the answer has none")
        XCTAssertNil(Mail.applyChanges(nil, changes), "changes with no copy: the whole list is asked for")
    }

    func testAHubFromBeforeSendsTheWholeListAndNoCursor() throws {
        let old = try answer(#"{"messages":[\#(msg("a", "2026-11-25T08:00:00.000Z"))],"mailboxes":[]}"#)
        XCTAssertNil(old.cursor)
        XCTAssertEqual(Mail.applyChanges(nil, old)?.messages.map(\.id), ["a"])
        // The list type itself still reads a whole list as before, for every caller of mailList().
        XCTAssertEqual(try JSONCoding.decode(MailList.self, from: #"{"messages":[],"mailboxes":[]}"#).messages, [])
        XCTAssertThrowsError(try JSONCoding.decode(MailList.self, from: #"{"mailboxes":[]}"#), "a list with no messages and no changes is not a list")
    }

    func testTheClientSendsItsCursor() async throws {
        let hub = FakeTransport()
        hub.responses = [(200, Data(#"{"messages":[],"mailboxes":[],"cursor":"c1","max":5000}"#.utf8))]
        let c = HubClient(transport: hub)
        let a = try await c.mailList(since: "")
        XCTAssertEqual(a.cursor, "c1")
        XCTAssertEqual(hub.calls.first?.query["since"], "")
    }

    /// Whatever changes come, the result is the copy and the changes sorted whole and cut, as the hub's list is.
    func testRandomChangesGiveTheSortedList() throws {
        var rng = SystemRandomNumberGenerator()
        func summary(_ id: String, _ at: Int, back: Int?) -> MailSummary {
            var m = try! JSONCoding.decode(MailSummary.self, from: msg(id, "2026-11-\(10 + at / 24)T\(String(format: "%02d", at % 24)):00:00.000Z"))
            if let back { m.back_at = "2026-11-\(10 + back / 24)T\(String(format: "%02d", back % 24)):00:00.000Z" }
            return m
        }
        func ordered(_ xs: [MailSummary]) -> [MailSummary] {
            xs.sorted { x, y in (x.back_at ?? x.at) != (y.back_at ?? y.at) ? (x.back_at ?? x.at) > (y.back_at ?? y.at) : x.id < y.id }
        }
        for _ in 0..<200 {
            let copyList = ordered((0..<Int.random(in: 0...30, using: &rng)).map { summary("m\($0)", Int.random(in: 0...200, using: &rng), back: nil) })
            var changed: [MailSummary] = []
            for m in copyList where Int.random(in: 0..<4, using: &rng) == 0 {
                var c = m; c.seen = true
                if Bool.random(using: &rng) { c = summary(m.id, Int.random(in: 0...200, using: &rng), back: Bool.random(using: &rng) ? Int.random(in: 0...200, using: &rng) : nil) }
                changed.append(c)
            }
            changed += (0..<Int.random(in: 0...5, using: &rng)).map { summary("n\($0)", Int.random(in: 0...200, using: &rng), back: nil) }
            let gone = copyList.filter { _ in Int.random(in: 0..<6, using: &rng) == 0 }.map(\.id)
            let max = Int.random(in: 1...40, using: &rng)
            var copy = MailList(messages: copyList, mailboxes: [])
            copy.logos = [:]
            let a = MailListAnswer(list: MailList(messages: [], mailboxes: []), changed: changed, gone: gone, cursor: "c", max: max, hasLogos: false)
            var byId: [String: MailSummary] = [:]
            for m in copyList where !gone.contains(m.id) { byId[m.id] = m }
            for m in changed { byId[m.id] = m }
            XCTAssertEqual(Mail.applyChanges(copy, a)?.messages, Array(ordered(Array(byId.values)).prefix(max)))
        }
    }
}
