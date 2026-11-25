import XCTest
@testable import EACore

final class CaptureSortTests: XCTestCase {
    /// Unsorted Info names where a capture came from as people say it, as the web does (captureSourceLabel).
    func testWhereACaptureCameFromIsNamedAsPeopleSayIt() {
        XCTAssertEqual(Source.label("iphone"), "iPhone")
        XCTAssertEqual(Source.label("watch"), "Watch")
        XCTAssertEqual(Source.label("shortcut"), "Shortcut")
        XCTAssertEqual(Source.label("api"), "API")
        XCTAssertEqual(Source.label("newthing"), "newthing", "a source a later hub adds shows as it is")
        XCTAssertEqual(Source.allCases.filter { Source.label($0.rawValue) == $0.rawValue }, [], "every source has a name")
        XCTAssertEqual(Platform.mac.name, "Mac", "Settings, About names the device the same way")
        XCTAssertEqual(Platform.allCases.filter { $0.name == $0.rawValue }, [])
    }

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
