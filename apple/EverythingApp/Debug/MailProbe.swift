#if DEBUG
import Foundation
import QuartzCore
import EACore

/// Debug builds only: what typing in a Mail writing box costs, and a made-up mailbox to measure it on.
///   -EAMailProbe YES      counts how often the Mail screen's views are worked out for each letter typed in a writing
///                         box, and how long the main thread is busy for it (from the letter to the screen drawn), and
///                         prints a summary line ("MAILPROBE") when the typing stops for 2 seconds
///   -EAMailFake <n>       the Mail screen shows n made-up threads (Jamie, Alex, Robin at example.com) in one made-up
///                         mailbox, in place of the hub's list (sample mode has no mail)
///   -EAMailWrite new      with -EASection mail, New mail opens; `reply` opens a reply under the mail -EAMailOpen opened
///   -EAMailType <n>       the writing box that opens types n letters by itself, one every 0.3 seconds, as typing does
///   -EAMailProposalDemo YES  the Assistant opens a made-up chat in which the assistant wrote a mail for you to send:
///                         its card, with Send (a made-up outbox that sends 10 seconds later), Edit and Cancel
///   -EAMailSendFlow YES   with -EAMailType: then Preview, and Send 3 seconds later, into a made-up outbox that sends
///                         10 seconds after (Sending with Undo, then Sent); -EAMailSendFails YES: Not sent, with words
///                         like the hub's
@MainActor
enum MailProbe {
    static let on = UserDefaults.standard.bool(forKey: "EAMailProbe")
    private static var counts: [String: Int] = [:]
    private static var letters: [(counts: [String: Int], busy: Double)] = []
    private static var busy: Double = 0
    private static var wake: CFTimeInterval = 0
    private static var observer: CFRunLoopObserver?
    private static var quiet: Task<Void, Never>?
    private static var started = false

    /// A view's body was worked out.
    static func count(_ name: String) { if on { counts[name, default: 0] += 1 } }

    /// A letter was typed: what came since the one before is that one's.
    static func letter() {
        guard on else { return }
        install()
        if started { letters.append((counts, busy)) }
        started = true
        counts = [:]
        busy = 0
        quiet?.cancel()
        quiet = Task {
            try? await Task.sleep(for: .seconds(2))
            if !Task.isCancelled { report() }
        }
    }

    /// The main run loop's busy time: from each wake to just before it sleeps again, the drawing included (this
    /// observer comes after every other one).
    private static func install() {
        guard observer == nil else { return }
        let o = CFRunLoopObserverCreateWithHandler(nil, CFRunLoopActivity.afterWaiting.rawValue | CFRunLoopActivity.beforeWaiting.rawValue, true, CFIndex.max) { _, activity in
            let now = CACurrentMediaTime()
            if activity == .afterWaiting { MainActor.assumeIsolated { wake = now } }
            else { MainActor.assumeIsolated { if wake > 0 { busy += now - wake; wake = 0 } } }
        }
        CFRunLoopAddObserver(CFRunLoopGetMain(), o, .commonModes)
        observer = o
    }

    private static func report() {
        letters.append((counts, busy))
        let n = letters.count
        let names = Set(letters.flatMap(\.counts.keys)).sorted()
        let per = names.map { name in
            let all = letters.map { $0.counts[name] ?? 0 }
            return "\(name) \(String(format: "%.1f", Double(all.reduce(0, +)) / Double(n)))"
        }.joined(separator: ", ")
        let ms = letters.map { $0.busy * 1000 }.sorted()
        let avg = ms.reduce(0, +) / Double(n)
        print("MAILPROBE letters \(n); bodies per letter: \(per); main thread busy per letter: median \(String(format: "%.1f", ms[n / 2])) ms, mean \(String(format: "%.1f", avg)) ms, max \(String(format: "%.1f", ms.last ?? 0)) ms")
        letters = []
        started = false
    }

    // MARK: A made-up mailbox

    static var fakeCount: Int { UserDefaults.standard.integer(forKey: "EAMailFake") }
    static let fakeBox = "robin@example.com"

    /// n made-up threads in one mailbox, a day's worth of mail every few rows, some in bundles.
    static func fakeList(_ n: Int, now: Date = Date()) -> MailList {
        let people = [("Jamie Lee", "jamie@example.com"), ("Alex Kim", "alex@example.com"), ("Sam Park", "sam@example.com"), ("Robin Diaz", "robin.diaz@example.com")]
        let bundles: [String?] = [nil, nil, "promos", nil, "purchases", nil, "other", nil]
        let messages = (0..<n).map { i -> MailSummary in
            let p = people[i % people.count]
            return MailSummary(id: String(format: "fake%020d", i), at: ISO.string(now.addingTimeInterval(-Double(i) * 1700)),
                               from: MailAddress(name: p.0, address: p.1), subject: "Plans for week \(i % 52 + 1)",
                               preview: "A made-up mail to measure the screen with. Line \(i) of the list, with a few more words to fill two lines.",
                               bundle: bundles[i % bundles.count], seen: i % 3 != 0, mailbox: fakeBox)
        }
        return MailList(messages: messages, mailboxes: [MailMailbox(email: fakeBox, last_refresh: ISO.string(now), provider: "Gmail", kind: "gmail", read_only: false, can_send: true)])
    }

    /// The made-up outbox: each mail and when it is sent.
    static var outbox: [String: (item: MailOutboxItem, at: Date)] = [:]

