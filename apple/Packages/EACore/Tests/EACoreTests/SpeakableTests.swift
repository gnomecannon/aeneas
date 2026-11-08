import XCTest
@testable import EACore

final class SpeakableTests: XCTestCase {
    func testDropsMarkdownMarksAndKeepsTheWords() {
        XCTAssertEqual(Speakable.text("## Plan\n**Restart** the *service*, then check `systemctl status`."), "Plan\nRestart the service, then check systemctl status.")
    }

    func testNamesCodeBlocksInsteadOfReadingThem() {
        XCTAssertEqual(Speakable.text("Run this:\n```sh\nsudo zfs scrub tank\n```\nThen wait."), "Run this:\n (code block) \nThen wait.")
    }

    func testReadsLinkTextNotAddresses() {
        XCTAssertEqual(Speakable.text("See [the runbook](https://core/x) or https://example.com/a?b=c."), "See the runbook or a link")
    }

    func testDropsListMarkersAndQuoteMarks() {
        XCTAssertEqual(Speakable.text("- one\n- two\n1. three\n> note"), "one\ntwo\nthree\nnote")
    }

    func testLeavesSnakeCaseAndFileNamesAlone() {
        XCTAssertEqual(Speakable.text("Edit backup_now.sh and my_var."), "Edit backup_now.sh and my_var.")
    }
}
