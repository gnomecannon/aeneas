import XCTest
@testable import EACore

final class ImageWorkerTests: XCTestCase {
    func testCapabilitiesCarryTheHubsWorkersAndTheirLabels() throws {
        let caps = try JSONCoding.decode(ImageCapabilities.self, from: Data(#"{"enabled":true,"hardware":[{"id":"gpu-a","label":"Big GPU"},{"id":"gpu-b","label":"Desktop GPU"}]}"#.utf8))
        let w = caps.hardware ?? []
        XCTAssertEqual(w.map(\.id), ["gpu-a", "gpu-b"])
        XCTAssertEqual(w.label(for: "gpu-b"), "Desktop GPU")
        XCTAssertEqual(w.label(for: "other"), "other", "an unknown worker shows its id")
        XCTAssertEqual(w.whereLabel(["gpu-a"]), "Big GPU")
        XCTAssertEqual(w.whereLabel([]), "Big GPU or Desktop GPU", "no eligible list: any known worker")
        XCTAssertEqual([ImageWorker]().whereLabel([]), "Auto")
        let none = try JSONCoding.decode(ImageCapabilities.self, from: Data(#"{"enabled":false}"#.utf8))
        XCTAssertNil(none.hardware)
    }
}
