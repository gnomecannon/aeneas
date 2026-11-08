import Foundation

/// One contact as both sides hold it: the app's `person` fields and an Apple Contacts card.
public struct ContactCard: Equatable, Sendable {
    public struct Labeled: Equatable, Sendable { public var label: String?; public var value: String; public init(label: String?, value: String) { self.label = label; self.value = value } }
    public struct Address: Equatable, Sendable {
        public var label: String?, street: String?, city: String?, state: String?, postal_code: String?, country: String?
        public init(label: String? = nil, street: String? = nil, city: String? = nil, state: String? = nil, postal_code: String? = nil, country: String? = nil) {
            self.label = label; self.street = street; self.city = city; self.state = state; self.postal_code = postal_code; self.country = country
        }
    }
    /// A dated label on the card (anniversary, or any custom label); `date` is YYYY-MM-DD or --MM-DD.
    public struct DateEntry: Equatable, Sendable { public var label: String?; public var date: String; public init(label: String?, date: String) { self.label = label; self.date = date } }
    public var name = ""
    public var given: String?
    public var family: String?
    public var nickname: String?
    public var organization: String?
    public var jobTitle: String?
    /// YYYY-MM-DD or --MM-DD.
    public var birthday: String?
    public var phones: [Labeled] = []
    public var emails: [Labeled] = []
    public var addresses: [Address] = []
    public var dates: [DateEntry] = []

    public init() {}

    public init(person e: Entity) {
        func s(_ k: String) -> String? { let v = e.str(k).trimmingCharacters(in: .whitespaces); return v.isEmpty ? nil : v }
        name = e.str("name"); given = s("given_name"); family = s("family_name"); nickname = s("nickname")
        organization = s("organization"); jobTitle = s("job_title"); birthday = s("birthday")
        func labeled(_ k: String) -> [Labeled] {
            (e.fields[k]?.arrayValue ?? []).compactMap { v in
                guard case .object(let o) = v, let value = o["value"]?.stringValue, !value.isEmpty else { return nil }
                return Labeled(label: o["label"]?.stringValue, value: value)
            }
        }
        phones = labeled("phones"); emails = labeled("emails")
        dedupe()
        dates = (e.fields["dates"]?.arrayValue ?? []).compactMap { v in
            guard case .object(let o) = v, let d = o["date"]?.stringValue, !d.isEmpty else { return nil }
            return DateEntry(label: o["label"]?.stringValue, date: d)
        }
        addresses = (e.fields["addresses"]?.arrayValue ?? []).compactMap { v in
            guard case .object(let o) = v else { return nil }
            let a = Address(label: o["label"]?.stringValue, street: o["street"]?.stringValue, city: o["city"]?.stringValue, state: o["state"]?.stringValue,
                            postal_code: o["postal_code"]?.stringValue, country: o["country"]?.stringValue)
            return ContactsMirror.addressKey(a).isEmpty ? nil : a
        }
    }

    /// Drop repeated phones and emails: a card unified from linked cards lists a number once per card.
    public mutating func dedupe() {
        var seenPhones = Set<String>(), seenEmails = Set<String>()
        phones = phones.filter { seenPhones.insert(ContactsMirror.digits($0.value)).inserted }
        emails = emails.filter { seenEmails.insert($0.value.trimmingCharacters(in: .whitespaces).lowercased()).inserted }
    }

    /// Every phone, email, address and date on `other` is also here (formatting and labels aside).
    public func holds(_ other: ContactCard) -> Bool {
        func has<T: Hashable>(_ mine: [T], _ theirs: [T]) -> Bool { Set(theirs).isSubset(of: Set(mine)) }
        let c = comparable, o = other.comparable
        func values(_ d: [String: String], _ k: String, _ sep: Character) -> [String] { (d[k] ?? "").split(separator: sep).map(String.init) }
        return has(values(c, "phones", ","), values(o, "phones", ",")) && has(values(c, "emails", ","), values(o, "emails", ","))
            && has(values(c, "addresses", ";"), values(o, "addresses", ";")) && has(values(c, "dates", ","), values(o, "dates", ","))
            && (other.birthday == nil || birthday != nil)
    }