    /// What a made-up mail would be, as the hub's preview says it (its JSON, decoded as the hub's answer is).
    static func fakeDraft(_ r: MailDraftRequest, threads: [MailThread]) throws -> MailDraft {
        let to = r.reply_to.flatMap { id in threads.lazy.flatMap(\.members).first { $0.id == id }?.from.address }.map { [$0] } ?? [r.to ?? ""]
        let subject = r.reply_to.flatMap { id in threads.lazy.flatMap(\.members).first { $0.id == id }.map { "Re: \($0.subject)" } } ?? (r.subject ?? "")
        let text = [r.greeting, r.text, r.signoff].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "\n\n")
        let body: [String: Any] = ["saved": false, "from": ["name": "Robin", "address": fakeBox], "to": to, "subject": subject, "text": text]
        return try JSONCoding.decode(MailDraft.self, from: JSONSerialization.data(withJSONObject: body))
    }

    /// A made-up Send: in the made-up outbox, sent 10 seconds later (or not, with -EAMailSendFails).
    static func fakeSend(_ r: MailDraftRequest, threads: [MailThread]) throws -> MailSent {
        let d = try fakeDraft(r, threads: threads)
        let id = "fake-out-\(outbox.count + 1)"
        let at = Date().addingTimeInterval(10)
        outbox[id] = (MailOutboxItem(id: id, mailbox: fakeBox, to: d.to, subject: d.subject, state: "waiting", send_at: ISO.string(at)), at)
        let body: [String: Any] = ["id": id, "send_at": ISO.string(at), "from": ["name": "Robin", "address": fakeBox], "to": d.to, "subject": d.subject]
        return try JSONCoding.decode(MailSent.self, from: JSONSerialization.data(withJSONObject: body))
    }

    /// A made-up mail in the outbox now.
    static func fakeOutbox(_ id: String) -> MailOutboxItem? {
        guard var x = outbox[id] else { return nil }
        if Date() >= x.at {
            if UserDefaults.standard.bool(forKey: "EAMailSendFails") {
                x.item.state = "failed"
                x.item.error = "Gmail did not accept the account's password for sending, so the mail was not sent. Check the app password in Settings, Accounts."
            } else {
                x.item.state = "sent"
            }
        }
        return x.item
    }

    // MARK: A made-up mail the assistant wrote (-EAMailProposalDemo)

    static var proposals: [String: (view: MailProposal, sendAt: Date?)] = [:]
    static let demoProposal = "fake-proposal-1"

    /// The made-up chat: the owner's ask, and the reply with its card.
    static func demoChat() -> AISession {
        let now = ISO.now()
        return AISession(session_id: "debug-mail-chat", title: "Saturday with Alex", task_type: "auto", created_at: now, last_at: now, messages: [
            AIStoredMessage(role: .user, content: "Can you email Alex that Saturday works for the gutters, and copy Sam?", at: now),
            AIStoredMessage(role: .assistant, content: "I wrote it to Alex with Sam on copy. It is below. Nothing is sent until you tap Send.", at: now, mail_proposal: ChatMailProposal(id: demoProposal)),
        ])
    }

    /// A made-up proposal now: proposed, waiting until 10 seconds after Send, then sent.
    static func fakeProposal(_ id: String) -> MailProposal? {
        if proposals[id] == nil, id == demoProposal {
            proposals[id] = (MailProposal(id: id, from: MailAddress(name: "Robin", address: fakeBox), to: ["alex@example.com"], cc: ["sam@example.com"], subject: "Gutters on Saturday",
                                          text: "Hi Alex,\n\nSaturday works for the gutters. Ten in the morning is fine, and Sam can help with the ladder.\n\nThanks,\nRobin", state: "proposed"), nil)
        }
        guard var x = proposals[id] else { return nil }
        if x.view.state == "waiting", let at = x.sendAt, Date() >= at { x.view.state = "sent"; proposals[id] = x }
        return x.view
    }

    /// A tap on a made-up card.
    static func fakeProposalAct(_ id: String, _ b: Mail.ProposalButton) -> MailProposal? {
        guard var x = proposals[id] ?? fakeProposal(id).map({ ($0, nil) }) else { return nil }
        switch b {
        case .send, .retry: x.view.state = "waiting"; x.sendAt = Date().addingTimeInterval(10)
        case .undo: x.view.state = "proposed"; x.sendAt = nil
        case .cancel: x.view.state = "cancelled"
        case .edit: x.view.state = "edited"
        }
        proposals[id] = x
        return x.view
    }

    /// Edit on a made-up card: the mail for New mail's box.
    static func fakeProposalEdit(_ id: String) throws -> MailProposalEdit {
        let v = fakeProposal(id)
        _ = fakeProposalAct(id, .edit)
        let body: [String: Any] = ["from": fakeBox, "to": v?.to ?? [], "cc": v?.cc ?? [], "subject": v?.subject ?? "", "text": v?.text ?? "", "files": [] as [Any]]
        return try JSONCoding.decode(MailProposalEdit.self, from: JSONSerialization.data(withJSONObject: body))
    }

    /// A made-up mail opened: its summary's words.
    static func fakeMessage(_ s: MailSummary) -> MailMessage {
        MailMessage(summary: s, text: "\(s.preview)\n\nSee you then,\n\(s.from.name)")
    }
}
#endif
