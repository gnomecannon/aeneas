import XCTest
@testable import EACore

/// The journal form's pre-flight: the hub's answer passes through; harmless text and an unreachable hub show nothing.
final class PreflightClientTests: XCTestCase {

    func testDestructiveCommandComesBackWithTheAssistantsWording() async throws {
        let t = FakeTransport()
        t.responses = [(200, Data("""
        {"destructive":true,"name":"zfs destroy","command":"zfs destroy -r tank/scratch","backup":"Back up: `zfs snapshot <dataset>@pre-destroy` and send it off the pool.","verify":"Verify: `zfs list -r -t all <dataset>`; check for children, clones and holds.","rollback":"Rollback: receive the sent snapshot back. A destroyed dataset is gone from the pool.","block":"Pre-flight for `zfs destroy -r tank/scratch` (zfs destroy):\\n- Back up: x\\n- Verify: y\\n- Rollback: z"}
        """.utf8))]
        let hit = try await HubClient(transport: t).preflight(text: "zfs destroy -r tank/scratch")
        XCTAssertEqual(t.calls.last?.method, "POST")
        XCTAssertEqual(t.calls.last?.path, "preflight")
        let sent = try JSONSerialization.jsonObject(with: t.calls.last?.body ?? Data()) as? [String: Any]
        XCTAssertEqual(sent?["text"] as? String, "zfs destroy -r tank/scratch")
        XCTAssertEqual(hit?.name, "zfs destroy")
        XCTAssertTrue(hit?.block.hasPrefix("Pre-flight for `zfs destroy -r tank/scratch` (zfs destroy):\n- Back up:") ?? false)
        XCTAssertEqual(hit?.rollbackText, "receive the sent snapshot back. A destroyed dataset is gone from the pool.")
    }

    func testHarmlessBlankAndOfflineAreQuiet() async throws {
        let t = FakeTransport()
        t.responses = [(200, Data(#"{"destructive":false}"#.utf8))]
        let c = HubClient(transport: t)
        let harmless = await c.preflightQuietly(text: "zpool status tank")
        XCTAssertNil(harmless)
        let blank = await c.preflightQuietly(text: "   ")
        XCTAssertNil(blank)
        XCTAssertEqual(t.calls.count, 1)
        t.error = URLError(.notConnectedToInternet)
        let offline = await c.preflightQuietly(text: "rm -rf /srv/old")
        XCTAssertNil(offline)
        t.error = nil
        t.responses = [(404, Data(#"{"error":"not found"}"#.utf8))]
        let olderHub = await c.preflightQuietly(text: "rm -rf /srv/old")
        XCTAssertNil(olderHub)
    }
}
