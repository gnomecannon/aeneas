import XCTest
@testable import EACore

/// Records calls and answers with canned responses.
final class FakeTransport: HubTransport, @unchecked Sendable {
    struct Call: Equatable { var method: String; var path: String; var query: [String: String]; var body: Data? }
    var calls: [Call] = []
    var responses: [(Int, Data)] = []
    var error: Error?
    /// Runs as each call arrives, before it is answered (to act while a sync is in flight).
    var onSend: ((Call) async -> Void)?

    func send(method: String, path: String, query: [String: String], body: Data?) async throws -> (status: Int, data: Data) {
        calls.append(Call(method: method, path: path, query: query, body: body))
        if let hook = onSend { await hook(calls[calls.count - 1]) }
        if let e = error { throw e }
        if responses.isEmpty { return (200, Data("{}".utf8)) }
        return responses.removeFirst()
    }
}

final class RelayTests: XCTestCase {
    func testEnvelopeRoundTrip() throws {
        let body = Data("{\"name\":\"x\",\"platform\":\"watch\"}".utf8)
        let req = RelayRequest(id: "r1", method: "POST", path: "devices/register", query: ["a": "1", "b": "two words"], body: body)
        let wire = try req.encoded()
        let back = try RelayRequest.decode(wire)
        XCTAssertEqual(back, req)
        XCTAssertEqual(back.bodyData, body)
        XCTAssertEqual(back.query["b"], "two words")

        let resp = RelayResponse(id: "r1", status: 201, data: Data("{\"device_id\":\"d9\"}".utf8))
        let rback = try RelayResponse.decode(try resp.encoded())
        XCTAssertEqual(rback, resp)
        XCTAssertEqual(String(decoding: rback.bodyData, as: UTF8.self), "{\"device_id\":\"d9\"}")
        XCTAssertNil(rback.error)

        let empty = RelayRequest(method: "GET", path: "health")
        XCTAssertNil(try RelayRequest.decode(try empty.encoded()).bodyData)
        XCTAssertLessThan(empty.wireSize, 200)
    }

    func testRelayHandlerFillsWatchNameAndMapsErrors() async throws {
        let t = FakeTransport()
        t.responses = [(200, Data("{\"device_id\":\"abc\"}".utf8))]
        let req = RelayRequest(method: "POST", path: "devices/register", body: Data("{\"name\":\"Apple Watch\",\"platform\":\"watch\"}".utf8))
        let resp = await RelayHandler.perform(req, transport: t, watchDeviceName: "Alex iPhone Watch")
        XCTAssertEqual(resp.status, 200)
        XCTAssertEqual(resp.id, req.id)
        let sent = try JSONSerialization.jsonObject(with: t.calls[0].body!) as! [String: Any]
        XCTAssertEqual(sent["name"] as? String, "Alex iPhone Watch")
        XCTAssertEqual(sent["platform"] as? String, "watch")

        // Other paths are passed through untouched, including query and body.
        t.responses = [(422, Data("{\"error\":\"reason required\"}".utf8))]
        let r2 = await RelayHandler.perform(RelayRequest(method: "POST", path: "reminders/x/snooze", query: ["q": "1"], body: Data("{}".utf8)), transport: t, watchDeviceName: "n")
        XCTAssertEqual(r2.status, 422)
        XCTAssertEqual(t.calls[1].query, ["q": "1"])
        XCTAssertEqual(String(decoding: t.calls[1].body!, as: UTF8.self), "{}")

        // Transport failure on the phone becomes status 0 with a message.
        t.error = HubError.transport("could not connect")
        let r3 = await RelayHandler.perform(RelayRequest(method: "GET", path: "health"), transport: t, watchDeviceName: nil)
        XCTAssertEqual(r3.status, 0)
        XCTAssertEqual(r3.error, "could not connect")
    }

