import XCTest
@testable import EACore

final class InboxSectionsSpeedTests: XCTestCase {
    /// The Inbox's sections, now worked out with each day's group once and each bundle's mail gathered apart, are the
    /// sections the plain way gives (a group per mail, each mail added to its bundle's row), on random lists of mail:
    /// days from today back to last year, bundles, pinned mail, mail back from snooze, held bundles.
    func testSameSectionsAsThePlainWay() {
        var rng = SystemRandomNumberGenerator()
        let now = Date()
        let shown = Mail.shownBundles(on: { _ in true })
        let bundles: [String?] = [nil, nil, "purchases", "other", "promos", "trips", "bills", "pet", "jobs", "gone"]
        for round in 0..<30 {
            let mails: [MailSummary] = (0..<Int.random(in: 1...400, using: &rng)).map { n in
                let at = ISO.string(now.addingTimeInterval(-Double.random(in: -3_600...(400 * 86_400), using: &rng)))
                var m = MailSummary(id: "m\(round)-\(n)", at: at, from: MailAddress(name: "Alex", address: "alex@example.com"), subject: "Mail \(n)", preview: "Hi")
                m.bundle = bundles.randomElement(using: &rng)!
                m.pinned = Int.random(in: 0..<15, using: &rng) == 0
                if Int.random(in: 0..<10, using: &rng) == 0 { m.back_at = ISO.string(now.addingTimeInterval(-Double.random(in: 0...86_400, using: &rng))) }
                return m
            }
            let delivery: [String: MailBundleDelivery] = round % 3 == 0 ? [:] : ["promos": MailBundleDelivery(mode: .daily, time: "17:00"), "bills": MailBundleDelivery(mode: .never, time: nil)]
            for pinnedOnly in [false, true] {
                let got = Mail.inboxSections(mails, shown: shown, pinnedOnly: pinnedOnly, now: now, delivery: delivery)
                XCTAssertEqual(flat(got), flat(plain(mails, shown: shown, pinnedOnly: pinnedOnly, now: now, delivery: delivery)), "round \(round)")
            }
        }
    }

    private func flat(_ s: [Mail.DaySection<MailSummary>]) -> [String] {
        s.flatMap { sec in [sec.title] + sec.rows.map { r -> String in
            switch r {
            case .mail(let m): return "mail \(m.id)"
            case .bundle(let b, let ms): return "bundle \(b.id): \(ms.map(\.id).joined(separator: ","))"
            }
        } }
    }

    /// The sections as they were made before 2026-11-25.
    private func plain(_ messages: [MailSummary], shown: [Mail.Bundle], pinnedOnly: Bool, now: Date, delivery: [String: MailBundleDelivery]) -> [Mail.DaySection<MailSummary>] {
        let held = Mail.shownDelivery(delivery, shown: shown)
        let timed: [(MailSummary, String)] = messages.compactMap { s in
            guard s.state == .inbox, !pinnedOnly || s.pinned, let w = Mail.inboxAt(s, delivery: held, now: now) else { return nil }
            return (s, w)
        }
        let sorted = timed.enumerated().sorted { a, b in a.element.1 == b.element.1 ? a.offset < b.offset : a.element.1 > b.element.1 }.map(\.element)
        var sections: [Mail.DaySection<MailSummary>] = []
        for (m, when) in sorted {
            let title = Mail.dayGroup(when, now: now)
            if sections.last?.title != title { sections.append(Mail.DaySection(title: title, rows: [])) }
            let i = sections.count - 1
            guard !m.pinned, !pinnedOnly, let b = Mail.bundleOf(m, in: shown) else { sections[i].rows.append(.mail(m)); continue }
            if let r = sections[i].rows.firstIndex(where: { if case .bundle(let x, _) = $0 { return x.id == b.id } else { return false } }),
               case .bundle(let x, var mails) = sections[i].rows[r] {
                mails.append(m)
                sections[i].rows[r] = .bundle(x, mails)
            } else {
                sections[i].rows.append(.bundle(b, [m]))
            }
        }
        return sections
    }
}
