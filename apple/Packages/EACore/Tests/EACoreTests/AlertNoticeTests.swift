import XCTest
@testable import EACore

/// A `notify` alert from `/live` as a notification: what it says and the id it goes under.
final class AlertNoticeTests: XCTestCase {
    private let monitorId = "77777777-7777-4777-8777-777777777777"

    private func down(at: String, title: String? = nil, error: String = "connection refused") -> NotifyEvent {
        NotifyEvent(kind: "monitor", id: "monitor:\(monitorId):down:\(at)", title: title ?? "Ollama down: \(error)", at: at,
                    incident_id: "inc-1", name: "Ollama", state: "down", error: error)
    }

    func testAMonitorAlertNamesItAndItsStateWithTheErrorBelow() {
        let a = AlertNotice(down(at: "2026-11-13T21:14:00.000Z"))
        XCTAssertEqual(a.title, "Ollama down")
        XCTAssertEqual(a.body, "connection refused")
        XCTAssertEqual(a.incidentId, "inc-1")
        XCTAssertEqual(a.url, AlertNotice.opsURL)
        XCTAssertEqual(a.thread, "monitor")
    }

    func testLaterAlertsForTheSameMonitorTakeTheEarlierOnesPlace() {
        let first = AlertNotice(down(at: "2026-11-13T21:14:00.000Z"))
        let again = AlertNotice(down(at: "2026-11-14T03:14:00.000Z"))
        let up = AlertNotice(NotifyEvent(kind: "monitor", id: "monitor:\(monitorId):up:2026-11-14T04:00:00.000Z", title: "Ollama up", name: "Ollama", state: "up"))
        XCTAssertEqual(first.id, "alert|monitor|\(monitorId)")
        XCTAssertEqual(again.id, first.id)
        XCTAssertEqual(up.id, first.id)
        XCTAssertEqual(up.title, "Ollama up")
        XCTAssertEqual(up.body, "")
        XCTAssertNil(up.incidentId)
        // Another monitor in the same second keeps its own alert.
        let other = AlertNotice(NotifyEvent(kind: "monitor", id: "monitor:other-id:down:2026-11-13T21:14:00.000Z", title: "nas ping down: timeout", name: "nas ping", state: "down", error: "timeout"))
        XCTAssertNotEqual(other.id, first.id)
    }

    func testAReNotifyKeepsStillAndSaysSinceWhenInTheBody() {
        let error = "connection refused; also down: nas smb"
        let a = AlertNotice(down(at: "2026-11-14T03:14:00.000Z", title: "Ollama still down since Nov 13, 9:14 PM (6 h): \(error)", error: error))
        XCTAssertEqual(a.title, "Ollama still down")
        XCTAssertEqual(a.body, "Since Nov 13, 9:14 PM (6 h): connection refused; also down: nas smb")
    }

    func testOtherAlertsInTheSameSecondDoNotReplaceEachOther() {
        let a = AlertNotice(NotifyEvent(kind: "sensor", id: "sensor:freezer:high:2026-11-13T21:14:00.000Z", title: "freezer high: -5 C", name: "freezer", state: "high"))
        let b = AlertNotice(NotifyEvent(kind: "sensor", id: "sensor:fridge:high:2026-11-13T21:14:00.100Z", title: "fridge high: 9 C", name: "fridge", state: "high"))
        XCTAssertNotEqual(a.id, b.id)
        XCTAssertEqual(a.title, "freezer high: -5 C")
        XCTAssertNil(a.url)
        XCTAssertNil(a.incidentId)
        // With no id from the hub, each still gets one of its own.
        let c = AlertNotice(NotifyEvent(kind: "quiz", title: "Recall quiz: 5 questions"))
        let d = AlertNotice(NotifyEvent(kind: "quiz", title: "Recall quiz: 5 questions"))
        XCTAssertNotEqual(c.id, d.id)
        XCTAssertTrue(c.id.hasPrefix("alert|quiz|"))
    }

    func testAnOlderHubWithoutNameOrStateShowsItsTitle() {
        let a = AlertNotice(NotifyEvent(kind: "monitor", id: "monitor:\(monitorId):down:2026-11-13T21:14:00.000Z", title: "Ollama down: connection refused"))
        XCTAssertEqual(a.title, "Ollama down: connection refused")
        XCTAssertEqual(a.body, "")
        XCTAssertEqual(a.id, "alert|monitor|\(monitorId)")
    }

    func testMonitorIdFromTheNotifyId() {
        XCTAssertEqual(AlertNotice.monitorId(fromNotifyId: "monitor:abc:down:2026-11-13T21:14:00.000Z"), "abc")
        XCTAssertEqual(AlertNotice.monitorId(fromNotifyId: "monitor:abc"), "abc")
        XCTAssertNil(AlertNotice.monitorId(fromNotifyId: "monitor::down:x"))
        XCTAssertNil(AlertNotice.monitorId(fromNotifyId: "sensor:abc:high:x"))
        XCTAssertNil(AlertNotice.monitorId(fromNotifyId: nil))
    }

    func testTheLiveEventCarriesNameStateAndError() {
        let msg = SSEMessage(event: "notify", data: #"{"id":"monitor:m1:down:2026-11-13T21:14:00.000Z","kind":"monitor","title":"Ollama down: refused","at":"2026-11-13T21:14:00.000Z","name":"Ollama","state":"down","error":"refused","incident_id":"inc-1"}"#)
        guard case .notify(let n) = HubClient.liveEvent(msg) else { return XCTFail("not a notify event") }
        XCTAssertEqual(n.kind, "monitor")
        XCTAssertEqual(n.name, "Ollama")
        XCTAssertEqual(n.state, "down")
        XCTAssertEqual(n.error, "refused")
        XCTAssertEqual(n.incident_id, "inc-1")
        // A field of another type is left out; the alert still comes through.
        let odd = SSEMessage(event: "notify", data: #"{"id":"sensor:7:high:x","kind":"sensor","title":"7 high","name":7,"state":"high","value":12}"#)
        guard case .notify(let s) = HubClient.liveEvent(odd) else { return XCTFail("not a notify event") }
        XCTAssertNil(s.name)
        XCTAssertEqual(s.state, "high")
        XCTAssertEqual(s.title, "7 high")
    }
}