    /// A sync page can be hundreds of KB and one capture with a picture 500 KB: too big for one WatchConnectivity
    /// message, whose reply then fails and the Watch said "iPhone not reachable".
    func testBigAnswerGoesInPartsThatEachFitOneMessage() throws {
        let store = RelayPartStore()
        let small = RelayResponse(id: "s", status: 200, data: Data("{\"ok\":true}".utf8))
        XCTAssertEqual(try RelayResponse.decode(RelayHandler.reply(small, store: store)), small)
        XCTAssertEqual(store.count, 0)

        // Like the real feed: 500 log entries (they compress) and one picture's worth of random bytes (it does not).
        var json = "{\"changes\":["
        json += (0..<500).map { "{\"seq\":\($0),\"entity\":{\"kind\":\"log\",\"fields\":{\"type\":\"mood\",\"value\":\($0 % 10),\"note\":\"seeded log \($0)\"}}}" }.joined(separator: ",")
        json += "],\"picture\":\"\(Data((0..<380_000).map { _ in UInt8.random(in: 0...255) }).base64EncodedString())\"}"
        let body = Data(json.utf8)
        XCTAssertGreaterThan(body.count, 500_000)
        let big = RelayResponse(id: "b1", status: 200, data: body)

        let header = try RelayResponse.decode(RelayHandler.reply(big, store: store))
        let n = try XCTUnwrap(header.parts)
        XCTAssertGreaterThan(n, 1)
        XCTAssertEqual(header.status, 200)
        XCTAssertTrue(header.bodyData.isEmpty)

        // The Watch asks for each part; every reply fits one message.
        var parts: [Data] = []
        for i in 0..<n {
            let ask = try RelayRequest.decode(RelayRequest.part(of: header.id, index: i).encoded())
            XCTAssertLessThan(try ask.encoded().count, RelayHandler.maxWireSize)
            let p = try XCTUnwrap(ask.partOf)
            let part = try XCTUnwrap(store.take(p.id, p.index))
            XCTAssertLessThanOrEqual(part.count, RelayHandler.maxWireSize)
            parts.append(part)
        }
        XCTAssertEqual(try RelayParts.join(header, parts), big)
        // Dropped once the last part was taken.
        XCTAssertEqual(store.count, 0)
        XCTAssertNil(store.take("b1", 0))

        // A missing part fails the request instead of handing on half an answer.
        XCTAssertThrowsError(try RelayParts.join(header, Array(parts.dropLast())))
        XCTAssertThrowsError(try RelayParts.join(header, Array(parts.dropLast()) + [Data()]))
        // An ordinary request is never mistaken for a part request.
        XCTAssertNil(RelayRequest(method: "GET", path: "relay/part", query: ["id": "b1", "index": "0"]).partOf)
    }

    func testPartsExpireAfterTwoMinutes() {
        let store = RelayPartStore()
        let t0 = Date(timeIntervalSince1970: 1_000_000)
        store.put("a", [Data([1]), Data([2])], now: t0)
        XCTAssertEqual(store.take("a", 0, now: t0.addingTimeInterval(60)), Data([1]))
        // Two minutes after the last part was taken (each take restarts the time).
        XCTAssertNil(store.take("a", 1, now: t0.addingTimeInterval(60 + RelayPartStore.keep + 1)))
        XCTAssertNil(store.take("a", 5, now: t0))
        // Old answers the Watch never finished are cleared when the next one comes in.
        store.put("b", [Data([3])], now: t0.addingTimeInterval(60 + RelayPartStore.keep + 1))
        XCTAssertEqual(store.count, 1)
    }

    func testHubClientOverFakeTransport() async throws {
        let t = FakeTransport()
        let c = HubClient(transport: t)
        XCTAssertFalse(c.supportsStreaming)

        t.responses = [(200, Data("{\"ok\":true,\"version\":\"1\",\"db_seq\":7}".utf8))]
        let h = try await c.health()
        XCTAssertTrue(h.ok)
        XCTAssertEqual(h.db_seq, 7)
        XCTAssertEqual(t.calls.last?.method, "GET")
        XCTAssertEqual(t.calls.last?.path, "health")

        t.responses = [(200, Data("{\"changes\":[],\"seq\":3,\"more\":false}".utf8))]
        let ch = try await c.changes(since: 2, kinds: [.task, .note], space: .personal)
        XCTAssertEqual(ch.seq, 3)
        XCTAssertEqual(t.calls.last?.query, ["since": "2", "kinds": "task,note", "space": "personal"])

        t.responses = [(200, Data("{\"applied\":[{\"id\":\"e1\",\"seq\":4}],\"rejected\":[],\"seq\":4}".utf8))]
        let patch = Patch(id: "e1", kind: .log, ts: "2026-10-21T10:00:00.000Z", fields: ["type": "weight", "value": 162], create: true)
        let pushed = try await c.push(deviceId: "dev1", patches: [patch])
        XCTAssertEqual(pushed.applied.first?.seq, 4)
        let body = try JSONSerialization.jsonObject(with: t.calls.last!.body!) as! [String: Any]
        XCTAssertEqual(body["device_id"] as? String, "dev1")
        XCTAssertEqual(((body["patches"] as? [[String: Any]])?.first?["id"]) as? String, "e1")

        t.responses = [(200, Data("{\"device_id\":\"w1\"}".utf8))]
        let id = try await c.register(name: "Apple Watch", platform: .watch)
        XCTAssertEqual(id, "w1")
        XCTAssertEqual(t.calls.last?.path, "devices/register")

        t.responses = [(401, Data("{\"error\":\"unauthorized\"}".utf8))]
        do { _ = try await c.health(); XCTFail("expected error") }
        catch let e as HubError { XCTAssertTrue(e.isAuth); XCTAssertEqual(e, .http(status: 401, message: "unauthorized")) }

        t.error = HubError.phoneUnreachable
        do { _ = try await c.health(); XCTFail("expected error") }
        catch let e as HubError { XCTAssertEqual(e, .phoneUnreachable); XCTAssertEqual(e.errorDescription, "iPhone not reachable") }

        let streamFailed: Bool = await {
            do { for try await _ in c.live() {}; return false } catch { return true }
        }()
        XCTAssertTrue(streamFailed)
    }

