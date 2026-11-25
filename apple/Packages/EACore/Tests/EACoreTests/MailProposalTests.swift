import XCTest
@testable import EACore

/// A mail the assistant wrote for the owner to send with one tap (since 2026-11-24): the card's words and buttons, the
/// owner's taps, Edit into the writing box, and the chat's record of it. The same cases as the web's
/// (web/src/lib/mailProposal.test.ts). Made-up addresses.
final class MailProposalTests: XCTestCase {
    private func view(_ state: String, error: String? = nil) -> MailProposal {
        MailProposal(id: "p1", from: MailAddress(name: "Robin", address: "robin@example.com"), to: ["alex@example.com"], subject: "Saturday", text: "Saturday works.", state: state, error: error)
    }

    func testTheCardSaysNothingIsSentUntilSendAndOffersSendEditCancel() {
        let f = Mail.proposalFace(view("proposed"))
        XCTAssertEqual(f.line, "Nothing is sent until you tap Send.")
        XCTAssertEqual(f.buttons, [.send, .edit, .cancel])
        XCTAssertTrue(f.showMail)
        XCTAssertEqual(Mail.proposalFace(view("waiting")).buttons, [.undo], "Sending, with Undo")
        XCTAssertEqual(Mail.proposalFace(view("waiting")).line, "Sending")
        XCTAssertEqual(Mail.proposalFace(view("sending")).buttons, [])
        XCTAssertEqual(Mail.proposalFace(view("sent")).line, "Sent.")
        XCTAssertEqual(Mail.proposalFace(view("sent")).buttons, [], "once sent, its buttons go")
        let why = "iCloud Mail did not accept the account's password for sending, so the mail was not sent. Check the app password in Settings, Accounts."
        let failed = Mail.proposalFace(view("failed", error: why))
        XCTAssertEqual([failed.line, failed.error], ["Not sent", why])
        XCTAssertEqual(failed.buttons, [.retry, .edit, .cancel])
        XCTAssertEqual(Mail.proposalFace(view("cancelled")).line, "Cancelled. Nothing was sent.")
        XCTAssertEqual(Mail.proposalFace(view("edited")).line, "Opened on the Mail screen to edit. Send it from there.")
    }

    func testAProposalTheHubNoLongerKeepsSaysHowItEndedElseThatItExpired() {
        XCTAssertEqual(Mail.proposalFace(nil).line, "This mail expired after 24 hours. Nothing was sent.")
        XCTAssertEqual(Mail.proposalFace(nil, stored: "sent").line, "Sent.")
        XCTAssertEqual(Mail.proposalFace(nil, stored: "cancelled").line, "Cancelled. Nothing was sent.")
        XCTAssertEqual(Mail.proposalFace(nil, stored: "edited").buttons, [])
        XCTAssertFalse(Mail.proposalFace(nil).showMail)
        for t in [Mail.ProposalTexts.title, Mail.ProposalTexts.notSent, Mail.ProposalTexts.expired, Mail.ProposalTexts.edited, Mail.ProposalTexts.watchEdit] {
            XCTAssertNil(t.range(of: "[\u{2013}\u{2014}]", options: .regularExpression), t)
        }
    }

    func testTheOwnersTapsAndEditCallTheHub() async throws {
        let t = FakeTransport()
        let card = #"{"id":"p1","from":{"name":"Robin","address":"robin@example.com"},"to":["alex@example.com"],"cc":["sam@example.com"],"subject":"Gutters","text":"Done.","files":[],"state":"waiting","expires_at":"2026-11-25T10:00:00.000Z"}"#
        let png = "iVBORw0KGgo="
        t.responses = [(200, Data(card.utf8)), (404, Data(#"{"error":"gone"}"#.utf8)),
                       (200, Data(#"{"from":"robin@example.com","to":["alex@example.com"],"cc":["sam@example.com"],"subject":"Gutters","text":"Done.","files":[{"name":"Photo 1.png","type":"image/png","data":"\#(png)"}]}"#.utf8))]
        let c = HubClient(transport: t)
        let sent = try await c.mailProposalAct("p1", .send)
        XCTAssertEqual([sent.state, sent.cc.first], ["waiting", "sam@example.com"])
        let gone = try await c.mailProposal("p1")
        XCTAssertNil(gone, "expired: nil, not an error")
        let e = try await c.mailProposalEdit("p1")
        let w = e.writing
        XCTAssertEqual([w.from, w.to, w.cc, w.subject, w.text], ["robin@example.com", "alex@example.com", "sam@example.com", "Gutters", "Done."])
        XCTAssertEqual(w.files.map(\.name), ["Photo 1.png"])
        XCTAssertFalse(w.dirty, "typed by the assistant: Discard asks only once the owner changes it")
        XCTAssertEqual(t.calls.map { "\($0.method) \($0.path)" }, ["POST mail/proposals/p1/send", "GET mail/proposals/p1", "POST mail/proposals/p1/edit"])
        // The box sends its Cc with a new mail.
        let r = Mail.draftRequest(.fresh, w, files: [], preview: false)
        XCTAssertEqual(r.cc, "sam@example.com")
    }

    func testTheChatKeepsTheProposalOnItsReplyAndTheWatchSeesIt() throws {
        let json = #"{"session_id":"watch-1","title":"Mail","task_type":"auto","created_at":"2026-11-24T10:00:00Z","last_at":"2026-11-24T10:00:00Z","messages":[{"role":"user","content":"Email Alex"},{"role":"assistant","content":"It is below. Nothing is sent until you tap Send.","mail_proposal":{"id":"p1","state":"sent"}}]}"#
        let s = try JSONCoding.decode(AISession.self, from: Data(json.utf8))
        XCTAssertEqual(s.messages.last?.mail_proposal, ChatMailProposal(id: "p1", state: "sent"))
        XCTAssertEqual(ChatTurn.turns(of: s).first?.mail, ChatMailProposal(id: "p1", state: "sent"))
        XCTAssertEqual(ToolAction.label("propose_mail"), "Writing a mail for you to send")
    }
}
