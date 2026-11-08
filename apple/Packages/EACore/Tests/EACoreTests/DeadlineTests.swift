import XCTest
@testable import EACore

final class DeadlineTests: XCTestCase {
    private final class Flag: @unchecked Sendable {
        private var on = false
        private let lock = NSLock()
        func set() { lock.lock(); on = true; lock.unlock() }
        var value: Bool { lock.lock(); defer { lock.unlock() }; return on }
    }

    func testAnswerInTimeElseFallbackAndTheWorkCarriesOn() async throws {
        let fast = await Deadline.answer(within: 2, otherwise: "late") { "on time" }
        XCTAssertEqual(fast, "on time")

        let finished = Flag()
        let slow = await Deadline.answer(within: 0.05, otherwise: "late") {
            try? await Task.sleep(nanoseconds: 300_000_000)
            finished.set()
            return "slow"
        }
        XCTAssertEqual(slow, "late")
        XCTAssertFalse(finished.value)
        // Siri has moved on, but the answer still comes in.
        try await Task.sleep(nanoseconds: 600_000_000)
        XCTAssertTrue(finished.value)
    }
}
