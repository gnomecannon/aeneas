import XCTest
@testable import EACore

final class TodayExtrasTests: XCTestCase {
    private let cal: Calendar = { var c = Calendar(identifier: .gregorian); c.timeZone = TimeZone(identifier: "America/Chicago")!; return c }()
    private func day(_ d: Int, _ h: Int = 8) -> Date { cal.date(from: DateComponents(year: 2026, month: 10, day: d, hour: h))! }
    private func med(_ v: String, _ at: Date) -> Entity { Entity(kind: .log, fields: ["type": "med", "value": .string(v), "at": .string(ISO.string(at))]) }

    func testRegularMedsNeedTwoDaysAndReportToday() {
        let now = day(28, 12)
        let logs = [
            med("Claritin", day(27)), med("claritin", day(26)), med("Claritin", day(28, 9)),
            med("Ibuprofen", day(25)), med("Ibuprofen", day(25, 20)),
            med("Zyrtec", day(27)), med("Zyrtec", day(24)),
            med("Old", day(18)), med("Old", day(16)),
        ]
        let r = TodayExtras.regularMeds(logs, now: now, calendar: cal)
        XCTAssertEqual(r.map(\.name), ["Claritin", "Zyrtec"])
        XCTAssertEqual(r[0].takenAt, day(28, 9))
        XCTAssertNil(r[1].takenAt)
    }

    func testDatesSoonestFirstWithAgesAndYears() {
        func person(_ n: String, _ b: String, _ dates: [(String, String)] = []) -> Entity {
            Entity(kind: .person, fields: ["name": .string(n), "birthday": .string(b), "dates": .array(dates.map { .object(["label": .string($0.0), "date": .string($0.1)]) })])
        }
        let now = day(31, 9)
        let r = TodayExtras.datesSoon([person("Beth", "1990-11-02", [("anniversary", "2021-11-05"), ("other", "--11-01")]), person("Jamie", "--10-31"), person("Far", "1980-12-25"), person("Past", "--10-30"), person("Bad", "soon")],
                                      now: now, within: 14, calendar: cal)
        XCTAssertEqual(r.map(\.name), ["Jamie", "Beth", "Beth", "Beth"])
        XCTAssertEqual(r.map(\.label), ["birthday", "", "birthday", "anniversary"])
        XCTAssertEqual(r.map(\.days), [0, 1, 2, 5])
        XCTAssertEqual(r.map(\.years), [nil, nil, 36, 5])
        XCTAssertEqual(TodayExtras.phrase(r[0]), "Jamie's birthday today")
        XCTAssertEqual(TodayExtras.phrase(r[1]), "Beth tomorrow")
        XCTAssertTrue(TodayExtras.phrase(r[3]).hasSuffix("anniversary Thu (5 years)"))
        let leap = TodayExtras.datesSoon([person("Leap", "2000-02-29")], now: cal.date(from: DateComponents(year: 2027, month: 2, day: 20))!, within: 14, calendar: cal)
        XCTAssertEqual(cal.component(.day, from: leap[0].date), 28)
        XCTAssertEqual(leap[0].years, 27)
    }

