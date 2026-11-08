import Foundation

/// Meds, job follow-ups and people shown on Today. Same rules as the web app's `lib/today.ts`.
public enum TodayExtras {
    public struct Med: Equatable, Sendable {
        public var name: String
        public var takenAt: Date?
    }

    /// A date on someone's card coming up: their birthday, an anniversary, or any other labeled date from Contacts.
    public struct PersonDate: Equatable, Sendable {
        public var id: String
        public var name: String
        /// "birthday", "anniversary", another label, or "" for an unlabeled date.
        public var label: String
        public var date: Date
        public var days: Int
        /// The age, or the anniversary count, when the year is known.
        public var years: Int?
    }

    private static func shortName(_ p: Entity) -> String {
        [p.str("nickname"), p.str("given_name"), p.str("name")].first { !$0.isEmpty } ?? ""
    }

    /// Birthdays and every other date on people's cards within `within` days from today (0 = today), soonest first.
    /// A date is YYYY-MM-DD, or --MM-DD without a year; Feb 29 is Feb 28 in other years. Same rule as the hub.
    public static func datesSoon(_ people: [Entity], now: Date = Date(), within: Int = 14, calendar: Calendar = .current) -> [PersonDate] {
        let today = calendar.startOfDay(for: now)
        let year = calendar.component(.year, from: today)
        var out: [PersonDate] = []
        for p in people where !p.isDeleted {
            var entries: [(String, String)] = [("birthday", p.str("birthday"))]
            for v in p.fields["dates"]?.arrayValue ?? [] {
                if case .object(let o) = v { entries.append((o["label"]?.stringValue ?? "", o["date"]?.stringValue ?? "")) }
            }
            for (rawLabel, raw) in entries {
                let s = raw.trimmingCharacters(in: .whitespaces)
                let parts = s.split(separator: "-").map(String.init)
                let born: Int?, month: Int, day: Int
                if s.hasPrefix("--"), parts.count == 2, let m = Int(parts[0]), let d = Int(parts[1]) { born = nil; month = m; day = d }
                else if parts.count == 3, let y = Int(parts[0]), let m = Int(parts[1]), let d = Int(parts[2]) { born = y; month = m; day = d }
                else { continue }
                guard (1...12).contains(month), (1...31).contains(day) else { continue }
                func on(_ y: Int) -> Date? {
                    let leapless = month == 2 && day == 29 && calendar.date(from: DateComponents(year: y, month: 2, day: 29)).map { calendar.component(.month, from: $0) != 2 } ?? true
                    return calendar.date(from: DateComponents(year: y, month: month, day: leapless ? 28 : day))
                }
                guard var next = on(year) else { continue }
                if next < today, let n = on(year + 1) { next = n }
                let days = calendar.dateComponents([.day], from: today, to: next).day ?? 0
                guard days <= within else { continue }
                let years = born.map { calendar.component(.year, from: next) - $0 }.flatMap { $0 > 0 ? $0 : nil }
                let label = rawLabel.trimmingCharacters(in: .whitespaces).lowercased()
                out.append(PersonDate(id: p.id, name: shortName(p), label: label == "other" ? "" : label, date: next, days: days, years: years))
            }
        }
        return out.sorted { $0.days != $1.days ? $0.days < $1.days : $0.name < $1.name }
    }

    /// "Kim's birthday Mon (turns 36)", "Jamie's anniversary today (5 years)", "Ana Nov 20" (a date without a label).
    public static func phrase(_ d: PersonDate, calendar: Calendar = .current) -> String {
        let when: String
        switch d.days {
        case 0: when = "today"
        case 1: when = "tomorrow"
        case 2..<7: when = d.date.formatted(.dateTime.weekday(.abbreviated))
        default: when = d.date.formatted(.dateTime.month(.abbreviated).day())
        }
        let count = d.years.map { d.label == "birthday" ? " (turns \($0))" : " (\($0) year\($0 == 1 ? "" : "s"))" } ?? ""
        return "\(d.label.isEmpty ? d.name : "\(d.name)'s \(d.label)") \(when)\(count)"
    }

    // MARK: people in today's plans

    /// Someone named in today's plans, with what the owner has told the app about them.
    public struct PersonToday: Equatable, Sendable, Identifiable {
        public var id: String
        public var name: String
        /// Every plan today that names them, in time order.
        public var plans: [PlanItem]
        public var notes: [String]
    }

