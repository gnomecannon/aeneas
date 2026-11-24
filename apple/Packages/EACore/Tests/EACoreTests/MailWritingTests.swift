import XCTest
@testable import EACore

/// Writing mail, attachments, folders, moves, search, cards, trips and the model's sorting on the Apple apps: the same
/// rules as the web's (web/src/lib/mail.test.ts), so a draft, a folder, a card or a hit reads the same on every device.
/// Made-up mail only (gnomecannon/aeneas#8).
final class MailWritingTests: XCTestCase {
    private var cal: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "America/New_York")!
        c.locale = Locale(identifier: "en_US")
        return c
    }()

    private func json(_ r: MailDraftRequest) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: JSONCoding.data(r)) as? [String: Any])
    }

    // MARK: Drafts

    func testAsksForAReplyAForwardAndANewMailAsTheHubTakesThem() throws {
        var w = Mail.Writing()
        w.to = "alex@example.com"; w.subject = "Gutters"; w.text = "Saturday works."; w.greeting = "Hi Alex,"; w.signoff = "  "
        let reply = try json(Mail.draftRequest(.reply("m1", all: false), w, files: [], preview: true))
        XCTAssertEqual(reply as NSDictionary, ["reply_to": "m1", "text": "Saturday works.", "greeting": "Hi Alex,", "preview": true] as NSDictionary)
        w.greeting = ""
        let all = try json(Mail.draftRequest(.reply("m1", all: true), w, files: [], preview: false))
        XCTAssertEqual(all as NSDictionary, ["reply_to": "m1", "reply_all": true, "text": "Saturday works."] as NSDictionary)
        w.withTheirs = true
        let file = MailDraftFileIn(name: "plan.pdf", type: "application/pdf", data: "AA==")
        let fwd = try json(Mail.draftRequest(.forward("m1"), w, files: [file], preview: false))
        XCTAssertEqual(fwd["forward"] as? String, "m1")
        XCTAssertEqual(fwd["to"] as? String, "alex@example.com")
        XCTAssertEqual(fwd["forward_attachments"] as? Bool, true)
        XCTAssertEqual((fwd["files"] as? [[String: String]])?.first, ["name": "plan.pdf", "type": "application/pdf", "data": "AA=="])
        XCTAssertNil(fwd["subject"], "a forward's subject is the hub's: Fwd: and the mail's")
        w.withTheirs = false
        let fresh = try json(Mail.draftRequest(.fresh, w, files: [], preview: false))
        XCTAssertEqual(fresh as NSDictionary, ["to": "alex@example.com", "subject": "Gutters", "text": "Saturday works."] as NSDictionary)
        XCTAssertEqual(try json(Mail.draftRequest(.fresh, w, files: [], preview: false, from: "robin@northwind.example"))["from"] as? String, "robin@northwind.example")
        // Only a changed draft names old attachments.
        w.kept = [MailAttachment(part: "2", name: "a.pdf", size: 1)]
        for what in [Mail.DraftFor.reply("m1", all: false), .forward("m1"), .fresh] {
            XCTAssertNil(try json(Mail.draftRequest(what, w, files: [], preview: false))["keep_parts"])
        }
    }

    func testAChangedDraftAlwaysSaysWhichOfItsOldAttachmentsStayAnEmptyListToo() throws {
        var w = Mail.Writing()
        w.to = "alex@example.com"; w.subject = "Gutters"; w.text = "Saturday works."
        w.kept = [MailAttachment(part: "2", name: "a.pdf", size: 1), MailAttachment(part: "3.1", name: "b.pdf", size: 1)]
        let r = try json(Mail.draftRequest(.draft("d1", from: "robin@northwind.example"), w, files: [], preview: true))
        XCTAssertEqual(r as NSDictionary, ["to": "alex@example.com", "subject": "Gutters", "replaces": "d1", "keep_parts": ["2", "3.1"],
                                            "from": "robin@northwind.example", "text": "Saturday works.", "preview": true] as NSDictionary)
        w.kept = []
        let none = try json(Mail.draftRequest(.draft("d1", from: "robin@northwind.example"), w, files: [], preview: false))
        XCTAssertEqual(none["keep_parts"] as? [String], [])
        XCTAssertNil(none["preview"])
    }

    func testKeepsOneWritingBoxForReplyAndReplyAll() {
        XCTAssertEqual(Mail.writingKey(.reply("m1", all: false)), Mail.writingKey(.reply("m1", all: true)))
        XCTAssertNotEqual(Mail.writingKey(.reply("m1", all: false)), Mail.writingKey(.forward("m1")))
        XCTAssertEqual(Mail.writingKey(.fresh), Mail.newMailKey)
    }

    func testReadsWhatTheHubSavedOrWouldSave() throws {
        let d = try JSONCoding.decode(MailDraft.self, from: """
        {"saved":false,"from":{"name":"Robin","address":"robin@icloud.example"},"to":["alex@example.com"],"cc":["sam@example.com"],"bcc":["jamie@example.com"],
         "subject":"Re: Gutters","text":"Hi Alex,\\n\\nSaturday works.","in_reply_to":"<a@x>","files":[{"name":"plan.pdf","size":2048}]}
        """)
        XCTAssertFalse(d.saved)
        XCTAssertEqual(d.cc, ["sam@example.com"])
        XCTAssertEqual(d.bcc, ["jamie@example.com"])
        XCTAssertEqual(d.files.first?.size, 2048)
        let g = try JSONCoding.decode(MailGreeting.self, from: #"{"greeting":"Hi Alex,","signoff":"Thanks,\nRobin","by":"plain"}"#)
        XCTAssertEqual(g.replies, [], "no model, no suggested replies")
    }

    // MARK: Mailboxes in words

    private let boxes = [MailMailbox(email: "robin@northwind.example", provider: "iCloud", kind: "icloud"),
                         MailMailbox(email: "robin@larkspur.example", provider: "Gmail", kind: "gmail"),
                         MailMailbox(email: "robin@fabrikam.example")]

    func testKnowsAMailsMailboxTheOneItNamesElseTheOnlyOneLinked() {
        XCTAssertEqual(Mail.mailboxOf(boxes, "ROBIN@larkspur.example")?.kind, "gmail")
        XCTAssertNil(Mail.mailboxOf(boxes, nil))
        XCTAssertEqual(Mail.mailboxOf([boxes[0]], nil)?.email, "robin@northwind.example")
        XCTAssertNil(Mail.mailboxOf(boxes, "sam@fourthcoffee.example"))
    }

    func testNamesTheProviderAndTheMailAppOnlyAsFarAsTheyAreKnown() {
        XCTAssertEqual([Mail.inProvider(boxes[0]), Mail.inProvider(boxes[1]), Mail.inProvider(boxes[2]), Mail.inProvider(nil)], ["in iCloud", "in Gmail", "in your mailbox", "in your mailbox"])
        XCTAssertEqual([Mail.mailApp(boxes[0]), Mail.mailApp(boxes[1]), Mail.mailApp(nil)], ["Apple Mail", "your mail app", "your mail app"])
        XCTAssertTrue(Mail.tooBig(boxes[0]).contains("Mail Drop"))
        XCTAssertFalse(Mail.tooBig(boxes[1]).contains("Apple"))
    }

    func testANewMailGoesFromTheMailboxUsedLastTimeWhileItIsStillLinked() {
        XCTAssertEqual(Mail.fromChoice(boxes, last: "robin@larkspur.example"), "robin@larkspur.example")
        XCTAssertEqual(Mail.fromChoice(boxes, last: "sam@fourthcoffee.example"), "robin@northwind.example")
        XCTAssertEqual(Mail.fromChoice(boxes, last: nil), "robin@northwind.example")
        XCTAssertEqual(Mail.fromChoice([], last: nil), "")
    }

    // MARK: Attachments

    func testShowsAPreviewOnlyForADataJPEGPNGGIFOrWebP() {
        XCTAssertNotNil(Mail.previewData("data:image/png;base64,iVBORw0KGgo="))
        for bad in ["data:image/svg+xml;base64,PHN2Zz4=", "https://evil.example/x.png", "data:text/html;base64,PHNjcmlwdD4=", "javascript:alert(1)", nil] {
            XCTAssertNil(Mail.previewData(bad), bad ?? "nil")
        }
    }

    func testWarnsBeforeFilesThatCanRunAProgramOrHideOne() {
        let risky = ["setup.exe", "invoice.pdf.exe", "run.JS", "report.xlsm", "photo.lnk", "disk.iso", "letter.doc", "budget.xls", "slides.pptm", "a.ps1",
                     "a.sh", "a.py", "drawing.svg", "page.html", "site.webloc", "a.pkg", "a.dmg", "a.app", "a.command", "a.zip", "a.7z", "a.tgz",
                     "SETUP.EXE", "setup.exe.", "setup.exe . ", " setup.exe ", "invoice\u{202E}fdp.txt", "notes\u{2066}.txt"]
        for n in risky { XCTAssertTrue(Mail.riskyFile(n), n) }
        for n in ["photo.jpg", "photo.heic", "tickets.pdf", "notes.txt", "budget.xlsx", "letter.docx", "slides.pptx", "table.csv", "song.mp3", "invite.ics", "exe", "zip file", "my.exercises.txt"] {
            XCTAssertFalse(Mail.riskyFile(n), n)
        }
    }

    func testSaysSizesAsPeopleReadThem() {
        XCTAssertEqual([512, 840_000, 2_500_000, 25_000_000].map(Mail.fileSize), ["512 B", "820 KB", "2.4 MB", "24 MB"])
    }

    func testReadsWhetherAMailHasAttachmentsOrIsNotKnownYet() throws {
        let l = try JSONCoding.decode(MailList.self, from: """
        {"messages":[
          {"id":"a","at":"2026-11-19T14:00:00.000Z","from":{"name":"Alex","address":"alex@example.com"},"subject":"Plans","state":"inbox","attachments":2,"mailbox":"robin@icloud.example"},
          {"id":"b","at":"2026-11-19T13:00:00.000Z","from":{"name":"Alex","address":"alex@example.com"},"subject":"Old","state":"inbox","attachments":null},
          {"id":"c","at":"2026-11-19T12:00:00.000Z","from":{"name":"Alex","address":"alex@example.com"},"subject":"None","state":"inbox"}
        ],"mailboxes":[{"email":"robin@icloud.example","last_refresh":null,"last_error":null,"more":false,"kind":"icloud","provider":"iCloud"}]}
        """)
        let (a, b, c) = (l.messages[0], l.messages[1], l.messages[2])
        XCTAssertEqual(a.attachments, 2)
        XCTAssertTrue(a.asksForAttachments)
        XCTAssertEqual(a.mailbox, "robin@icloud.example")
        XCTAssertTrue(b.attachmentsUnknown)
        XCTAssertTrue(b.asksForAttachments, "mail kept before attachments were listed asks once, on opening")
        XCTAssertFalse(c.asksForAttachments, "a mail without attachments never asks the mailbox")
        XCTAssertEqual(l.mailboxes[0].provider, "iCloud")
        XCTAssertEqual(l.mailboxes[0].kind, "icloud")
        // A thread counts its mail's attachments; one not known makes the thread's not known.
        XCTAssertEqual(Mail.threads([a, withThread(c, "t")]).first?.summary.attachments, 2)
        let t = Mail.threads([withThread(a, "t"), withThread(b, "t")]).first!
        XCTAssertTrue(t.summary.attachmentsUnknown)
        XCTAssertNil(t.summary.attachments)
        let list = try JSONCoding.decode(MailAttachmentList.self, from: #"{"attachments":[{"part":"2","name":"plan.pdf","type":"application/pdf","size":1200},{"part":"3","name":"p.png","type":"image/png","size":90,"preview":"data:image/png;base64,iVBORw0KGgo="}]}"#)
        XCTAssertEqual(list.attachments.map(\.part), ["2", "3"])
        XCTAssertNotNil(Mail.previewData(list.attachments[1].preview))
    }

    private func withThread(_ m: MailSummary, _ t: String) -> MailSummary { var x = m; x.thread = t; return x }

    func testWaitsLongerForTheMailRoutesThatReadTheMailboxOrCarryFiles() {
        XCTAssertEqual(HTTPTransport.timeout(path: "mail/drafts"), 120)
        XCTAssertEqual(HTTPTransport.timeout(path: HubClient.mailPath("0123abcd", "/attachments/2")), 120)
        XCTAssertEqual(HTTPTransport.timeout(path: HubClient.mailPath("0123abcd", "/attachments")), 60)
        XCTAssertEqual(HTTPTransport.timeout(path: HubClient.mailPath("0123abcd", "/greeting")), 60)
        XCTAssertEqual(HTTPTransport.timeout(path: HubClient.mailPath("0123abcd", "/unsubscribe")), 60)
        XCTAssertEqual(HTTPTransport.timeout(path: "mail/move"), 60)
        XCTAssertEqual(HTTPTransport.timeout(path: "mail/settings/blocked"), 120)
        XCTAssertNil(HTTPTransport.timeout(path: "mail/search"))
    }

    /// The draft and its files go to the hub in one request; the attachment's bytes come back only when asked for.
    func testSendsADraftAndFetchesAnAttachmentOnTheHubsOwnPaths() async throws {
        final class Seen: HubTransport, @unchecked Sendable {
            var calls: [(String, String, Data?)] = []
            func send(method: String, path: String, query: [String: String], body: Data?) async throws -> (status: Int, data: Data) {
                calls.append((method, path, body))
                if path == "mail/drafts" { return (200, Data(#"{"saved":true,"id":"d9","from":{"name":"Robin","address":"robin@icloud.example"},"to":["alex@example.com"],"subject":"Hi","text":"x"}"#.utf8)) }
                return (200, Data([0x25, 0x50, 0x44, 0x46]))
            }
        }
        let t = Seen()
        let c = HubClient(transport: t)
        var w = Mail.Writing()
        w.to = "alex@example.com"; w.subject = "Hi"; w.text = "x"
        let d = try await c.mailDraft(Mail.draftRequest(.fresh, w, files: [], preview: false))
        XCTAssertEqual(d.id, "d9")
        XCTAssertTrue(d.saved)
        let bytes = try await c.mailAttachment("0123abcd", part: "2.1")
        XCTAssertEqual(bytes, Data([0x25, 0x50, 0x44, 0x46]))
        XCTAssertEqual(t.calls.map(\.0), ["POST", "GET"])
        XCTAssertEqual(t.calls.map(\.1), ["mail/drafts", "mail/messages/0123abcd/attachments/2.1"])
    }

    // MARK: Folders and moves

    private func folder(_ role: MailFolderRole, _ name: String = "x", key: String = "k", email: String = "robin@icloud.example", count: Int = 3, unread: Int = 2) -> MailFolder {
        MailFolder(key: key, email: email, role: role, name: name, count: count, unread: unread)
    }

    func testNamesTheFoldersAsTheScreenDoesJunkIsSpam() {
        XCTAssertEqual([folder(.drafts), folder(.sent), folder(.junk), folder(.trash), folder(.own, "Taxes")].map { Mail.folderLabel($0) }, ["Drafts", "Sent", "Spam", "Trash", "Taxes"])
        XCTAssertEqual(Mail.folderLabel(folder(.sent), many: true), "Sent (robin@icloud.example)")
        let other = { (r: MailFolderRole) in self.folder(r, email: "Robin@Larkspur.example") }
        let groups = Mail.folderGroups([folder(.drafts), other(.drafts), folder(.sent), folder(.sent, email: "robin@larkspur.example"), folder(.own, "Taxes")])
        XCTAssertEqual(groups.map(\.email), ["robin@icloud.example", "Robin@Larkspur.example"])
        XCTAssertEqual(groups.map { $0.folders.map { Mail.folderLabel($0) } }, [["Drafts", "Sent", "Taxes"], ["Drafts", "Sent"]])
        let mixed = [other(.drafts), folder(.drafts), other(.sent), folder(.sent)]
        XCTAssertEqual(Mail.folderGroups(mixed, boxes: [MailMailbox(email: "robin@icloud.example"), MailMailbox(email: "robin@larkspur.example")]).map(\.email), ["robin@icloud.example", "Robin@Larkspur.example"])
        XCTAssertEqual(Mail.folderGroups(mixed).map(\.email), ["Robin@Larkspur.example", "robin@icloud.example"])
        // A part a newer hub adds offers the least: the owner's own.
        XCTAssertEqual(try JSONCoding.decode(MailFolder.self, from: #"{"key":"k","email":"a@b.example","role":"archive2","name":"X","count":1,"unread":0,"more":false}"#).role, .own)
    }

    func testCountsDraftsAndUnreadMailWhereItMatters() {
        XCTAssertEqual([folder(.drafts), folder(.sent), folder(.junk), folder(.trash), folder(.own)].map(Mail.folderCount), [3, 0, 2, 0, 2])
    }

    func testNamesWhoTheOwnerWroteToForSentAndDraftsElseTheSender() throws {
        let m = try JSONCoding.decode(MailFolderList.self, from: """
        {"messages":[{"id":"1","at":"2026-11-20T10:00:00Z","from":{"name":"Robin","address":"robin@icloud.example"},"to":[{"name":"Alex","address":"alex@example.com"},{"name":"","address":"sam@example.com"}],
          "subject":"Hi","preview":"","automated":false,"bundle":null,"state":"folder","pinned":false,"folder_role":"sent","attachments":1}]}
        """).messages[0]
        XCTAssertEqual(m.summary.state, .folder)
        XCTAssertEqual(Mail.folderWho(m), "To: Alex, sam@example.com")
        XCTAssertEqual(m.summary.attachments, 1)
        var junk = m
        junk.folder_role = .junk
        XCTAssertEqual(Mail.folderWho(junk), "Robin")
    }

    func testWhatAFoldersMailCanDo() {
        XCTAssertEqual(Mail.folderActs(.junk), .init(inbox: true, trash: true, undo: true, move: false))
        XCTAssertEqual(Mail.folderActs(.trash), .init(inbox: true, trash: false, undo: true, move: false))
        XCTAssertEqual(Mail.folderActs(.own), .init(inbox: true, trash: true, undo: true, move: true))
        XCTAssertEqual(Mail.folderActs(.sent), .init(inbox: false, trash: true, undo: false, move: false))
        XCTAssertEqual(Mail.folderActs(.drafts), .init(inbox: false, trash: true, undo: false, move: false))
        XCTAssertEqual(Mail.moveTarget(folder(.own, key: "taxes")), "taxes")
        XCTAssertEqual(Mail.moveTarget(folder(.junk)), "junk")
    }

    func testOffersMoveToOnlyFoldersOfTheMailsOwnMailbox() {
        let fs = [folder(.own, key: "taxes", email: "robin@northwind.example"), folder(.trash, key: "trash1", email: "robin@northwind.example"),
                  folder(.own, key: "school", email: "robin@northwind.example"), folder(.own, key: "work", email: "robin@larkspur.example")]
        XCTAssertEqual(Mail.moveFolders(fs, mailboxes: ["robin@northwind.example"]).map(\.key), ["taxes", "school"])
        XCTAssertEqual(Mail.moveFolders(fs, mailboxes: ["Robin@Northwind.example"], except: "taxes").map(\.key), ["school"])
        XCTAssertEqual(Mail.moveFolders(fs, mailboxes: ["robin@northwind.example", "robin@northwind.example"]).map(\.key), ["taxes", "school"])
        XCTAssertEqual(Mail.moveFolders(fs, mailboxes: ["robin@northwind.example", "robin@larkspur.example"]), [])
        XCTAssertEqual(Mail.moveFolders(fs, mailboxes: [nil]), [])
        XCTAssertEqual(Mail.moveFolders(fs, mailboxes: []), [])
    }

    func testAsksBeforeMovingMailWithWordsWrittenUnderItsThread() {
        var a = MailSummary(id: "a", at: "2026-11-20T10:00:00Z", from: MailAddress(name: "Alex", address: "alex@example.com"), subject: "Gutters")
        a.thread = "t"
        var b = a; b.id = "b"; b.at = "2026-11-21T10:00:00Z"
        let c = MailSummary(id: "c", at: "2026-11-21T10:00:00Z", from: MailAddress(name: "Sam", address: "sam@example.com"), subject: "Lunch")
        let ts = Mail.threads([a, b, c])
        // A reply written under the thread's first mail goes with a move of its newest: the whole thread moves.
        XCTAssertEqual(Mail.writtenUnder(["b"], threads: ts, unsaved: { $0 == "a" }), ["a"])
        XCTAssertEqual(Mail.writtenUnder(["c"], threads: ts, unsaved: { $0 == "a" }), [])
        XCTAssertEqual(Mail.writtenUnder(["x"], threads: ts, unsaved: { $0 == "x" }), ["x"], "a folder's mail is its own")
        XCTAssertEqual(Mail.movedText("Moved to Trash", count: 1), "Moved to Trash")
        XCTAssertEqual(Mail.movedText("Moved to Spam", count: 3), "3 moved to Spam")
    }

    /// gnomecannon/aeneas#10 on the Mail screen: a Read only mailbox's mail is left out of every change the screen
    /// offers (a move, a Sweep, a draft), as the web leaves it out, and the hub refuses it anyway.
    func testLeavesAReadOnlyMailboxsMailOutOfEveryChange() {
        let boxes = [MailMailbox(email: "robin@northwind.example", provider: "iCloud", kind: "icloud", read_only: true),
                     MailMailbox(email: "robin@larkspur.example", provider: "Gmail", kind: "gmail")]
        func m(_ id: String, _ box: String?) -> MailSummary {
            MailSummary(id: id, at: "2026-11-20T10:00:00Z", from: MailAddress(name: "Northwind", address: "o@northwind.example"), subject: id, automated: true, bundle: "purchases", mailbox: box)
        }
        let ro = m("ro", "Robin@Northwind.example"), rw = m("rw", "robin@larkspur.example"), none = m("none", nil)
        XCTAssertEqual(Mail.writableBoxes(boxes).map(\.email), ["robin@larkspur.example"])
        XCTAssertEqual(Mail.fromChoice(Mail.writableBoxes(boxes), last: "robin@northwind.example"), "robin@larkspur.example", "a new mail never goes from a Read only mailbox")
        XCTAssertEqual(Mail.readOnlyIds(["ro", "rw", "none"], mails: [ro, rw, none], boxes: boxes), ["ro"], "a mail naming no mailbox among several is not known to be Read only")
        XCTAssertEqual(Mail.readOnlyIds(["x"], mails: [], boxes: [boxes[0]]), ["x"], "with one mailbox linked, every mail is in it")
        XCTAssertEqual(Mail.sweepIds(Mail.threads([ro, rw]), boxes: boxes), ["rw"])
        XCTAssertEqual(Mail.sweepIds(Mail.threads([ro, rw]), boxes: []), ["ro", "rw"], "an older hub says nothing of Read only")
    }

    /// A thread is known on the screen by its thread, so the reply being written in it stays open when new mail
    /// arrives in the thread (its newest mail's id, which the hub's actions take, changes then).
    func testAThreadKeepsItsKeyWhenNewMailArrivesInIt() {
        var first = MailSummary(id: "m1", at: "2026-11-20T10:00:00Z", from: MailAddress(name: "Alex", address: "alex@example.com"), subject: "Gutters")
        first.thread = "t1"
        var second = first
        second.id = "m2"; second.at = "2026-11-21T10:00:00Z"
        let before = Mail.threads([first])[0], after = Mail.threads([first, second])[0]
        XCTAssertEqual(before.key, "t1")
        XCTAssertEqual(after.key, "t1")
        XCTAssertNotEqual(before.id, after.id)
        XCTAssertEqual(Mail.threads([MailSummary(id: "solo", at: "", from: MailAddress(name: "", address: "a@b.example"))])[0].key, "solo", "a mail in no thread is known by its own id")
        // Shown in its place by the key, whatever its newest mail is now.
        let sections = Mail.inboxSections(Mail.threads([first, second]), shown: [], now: ISO.date("2026-11-21T12:00:00Z")!)
        XCTAssertTrue(Mail.inboxPlace(sections, key: "t1").found)
    }

    func testOffersToUndoABlockHowManyMovedAndTheMailToMoveBack() {
        let a = Mail.blockUndo(MailBlocked(blocked: ["sam@fourthcoffee.example"], moved: 2, to: ["old1": "new1", "old2": "new2"]), who: "sam@fourthcoffee.example")
        XCTAssertEqual(a.text, "Blocked sam@fourthcoffee.example: 2 moved to Spam")
        XCTAssertEqual(a.back, ["new1", "new2"])
        XCTAssertEqual(Mail.blockUndo(MailBlocked(blocked: [], moved: 0), who: "everyone at fourthcoffee.example").text, "Blocked everyone at fourthcoffee.example")
        // An older hub says only how many moved: nothing to move back by id.
        XCTAssertEqual(try JSONCoding.decode(MailBlocked.self, from: #"{"blocked":[],"moved":3}"#).to, [:])
    }

    func testReadsTheWaysToUnsubscribe() throws {
        let o = try JSONCoding.decode(MailUnsubscribeOptions.self, from: #"{"one_click":{"host":"news.example"},"link":"https://news.example/u","mailto":{"to":"u@news.example","subject":"unsubscribe"},"tor":false}"#)
        XCTAssertEqual(o.one_click?.host, "news.example")
        XCTAssertEqual(o.mailto?.to, "u@news.example")
        XCTAssertFalse(o.tor)
        XCTAssertNil(try JSONCoding.decode(MailUnsubscribeOptions.self, from: #"{"tor":true}"#).link)
    }

    // MARK: Search and select all

    func testNamesWhereAHitIs() throws {
        func hit(_ w: String, _ state: String, folder: String? = nil) throws -> MailSearchHit {
            let f = folder.map { #","folder_name":"\#($0)""# } ?? ""
            return try JSONCoding.decode(MailSearchHit.self, from: #"{"id":"1","at":"2026-11-20T10:00:00Z","from":{"name":"Alex","address":"alex@example.com"},"subject":"Hi","state":"\#(state)","where":"\#(w)","snippet":"…the pipe…"\#(f)}"#)
        }
        XCTAssertEqual(Mail.whereLabel(try hit("inbox", "inbox")), "Inbox")
        XCTAssertEqual(Mail.whereLabel(try hit("junk", "folder")), "Spam")
        XCTAssertEqual(Mail.whereLabel(try hit("sent", "sent")), "Your reply")
        XCTAssertEqual(Mail.whereLabel(try hit("sent", "folder")), "Sent")
        XCTAssertEqual(Mail.whereLabel(try hit("own", "folder", folder: "Taxes")), "Taxes")
        XCTAssertEqual(try hit("inbox", "inbox").snippet, "…the pipe…")
        XCTAssertTrue(try hit("done", "done").isListed)
        XCTAssertFalse(try hit("trash", "folder").isListed)
        let twice = [try hit("inbox", "inbox"), try hit("sent", "sent")]
        XCTAssertEqual(Mail.uniqueHits(twice).count, 1, "a mail the hub lists twice is one row")
    }

    func testSearchesEveryKeptMailOnTheHubWithTheWordsAndThePerson() async throws {
        final class Seen: HubTransport, @unchecked Sendable {
            var query: [String: String] = [:]
            func send(method: String, path: String, query: [String: String], body: Data?) async throws -> (status: Int, data: Data) {
                self.query = query
                return (200, Data(#"{"hits":[]}"#.utf8))
            }
        }
        let t = Seen()
        _ = try await HubClient(transport: t).mailSearch("pipe leak")
        XCTAssertEqual(t.query, ["q": "pipe leak"])
        _ = try await HubClient(transport: t).mailSearch("", with: "alex@example.com")
        XCTAssertEqual(t.query, ["with": "alex@example.com"])
    }

    func testSelectsEveryShownMailOrNoneWhenAllAreNeverOneOutOfSight() {
        XCTAssertEqual(Mail.selectAll(["a", "b", "c"], ["a"]).next, ["a", "b", "c"])
        XCTAssertEqual(Mail.selectAll(["a", "b", "c"], ["a"]).state, .some)
        XCTAssertEqual(Mail.selectAll(["a", "b", "c"], ["a", "b", "c"]).next, [])
        XCTAssertEqual(Mail.selectAll(["a", "b", "c"], ["a", "b", "c"]).state, .all)
        XCTAssertEqual(Mail.selectAll(["a", "b", "c"], ["x"]).next, ["a", "b", "c"])
        XCTAssertEqual(Mail.selectAll([], []).state, .none)
    }

    func testDeleteAndBackspaceDeleteBangIsSpamNeverWhileTyping() {
        XCTAssertEqual(["delete", "backspace", "deleteForward", "!"].map { Mail.keyAction($0) }, [.delete, .delete, .delete, .spam])
        XCTAssertNil(Mail.keyAction("delete", typing: true))
        XCTAssertNil(Mail.keyAction("!", typing: true))
        XCTAssertTrue(Mail.keys.contains { $0.keys == "Delete" } && Mail.keys.contains { $0.keys == "!" })
        XCTAssertEqual(Mail.keys.last?.does, "Show these keys")
    }

    // MARK: Cards and trips

    func testSaysACardsFactsInOneLine() {
        XCTAssertEqual(Mail.cardLine(MailCard(kind: "package", title: "UPS", number: "1Z999AA10123456784", source: "text"), calendar: cal), "UPS \u{00B7} 1Z999AA10123456784")
        XCTAssertEqual(Mail.cardLine(MailCard(kind: "flight", title: "Example Air", number: "EA 110", from: "SFO", to: "JFK"), calendar: cal), "EA 110 \u{00B7} SFO \u{2192} JFK")
        XCTAssertEqual(Mail.cardLine(MailCard(kind: "bill", title: "City Water", at: "2026-12-15", amount: "$61.50", source: "text"), calendar: cal),
                       "City Water \u{00B7} $61.50 due \u{00B7} By \(Mail.cardTime("2026-12-15", calendar: cal))")
        XCTAssertEqual(Mail.cardLine(MailCard(kind: "order")), "")
        XCTAssertEqual(Mail.cardBundle(MailCard(kind: "package")), "purchases")
        XCTAssertEqual(Mail.cardBundle(MailCard(kind: "bill")), "bills")
        XCTAssertEqual(Mail.cardBundle(MailCard(kind: "stay")), "trips")
    }

    func testShowsADayWithoutATimeAsThatDayWhereverTheDeviceIs() {
        XCTAssertEqual(Mail.cardTime("2026-12-15", calendar: cal), "Tue, Dec 15")
        XCTAssertTrue(Mail.cardTime("2026-12-03T16:00:00.000Z", calendar: cal).contains("11:00"))
        XCTAssertEqual(Mail.cardTime("soon", calendar: cal), "")
    }

    func testOpensACardsLinkOnlyWhenItIsHttps() {
        XCTAssertEqual(Mail.cardLink(MailCard(kind: "package", url: "https://track.example/1"))?.absoluteString, "https://track.example/1")
        XCTAssertNil(Mail.cardLink(MailCard(kind: "package", url: "http://track.example/1")))
        XCTAssertNil(Mail.cardLink(MailCard(kind: "package", url: "javascript:alert(1)")))
        XCTAssertNil(Mail.cardLink(MailCard(kind: "package", url: "https://a:b@track.example/1")))
        XCTAssertNil(Mail.cardLink(MailCard(kind: "package", source: "text")))
    }

    private func trip(_ id: String, _ cards: [MailCard]) -> MailSummary {
        MailSummary(id: id, at: "2026-11-20T12:00:00Z", from: MailAddress(name: "", address: "x@air.example"), subject: id, automated: true, bundle: "trips", seen: true, cards: cards)
    }
    private func local(_ d: Int, _ h: Int, _ m: Int = 0) -> String { ISO.string(cal.date(from: DateComponents(year: 2026, month: 12, day: d, hour: h, minute: m))!) }
    private var tripNow: Date { ISO.date("2026-11-20T12:00:00Z")! }

    func testGroupsTheFlightOutTheHotelAndTheFlightBackAsOneTrip() {
        let out = trip("out", [MailCard(kind: "flight", number: "EA 110", from: "SFO", to: "JFK", at: local(3, 8), until: local(3, 13, 30))])
        let hotel = trip("hotel", [MailCard(kind: "stay", title: "Harbor Inn", at: "2026-12-03", until: "2026-12-06")])
        let back = trip("back", [MailCard(kind: "flight", number: "EA 111", from: "JFK", to: "SFO", at: local(6, 10))])
        let ts = Mail.trips([back, hotel, out], now: tripNow, calendar: cal)
        XCTAssertEqual(ts.count, 1)
        XCTAssertEqual(ts[0].name, "Trip to JFK")
        XCTAssertEqual(ts[0].parts.map { $0.mail.id }, ["out", "hotel", "back"])
        XCTAssertEqual(Mail.tripDates(start: ts[0].start, end: ts[0].end, calendar: cal), "Dec 3 to 6")
        // Two mails at least; a dinner and a show at home are no trip; trips weeks apart stay apart.
        XCTAssertTrue(Mail.trips([out], now: tripNow, calendar: cal).isEmpty)
        let dinner = trip("dinner", [MailCard(kind: "table", title: "Bistro", at: "2026-11-28T19:00:00Z")])
        let show = trip("show", [MailCard(kind: "event", title: "Concert", at: "2026-11-28T21:00:00Z")])
        XCTAssertTrue(Mail.trips([dinner, show], now: tripNow, calendar: cal).isEmpty)
        let later = trip("later", [MailCard(kind: "stay", title: "Lake Lodge", at: "2027-01-10", until: "2027-01-12")])
        let car = trip("car", [MailCard(kind: "booking", title: "Car hire", at: "2027-01-10T15:00:00Z")])
        XCTAssertEqual(Mail.trips([out, hotel, back, later, car], now: tripNow, calendar: cal).map(\.name), ["Trip to JFK", "Stay at Lake Lodge"])
        // Trips not over yet first, then past ones; cards read from text have no date.
        let old1 = trip("o1", [MailCard(kind: "flight", to: "LAX", at: "2026-10-01T10:00:00Z")])
        let old2 = trip("o2", [MailCard(kind: "stay", title: "Beach Hotel", at: "2026-10-01", until: "2026-10-04")])
        XCTAssertEqual(Mail.trips([old1, old2, out, hotel], now: tripNow, calendar: cal).map(\.name), ["Trip to JFK", "Trip to LAX"])
        let conf = trip("conf", [MailCard(kind: "booking", number: "X7K2PQ", source: "text")])
        XCTAssertTrue(Mail.trips([out, conf], now: tripNow, calendar: cal).isEmpty)
    }

    // MARK: Sorting new mail

    func testSaysHowMuchNewMailIsNotSortedWithSortNewMailOnlyWhenTheHubWaitsToBeAsked() {
        XCTAssertEqual(Mail.triageRow(on: true, MailTriageState(waiting: 3))?.text, "3 new mails are not sorted yet.")
        XCTAssertEqual(Mail.triageRow(on: true, MailTriageState(waiting: 3))?.button, true)
        XCTAssertEqual(Mail.triageRow(on: true, MailTriageState(waiting: 1))?.text, "1 new mail is not sorted yet.")
        XCTAssertNil(Mail.triageRow(on: true, MailTriageState(waiting: 0)))
        XCTAssertNil(Mail.triageRow(on: true, MailTriageState(waiting: 3, auto: true)))
        XCTAssertNil(Mail.triageRow(on: false, MailTriageState(waiting: 3)))
        XCTAssertNil(Mail.triageRow(on: true, nil))
        XCTAssertNil(Mail.triageRow(on: nil, nil))
        XCTAssertEqual(Mail.triageRow(on: true, MailTriageState(waiting: 5, running: true))?.text, "Sorting new mail: 5 left.")
        XCTAssertEqual(Mail.triageRow(on: true, MailTriageState(waiting: 5, running: true))?.button, false)
        let stopped = "Sorting stopped: a game is using the graphics card."
        XCTAssertEqual(Mail.triageRow(on: true, MailTriageState(waiting: 4, stopped: stopped))?.text, stopped)
        XCTAssertEqual(Mail.triageRow(on: true, MailTriageState(waiting: 4, stopped: stopped))?.button, true)
        XCTAssertEqual(Mail.triageRow(on: true, MailTriageState(waiting: 4, running: true, stopped: stopped))?.text, "Sorting new mail: 4 left.")
    }

    private func triaged(_ id: String, _ at: String, _ t: MailTriage?, _ state: MailState = .inbox) -> MailSummary {
        MailSummary(id: id, at: at, from: MailAddress(name: "", address: "a@x.example"), subject: id, state: state, triage: t)
    }

    func testNeedsYouTodaysFirstThenThoseNeedingAReplyNeverDoneOrUntriagedAtMost5() {
        let list = [
            triaged("reply-old", "2026-11-19T10:00:00Z", MailTriage(urgency: "soon", needs_reply: true)),
            triaged("today", "2026-11-18T10:00:00Z", MailTriage(urgency: "today")),
            triaged("reply-new", "2026-11-20T10:00:00Z", MailTriage(urgency: "fyi", needs_reply: true)),
            triaged("low", "2026-11-20T11:00:00Z", MailTriage(urgency: "low")),
            triaged("done", "2026-11-20T12:00:00Z", MailTriage(urgency: "today", needs_reply: true), .done),
            triaged("plain", "2026-11-20T13:00:00Z", nil),
        ]
        let shown = Mail.shownBundles(on: { _ in true })
        XCTAssertEqual(Mail.needsYou(list, shown: shown).map(\.id), ["today", "reply-new", "reply-old"])
        XCTAssertEqual(Mail.needsYou((0..<9).map { triaged("t\($0)", "2026-11-2\($0)T10:00:00Z", MailTriage(urgency: "today")) }, shown: shown).count, 5)
        // An urgency the app does not know is fyi.
        XCTAssertEqual(try JSONCoding.decode(MailTriage.self, from: #"{"urgency":"asap","needs_reply":false}"#).urgency, "fyi")
    }

    func testNeedsYouNamesOnlyMailTheInboxLists() {
        let shown = Mail.shownBundles(on: { _ in true })
        let now = cal.date(from: DateComponents(year: 2026, month: 11, day: 19, hour: 12))!
        let at = ISO.string(cal.date(from: DateComponents(year: 2026, month: 11, day: 19, hour: 10, minute: 30))!)
        func m(_ id: String, _ bundle: String, pinned: Bool = false) -> MailSummary {
            var x = triaged(id, at, MailTriage(urgency: "today")); x.bundle = bundle; x.automated = true; x.pinned = pinned; return x
        }
        let delivery = ["other": MailBundleDelivery(mode: .never), "promos": MailBundleDelivery(mode: .daily, time: "18:00")]
        let got = Mail.needsYou([m("never", "other"), m("later", "promos"), m("pinned", "promos", pinned: true), m("bundled", "purchases")], shown: shown, delivery: delivery, now: now, calendar: cal)
        XCTAssertEqual(got.map(\.id).sorted(), ["bundled", "pinned"])
        let evening = cal.date(from: DateComponents(year: 2026, month: 11, day: 19, hour: 19))!
        XCTAssertEqual(Mail.needsYou([m("later", "promos")], shown: shown, delivery: delivery, now: evening, calendar: cal).map(\.id), ["later"])
    }

    func testOpensAMailInsideABundlesRowByOpeningThatRowFirst() {
        let shown = Mail.shownBundles(on: { _ in true })
        let now = cal.date(from: DateComponents(year: 2026, month: 11, day: 19, hour: 15))!
        func day(_ h: Int) -> String { ISO.string(cal.date(from: DateComponents(year: 2026, month: 11, day: 19, hour: h))!) }
        var order = triaged("order", day(9), MailTriage(urgency: "today")); order.bundle = "purchases"; order.automated = true
        let person = triaged("person", day(10), MailTriage(urgency: "soon", needs_reply: true))
        var held = triaged("held", day(11), MailTriage(urgency: "today")); held.bundle = "other"; held.automated = true
        let ts = Mail.threads([order, person, held])
        let delivery = ["other": MailBundleDelivery(mode: .never)]
        let sections = Mail.inboxSections(ts, shown: shown, now: now, delivery: delivery, calendar: cal)
        XCTAssertEqual(Mail.needsYou(ts, shown: shown, delivery: delivery, now: now, calendar: cal).map(\.id), ["order", "person"])
        XCTAssertEqual(Mail.inboxPlace(sections, key: "order").row, "Today:purchases")
        XCTAssertTrue(Mail.inboxPlace(sections, key: "person").found)
        XCTAssertNil(Mail.inboxPlace(sections, key: "person").row)
        XCTAssertFalse(Mail.inboxPlace(sections, key: "held").found)
    }

    func testListsSnoozedMailComingBackLaterTodaySoonestFirst() {
        let now = cal.date(from: DateComponents(year: 2026, month: 11, day: 22, hour: 9))!
        func m(_ id: String, _ h: Int?, day: Int = 22, _ state: MailState = .snoozed) -> MailSummary {
            var x = MailSummary(id: id, at: "2026-11-20T10:00:00Z", from: MailAddress(name: "", address: "a@x.example"), subject: id, state: state)
            x.snooze_until = h.map { ISO.string(cal.date(from: DateComponents(year: 2026, month: 11, day: day, hour: $0))!) }
            return x
        }
        let list = [m("evening", 18), m("noon", 12), m("tomorrow", 8, day: 23), m("passed", 8), m("inbox", 12, .inbox)]
        XCTAssertEqual(Mail.backLaterToday(list, now: now, calendar: cal).map(\.id), ["noon", "evening"])
    }

    func testAMailTheOwnerSaidNotToFoldShowsUnfolded() throws {
        let m = try JSONCoding.decode(MailMessage.self, from: #"{"id":"a","at":"2026-11-20T10:00:00Z","from":{"name":"Alex","address":"alex@example.com"},"subject":"Re: Pipe","state":"inbox","text":"Yes.\n\nOn Monday Alex wrote:\n> The pipe","no_fold":true}"#)
        XCTAssertTrue(m.no_fold)
        XCTAssertNil(m.quote_at)
        XCTAssertFalse(try JSONCoding.decode(MailMessage.self, from: #"{"id":"a","at":"","from":{"name":"","address":""},"subject":"","state":"inbox","text":"x","quote_at":1}"#).no_fold)
    }

    func testOffersTheFirstLinesTheFoldHides() {
        let text = "Sounds good.\n\nOn Monday Alex wrote:\n\n  The pipe must go.  \n> a\n> b\n> c\n> d\n> e\n> f\n> g"
        let at = (text as NSString).range(of: "On Monday").location
        XCTAssertEqual(Mail.foldedLines(text, quoteAt: at), ["On Monday Alex wrote:", "The pipe must go.", "> a", "> b", "> c", "> d", "> e", "> f"])
        XCTAssertEqual(Mail.foldedLines(text, quoteAt: nil), [])
    }

    func testReadsTheListsFoldersBlockedSendersAndSorting() throws {
        let l = try JSONCoding.decode(MailList.self, from: """
        {"messages":[{"id":"a","at":"2026-11-19T14:00:00.000Z","from":{"name":"Northwind","address":"orders@northwind.example"},"subject":"Shipped","state":"inbox",
          "cards":[{"kind":"package","title":"UPS","number":"1Z9","url":"https://www.ups.com/track?tracknum=1Z9","source":"text"}],"triage":{"urgency":"today","summary":"Your order ships today","needs_reply":false}}],
         "mailboxes":[],"folders":[{"key":"f1","email":"robin@icloud.example","role":"junk","name":"Junk","count":4,"unread":1,"more":false}],
         "blocked":["@spam.example"],"triage":true,"triage_state":{"on":true,"waiting":2,"running":false,"auto":false}}
        """)
        XCTAssertEqual(l.messages[0].cards?.first?.kind, "package")
        XCTAssertEqual(l.messages[0].triage?.summary, "Your order ships today")
        XCTAssertEqual(l.folders.first?.role, .junk)
        XCTAssertEqual(l.blocked, ["@spam.example"])
        XCTAssertEqual(l.triage, true)
        XCTAssertEqual(l.triage_state?.waiting, 2)
        // An older hub sends none of them.
        let old = try JSONCoding.decode(MailList.self, from: #"{"messages":[],"mailboxes":[]}"#)
        XCTAssertEqual(old.folders, [])
        XCTAssertNil(old.triage)
        XCTAssertNil(Mail.triageRow(on: old.triage, old.triage_state))
    }
}
