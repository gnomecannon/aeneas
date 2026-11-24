import XCTest
@testable import EACore

/// The Mail screen's rules, the same as the web's (web/src/lib/mail.test.ts), so every app sorts, groups and links
/// mail alike. Made-up mail only.
final class MailTests: XCTestCase {
    private let alex = MailAddress(name: "Alex", address: "alex@example.com")
    private var cal: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "America/New_York")!
        c.locale = Locale(identifier: "en_US")
        return c
    }()
    private var n = 0

    private func date(_ y: Int, _ mo: Int, _ d: Int, _ h: Int = 0, _ mi: Int = 0) -> Date {
        cal.date(from: DateComponents(year: y, month: mo, day: d, hour: h, minute: mi))!
    }
    /// Thursday, November 19 2026, 3 PM.
    private var now: Date { date(2026, 11, 19, 15) }
    private func at(_ daysAgo: Int, _ h: Int = 9) -> String { ISO.string(date(2026, 11, 19 - daysAgo, h)) }
    private func mail(_ change: (inout MailSummary) -> Void = { _ in }) -> MailSummary {
        n += 1
        var m = MailSummary(id: "m\(n)", at: at(0), from: alex, subject: "Mail \(n)", preview: "Hello")
        change(&m)
        return m
    }
    private let allOn: (String) -> Bool = { _ in true }

    func testGroupsByDayTodayYesterdayThisWeekThisMonthThenMonths() {
        XCTAssertEqual(Mail.dayGroup(at(0, 8), now: now, calendar: cal), "Today")
        XCTAssertEqual(Mail.dayGroup(at(1, 23), now: now, calendar: cal), "Yesterday")
        XCTAssertEqual(Mail.dayGroup(at(5), now: now, calendar: cal), "This week")
        XCTAssertEqual(Mail.dayGroup(at(12), now: now, calendar: cal), "This month")
        XCTAssertEqual(Mail.dayGroup(ISO.string(date(2026, 10, 3)), now: now, calendar: cal), "October 2026")
        XCTAssertEqual(Mail.dayGroup("nonsense", now: now, calendar: cal), "Earlier")
        XCTAssertEqual(Mail.whenLabel(at(0, 9), now: now, calendar: cal), "9:00\u{202F}AM")
        XCTAssertEqual(Mail.whenLabel(at(3), now: now, calendar: cal), "Mon")
        XCTAssertEqual(Mail.whenLabel(at(10), now: now, calendar: cal), "Nov 9")
        XCTAssertEqual(Mail.whenLabel(ISO.string(date(2025, 12, 30)), now: now, calendar: cal), "Dec 30, 2025")
    }

    func testModuleBundlesShowOnlyWhileTheirModuleIsOn() {
        let off: (String) -> Bool = { $0 != "pet" }
        XCTAssertEqual(Mail.shownBundles(on: allOn).map(\.id), Mail.bundles.map(\.id))
        XCTAssertFalse(Mail.shownBundles(on: off).map(\.id).contains("pet"))
        XCTAssertTrue(Mail.shownBundles(on: off).map(\.id).contains("promos"))
        XCTAssertNil(Mail.bundleOf(mail { $0.bundle = "pet" }, in: Mail.shownBundles(on: off)))
        XCTAssertNil(Mail.bundleOf(mail { $0.bundle = "made-up" }, in: Mail.shownBundles(on: allOn)))
        XCTAssertEqual(Mail.bundleOf(mail { $0.bundle = "promos" }, in: Mail.shownBundles(on: allOn))?.name, "Promotions")
    }

    /// The ids are the hub's own, and so are the names: a bundle renamed on the hub alone would show its mail in no
    /// bundle here, and one set to show later or never would show nowhere.
    func testTheBundlesAreTheHubsOwn() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../../..").standardized
        let hub = try String(contentsOf: root.appendingPathComponent("hub/src/mail-bundles.ts"), encoding: .utf8)
        func quoted(_ line: String) -> [String] { line.split(separator: "\"").enumerated().filter { $0.offset % 2 == 1 }.map { String($0.element) } }
        let ids = try XCTUnwrap(hub.split(separator: "\n").first { $0.hasPrefix("export const BUNDLE_IDS = [") })
        XCTAssertEqual(Set(quoted(String(ids))), Set(Mail.bundles.map(\.id)))
        let names = try XCTUnwrap(hub.split(separator: "\n").first { $0.hasPrefix("export const BUNDLE_NAMES") })
        for b in Mail.bundles { XCTAssertTrue(names.contains("\(b.id): \"\(b.name)\""), "\(b.id) is called \(b.name) on the hub") }
        // The ids a build of the renaming used are read as the same bundles here as on the hub.
        let short = try XCTUnwrap(hub.split(separator: "\n").first { $0.hasPrefix("export const SHORT_LIVED_BUNDLE_IDS") })
        let body = short.split(separator: "{").last?.split(separator: "}").first ?? ""
        var hubMap: [String: String] = [:]
        for kv in body.split(separator: ",") {
            let p = kv.split(separator: ":").map { $0.trimmingCharacters(in: CharacterSet.whitespaces.union(CharacterSet(charactersIn: "\""))) }
            if p.count == 2 { hubMap[p[0]] = p[1] }
        }
        XCTAssertEqual(hubMap, Mail.shortLivedBundleIds)
    }

    func testMailOfABundleThisAppHasNoViewForIsNeverHeldBack() {
        // A hub newer than the app names a bundle the app does not know, set to never show in the Inbox.
        let delivery = ["brand-new": MailBundleDelivery(mode: .never), "promos": MailBundleDelivery(mode: .never)]
        let unknown = mail { $0.bundle = "brand-new"; $0.automated = true }
        let promo = mail { $0.bundle = "promos"; $0.automated = true }
        let rows = Mail.inboxSections([unknown, promo], shown: Mail.shownBundles(on: allOn), delivery: delivery, calendar: cal).flatMap(\.rows)
        XCTAssertEqual(rows.map { r -> String in if case .mail(let m) = r { return m.id } else { return "bundle" } }, [unknown.id], "it shows on its own, as any mail in no bundle")
    }

    func testInboxNewestFirstUnderDayHeadingsABundleOneRowPinnedOnItsOwn() {
        let shown = Mail.shownBundles(on: allOn)
        let ms = [
            mail { $0.at = self.at(0, 10); $0.subject = "Hike?" },
            mail { $0.at = self.at(0, 9); $0.bundle = "purchases"; $0.from = MailAddress(name: "Northwind", address: "o@northwind.example") },
            mail { $0.at = self.at(0, 8); $0.bundle = "purchases"; $0.from = MailAddress(name: "Larkspur Books", address: "r@larkspur.example") },
            mail { $0.at = self.at(0, 7); $0.bundle = "purchases"; $0.pinned = true; $0.subject = "Pinned receipt" },
            mail { $0.at = self.at(1); $0.bundle = "purchases" },
            mail { $0.at = self.at(0, 6); $0.state = .done; $0.subject = "Done one" },
            mail { $0.at = self.at(0, 5); $0.state = .snoozed; $0.subject = "Snoozed one" },
        ]
        let s = Mail.inboxSections(ms, shown: shown, now: now, calendar: cal)
        XCTAssertEqual(s.map(\.title), ["Today", "Yesterday"])
        XCTAssertEqual(s[0].rows.map(describe), ["Hike?", "[Transactions 2]", "Pinned receipt"])
        if case .bundle(_, let mails) = s[0].rows[1] { XCTAssertEqual(Mail.sendersLine(mails), "Northwind, Larkspur Books") } else { XCTFail("a bundle row") }
        XCTAssertEqual(s[1].rows.map(describe), ["[Transactions 1]"])
        XCTAssertEqual(Mail.inboxSections(ms, shown: shown, pinnedOnly: true, now: now, calendar: cal).flatMap(\.rows).map(describe), ["Pinned receipt"])
        XCTAssertEqual(Mail.viewMessages(ms, view: .done, shown: shown).map(\.subject), ["Done one"])
        XCTAssertEqual(Mail.viewMessages(ms, view: .snoozed, shown: shown).map(\.subject), ["Snoozed one"])
        XCTAssertEqual(Mail.viewMessages(ms, view: .bundle("purchases"), shown: shown).count, 4)
    }

    private func describe<T: MailRowItem>(_ r: Mail.Row<T>) -> String {
        switch r {
        case .mail(let m): return m.summary.subject
        case .bundle(let b, let mails): return "[\(b.name) \(mails.count)]"
        }
    }

    func testSearchesSenderSubjectAndFirstWordsEveryWord() {
        let m = mail { $0.subject = "Gutters this weekend"; $0.preview = "Bring the ladder" }
        XCTAssertTrue(Mail.matches(m, ""))
        XCTAssertTrue(Mail.matches(m, "alex LADDER"))
        XCTAssertFalse(Mail.matches(m, "alex roof"))
    }

    func testGivesEachSenderLetters() {
        XCTAssertEqual(Mail.initial(alex), "A")
        XCTAssertEqual(Mail.initial(MailAddress(name: "", address: "sam@example.com")), "S")
        XCTAssertEqual(Mail.initial(MailAddress(name: "\"\u{00D6}lund\"", address: "x@y")), "\u{00D6}")
        XCTAssertEqual(Mail.initial(MailAddress(name: "", address: "")), "?")
        XCTAssertEqual(Mail.initials(MailAddress(name: "Alumni Relations Team", address: "a@x")), "AT")
        XCTAssertEqual(Mail.initials(MailAddress(name: "jordan avery", address: "j@x")), "JA")
        XCTAssertEqual(Mail.initials(alex), "A")
        XCTAssertEqual(Mail.initials(MailAddress(name: "", address: "sam@example.com")), "S")
    }

    func testOffersTheSnoozeTimes() {
        let c = Mail.snoozeChoices(now: now, calendar: cal)
        XCTAssertEqual(c.map(\.id), ["later", "tomorrow", "weekend", "nextweek"])
        XCTAssertEqual(c.map(\.label), ["Later today", "Tomorrow", "This weekend", "Next week"])
        XCTAssertEqual(c.map(\.at), [date(2026, 11, 19, 18), date(2026, 11, 20, 8), date(2026, 11, 21, 9), date(2026, 11, 23, 8)])
        XCTAssertFalse(Mail.snoozeChoices(now: date(2026, 11, 19, 19), calendar: cal).map(\.id).contains("later"))
        let sat = Mail.snoozeChoices(now: date(2026, 11, 21, 10), calendar: cal)
        XCTAssertEqual(sat.first { $0.id == "weekend" }?.label, "Next weekend")
        XCTAssertEqual(sat.first { $0.id == "weekend" }?.at, date(2026, 11, 28, 9))
        XCTAssertEqual(sat.first { $0.id == "nextweek" }?.at, date(2026, 11, 23, 8))
    }

    func testUsesTheOwnersOwnSnoozeTimes() {
        let mine = Mail.snoozeChoices(now: now, times: MailSnoozeTimes(later_hours: 2, tomorrow: "07:30", weekend_day: 0, weekend_time: "10:15", week_day: 2, week_time: "09:00"), calendar: cal)
        XCTAssertEqual(mine.map(\.at), [date(2026, 11, 19, 17), date(2026, 11, 20, 7, 30), date(2026, 11, 22, 10, 15), date(2026, 11, 24, 9)])
    }

    func testAddsTheOwnersBundlesAfterTheBuiltInOnes() {
        let school = MailCustomBundle(id: "c-0123456789", name: "School", color: 2, domains: ["school.example"])
        let shown = Mail.shownBundles(on: allOn, custom: [school])
        XCTAssertEqual(shown.map(\.id), Mail.bundles.map(\.id) + ["c-0123456789"])
        XCTAssertEqual(shown.last?.custom, 2)
        XCTAssertEqual(MailColors.key(shown.last!), .custom(2))
        XCTAssertEqual(MailColors.key(Mail.bundles[0]), .place("purchases"))
        XCTAssertEqual(Mail.bundleOf(mail { $0.bundle = "c-0123456789" }, in: shown)?.name, "School")
    }

    func testMapsTheKeysLettersToActNothingWhileTypingButEscape() {
        XCTAssertEqual(["return", " ", "escape"].map { Mail.keyAction($0) }, [.open, .select, .escape])
        XCTAssertEqual(["d", "D", "s", "p", "u", "r", "/", "?"].map { Mail.keyAction($0) }, [.done, .done, .snooze, .pin, .unread, .read, .search, .help])
        XCTAssertNil(Mail.keyAction("d", typing: true))
        XCTAssertEqual(Mail.keyAction("escape", typing: true), .escape)
        XCTAssertNil(Mail.keyAction("p", control: true))
        XCTAssertNil(Mail.keyAction("r", command: true))
        XCTAssertNil(Mail.keyAction("t"))
    }

    func testShowsTheRemindersThatAreDueNeverAMailsOwnSnoozeTask() {
        let noon = date(2026, 11, 20, 12)
        func iso(_ h: Int, _ d: Int = 20) -> JSONValue { .string(ISO.string(date(2026, 11, d, h))) }
        func t(_ id: String, _ f: [String: JSONValue]) -> Entity {
            Entity(id: id, kind: .task, fields: ["title": .string(id), "status": "scheduled"].merging(f) { $1 })
        }
        let due = Mail.dueReminders([
            t("dentist", ["remind_at": iso(9)]),
            t("overdue", ["remind_at": iso(9, 18), "friction": "reason"]),
            t("later", ["remind_at": iso(15)]),
            t("snoozed", ["remind_at": iso(8), "snoozed_until": iso(14)]),
            t("woke", ["remind_at": iso(7), "snoozed_until": iso(11)]),
            t("finished", ["remind_at": iso(9), "status": "done"]),
            t("mailsnooze", ["remind_at": iso(9), "mail": "abc"]),
            t("notime", [:]),
        ], now: noon)
        XCTAssertEqual(due.map(\.id), ["overdue", "dentist", "woke"])
        XCTAssertEqual(due[0].friction, "reason")
        XCTAssertEqual(due[2].at, date(2026, 11, 20, 11))
    }

    /// The hub's page folds the parts mail apps mark as quoted; the app unfolds the same ones, and the web too.
    func testFoldsTheSameQuotedHistoryTheHubsPageFolds() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../../..").standardized
        let hub = try String(contentsOf: root.appendingPathComponent("hub/src/mail-html.ts"), encoding: .utf8)
        XCTAssertTrue(hub.contains("export const QUOTE_SELECTOR = '\(Mail.quoteSelector)';"))
        let web = try String(contentsOf: root.appendingPathComponent("web/src/lib/mail.ts"), encoding: .utf8)
        XCTAssertTrue(web.contains("export const QUOTE_SELECTOR = '\(Mail.quoteSelector)';"))
    }

    func testAThreadIsOneRowWithItsPeopleNewestTimeStateUnreadAndIds() {
        let g1 = mail { $0.thread = "t1"; $0.at = self.at(3); $0.subject = "Gutters"; $0.seen = true; $0.preview = "Saturday?" }
        let me = mail { $0.thread = "t1"; $0.at = self.at(2); $0.subject = "Re: Gutters"; $0.mine = true; $0.state = .sent; $0.from = MailAddress(name: "Robin", address: "robin@icloud.example"); $0.preview = "Yes, 10 AM." }
        let g2 = mail { $0.thread = "t1"; $0.at = self.at(1); $0.subject = "Re: Gutters"; $0.seen = false; $0.preview = "Bring the ladder." }
        let shop = mail { $0.thread = "t2"; $0.at = self.at(0, 8); $0.automated = true; $0.bundle = "purchases"; $0.from = MailAddress(name: "Northwind", address: "o@northwind.example") }
        let lonely = mail { $0.thread = "t3"; $0.mine = true; $0.state = .sent }
        let rows = Mail.threads([g1, me, g2, shop, lonely])
        XCTAssertEqual(rows.count, 2)
        let t = rows.first { $0.summary.thread == "t1" }!
        XCTAssertEqual(t.id, g2.id)
        XCTAssertEqual(t.summary.subject, "Gutters")
        XCTAssertEqual(t.people, "Alex, me (3)")
        XCTAssertEqual(t.state, .inbox)
        XCTAssertEqual(t.summary.seen, false)
        XCTAssertEqual(t.summary.at, g2.at)
        XCTAssertEqual(t.members.map(\.id), [g1.id, me.id, g2.id])
        XCTAssertEqual(t.openIds, [g1.id, g2.id])
        XCTAssertEqual(t.doneIds, [])
        XCTAssertEqual(t.unreadIds, [g2.id])
        XCTAssertNil(t.summary.bundle)
        XCTAssertEqual(rows.first { $0.summary.thread == "t2" }?.people, "Northwind")
        // Done with one message, the other still in the Inbox: the thread stays in the Inbox.
        var g1done = g1; g1done.state = .done
        var g2done = g2; g2done.state = .done
        XCTAssertEqual(Mail.threads([g1done, g2]).first?.state, .inbox)
        XCTAssertEqual(Mail.threads([g1done, g2done]).first?.doneIds, [g1.id, g2.id])
        var late = me; late.id = "m-late"; late.at = at(0, 9); late.preview = "See you"
        var g2x = g2; g2x.preview = "x"
        XCTAssertEqual(Mail.threads([me, g2x, late]).first?.summary.preview, "You: See you")
    }

    func testHoldsABundlesMailUntilItsTimeOrKeepsItOutPinnedAlwaysShows() {
        // Arrived Thursday 10:30 AM.
        let arrived = ISO.string(date(2026, 11, 19, 10, 30))
        XCTAssertEqual(Mail.deliveryAt(arrived, MailBundleDelivery(mode: .daily, time: "07:00"), calendar: cal), date(2026, 11, 20, 7))
        XCTAssertEqual(Mail.deliveryAt(arrived, MailBundleDelivery(mode: .daily, time: "18:00"), calendar: cal), date(2026, 11, 19, 18))
        XCTAssertEqual(Mail.deliveryAt(arrived, MailBundleDelivery(mode: .weekly, time: "18:00", day: 0), calendar: cal), date(2026, 11, 22, 18))
        XCTAssertEqual(Mail.deliveryAt(arrived, MailBundleDelivery(mode: .weekly, time: "09:00", day: 4), calendar: cal), date(2026, 11, 26, 9), "Thursday 9 AM had passed: next week's")
        XCTAssertNil(Mail.deliveryAt(arrived, MailBundleDelivery(mode: .never), calendar: cal))
        XCTAssertEqual(Mail.deliveryAt(arrived, nil, calendar: cal), ISO.date(arrived))

        let delivery = ["promos": MailBundleDelivery(mode: .daily, time: "07:00"), "other": MailBundleDelivery(mode: .never)]
        let promo = mail { $0.at = arrived; $0.bundle = "promos"; $0.automated = true }
        let pinned = mail { $0.at = arrived; $0.bundle = "promos"; $0.automated = true; $0.pinned = true }
        let social = mail { $0.at = arrived; $0.bundle = "other"; $0.automated = true }
        let person = mail { $0.at = arrived }
        let thuNoon = date(2026, 11, 19, 12)
        XCTAssertNil(Mail.inboxAt(promo, delivery: delivery, now: thuNoon, calendar: cal))
        XCTAssertEqual(Mail.inboxAt(promo, delivery: delivery, now: date(2026, 11, 20, 8), calendar: cal), ISO.string(date(2026, 11, 20, 7)), "listed by when it showed")
        XCTAssertEqual(Mail.inboxAt(pinned, delivery: delivery, now: thuNoon, calendar: cal), arrived)
        XCTAssertNil(Mail.inboxAt(social, delivery: delivery, now: date(2027, 1, 1), calendar: cal))
        XCTAssertEqual(Mail.inboxAt(person, delivery: delivery, now: thuNoon, calendar: cal), arrived)
        let rows = Mail.inboxSections([promo, pinned, social, person], shown: Mail.shownBundles(on: allOn), now: thuNoon, delivery: delivery, calendar: cal).flatMap(\.rows)
        XCTAssertEqual(rows.map { r -> String in if case .mail(let m) = r { return m.id } else { return "bundle" } }, [pinned.id, person.id])
    }

    func testListsAMailBackFromASnoozeByWhenItCameBackAtTheTop() {
        let old = mail { $0.at = self.at(5); $0.subject = "Back from snooze"; $0.back_at = self.at(0, 14) }
        let fresh = mail { $0.at = self.at(0, 10); $0.subject = "Fresh" }
        XCTAssertEqual(Mail.shownAt(old), at(0, 14))
        let s = Mail.inboxSections([fresh, old], shown: Mail.shownBundles(on: allOn), now: now, calendar: cal)
        XCTAssertEqual(s.first?.title, "Today")
        XCTAssertEqual(s.first?.rows.map(describe), ["Back from snooze", "Fresh"])
    }

    func testShowsALogoOnlyAsTheHubSendsItADataSVG() {
        let svg = "data:image/svg+xml;base64," + Data("<svg xmlns='http://www.w3.org/2000/svg'/>".utf8).base64EncodedString()
        XCTAssertEqual(Mail.logoData(svg), Data("<svg xmlns='http://www.w3.org/2000/svg'/>".utf8))
        XCTAssertNil(Mail.logoData("https://cdn.shop.example/logo.svg"))
        XCTAssertNil(Mail.logoData("data:text/html;base64,PHNjcmlwdD4="))
        XCTAssertNil(Mail.logoData(svg + "\" onerror=\"alert(1)"))
        XCTAssertNil(Mail.logoData(nil))
    }

    func testMakesTheHttpsAddressesInAMessageLinksTheAddressItselfAsTheirText() {
        XCTAssertEqual(Mail.textParts("See https://example.com/a?b=1. Thanks"), [
            .init(text: "See "), .init(text: "https://example.com/a?b=1", href: "https://example.com/a?b=1"), .init(text: ". Thanks"),
        ])
        XCTAssertEqual(Mail.textParts("Visit www.shop.example, or not")[1], .init(text: "www.shop.example", href: "https://www.shop.example/"))
        XCTAssertEqual(Mail.textParts("(https://en.wikipedia.example/wiki/Tea_(drink))")[1].text, "https://en.wikipedia.example/wiki/Tea_(drink)", "a bracket the address opened stays")
        XCTAssertEqual(Mail.textParts("(see https://example.com/x)")[1].text, "https://example.com/x", "a bracket it did not open goes")
        XCTAssertEqual(Mail.textParts("Plain text, no address."), [.init(text: "Plain text, no address.")])
        for bad in ["http://example.com", "http://www.example.com", "javascript:alert(1)", "https://user:pw@example.com/", "mailto:a@b.example", "me@www.example.com", "https://localhost/x", "data:text/html,x"] {
            XCTAssertFalse(Mail.textParts("x \(bad) y").contains { $0.href != nil }, bad)
        }
        // Letters from another alphabet that look like Latin ones: the real host is shown beside it.
        XCTAssertEqual(Mail.textParts("https://\u{0430}pple.example/login")[0].warnHost, "xn--pple-43d.example")
        XCTAssertNil(Mail.textParts("https://apple.example/")[0].warnHost)
        for bad in ["javascript:alert(1)", "https://user:pw@shop.example/", "data:text/html,x", "not a url"] { XCTAssertNil(Mail.httpsLink(bad), bad) }
    }

    func testWarnsWhenRepliesWouldGoSomewhereOtherThanTheSender() {
        XCTAssertNil(Mail.replyToWarning(mail()))
        XCTAssertNil(Mail.replyToWarning(mail { $0.reply_to = "ALEX@example.com" }))
        XCTAssertEqual(Mail.replyToWarning(mail { $0.from = MailAddress(name: "Your Bank", address: "alerts@bank.example"); $0.reply_to = "help@b4nk-support.example" }),
                       "Replies go to help@b4nk-support.example, not to alerts@bank.example.")
    }

    func testNoticesADisplayNameThatShowsAnotherAddress() {
        XCTAssertTrue(Mail.nameHidesAddress(MailAddress(name: "support@bank.example", address: "x@evil.example")))
        XCTAssertFalse(Mail.nameHidesAddress(MailAddress(name: "Alex (alex@example.com)", address: "alex@example.com")))
        XCTAssertFalse(Mail.nameHidesAddress(alex))
    }

    func testOpensALinkFromInsideAMailOnlyWhenItIsHttpHttpsOrMailto() {
        XCTAssertEqual(Mail.frameLink("https://shop.example/a")?.absoluteString, "https://shop.example/a")
        XCTAssertEqual(Mail.frameLink("http://shop.example/a")?.absoluteString, "http://shop.example/a")
        XCTAssertEqual(Mail.frameLink("mailto:help@shop.example")?.absoluteString, "mailto:help@shop.example")
        XCTAssertNil(Mail.frameLink("javascript:alert(1)"))
        XCTAssertNil(Mail.frameLink("file:///c:/x"))
        XCTAssertNil(Mail.frameLink("data:text/html,x"))
        XCTAssertNil(Mail.frameLink("about:blank"))
        XCTAssertNil(Mail.frameLink(nil))
    }

    func testASelectionOfAnySizeGoesToTheHub500AtATime() {
        let ids = (0..<1201).map(String.init)
        let parts = Mail.batches(ids)
        XCTAssertEqual(parts.map(\.count), [500, 500, 201])
        XCTAssertEqual(parts.flatMap { $0 }, ids)
        XCTAssertEqual(Mail.batches([String]()).count, 0)
    }

    func testFoldsAMessagesQuotedTextWhereTheHubSaysCountingAsJavaScriptDoes() {
        // A word with an accent and an emoji: 7 UTF-16 units in JavaScript and 6 characters here; quote_at counts the first.
        let text = "Caf\u{00E9} \u{1F44B}\n\nOn Tuesday, Alex wrote:\n> hi"
        let quote = ("Caf\u{00E9} \u{1F44B}\n\n" as NSString).length
        let m = MailMessage(summary: mail(), text: text, quote_at: quote)
        XCTAssertEqual(m.ownText, "Caf\u{00E9} \u{1F44B}")
        XCTAssertEqual(MailMessage(summary: mail(), text: text).ownText, text)
        XCTAssertEqual(MailMessage(summary: mail(), text: text, quote_at: 9999).ownText, text, "a place past the end folds nothing")
    }

    /// Older hubs: Mail shows only while the hub lists it as on, never while the switches are unknown.
    func testMailShowsOnlyWhileTheHubListsItAsOn() {
        XCTAssertFalse([ModuleInfo]().isOnListed(.mailInbox))
        XCTAssertFalse([ModuleInfo(id: "mail_inbox", title: "Mail", on: false)].isOnListed(.mailInbox))
        XCTAssertTrue([ModuleInfo(id: "mail_inbox", title: "Mail", on: true)].isOnListed(.mailInbox))
        XCTAssertEqual(AppModule.mailInbox.rawValue, "mail_inbox")
    }

    /// Mail is not cached anywhere on the device: the hub's sessions keep no URL cache.
    func testHubSessionsKeepNoURLCache() {
        let c = HTTPTransport.sessionConfiguration()
        XCTAssertNil(c.urlCache)
        XCTAssertEqual(c.requestCachePolicy, .reloadIgnoringLocalCacheData)
        XCTAssertNil(HTTPTransport(baseURL: URL(string: "http://127.0.0.1:1")!, token: "t").session.configuration.urlCache)
    }

    /// Mail is never written down in a sample recording either.
    func testARecordingNeverKeepsMail() async throws {
        struct Fixed: HubTransport {
            func send(method: String, path: String, query: [String: String], body: Data?) async throws -> (status: Int, data: Data) { (200, Data(#"{"messages":[]}"#.utf8)) }
        }
        let r = RecordingTransport(inner: Fixed(), file: nil)
        _ = try await r.send(method: "GET", path: "mail", query: [:], body: nil)
        _ = try await r.send(method: "GET", path: "mail/messages/abc", query: [:], body: nil)
        _ = try await r.send(method: "GET", path: "notes", query: [:], body: nil)
        XCTAssertEqual(r.recording.entries.count, 1)
    }

    func testLongWaitsForTheMailRoutesThatSignInToTheMailbox() {
        XCTAssertEqual(HTTPTransport.timeout(path: "mail/refresh"), 120)
        XCTAssertEqual(HTTPTransport.timeout(path: HubClient.mailPath("0123abcd", "/pictures")), 120)
        XCTAssertEqual(HTTPTransport.timeout(path: "mail/done"), 60)
        XCTAssertNil(HTTPTransport.timeout(path: "mail"))
        XCTAssertEqual(HubClient.mailPath("../x"), "mail/messages/%2E%2E%2Fx", "an id is one path part")
    }
}
