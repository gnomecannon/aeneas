import XCTest
@testable import EACore

final class CaptureSortTests: XCTestCase {
    /// Saved away from the hub, a capture asks the hub to sort it once it syncs, instead of waiting in Unsorted Info.
    @MainActor
    func testOfflineCaptureAsksTheHubToSortIt() async throws {
        let engine = SyncEngine(config: SharedConfig(suiteName: "capture-sort-\(UUID().uuidString)"), platform: .iphone, store: try SyncStore.inMemory())
        engine.schedulesNotifications = false
        let saved = await engine.capture("A skit where a robot runs a bakery")
        let e = try XCTUnwrap(saved)
        XCTAssertEqual(e.kind, .capture)
        XCTAssertEqual(e.bool("sort"), true)
        XCTAssertEqual(e.bool("processed"), false)
    }
}
