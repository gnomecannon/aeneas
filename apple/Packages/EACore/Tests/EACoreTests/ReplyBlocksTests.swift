import XCTest
@testable import EACore

final class ReplyBlocksTests: XCTestCase {
    func testRepliesSplitIntoHeadingsListsCodeAndText() {
        let reply = "## This week\n\n- **Mon:** dentist\n  - bring the card\n1. Check smbd\n2) Restart it\n\n```sh\nsystemctl status smbd\n```\nDone."
        XCTAssertEqual(ReplyBlocks.parse(reply), [
            .heading("This week"), .gap,
            .bullet("**Mon:** dentist", indent: 0), .bullet("bring the card", indent: 1),
            .numbered("Check smbd", label: "1."), .numbered("Restart it", label: "2)"), .gap,
            .code("systemctl status smbd"), .text("Done."),
        ])
        XCTAssertEqual(ReplyBlocks.parse("```\nls -la\n"), [.code("ls -la")], "an unclosed fence is still code")
        XCTAssertEqual(ReplyBlocks.parse("Plain line.\n\n"), [.text("Plain line.")])
    }
}