    func testHTTPTransportRequestShape() {
        let t = HTTPTransport.make(urlString: "core.example-tailnet.ts.net:8787/", token: "tok")!
        XCTAssertEqual(t.baseURL.absoluteString, "https://core.example-tailnet.ts.net:8787", "a typed address is https")
        let r = t.request(method: "GET", path: "sync/changes", query: ["since": "0", "kinds": "task,note"])
        XCTAssertEqual(r.url?.absoluteString, "https://core.example-tailnet.ts.net:8787/sync/changes?kinds=task,note&since=0")
        XCTAssertEqual(HTTPTransport.hubURL("192.168.1.20:8787")?.absoluteString, "https://192.168.1.20:8787", "a home network address too")
        XCTAssertEqual(HTTPTransport.hubURL("127.0.0.1:8788")?.absoluteString, "http://127.0.0.1:8788", "only this computer stays http")
        XCTAssertEqual(HTTPTransport.hubURL("http://hub.lan:8787")?.absoluteString, "http://hub.lan:8787", "a scheme typed is kept")
        XCTAssertEqual(r.value(forHTTPHeaderField: "Authorization"), "Bearer tok")
        XCTAssertNil(HTTPTransport.make(urlString: "", token: "x"))
    }

    func testAnAnsweredWatchChatGivesItsQuestionAndAnswer() throws {
        let body = try JSONEncoder().encode(ChatRequest(session_id: "watch-2026-11-05-ab12cd34", message: "what's on tonight?"))
        let req = RelayRequest(method: "POST", path: "ai/chat", query: [:], body: body)
        let answer = Data(#"{"reply":"Gym at 6.","model":"m","backend":"ollama","redactions":0,"rules_applied":[]}"#.utf8)
        let chat = RelayHandler.answeredChat(req, RelayResponse(id: req.id, status: 200, data: answer))
        XCTAssertEqual(chat?.question, "what's on tonight?")
        XCTAssertEqual(chat?.answer, "Gym at 6.")
        XCTAssertEqual(chat?.session, "watch-2026-11-05-ab12cd34")
        let pending = Data(#"{"reply":"This restarts Plex.","model":"m","backend":"ollama","redactions":0,"rules_applied":[],"pending_action":{"id":"a","host":"core","command":"systemctl restart plex"}}"#.utf8)
        XCTAssertEqual(RelayHandler.answeredChat(req, RelayResponse(id: req.id, status: 200, data: pending))?.answer,
                       "This restarts Plex.\n\nApprove or decline this on your iPhone.")
        // A failed chat, another request, or an empty reply is nothing to tell.
        XCTAssertNil(RelayHandler.answeredChat(req, RelayResponse(id: req.id, status: 503, data: Data(#"{"error":"no model"}"#.utf8))))
        XCTAssertNil(RelayHandler.answeredChat(req, RelayResponse(id: req.id, status: 0, data: Data(), error: "timed out")))
        XCTAssertNil(RelayHandler.answeredChat(RelayRequest(method: "GET", path: "sync/changes", query: [:], body: nil), RelayResponse(id: "x", status: 200, data: answer)))
        let empty = Data(#"{"reply":"","model":"m","backend":"ollama","redactions":0,"rules_applied":[]}"#.utf8)
        XCTAssertNil(RelayHandler.answeredChat(req, RelayResponse(id: req.id, status: 200, data: empty)))
    }
}