    func testPeopleInPlansWithWhatTheOwnerSaidPlanWordsFirst() {
        func person(_ id: String, _ n: String, _ extra: [String: JSONValue] = [:]) -> Entity { Entity(id: id, kind: .person, fields: ["name": .string(n)].merging(extra) { a, _ in a }) }
        func fact(_ v: String, _ pid: String, _ updated: String) -> Entity { var f = Entity(kind: .fact, fields: ["value": .string(v), "person_id": .string(pid)]); f.updated_at = updated; return f }
        let people = [person("beth", "Elizabeth Carter", ["given_name": "Elizabeth", "nickname": "Beth"]), person("jamie", "Jamie Hill"), person("jamie2", "Jamie Stone")]
        let facts = [fact("Beth is allergic to shellfish", "beth", "2026-10-30"), fact("Beth likes the house salad at Luigi's", "beth", "2026-10-01"),
                     fact("Beth works at the library", "beth", "2026-10-29"), fact("Beth has a cat", "beth", "2026-10-20")]
        let dinner = Entity(id: "e1", kind: .event, fields: ["title": "Dinner at Luigi's with Beth", "start": .string(ISO.string(day(31, 19))), "end": .string(ISO.string(day(31, 20)))])
        let lunch = Entity(id: "e0", kind: .event, fields: ["title": "Lunch with Beth", "start": .string(ISO.string(day(31, 7))), "end": .string(ISO.string(day(31, 8)))])
        let call = Entity(id: "t1", kind: .task, fields: ["title": "Call Jamie back", "status": "doing"])
        let plans = TodayExtras.plansToday(events: [dinner, lunch], reminders: [], tasks: [call], now: day(31, 9), calendar: cal)
        XCTAssertEqual(plans.map(\.id), ["e1", "t1"])
        // An all-day plan is stored at midnight UTC, the evening before in Chicago: it is still today's, after timed ones.
        let allDay = Entity(id: "e3", kind: .event, fields: ["title": "Luigi's with Beth", "all_day": true, "start": "2026-10-31T00:00:00.000Z", "end": "2026-11-01T00:00:00.000Z"])
        let local = LocalPlanner.day(day(31, 9), tasks: [], rules: [], events: [allDay, lunch], reminders: [], watches: [], now: day(31, 9), calendar: cal)
        XCTAssertEqual(Set(local.events.map(\.id)), ["e3", "e0"])
        let tomorrow = LocalPlanner.day(day(30, 9), tasks: [], rules: [], events: [allDay], reminders: [], watches: [], now: day(30, 9), calendar: cal)
        XCTAssertTrue(tomorrow.events.isEmpty, "not on the evening before")
        XCTAssertEqual(TodayExtras.plansToday(events: [allDay, dinner], reminders: [], tasks: [], now: day(31, 21), calendar: cal).map(\.id), ["e3"])
        let twice = TodayExtras.peopleInPlans(people: people, facts: facts, plans: plans + [TodayExtras.PlanItem(id: "e2", title: "Beth's game night")])
        XCTAssertEqual(twice.first?.plans.map(\.id), ["e1", "e2"])
        let r = TodayExtras.peopleInPlans(people: people, facts: facts, plans: plans)
        XCTAssertEqual(r.map(\.id), ["beth"], "Jamie is two people, so a bare first name names neither")
        XCTAssertEqual(r[0].plans.map(\.id), ["e1"])
        XCTAssertEqual(r[0].notes, ["Beth likes the house salad at Luigi's", "Beth is allergic to shellfish", "Beth works at the library"])
        let group = Entity(id: "g", kind: .fact, fields: ["value": "Friend group for board games: Devon, Casey, Beth"])
        let lookalike = Entity(id: "x", kind: .fact, fields: ["value": "Lizzo concert tickets"])
        XCTAssertEqual(TodayExtras.factsAbout(people[0], among: people, facts: [group, lookalike] + facts).map(\.id).last, "g")
        XCTAssertTrue(TodayExtras.mentions("Beth's game night", ["beth"]))
        XCTAssertFalse(TodayExtras.mentions("Lizard show", ["beth"]))
    }

    func testFollowUpsDueByTonight() {
        let now = day(28, 12)
        func app(_ c: String, _ stage: String, _ at: Date?) -> Entity {
            var f: [String: JSONValue] = ["company": .string(c), "role": "Admin", "stage": .string(stage)]
            if let at { f["next_at"] = .string(ISO.string(at)) }
            return Entity(kind: .application, fields: f)
        }
        let r = TodayExtras.followUpsDue([app("B", "screen", day(28, 20)), app("C", "applied", day(29, 9)), app("D", "rejected", day(27)), app("E", "saved", nil), app("A", "applied", day(26))], now: now, calendar: cal)
        XCTAssertEqual(r.map { $0.str("company") }, ["A", "B"])
    }
}