    /// The person fields this card sets (app-only fields such as relationship are left alone).
    public var personFields: [String: JSONValue] {
        func opt(_ v: String?) -> JSONValue { v.map { .string($0) } ?? .null }
        func labeled(_ l: [Labeled]) -> JSONValue { .array(l.map { x in .object(["value": .string(x.value)].merging(x.label.map { ["label": .string($0)] } ?? [:]) { a, _ in a }) }) }
        return [
            "name": .string(name), "given_name": opt(given), "family_name": opt(family), "nickname": opt(nickname),
            "organization": opt(organization), "job_title": opt(jobTitle), "birthday": opt(birthday),
            "phones": labeled(phones), "emails": labeled(emails),
            "addresses": .array(addresses.map { a in
                var o: [String: JSONValue] = [:]
                for (k, v) in [("label", a.label), ("street", a.street), ("city", a.city), ("state", a.state), ("postal_code", a.postal_code), ("country", a.country)] { if let v, !v.isEmpty { o[k] = .string(v) } }
                return .object(o)
            }),
            "dates": .array(dates.map { d in .object(["date": .string(d.date)].merging(d.label.map { ["label": .string($0)] } ?? [:]) { a, _ in a }) }),
        ]
    }

    /// What both sides must agree on, ignoring labels and formatting (Apple localizes labels; phone formats vary).
    public var comparable: [String: String] {
        func norm(_ s: String?) -> String { (s ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
        var c = [
            "name": norm(name), "given": norm(given), "family": norm(family), "nickname": norm(nickname),
            "org": norm(organization), "job": norm(jobTitle), "birthday": norm(birthday),
            // Sets: a value listed twice (linked cards each carry it) is not a difference.
            "phones": Set(phones.map { ContactsMirror.digits($0.value) }).sorted().joined(separator: ","),
            "emails": Set(emails.map { norm($0.value) }).sorted().joined(separator: ","),
            "addresses": Set(addresses.map { ContactsMirror.addressKey($0) }).sorted().joined(separator: ";"),
        ]
        // Only when there are some: snapshots from before dates synced have no such key, and an empty value there
        // would read as a change and overwrite the card's dates.
        if !dates.isEmpty { c["dates"] = Set(dates.map(\.date)).sorted().joined(separator: ",") }
        return c
    }
}

public struct AppleContact: Equatable, Sendable {
    public var id: String
    public var card: ContactCard
    public init(id: String, card: ContactCard) { self.id = id; self.card = card }
}

/// What one run changes on each side.
public struct ContactsPlan: Equatable, Sendable {
    public struct Link: Equatable, Sendable { public var personId: String; public var contactId: String }
    public struct Write: Equatable, Sendable { public var personId: String; public var contactId: String; public var card: ContactCard }
    public struct Create: Equatable, Sendable { public var personId: String; public var card: ContactCard }
    /// New people from contacts that are not in the app yet.
    public var newPeople: [AppleContact] = []
    /// Person changes from Apple, by person id.
    public var patches: [String: ContactCard] = [:]
    public var links: [Link] = []
    /// Cards to rewrite in Apple Contacts.
    public var writes: [Write] = []
    /// People made in the app that get a new Apple card.
    public var creates: [Create] = []
    /// People whose card was deleted in Apple Contacts.
    public var personDeletes: [String] = []
    /// Cards of duplicates merged in the app, to remove now that the kept person's card holds everything on them.
    public var cardDeletes: [Link] = []
    public var state: [String: [String: String]] = [:]
}

/// Two-way rules between People and Apple Contacts, run by the one device that syncs contacts. A change made on one
/// side since the last agreed snapshot is copied to the other; when both changed, the app's version wins (the owner's
/// edits there come from the assistant or the People screen); with no snapshot yet, both sides are merged. Deleting a
/// person in the app unlinks it and never deletes the Apple card, except a duplicate merged into another person
/// (`merged_into`), whose card is removed once the kept card holds everything on it; `protected` cards (My Card) are
/// never removed. A card deleted in Apple Contacts removes the person.
public enum ContactsMirror {
    public static func digits(_ s: String) -> String {
        let d = s.filter(\.isNumber)
        return d.count == 11 && d.hasPrefix("1") ? String(d.dropFirst()) : d
    }

    public static func addressKey(_ a: ContactCard.Address) -> String {
        [a.street, a.city, a.postal_code].map { ($0 ?? "").lowercased().filter { $0.isLetter || $0.isNumber } }.filter { !$0.isEmpty }.joined(separator: "|")
    }

    static func nameKey(_ s: String) -> String { s.lowercased().filter { $0.isLetter || $0.isNumber } }

    /// Lists merged by value, keeping both sides' entries (used when an existing person is first linked).
    static func merged(_ app: ContactCard, _ apple: ContactCard) -> ContactCard {
        var c = apple
        for p in app.phones where !c.phones.contains(where: { digits($0.value) == digits(p.value) }) { c.phones.append(p) }
        for e in app.emails where !c.emails.contains(where: { $0.value.lowercased() == e.value.lowercased() }) { c.emails.append(e) }
        for a in app.addresses where !c.addresses.contains(where: { addressKey($0) == addressKey(a) }) { c.addresses.append(a) }
        for d in app.dates where !c.dates.contains(where: { $0.date == d.date }) { c.dates.append(d) }
        c.nickname = apple.nickname ?? app.nickname
        c.organization = apple.organization ?? app.organization
        c.jobTitle = apple.jobTitle ?? app.jobTitle
        c.birthday = apple.birthday ?? app.birthday
        return c
    }

    public static func plan(people: [Entity], contacts: [AppleContact], state: [String: [String: String]], deviceId: String, protected: Set<String> = []) -> ContactsPlan {
        var p = ContactsPlan()
        let mine: (Entity) -> Bool = { e in
            guard case .object(let o)? = e.fields["apple"] else { return false }
            let d = o["device"]?.stringValue ?? ""
            return d.isEmpty || d == deviceId
        }
        func appleId(_ e: Entity) -> String? {
            guard case .object(let o)? = e.fields["apple"], let id = o["id"]?.stringValue, !id.isEmpty else { return nil }
            return id
        }
        let live = people.filter { !$0.isDeleted }
        // Cards whose person was deleted in the app stay out of the app (unless a live person took the card over in a merge).
        let ignored = Set(people.filter { $0.isDeleted }.compactMap(appleId)).subtracting(live.compactMap(appleId))
        var linked: [String: Entity] = [:]
        for e in live where mine(e) { if let id = appleId(e) { linked[id] = e } }
        var unlinked = live.filter { appleId($0) == nil }
        let byId = Dictionary(contacts.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })

        for c in contacts where !ignored.contains(c.id) {
            if let e = linked[c.id] {
                let app = ContactCard(person: e)
                let a = app.comparable, b = c.card.comparable
                let snap = state[e.id]
                if a == b { p.state[e.id] = a; continue }
                guard let snap else {
                    // Never agreed on this device (a new syncing device, or a card taken over in a merge): keep both sides' values.
                    let m = merged(app, c.card)
                    if m.comparable != a { p.patches[e.id] = m }
                    if m.comparable != b { p.writes.append(.init(personId: e.id, contactId: c.id, card: m)) }
                    p.state[e.id] = m.comparable
                    continue
                }
                let appChanged = snap != a
                let appleChanged = snap != b
                if appChanged {
                    // Only the full name changed in the app (the assistant renamed someone): the card's given and family
                    // names follow it, or Apple keeps the old ones and the next run copies the old name back.
                    var out = app
                    if a["name"] != snap["name"], a["given"] == snap["given"], a["family"] == snap["family"], !app.name.isEmpty {
                        let words = app.name.split(separator: " ").map(String.init)
                        out.given = words.count > 1 ? words.dropLast().joined(separator: " ") : app.name
                        out.family = words.count > 1 ? words.last : nil
                        p.patches[e.id] = out
                    }
                    p.writes.append(.init(personId: e.id, contactId: c.id, card: out)); p.state[e.id] = out.comparable
                } else if appleChanged {
                    p.patches[e.id] = c.card; p.state[e.id] = b
                }
            } else if let i = unlinked.firstIndex(where: { nameKey($0.str("name")) == nameKey(c.card.name) && !nameKey(c.card.name).isEmpty }) {
                // Someone added in the app who is already in Apple Contacts: link them and merge both sides.
                let e = unlinked.remove(at: i)
                let m = merged(ContactCard(person: e), c.card)
                p.links.append(.init(personId: e.id, contactId: c.id))
                p.patches[e.id] = m
                if m.comparable != c.card.comparable { p.writes.append(.init(personId: e.id, contactId: c.id, card: m)) }
                p.state[e.id] = m.comparable
            } else if !c.card.name.isEmpty {
                p.newPeople.append(c)
            }
        }
        for e in unlinked { p.creates.append(.init(personId: e.id, card: ContactCard(person: e))) }
        for (id, e) in linked where byId[id] == nil {
            // Gone from Apple Contacts. Only conclude it was deleted when this device saw it before.
            if state[e.id] != nil { p.personDeletes.append(e.id) }
        }
        let byPerson = Dictionary(people.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        for d in people where d.isDeleted && mine(d) {
            guard let cd = appleId(d), !protected.contains(cd), !linked.keys.contains(cd), let gone = byId[cd] else { continue }
            // Follow the merge to the person kept (it may itself have been merged since).
            var target = d.str("merged_into"), hops = 0
            while let t = byPerson[target], t.isDeleted, !t.str("merged_into").isEmpty, hops < 5 { target = t.str("merged_into"); hops += 1 }
            guard let s = byPerson[target], !s.isDeleted, mine(s), let cs = appleId(s), cs != cd, let kept = byId[cs] else { continue }
            if kept.card.holds(gone.card) { p.cardDeletes.append(.init(personId: d.id, contactId: cd)) }
        }
        return p
    }
}