    public struct PlanItem: Equatable, Sendable {
        public var id: String, title: String, text: String, at: Date?
        public init(id: String, title: String, text: String = "", at: Date? = nil) { self.id = id; self.title = title; self.text = text; self.at = at }
    }

    /// Lowercase words only, for matching names in text. Same rule as the hub.
    static func nameNorm(_ s: String) -> String {
        let kept = s.lowercased().map { c -> Character in (c.isASCII && (c.isLetter || c.isNumber)) || c == "'" || c == " " ? c : " " }
        return String(kept).split(separator: " ").joined(separator: " ")
    }

    private static func firstName(_ p: Entity) -> String {
        let g = nameNorm(p.str("given_name"))
        return g.isEmpty ? (nameNorm(p.str("name")).split(separator: " ").first.map(String.init) ?? "") : g
    }

    /// The names that point at a person in text: full name, nickname, and a first name nobody else shares.
    public static func mentionNames(_ person: Entity, among everyone: [Entity]) -> [String] {
        var names = [person.str("name"), person.str("nickname")].map(nameNorm).filter { $0.count >= 2 }
        let given = firstName(person)
        if given.count >= 2, !everyone.contains(where: { $0.id != person.id && !$0.isDeleted && firstName($0) == given }) { names.append(given) }
        var seen = Set<String>()
        return names.filter { seen.insert($0).inserted }
    }

    /// Whether one of `names` appears in `text` as whole words (a trailing 's counts).
    public static func mentions(_ text: String, _ names: [String]) -> Bool {
        let t = (" " + nameNorm(text) + " ").replacingOccurrences(of: "'s ", with: " ")
        return names.contains { t.contains(" \($0) ") }
    }

    private static let stop: Set<String> = Set("about after again also going have just like likes loves only really some that them then there they this tonight today tomorrow with from what when will would your".split(separator: " ").map(String.init))

    private static func words(_ s: String, skip: Set<String>) -> Set<String> {
        Set(nameNorm(s).replacingOccurrences(of: "'s", with: "").split(separator: " ").map(String.init).filter { $0.count >= 4 && !stop.contains($0) && !skip.contains($0) })
    }

    /// What the owner has told the app about someone: facts linked to them (`person_id`), kept with their name before
    /// they were in People (`person`), or whose text names them, linked ones first. Same rule as the hub.
    public static func factsAbout(_ person: Entity, among everyone: [Entity], facts: [Entity]) -> [Entity] {
        let called = Set([person.str("name"), person.str("nickname"), person.str("given_name")].map(nameNorm).filter { !$0.isEmpty })
        let names = mentionNames(person, among: everyone)
        func linked(_ f: Entity) -> Bool { f.str("person_id") == person.id || (f.str("person_id").isEmpty && called.contains(nameNorm(f.str("person")))) }
        let live = facts.filter { !$0.isDeleted }
        return live.filter(linked) + live.filter { !linked($0) && mentions($0.str("value"), names) }
    }

