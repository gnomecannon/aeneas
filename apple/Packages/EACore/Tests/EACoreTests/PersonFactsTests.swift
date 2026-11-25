import XCTest
@testable import EACore

/// A person's page in sections (PersonFacts.swift): the same cases as packages/shared/test/personFacts.test.ts, so a
/// person's page has the same sections on every device.
final class PersonFactsTests: XCTestCase {
    private let jamie = Entity(id: "jamie", kind: .person, fields: ["name": "Jamie Hill", "given_name": "Jamie"])

    private func fact(_ id: String, _ category: String, _ value: String, _ extra: [String: JSONValue] = [:], created: String = "2026-11-01T12:00:00.000Z") -> Entity {
        var f: [String: JSONValue] = ["category": .string(category), "key": .string(id), "value": .string(value), "person_id": "jamie"]
        f.merge(extra) { _, b in b }
        var e = Entity(id: id, kind: .fact, fields: f)
        e.created_at = created
        return e
    }

    func testEachFactInItsSectionGiftIdeasNotGivenFirstMentionsInOther() {
        var kept = fact("f3", "dislike", "Hates cilantro")
        kept.fields["person_id"] = nil
        kept.fields["person"] = "Jamie"
        var gone = fact("d1", "like", "Gone")
        gone.deleted_at = "2026-11-02T00:00:00.000Z"
        let facts = [
            fact("f1", "like", "Loves sushi"),
            fact("f2", "preference", "Prefers window seats"),
            // Kept with their name before they were in People.
            kept,
            fact("g1", "gift_idea", "Lego castle", created: "2026-11-01T12:00:00.000Z"),
            fact("g2", "gift_idea", "Wool scarf", ["occasion": "birthday"], created: "2026-11-10T12:00:00.000Z"),
            fact("g3", "gift_idea", "Board game", ["given_at": "2026-10-20"], created: "2026-10-01T12:00:00.000Z"),
            fact("g4", "gift_idea", "Concert tickets", ["given_at": "2026-11-05"], created: "2026-09-01T12:00:00.000Z"),
            fact("h1", "health", "Allergic to peanuts"),
            fact("c1", "constraint", "No caffeine after noon"),
            fact("r1", "relationship", "Sister of Devon"),
            fact("i1", "identity", "Works at the library"),
            // Devon's gift idea that names Jamie: someone else's, so not in Jamie's Gift ideas.
            fact("m1", "gift_idea", "A puzzle for Devon and Jamie", ["person_id": "devon"]),
            gone,
        ]
        let groups = PersonFacts.groups(jamie, facts: facts)
        XCTAssertEqual(groups.map(\.id), ["likes", "dislikes", "gift_ideas", "health_and_food", "history", "other"])
        XCTAssertEqual(groups.map { $0.items.map(\.id) }, [["f1", "f2"], ["f3"], ["g2", "g1", "g4", "g3"], ["h1", "c1"], ["r1"], ["i1", "m1"]])
    }

    func testEverySectionIsThereWhenThereAreNoneTheFirstThreeWithWhatTheyAdd() {
        let groups = PersonFacts.groups(jamie, facts: [])
        XCTAssertEqual(groups.map(\.title), ["Likes", "Dislikes", "Gift ideas", "Health and food", "History", "Other"])
        XCTAssertEqual(groups.map(\.add), [.like, .dislike, .giftIdea, nil, nil, nil])
        XCTAssertEqual(groups.map(\.empty), ["No likes yet", "No dislikes yet", "No gift ideas yet", nil, nil, nil])
        XCTAssertTrue(groups.allSatisfy(\.items.isEmpty))
    }

    func testTheKeyIsMadeFromTheValueSoTwoIdeasNeverShareOne() {
        XCTAssertEqual(PersonFacts.key(.giftIdea, value: "A LEGO castle set, the big one!"), "gift:a_lego_castle_set_the_big")
        XCTAssertEqual(PersonFacts.key(.like, value: "Crème brûlée"), "like:creme_brulee")
        XCTAssertEqual(PersonFacts.key(.dislike, value: "  "), "dislike:item")
        XCTAssertNotEqual(PersonFacts.key(.giftIdea, value: "Wool scarf"), PersonFacts.key(.giftIdea, value: "Board game"))
    }

    func testTheNewCategoriesDecodeAndReadAsWords() throws {
        let e = Entity(kind: .fact, fields: ["category": "gift_idea", "key": "gift:wool_scarf", "value": "Wool scarf", "given_at": "2026-12-25", "occasion": "Christmas"])
        XCTAssertEqual(e.decoded(FactFields.self)?.category, .giftIdea)
        XCTAssertEqual(FactCategory.giftIdea.label, "Gift idea")
        XCTAssertEqual(FactCategory.like.label, "Like")
    }
}
