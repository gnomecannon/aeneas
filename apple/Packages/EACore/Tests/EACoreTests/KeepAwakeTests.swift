import XCTest
@testable import EACore

final class KeepAwakeTests: XCTestCase {
    func testWorkRunsAndItsValueComesBack() async {
        let v = await KeepAwake.during("test") { () async -> Int in
            try? await Task.sleep(nanoseconds: 10_000_000)
            return 42
        }
        XCTAssertEqual(v, 42)
    }

    private func session(_ messages: [(ChatMessage.Role, String)], pending: Bool = false) -> AISession {
        AISession(
            session_id: "watch-2026-11-04-ab12cd34", title: "t", task_type: "auto", created_at: "", last_at: "",
            messages: messages.map { AIStoredMessage(role: $0.0, content: $0.1) },
            pending_action: pending ? try! JSONDecoder().decode(PendingAction.self, from: Data(#"{"id":"a","host":"core","command":"systemctl restart plex"}"#.utf8)) : nil
        )
    }

    func testTurnsPairEachQuestionWithItsAnswer() {
        let s = session([(.user, "what's on today?"), (.assistant, "Gym at 6."), (.user, "and tomorrow?"), (.assistant, ""), (.assistant, "Nothing yet.")])
        let t = ChatTurn.turns(of: s)
        XCTAssertEqual(t.map(\.q), ["what's on today?", "and tomorrow?"])
        XCTAssertEqual(t.map(\.a), ["Gym at 6.", "Nothing yet."])
        // Ids are stable across reads, so a turn being read aloud keeps its Stop button.
        XCTAssertEqual(t.map(\.id), ChatTurn.turns(of: s).map(\.id))
    }

    func testAQuestionStillBeingAnsweredIsLeftOut() {
        let t = ChatTurn.turns(of: session([(.user, "one"), (.assistant, "1"), (.user, "two")]))
        XCTAssertEqual(t.map(\.q), ["one"])
    }

    func testAChangeWaitingForApprovalSaysWhereToApprove() {
        let t = ChatTurn.turns(of: session([(.user, "restart plex"), (.assistant, "This restarts Plex.")], pending: true))
        XCTAssertEqual(t.last?.a, "This restarts Plex.\n\nApprove or decline this on your iPhone.")
    }

    func testLocalDayTurnsOverAtLocalMidnight() {
        let ny = TimeZone(identifier: "America/New_York")!
        // 7:30 PM in New York on Nov 4 is already Nov 5 in UTC.
        let evening = ISO.date("2026-11-05T00:30:00Z")!
        XCTAssertEqual(ISO.localDay(evening, in: ny), "2026-11-04")
        XCTAssertEqual(ISO.localDay(ISO.date("2026-11-05T05:01:00Z")!, in: ny), "2026-11-05")
    }

    func testOldWatchTurnsStillDecode() throws {
        let old = #"[{"id":"X","q":"hi","a":"hello"}]"#.data(using: .utf8)!
        XCTAssertEqual(try JSONDecoder().decode([ChatTurn].self, from: old), [ChatTurn(id: "X", q: "hi", a: "hello")])
    }

    // MARK: lateAnswer

    private func sessionJSON(_ messages: [(String, String, String?)], working: Bool, pending: Bool = false) -> Data {
        let ms = messages.map { m -> [String: Any] in
            var d: [String: Any] = ["role": m.0, "content": m.1]
            if let at = m.2 { d["at"] = at }
            return d
        }
        var o: [String: Any] = ["session_id": "watch-2026-11-05-ab12cd34", "title": "t", "task_type": "general", "created_at": "", "last_at": "", "messages": ms]
        if working { o["working"] = ["since": "2026-11-05T05:00:00Z"] }
        if pending { o["pending_action"] = ["id": "a", "host": "core", "command": "systemctl restart plex"] }
        return try! JSONSerialization.data(withJSONObject: o)
    }

    private let asked = ISO.date("2026-11-05T05:00:00Z")!

    func testALostReplyIsReadOnceTheHubFinishes() async {
        let t = FakeTransport()
        t.responses = [
            (200, sessionJSON([("user", "what's on tonight?", "2026-11-05T05:00:01Z")], working: true)),
            (200, sessionJSON([("user", "what's on tonight?", "2026-11-05T05:00:01Z")], working: true)),
            (200, sessionJSON([("user", "what's on tonight?", "2026-11-05T05:00:01Z"), ("assistant", "", nil), ("assistant", "Gym at 6.", "2026-11-05T05:06:00Z")], working: false)),
        ]
        let turn = await HubClient(transport: t).lateAnswer(to: " what's on tonight? ", session: "watch-2026-11-05-ab12cd34", askedAt: asked, every: 0.01)
        XCTAssertEqual(turn, ChatTurn(id: "watch-2026-11-05-ab12cd34:2", q: "what's on tonight?", a: "Gym at 6."))
        XCTAssertEqual(t.calls.count, 3)
        XCTAssertEqual(t.calls.first?.path, "ai/sessions/watch-2026-11-05-ab12cd34")
    }

    func testAQuestionThatNeverReachedTheHubHasNoLateAnswer() async {
        let t = FakeTransport()
        // The same words were asked and answered this morning; today's ask never arrived.
        t.responses = [(200, sessionJSON([("user", "what's on tonight?", "2026-11-04T13:00:00Z"), ("assistant", "Nothing.", "2026-11-04T13:00:05Z")], working: false))]
        let turn = await HubClient(transport: t).lateAnswer(to: "what's on tonight?", session: "s", askedAt: asked, every: 0.01)
        XCTAssertNil(turn)
        // A different latest question: this one did not arrive either.
        t.responses = [(200, sessionJSON([("user", "something else", "2026-11-05T05:00:01Z"), ("assistant", "Sure.", nil)], working: false))]
        let other = await HubClient(transport: t).lateAnswer(to: "what's on tonight?", session: "s", askedAt: asked, every: 0.01)
        XCTAssertNil(other)
    }

    func testAFailedOrUnreachableHubGivesNoLateAnswer() async {
        let t = FakeTransport()
        // The hub stored the question, then no model answered.
        t.responses = [(200, sessionJSON([("user", "what's on tonight?", "2026-11-05T05:00:01Z")], working: false))]
        let failed = await HubClient(transport: t).lateAnswer(to: "what's on tonight?", session: "s", askedAt: asked, every: 0.01)
        XCTAssertNil(failed)
        t.error = HubError.phoneUnreachable
        let away = await HubClient(transport: t).lateAnswer(to: "what's on tonight?", session: "s", askedAt: asked, every: 0.01)
        XCTAssertNil(away)
    }

    func testLateAnswerStopsWaitingAndNotesAnApproval() async {
        let t = FakeTransport()
        t.responses = Array(repeating: (200, sessionJSON([("user", "restart plex", "2026-11-05T05:00:01Z")], working: true)), count: 50)
        let gaveUp = await HubClient(transport: t).lateAnswer(to: "restart plex", session: "s", askedAt: asked, wait: 0.05, every: 0.01)
        XCTAssertNil(gaveUp)
        XCTAssertLessThan(t.calls.count, 50)
        t.responses = [(200, sessionJSON([("user", "restart plex", "2026-11-05T05:00:01Z"), ("assistant", "This restarts Plex.", nil)], working: false, pending: true))]
        let turn = await HubClient(transport: t).lateAnswer(to: "restart plex", session: "s", askedAt: asked, approveOn: "the app")
        XCTAssertEqual(turn?.a, "This restarts Plex.\n\nApprove or decline this on the app.")
    }
}

/// Answers by path, with a delay where asked, for tests where requests overlap.
final class RouteTransport: HubTransport, @unchecked Sendable {
    let route: @Sendable (String, String) async throws -> (Int, Data)
    init(_ route: @escaping @Sendable (String, String) async throws -> (Int, Data)) { self.route = route }
    func send(method: String, path: String, query: [String: String], body: Data?) async throws -> (status: Int, data: Data) {
        let (s, d) = try await route(method, path)
        return (s, d)
    }
}

final class ChatOrLateTests: XCTestCase {
    private let reply = Data(#"{"reply":"Straight back.","model":"m","backend":"ollama","redactions":0,"rules_applied":[]}"#.utf8)
    private func session(working: Bool, answer: String?) -> Data {
        var ms: [[String: Any]] = [["role": "user", "content": "slow one", "at": "2026-11-05T05:00:01Z"]]
        if let a = answer { ms.append(["role": "assistant", "content": a]) }
        var o: [String: Any] = ["session_id": "s", "title": "t", "task_type": "general", "created_at": "", "last_at": "", "messages": ms]
        if working { o["working"] = ["since": "2026-11-05T05:00:01Z"] }
        return try! JSONSerialization.data(withJSONObject: o)
    }
    private let asked = ISO.date("2026-11-05T05:00:00Z")!
    private let req = ChatRequest(session_id: "s", message: "slow one")

    func testAQuickReplyIsUsedAsIs() async throws {
        let c = HubClient(transport: RouteTransport { _, path in path == "ai/chat" ? (200, self.reply) : (500, Data()) })
        guard case .reply(let r) = try await c.chatOrLate(req, askedAt: asked, pollAfter: 5) else { return XCTFail("expected the reply") }
        XCTAssertEqual(r.reply, "Straight back.")
    }

    func testAReplyStuckOnALockedIPhoneLosesToTheHubsAnswer() async throws {
        let polls = Counter()
        let c = HubClient(transport: RouteTransport { _, path in
            if path == "ai/chat" { try await Task.sleep(nanoseconds: 2_000_000_000); return (200, self.reply) }
            let n = polls.next()
            return (200, self.session(working: n < 3, answer: n < 3 ? nil : "Read from the hub."))
        })
        let t0 = Date()
        guard case .late(let t) = try await c.chatOrLate(req, askedAt: asked, pollAfter: 0.05, every: 0.01) else { return XCTFail("expected the hub's answer") }
        XCTAssertEqual(t.a, "Read from the hub.")
        XCTAssertLessThan(Date().timeIntervalSince(t0), 1.5, "did not wait for the stuck reply")
    }

    func testAFailedRequestStillReadsTheAnswerOrThrows() async throws {
        let done = HubClient(transport: RouteTransport { _, path in
            if path == "ai/chat" { throw HubError.phoneUnreachable }
            return (200, self.session(working: false, answer: "It finished anyway."))
        })
        guard case .late(let t) = try await done.chatOrLate(req, askedAt: asked, pollAfter: 5, every: 0.01) else { return XCTFail("expected the hub's answer") }
        XCTAssertEqual(t.a, "It finished anyway.")
        let failed = HubClient(transport: RouteTransport { _, path in
            if path == "ai/chat" { throw HubError.http(status: 503, message: "no model answered") }
            return (200, self.session(working: false, answer: nil))
        })
        do { _ = try await failed.chatOrLate(req, askedAt: asked, pollAfter: 5, every: 0.01); XCTFail("expected the error") }
        catch { XCTAssertEqual(error as? HubError, .http(status: 503, message: "no model answered")) }
    }
}

final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var n = 0
    func next() -> Int { lock.lock(); defer { lock.unlock() }; let v = n; n += 1; return v }
}
