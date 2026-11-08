import XCTest
@testable import EACore

final class ContactsMirrorTests: XCTestCase {
    private func person(_ id: String, _ name: String, phones: [String] = [], apple: String? = nil, device: String = "mac", deleted: Bool = false) -> Entity {
        var f: [String: JSONValue] = ["name": .string(name), "given_name": .string(name), "phones": .array(phones.map { .object(["value": .string($0)]) }), "emails": [], "addresses": []]
        if let a = apple { f["apple"] = .object(["id": .string(a), "device": .string(device)]) }
        return Entity(id: id, kind: .person, deleted_at: deleted ? ISO.now() : nil, fields: f)
    }
    private func contact(_ id: String, _ name: String, phones: [String] = []) -> AppleContact {
        var c = ContactCard(); c.name = name; c.given = name; c.phones = phones.map { .init(label: "mobile", value: $0) }
        return AppleContact(id: id, card: c)
    }

    func testNewContactsBecomePeopleAndAppPeopleBecomeCards() {
        let p = ContactsMirror.plan(people: [person("p1", "Devon")], contacts: [contact("c1", "Mia")], state: [:], deviceId: "mac")
        XCTAssertEqual(p.newPeople.map(\.id), ["c1"])
        XCTAssertEqual(p.creates.map(\.personId), ["p1"])
    }

    func testSomeoneAddedInTheAppIsLinkedToTheirCardAndMerged() {
        let p = ContactsMirror.plan(people: [person("p1", "Mia", phones: ["312-555-0199"])], contacts: [contact("c1", "mia", phones: ["(312) 555-0101"])], state: [:], deviceId: "mac")
        XCTAssertEqual(p.links, [.init(personId: "p1", contactId: "c1")])
        XCTAssertEqual(p.patches["p1"]?.phones.count, 2)
        XCTAssertEqual(p.writes.first?.card.phones.count, 2, "the app's number reaches Apple Contacts")
        XCTAssertTrue(p.newPeople.isEmpty && p.creates.isEmpty)
    }

    func testChangesFlowTheRightWay() {
        let mia = person("p1", "Mia", phones: ["3125550101"], apple: "c1")
        let agreed = ContactCard(person: person("p1", "Mia", phones: ["3125550101"], apple: "c1")).comparable
        // Changed in the app since the last run: written to Apple.
        let appSide = ContactsMirror.plan(people: [person("p1", "Mia", phones: ["3125550101", "3125550199"], apple: "c1")], contacts: [contact("c1", "Mia", phones: ["312 555 0101"])], state: ["p1": agreed], deviceId: "mac")
        XCTAssertEqual(appSide.writes.count, 1)
        XCTAssertTrue(appSide.patches.isEmpty)
        // Changed in Apple Contacts: copied to the app.
        let appleSide = ContactsMirror.plan(people: [mia], contacts: [contact("c1", "Mia", phones: ["312 555 0101", "312 555 0123"])], state: ["p1": agreed], deviceId: "mac")
        XCTAssertEqual(appleSide.patches["p1"]?.phones.count, 2)
        XCTAssertTrue(appleSide.writes.isEmpty)
        // Same on both sides apart from phone formatting and labels: nothing to do.
        let same = ContactsMirror.plan(people: [mia], contacts: [contact("c1", "Mia", phones: ["+1 (312) 555-0101"])], state: [:], deviceId: "mac")
        XCTAssertTrue(same.writes.isEmpty && same.patches.isEmpty)
    }

    func testDatesOnTheCardReachTheAppWithoutBeingWipedByOldSnapshots() {
        let mia = person("p1", "Mia", apple: "c1")
        // The snapshot from before dates synced has no dates key; the card has an anniversary.
        let agreed = ContactCard(person: mia).comparable
        var card = contact("c1", "Mia"); card.card.dates = [.init(label: "anniversary", date: "2021-11-05")]
        let p = ContactsMirror.plan(people: [mia], contacts: [card], state: ["p1": agreed], deviceId: "mac")
        XCTAssertTrue(p.writes.isEmpty, "the card's dates are not overwritten")
        XCTAssertEqual(p.patches["p1"]?.dates, [.init(label: "anniversary", date: "2021-11-05")])
        XCTAssertEqual(p.patches["p1"]?.personFields["dates"], .array([.object(["label": "anniversary", "date": "2021-11-05"])]))
        // A date added in the app goes to the card.
        var withDate = mia; withDate.fields["dates"] = .array([.object(["label": "first date", "date": "--06-12"])])
        let q = ContactsMirror.plan(people: [withDate], contacts: [contact("c1", "Mia")], state: ["p1": agreed], deviceId: "mac")
        XCTAssertEqual(q.writes.first?.card.dates, [.init(label: "first date", date: "--06-12")])
    }