    /// What today still holds that can name someone, in time order: events not over yet, reminders due, and tasks
    /// being done or due today.
    public static func plansToday(events: [Entity], reminders: [Entity], tasks: [Entity], now: Date = Date(), calendar: Calendar = .current) -> [PlanItem] {
        let end = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: now)) ?? now
        var items: [PlanItem] = []
        // All-day events are today's for the whole day (the caller passes today's events).
        for e in events where !e.isDeleted && (e.bool("all_day") == true || (e.date("end") ?? e.date("start") ?? .distantPast) > now) {
            items.append(PlanItem(id: e.id, title: e.str("title"), text: e.str("location"), at: e.bool("all_day") == true ? nil : e.date("start")))
        }
        // A task reminder keeps its time in remind_at; reading only the old kind's `at` left every reminder with no
        // time, sorted after the timed plans.
        for r in reminders where !r.isDeleted {
            items.append(PlanItem(id: r.id, title: r.str("title"), at: r.alertDate ?? r.date("snoozed_until") ?? r.date("remind_at") ?? r.date("at")))
        }
        for t in tasks where !t.isDeleted && t.str("status") != "done" && (t.str("status") == "doing" || (t.date("due").map { $0 < end } ?? false)) {
            items.append(PlanItem(id: t.id, title: t.str("title"), text: t.str("notes")))
        }
        return items.enumerated().sorted { a, b in
            switch (a.element.at, b.element.at) {
            case let (x?, y?): return x != y ? x < y : a.offset < b.offset
            case (_?, nil): return true
            case (nil, _?): return false
            default: return a.offset < b.offset
            }
        }.map(\.element)
    }

    /// The people today's plans name, in the order of their first plan, each with every plan that names them and up
    /// to three things the owner told the app about them: those sharing words with their plans first, so dinner at
    /// Luigi's brings up what they like at Luigi's, then the newest. Same rule as the hub.
    public static func peopleInPlans(people: [Entity], facts: [Entity], plans: [PlanItem], limit: Int = 6) -> [PersonToday] {
        let live = people.filter { !$0.isDeleted }
        let names = Dictionary(live.map { ($0.id, mentionNames($0, among: live)) }, uniquingKeysWith: { a, _ in a })
        var order: [Entity] = []
        var theirs: [String: [PlanItem]] = [:]
        for plan in plans {
            for p in live where mentions(plan.title + "\n" + plan.text, names[p.id] ?? []) {
                if theirs[p.id] != nil { theirs[p.id]?.append(plan) }
                else if order.count < limit { order.append(p); theirs[p.id] = [plan] }
            }
        }
        var out: [PersonToday] = []
        for p in order {
            let mine = theirs[p.id] ?? []
            let own = Set((names[p.id] ?? []).flatMap { $0.split(separator: " ").map(String.init) })
            let planWords = words(mine.map { $0.title + " " + $0.text }.joined(separator: " "), skip: own)
            let about = factsAbout(p, among: live, facts: facts)
            let scored: [(fact: Entity, shared: Int)] = about.map { f in (f, words(f.str("value"), skip: own).intersection(planWords).count) }
            let ranked = scored.sorted { a, b in a.shared != b.shared ? a.shared > b.shared : a.fact.updated_at > b.fact.updated_at }
            let notes: [String] = ranked.prefix(3).map { $0.fact.str("value") }.filter { !$0.isEmpty }
            out.append(PersonToday(id: p.id, name: shortName(p), plans: mine, notes: notes))
        }
        return out
    }

    private static let closedStages: Set<String> = ["rejected", "withdrawn", "accepted"]

    /// Job applications whose next step is due by the end of today, oldest first.
    public static func followUpsDue(_ apps: [Entity], now: Date = Date(), calendar: Calendar = .current) -> [Entity] {
        guard let end = calendar.date(bySettingHour: 23, minute: 59, second: 59, of: now) else { return [] }
        return apps
            .filter { !$0.isDeleted && !closedStages.contains($0.str("stage")) && ($0.date("next_at").map { $0 <= end } ?? false) }
            .sorted { ($0.date("next_at") ?? .distantPast) < ($1.date("next_at") ?? .distantPast) }
    }

    /// Meds taken regularly: logged on at least 2 different days in the 7 days before today, with when today's was
    /// logged. The spelling of the newest log is the one shown.
    public static func regularMeds(_ logs: [Entity], now: Date = Date(), calendar: Calendar = .current) -> [Med] {
        let startToday = calendar.startOfDay(for: now)
        guard let since = calendar.date(byAdding: .day, value: -7, to: startToday) else { return [] }
        var days: [String: Set<Date>] = [:]
        var display: [String: (name: String, at: Date)] = [:]
        var today: [String: Date] = [:]
        for l in logs where !l.isDeleted && l.str("type") == "med" {
            let name = (l.fields["value"]?.displayString ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty, let at = l.date("at") else { continue }
            let key = name.lowercased()
            if at >= startToday {
                if at <= now.addingTimeInterval(60), today[key].map({ at > $0 }) ?? true { today[key] = at }
                continue
            }
            guard at >= since else { continue }
            days[key, default: []].insert(calendar.startOfDay(for: at))
            if display[key].map({ at > $0.at }) ?? true { display[key] = (name, at) }
        }
        return days.filter { $0.value.count >= 2 }
            .compactMap { key, _ in display[key].map { Med(name: $0.name, takenAt: today[key]) } }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }
}
