import XCTest
@testable import EACore

final class PeopleInPlansSpeedTests: XCTestCase {
    /// Looking only at the people a plan could name gives the same people, plans and order as testing everyone against
    /// every plan, the rule as it was written: shared first names, nicknames, two-word names, possessives, deleted people.
    func testSameAnswerAsEveryoneAgainstEveryPlan() {
        var rng = SystemRandomNumberGenerator()
        let given = ["Jamie", "Alex", "Robin", "Devon", "Sam", "Casey", "Jo", "O'Neil", "Ana Lu"]
        let family = ["Hale", "Reyes", "Park", "Novak"]
        var found = 0
        for round in 0..<40 {
            var people: [Entity] = []
            for i in 0..<Int.random(in: 5...40, using: &rng) {
                let g = given.randomElement(using: &rng)!, f = family.randomElement(using: &rng)!
                var fields: [String: JSONValue] = ["name": .string(Bool.random(using: &rng) ? "\(g) \(f)" : g)]
                if Int.random(in: 0..<4, using: &rng) == 0 { fields["nickname"] = .string(["Jay", "Bee", "Rob", "Dev"].randomElement(using: &rng)!) }
                if Bool.random(using: &rng) { fields["given_name"] = .string(g) }
                var p = Entity(id: "p\(round)-\(i)", kind: .person, fields: fields)
                if Int.random(in: 0..<10, using: &rng) == 0 { p.deleted_at = ISO.now() }
                people.append(p)
            }
            let words = given + family + ["Jay's", "dinner", "with", "Bee", "at", "Rob's", "and", "the", "park", "Hale's", "o'neil", "ana", "lu"]
            let plans = (0..<Int.random(in: 1...30, using: &rng)).map { i in
                TodayExtras.PlanItem(id: "x\(i)", title: (0..<Int.random(in: 1...8, using: &rng)).map { _ in words.randomElement(using: &rng)! }.joined(separator: Bool.random(using: &rng) ? " " : ", "),
                                     text: Bool.random(using: &rng) ? words.randomElement(using: &rng)! : "")
            }
            let got = TodayExtras.peopleInPlans(people: people, facts: [], plans: plans, limit: 50)
            // The rule as written before: every live person against every plan, in the order of `live`.
            let live = people.filter { !$0.isDeleted }
            var order: [String] = []
            var theirs: [String: [String]] = [:]
            for plan in plans {
                for p in live where TodayExtras.mentions(plan.title + "\n" + plan.text, TodayExtras.mentionNames(p, among: live)) {
                    if theirs[p.id] != nil { theirs[p.id]?.append(plan.id) } else { order.append(p.id); theirs[p.id] = [plan.id] }
                }
            }
            XCTAssertEqual(got.map(\.id), order, "round \(round)")
            XCTAssertEqual(got.map { $0.plans.map(\.id) }, order.map { theirs[$0] ?? [] }, "round \(round)")
            found += order.count
        }
        XCTAssertGreaterThan(found, 40, "the random plans name people")
    }
}
