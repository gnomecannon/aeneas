import XCTest
@testable import EACore

final class SampleHubTests: XCTestCase {
    private func day(_ s: String) -> Date { SampleTransport.dayDate(s)! }

    func testDatesMoveToTodayButBirthdaysStay() {
        let body = #"{"start":"2026-11-06T15:00:00.000Z","due":"2026-11-09","birthday":"1991-11-15","text":"Spotify on 2026-11-09"}"#
        let out = SampleTransport.shift(body, days: 10, around: "2026-11-06")
        XCTAssertTrue(out.contains(#""start":"2026-11-16T15:00:00.000Z""#), out)
        XCTAssertTrue(out.contains(#""due":"2026-11-19""#))
        XCTAssertTrue(out.contains(#""birthday":"1991-11-15""#), "a birthday decades ago is not moved")
        XCTAssertTrue(out.contains("Spotify on 2026-11-19"))
        XCTAssertEqual(SampleTransport.shift(body, days: 0, around: "2026-11-06"), body)
    }

    func testARequestForTodayFindsTheRecordingsToday() async throws {
        let recKey = SampleTransport.key(method: "GET", path: "planner/day/2026-11-06", query: ["tz": "America/New_York"], recordedDay: "2026-11-06")
        XCTAssertEqual(recKey, "GET planner/day/@D+0?tz=America/New_York")
        let rec = SampleTransport.Recording(day: "2026-11-06", entries: [recKey: .init(status: 200, body: #"{"date":"2026-11-06"}"#)])
        let t = SampleTransport(recording: rec, today: day("2026-12-01"))
        let r = try await t.send(method: "GET", path: "planner/day/2026-12-01", query: ["tz": "America/New_York"], body: nil)
        XCTAssertEqual(r.status, 200)
        XCTAssertEqual(String(data: r.data, encoding: .utf8), #"{"date":"2026-12-01"}"#)
    }

    func testEditsStayOnTheDeviceAndTheAssistantSaysWhy() async throws {
        let t = SampleTransport(recording: .init(day: "2026-11-06"), today: day("2026-11-06"))
        let push = try JSONEncoder().encode(PushRequest(device_id: "sample-device", patches: [Patch(id: "a1", kind: .task, fields: ["title": "x"], create: true)]))
        let p = try await t.send(method: "POST", path: "sync/push", query: [:], body: push)
        let pr = try JSONDecoder().decode(PushResponse.self, from: p.data)
        XCTAssertEqual(pr.applied.map(\.id), ["a1"])
        let c = try await t.send(method: "POST", path: "ai/chat", query: [:], body: Data("{}".utf8))
        XCTAssertTrue(try JSONDecoder().decode(ChatResponse.self, from: c.data).reply.contains("sample data"))
        let req = try JSONEncoder().encode(ChatRequest(session_id: "s1", message: "What's on today?"))
        _ = try await t.send(method: "POST", path: "ai/chat", query: [:], body: req)
        let back = try JSONDecoder().decode(AISession.self, from: try await t.send(method: "GET", path: "ai/sessions/s1", query: [:], body: nil).data)
        XCTAssertEqual(back.messages.map(\.role), [.user, .assistant], "the screen reads the conversation back")
        let later = try await t.send(method: "GET", path: "sync/changes", query: ["since": "1000001"], body: nil)
        XCTAssertEqual(try JSONDecoder().decode(ChangesResponse.self, from: later.data).changes.count, 0)
        let other = try await t.send(method: "POST", path: "capture", query: [:], body: Data("{}".utf8))
        XCTAssertEqual(other.status, 503)
    }

    func testSampleModeIsConfiguredAndUsesNoNetwork() {
        let c = SharedConfig(suiteName: "sample-test-\(UUID().uuidString)")
        XCTAssertFalse(c.isConfigured)
        c.sampleMode = true
        XCTAssertTrue(c.isConfigured)
        SampleTransport.shared = SampleTransport(recording: .init(day: "2026-11-06"))
        let client = HubClient.make(config: c)
        XCTAssertNotNil(client)
        XCTAssertFalse(client!.supportsStreaming, "no HTTP transport in sample mode")
    }

    func testCalendarRemindersAndContactsWaitForTheHubsWord() {
        let c = SharedConfig(suiteName: "modules-test-\(UUID().uuidString)")
        XCTAssertTrue(c.moduleOn(.appleCalendar), "screens show before the list comes")
        XCTAssertFalse(c.moduleSaidOn(.appleCalendar), "nothing of the person's is copied before the hub says so")
        c.modules = [ModuleInfo(id: "apple_calendar", title: "Apple Calendar", summary: "", group: "On your devices", on: true)]
        XCTAssertTrue(c.moduleSaidOn(.appleCalendar))
        XCTAssertFalse(c.moduleSaidOn(.contacts), "a module the hub did not list is off for copying")
    }
}
