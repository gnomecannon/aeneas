import XCTest
@testable import EACore

/// A Watch relay with its message limit, in front of a hub that answers pushes, captures and lookups.
final class RelayLimitTransport: HubTransport, @unchecked Sendable {
    private let lock = NSLock()
    private(set) var pushes = 0
    private(set) var refused = 0
    private(set) var hubCaptures: [String: String] = [:]
    private(set) var pushedCaptureCreates: [String] = []
    /// POST /capture is applied on the "hub", but its reply is lost.
    var loseCaptureReply = false

    func send(method: String, path: String, query: [String: String], body: Data?) async throws -> (status: Int, data: Data) {
        let payload = try RelayRequest(method: method, path: path, query: query, body: body).encoded()
        if payload.count > RelayHandler.maxWireSize {
            lock.withLock { refused += 1 }
            throw HubError.transport("Request too large for the Watch relay (\(payload.count / 1024) KB)")
        }
        switch path {
        case "sync/push":
            let req = try JSONCoding.decode(PushRequest.self, from: body!)
            lock.withLock {
                pushes += 1
                for p in req.patches where p.kind == .capture && p.create == true { pushedCaptureCreates.append(p.id) }
            }
            let applied = req.patches.enumerated().map { "{\"id\":\"\($0.element.id)\",\"seq\":\($0.offset + 1)}" }.joined(separator: ",")
            return (200, Data("{\"applied\":[\(applied)],\"rejected\":[],\"seq\":1}".utf8))
        case "sync/changes":
            return (200, Data("{\"changes\":[],\"seq\":1,\"more\":false}".utf8))
        case "capture":
            let obj = try JSONSerialization.jsonObject(with: body!) as! [String: Any]
            let id = obj["id"] as? String ?? UUID().uuidString.lowercased()
            lock.withLock { hubCaptures[id] = obj["text"] as? String ?? "" }
            if loseCaptureReply { throw HubError.transport("The iPhone did not answer in time") }
            return (201, Data(#"{"capture":\#(Self.capture(id, obj["text"] as? String ?? "")),"suggested_kind":"none"}"#.utf8))
        default:
            if path.hasPrefix("entities/") {
                let id = String(path.dropFirst("entities/".count))
                if let text = lock.withLock({ hubCaptures[id] }) { return (200, Data(Self.capture(id, text).utf8)) }
                return (404, Data(#"{"error":"not found"}"#.utf8))
            }
            return (200, Data("{}".utf8))
        }
    }

    static func capture(_ id: String, _ text: String) -> String {
        #"{"id":"\#(id)","kind":"capture","space":"personal","created_at":"2026-11-05T05:00:00Z","updated_at":"2026-11-05T05:00:00Z","deleted_at":null,"fields":{"text":"\#(text)","source":"watch","processed":true,"diary_id":"d1"}}"#
    }
}

final class RelayLimitTests: XCTestCase {
    @MainActor
    func testALongWatchQueueGoesOutInPiecesThatFitTheRelay() async throws {
        let config = SharedConfig(suiteName: "relay-limit-\(UUID().uuidString)")
        config.deviceId = "watch-1"
        let engine = SyncEngine(config: config, platform: .watch, store: try SyncStore.inMemory())
        engine.schedulesNotifications = false
        // 200 weight logs made while the iPhone was away: one push of all of them is several times the relay's limit.
        let batch = (0..<200).map { _ in
            Patch(id: UUID().uuidString.lowercased(), kind: .log, space: .personal, ts: ISO.now(),
                  fields: ["type": "weight", "value": .number(162.5), "unit": "lb", "at": .string(ISO.now()), "source": "watch"], create: true)
        }
        await engine.applyBatch(batch)
        XCTAssertEqual(engine.outboxCount, 200)
        let t = RelayLimitTransport()
        engine.makeClient = { HubClient(transport: t) }
        await engine.start()
        XCTAssertEqual(engine.outboxCount, 0, "the queue drained")
        XCTAssertEqual(t.refused, 0, "no push was too big for the relay")
        XCTAssertGreaterThan(t.pushes, 1)
        engine.stop()
    }

    @MainActor
    func testACaptureWhoseReplyIsLostIsNotSavedTwice() async throws {
        let config = SharedConfig(suiteName: "relay-capture-\(UUID().uuidString)")
        config.deviceId = "watch-1"
        let engine = SyncEngine(config: config, platform: .watch, store: try SyncStore.inMemory())
        engine.schedulesNotifications = false
        let t = RelayLimitTransport()
        engine.makeClient = { HubClient(transport: t) }
        await engine.start()
        t.loseCaptureReply = true
        let saved = await engine.capture("Buy dog food")
        await engine.sync()
        XCTAssertEqual(t.hubCaptures.count, 1)
        XCTAssertEqual(saved?.id, t.hubCaptures.keys.first, "the hub's copy, found by the capture's own id")
        XCTAssertEqual(t.pushedCaptureCreates, [], "no second copy went out to be sorted again")
        engine.stop()
    }

    func testAPartStoreKeepsALongAnswerWhileItIsBeingFetched() {
        let store = RelayPartStore()
        let start = Date()
        store.put("r1", (0..<5).map { Data([UInt8($0)]) }, now: start)
        // A part a minute: the whole answer takes longer than two minutes, but each part comes within them.
        for i in 0..<5 {
            XCTAssertEqual(store.take("r1", i, now: start.addingTimeInterval(Double(i + 1) * 60)), Data([UInt8(i)]), "part \(i)")
        }
        store.put("r2", [Data([1]), Data([2])], now: start)
        XCTAssertNil(store.take("r2", 0, now: start.addingTimeInterval(121)), "an answer nobody fetches still goes")
    }
}
