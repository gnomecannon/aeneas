import XCTest
@testable import EACore

/// Sending from the Mail screen (since 2026-11-24): when Send is offered, what the box says, how a mail in the outbox
/// shows, the calls the screen makes, and another account's sending server. The same cases as the web's
/// (web/src/lib/mail-send.test.ts, web/src/views/settings/Accounts.test.ts). Made-up addresses.
final class MailSendTests: XCTestCase {
    private func box(canSend: Bool? = nil, readOnly: Bool? = nil, kind: String = "gmail", provider: String = "Gmail") -> MailMailbox {
        MailMailbox(email: "robin@example.com", provider: provider, kind: kind, read_only: readOnly, can_send: canSend)
    }

    func testSendIsOfferedOnlyForAMailboxWithASendingServerThatIsNotReadOnly() {
        XCTAssertTrue(Mail.canSend(box(canSend: true)))
        XCTAssertFalse(Mail.canSend(box(canSend: true, readOnly: true)))
        XCTAssertFalse(Mail.canSend(box(canSend: false)))
        XCTAssertFalse(Mail.canSend(box()), "an older hub: drafts only, as before")
        XCTAssertFalse(Mail.canSend(nil))
    }

    func testTheBoxSaysWhetherItSendsOrSavesAndHowAnotherAccountCanSend() {
        XCTAssertEqual(Mail.writeNote(box(canSend: true)), "Preview shows the whole mail, then you send it or save it as a draft.")
        XCTAssertEqual(Mail.previewNote(box(canSend: true)), "This is the whole mail. Send it, or save it as a draft.")
        XCTAssertEqual(Mail.writeNote(box(canSend: false, kind: "icloud", provider: "iCloud")), "Saved to Drafts in iCloud, to send from Apple Mail.")
        XCTAssertEqual(Mail.previewNote(box(canSend: false, kind: "imap", provider: "mail.example.org")),
                       "This is the whole mail. Save it to Drafts, then send it from your mail app. To send from here, add a sending server on this account's page in Settings, Accounts.")
    }

    func testAMailInTheOutboxShowsAsTheWebShowsIt() {
        XCTAssertEqual(Mail.outboxFace(MailOutboxItem(id: "o1", state: "waiting")), .sending(undo: true))
        XCTAssertEqual(Mail.outboxFace(MailOutboxItem(id: "o1", state: "sending")), .sending(undo: false))
        XCTAssertEqual(Mail.outboxFace(MailOutboxItem(id: "o1", state: "sent")), .sent)
        let why = "Gmail did not accept the account's password for sending, so the mail was not sent. Check the app password in Settings, Accounts."
        XCTAssertEqual(Mail.outboxFace(MailOutboxItem(id: "o1", state: "failed", error: why)), .failed(why))
        XCTAssertEqual(Mail.outboxFace(nil), .gone)
        XCTAssertEqual(Mail.outboxLine(MailOutboxItem(id: "o1", to: ["alex@example.com"], subject: "Plans", state: "failed")), "Not sent: Plans, to alex@example.com")
        XCTAssertEqual(Mail.outboxLine(MailOutboxItem(id: "o1", to: ["a@example.com", "b@example.com", "c@example.com", "d@example.com", "e@example.com"], subject: " ", state: "failed")),
                       "Not sent: (no subject), to a@example.com, b@example.com, c@example.com and 2 more")
        for t in [Mail.SendTexts.write, Mail.SendTexts.preview, Mail.SendTexts.noServer, Mail.SendTexts.discard, AccountTexts.Sending.note, AccountTexts.Sending.none, AccountTexts.Sending.form, AccountTexts.Sending.optional] {
            XCTAssertNil(t.range(of: "[\u{2013}\u{2014}]", options: .regularExpression), t)
        }
    }