    func testDeletionRules() {
        // Deleted in the app: the card is left alone and not imported again.
        let gone = ContactsMirror.plan(people: [person("p1", "Mia", apple: "c1", deleted: true)], contacts: [contact("c1", "Mia")], state: [:], deviceId: "mac")
        XCTAssertTrue(gone.newPeople.isEmpty && gone.writes.isEmpty)
        // Deleted in Apple Contacts: removed here only by a device that saw it before.
        let seen = ContactsMirror.plan(people: [person("p1", "Mia", apple: "c1")], contacts: [], state: ["p1": [:]], deviceId: "mac")
        XCTAssertEqual(seen.personDeletes, ["p1"])
        let unseen = ContactsMirror.plan(people: [person("p1", "Mia", apple: "c1")], contacts: [], state: [:], deviceId: "mac")
        XCTAssertTrue(unseen.personDeletes.isEmpty)
        // Linked by another device: not this device's business.
        let other = ContactsMirror.plan(people: [person("p1", "Mia", apple: "c9", device: "iphone")], contacts: [], state: ["p1": [:]], deviceId: "mac")
        XCTAssertTrue(other.personDeletes.isEmpty && other.creates.isEmpty)
    }

    func testNumbersRepeatedByLinkedCardsAreNotADifference() {
        // The app still holds a number twice, the unified card lists it twice too: nothing to write either way.
        let mia = person("p1", "Mia", phones: ["3125550101", "312-555-0101"], apple: "c1")
        let old = ContactCard(person: mia).comparable
        let p = ContactsMirror.plan(people: [mia], contacts: [contact("c1", "Mia", phones: ["(312) 555-0101", "312 555 0101"])], state: ["p1": old], deviceId: "mac")
        XCTAssertTrue(p.writes.isEmpty && p.patches.isEmpty)
        XCTAssertEqual(ContactCard(person: mia).phones.count, 1)
    }

    func testAMergedDuplicatesCardIsRemovedOnlyOnceTheKeptCardHoldsEverything() {
        var dup = person("p2", "Alex", phones: ["5552010199"], apple: "c2", deleted: true)
        dup.fields["merged_into"] = .string("p1")
        let kept = person("p1", "Alex", phones: ["5552010142", "5552010199"], apple: "c1")
        let agreed = ContactCard(person: person("p1", "Alex", phones: ["5552010142"], apple: "c1")).comparable
        // First run: the kept card is still missing the duplicate's number, so it is written and nothing is removed.
        let first = ContactsMirror.plan(people: [kept, dup], contacts: [contact("c1", "Alex", phones: ["5552010142"]), contact("c2", "Alex", phones: ["5552010199"])], state: ["p1": agreed], deviceId: "mac")
        XCTAssertEqual(first.writes.map(\.contactId), ["c1"])
        XCTAssertTrue(first.cardDeletes.isEmpty)
        XCTAssertTrue(first.newPeople.isEmpty, "the duplicate's card is not imported again")
        // Next run: the kept card has it, so the duplicate's card goes.
        let next = ContactsMirror.plan(people: [kept, dup], contacts: [contact("c1", "Alex", phones: ["5552010142", "5552010199"]), contact("c2", "Alex", phones: ["5552010199"])], state: ["p1": ContactCard(person: kept).comparable], deviceId: "mac")
        XCTAssertEqual(next.cardDeletes, [.init(personId: "p2", contactId: "c2")])
        // My Card is never removed.
        let mine = ContactsMirror.plan(people: [kept, dup], contacts: [contact("c1", "Alex", phones: ["5552010142", "5552010199"]), contact("c2", "Alex", phones: ["5552010199"])], state: ["p1": ContactCard(person: kept).comparable], deviceId: "mac", protected: ["c2"])
        XCTAssertTrue(mine.cardDeletes.isEmpty)
        // A plain delete in the app still leaves the card alone.
        let plain = ContactsMirror.plan(people: [kept, person("p3", "Alex", phones: ["5552010199"], apple: "c2", deleted: true)], contacts: [contact("c1", "Alex", phones: ["5552010142", "5552010199"]), contact("c2", "Alex", phones: ["5552010199"])], state: [:], deviceId: "mac")
        XCTAssertTrue(plain.cardDeletes.isEmpty)
    }

    func testACardTakenOverInAMergeKeepsBothSidesValues() {
        // The kept person took the duplicate's card: no snapshot for it yet, so neither side overwrites the other.
        let p = ContactsMirror.plan(people: [person("p1", "Mia", phones: ["3125550101", "3125550199"], apple: "c1"), person("p2", "Mia", apple: "c1", deleted: true)],
                                    contacts: [contact("c1", "Mia", phones: ["3125550123"])], state: [:], deviceId: "mac")
        XCTAssertEqual(p.writes.first?.card.phones.count, 3)
        XCTAssertEqual(p.patches["p1"]?.phones.count, 3)
        XCTAssertTrue(p.newPeople.isEmpty)
    }

    func testARenameOfTheFullNameAloneReachesTheCardsGivenAndFamilyNames() {
        var jamie = person("p1", "James Lee", apple: "c1")
        jamie.fields["given_name"] = "Jamie"; jamie.fields["family_name"] = "Lee"
        var before = ContactCard(person: jamie); before.name = "Jamie Lee"
        var card = ContactCard(); card.name = "Jamie Lee"; card.given = "Jamie"; card.family = "Lee"
        let p = ContactsMirror.plan(people: [jamie], contacts: [AppleContact(id: "c1", card: card)], state: ["p1": before.comparable], deviceId: "mac")
        XCTAssertEqual(p.writes.first?.card.given, "James")
        XCTAssertEqual(p.writes.first?.card.family, "Lee")
    }

}
