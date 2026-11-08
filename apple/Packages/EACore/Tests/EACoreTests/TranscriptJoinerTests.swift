import XCTest
@testable import EACore

final class TranscriptJoinerTests: XCTestCase {
    func testAPauseThatStartsAFreshUtteranceKeepsTheEarlierWords() {
        var j = TranscriptJoiner()
        for p in ["So", "So I'm going", "So I'm going to create a flag", "So I'm going to create a flag, um,"] { j.update(p) }
        // After the pause the recognizer reports only the new words.
        for p in ["It", "It needs to be", "It needs to be a really cool one."] { j.update(p) }
        XCTAssertEqual(j.text, "So I'm going to create a flag, um, It needs to be a really cool one.")
    }

    func testRevisionsReplaceInsteadOfRepeating() {
        var j = TranscriptJoiner()
        for p in ["sew", "So I'm", "So I'm going to the store", "So I'm going to the stores"] { j.update(p) }
        XCTAssertEqual(j.text, "So I'm going to the stores")
    }

    func testARestartKeepsWhatWasHeard() {
        var j = TranscriptJoiner()
        j.update("First part.")
        j.endRun()
        j.update("Second")
        j.update("Second part.")
        XCTAssertEqual(j.text, "First part. Second part.")
    }
}