    func testTheListCarriesTheOutboxAndWhetherEachMailboxSends() throws {
        let json = #"{"messages":[],"mailboxes":[{"email":"robin@example.com","last_refresh":null,"last_error":null,"more":false,"kind":"gmail","provider":"Gmail","read_only":false,"can_send":true}],"outbox":[{"id":"o1","mailbox":"robin@example.com","to":["alex@example.com"],"subject":"Plans","state":"failed","send_at":"2026-11-24T10:00:10.000Z","error":"Not sent.","refused":["alex@example.com"]}]}"#
        let l = try JSONCoding.decode(MailList.self, from: Data(json.utf8))
        XCTAssertEqual(l.mailboxes.first?.can_send, true)
        XCTAssertEqual(l.outbox, [MailOutboxItem(id: "o1", mailbox: "robin@example.com", to: ["alex@example.com"], subject: "Plans", state: "failed", send_at: "2026-11-24T10:00:10.000Z", error: "Not sent.", refused: ["alex@example.com"])])
        let older = try JSONCoding.decode(MailList.self, from: Data(#"{"messages":[],"mailboxes":[{"email":"robin@example.com","more":false}]}"#.utf8))
        XCTAssertEqual(older.outbox, [])
        XCTAssertNil(older.mailboxes.first?.can_send)
    }

    func testSendUndoTryAgainAndSaveDraftCallTheHubsOutbox() async throws {
        let t = FakeTransport()
        t.responses = [
            (200, Data(#"{"id":"o1","send_at":"2026-11-24T10:00:10.000Z","state":"waiting","from":{"name":"Robin","address":"robin@example.com"},"to":["alex@example.com"],"subject":"Plans","text":"Hi"}"#.utf8)),
            (200, Data(#"{"undone":true}"#.utf8)),
            (404, Data(#"{"error":"This mail is not in the outbox any more."}"#.utf8)),
            (200, Data(#"{"id":"o1","mailbox":"robin@example.com","to":["alex@example.com"],"subject":"Plans","state":"waiting","send_at":"2026-11-24T10:01:10.000Z"}"#.utf8)),
            (200, Data(#"{"saved":true}"#.utf8)),
        ]
        let c = HubClient(transport: t)
        var w = Mail.Writing()
        w.to = "alex@example.com"; w.subject = "Plans"; w.text = "Hi"
        let sent = try await c.mailSend(Mail.draftRequest(.fresh, w, files: [], preview: false))
        XCTAssertEqual(sent.item, MailOutboxItem(id: "o1", mailbox: "robin@example.com", to: ["alex@example.com"], subject: "Plans", state: "waiting", send_at: "2026-11-24T10:00:10.000Z"))
        try await c.mailOutboxUndo("o1")
        let gone = try await c.mailOutbox("o1")
        XCTAssertNil(gone, "not in the outbox: nil, not an error")
        let again = try await c.mailOutboxRetry("o1")
        XCTAssertEqual(again.state, "waiting")
        try await c.mailOutboxDraft("o1")
        XCTAssertEqual(t.calls.map { "\($0.method) \($0.path)" }, ["POST mail/send", "POST mail/outbox/o1/undo", "GET mail/outbox/o1", "POST mail/outbox/o1/retry", "POST mail/outbox/o1/draft"])
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: t.calls[0].body ?? Data()) as? NSDictionary)
        XCTAssertEqual(body, ["to": "alex@example.com", "subject": "Plans", "text": "Hi"], "the draft's own request, with no preview")
    }

    func testUnsubscribeByMailIsSentAfterTheWholeMailIsShownElseSavedToDrafts() async throws {
        XCTAssertEqual(Mail.UnsubscribeTexts.send, "Send the unsubscribe mail\u{2026}")
        XCTAssertEqual(Mail.unsubscribeNote(to: "unsub@news.example", sends: true), "To unsub@news.example. You see the whole mail before it goes.")
        XCTAssertEqual(Mail.unsubscribeNote(to: "unsub@news.example", sends: false), "To unsub@news.example, saved in Drafts for you to send.")
        XCTAssertEqual(Mail.UnsubscribeTexts.confirm, "This is the whole mail. Send it?")
        XCTAssertEqual(Mail.unsubscribeSent(to: "unsub@news.example"), "Sent. The unsubscribe mail went to unsub@news.example.")
        for t in [Mail.UnsubscribeTexts.send, Mail.UnsubscribeTexts.write, Mail.UnsubscribeTexts.confirm, Mail.unsubscribeNote(to: "a@b.example", sends: true), Mail.unsubscribeSent(to: "a@b.example")] {
            XCTAssertNil(t.range(of: "[\u{2013}\u{2014}]", options: .regularExpression), t)
        }
        let t = FakeTransport()
        t.responses = [(200, Data(#"{"ok":true,"outbox":{"id":"o2","mailbox":"robin@example.com","to":["unsub@news.example"],"subject":"stop","state":"waiting","send_at":"2026-11-24T10:00:10.000Z"}}"#.utf8))]
        let item = try await HubClient(transport: t).mailUnsubscribeSend("m1")
        XCTAssertEqual(item, MailOutboxItem(id: "o2", mailbox: "robin@example.com", to: ["unsub@news.example"], subject: "stop", state: "waiting", send_at: "2026-11-24T10:00:10.000Z"))
        XCTAssertEqual(t.calls.map { "\($0.method) \($0.path)" }, ["POST mail/messages/m1/unsubscribe"])
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: t.calls[0].body ?? Data()) as? NSDictionary)
        XCTAssertEqual(body, ["how": "mailto", "send": true], "only how and send: the hub reads the address from the mail")
    }

    func testASendingServerIsShownInWordsAndTypedWithThePortFromTheSecurity() async throws {
        XCTAssertEqual(SendingServer(host: "smtp.gmail.com", port: 465, security: "tls").line, "smtp.gmail.com, port 465, TLS")
        XCTAssertEqual(SendingServer(host: "smtp.mail.me.com", port: 587, security: "starttls").line, "smtp.mail.me.com, port 587, STARTTLS")
        XCTAssertEqual(SendingServer.typed(host: " smtp.fastmail.com ", port: "", security: "tls"), SendingServer(host: "smtp.fastmail.com", port: 465, security: "tls"))
        XCTAssertEqual(SendingServer.typed(host: "smtp.fastmail.com", port: "", security: "starttls"), SendingServer(host: "smtp.fastmail.com", port: 587, security: "starttls"))
        XCTAssertNil(SendingServer.typed(host: "", port: "465", security: "tls"))
        XCTAssertEqual(Mail.smtpGuess("imap.fastmail.com"), "smtp.fastmail.com", "a hint only")
        XCTAssertEqual(Mail.smtpGuess("mail.example.org"), "mail.example.org")

        // Add account, Other mail, sends the server with the account; the account's page sets or removes it.
        let t = FakeTransport()
        t.responses = [(200, Data("{}".utf8)), (200, Data(#"{"smtp":{"host":"smtp.example.com","port":587,"security":"starttls"}}"#.utf8)), (200, Data(#"{"smtp":null}"#.utf8))]
        let c = HubClient(transport: t)
        let form = NewAccount(kind: .other, email: "jamie@example.com", password: "secret one", host: "imap.example.com", port: 993, smtp: SendingServer.typed(host: "smtp.example.com", port: "", security: "starttls"))
        _ = try await c.addAccount(form, isOn: { _ in true }) { _ in }
        let link = try XCTUnwrap(JSONSerialization.jsonObject(with: t.calls[0].body ?? Data()) as? NSDictionary)
        XCTAssertEqual(link["smtp"] as? NSDictionary, ["host": "smtp.example.com", "port": 587, "security": "starttls"])
        let kept = try await c.setSendingServer(key: "imap:jamie@example.com", SendingServer(host: "smtp.example.com", port: 587, security: "starttls"))
        XCTAssertEqual(kept?.host, "smtp.example.com")
        let none = try await c.setSendingServer(key: "imap:jamie@example.com", nil)
        XCTAssertNil(none)
        XCTAssertEqual(t.calls.map { "\($0.method) \($0.path)" }.suffix(2), ["PUT connections/accounts/imap:jamie@example.com/sending", "PUT connections/accounts/imap:jamie@example.com/sending"])
        XCTAssertEqual(String(data: t.calls[2].body ?? Data(), encoding: .utf8), #"{"smtp":null}"#, "null, so the hub removes it")
    }
}
