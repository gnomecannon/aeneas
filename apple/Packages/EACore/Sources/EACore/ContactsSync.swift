#if os(iOS) || os(macOS)
import Foundation
import Contacts
import os

/// People and Apple Contacts, both ways, on the one device where Settings, People, "Sync Apple Contacts" is on (the
/// Mac, which runs all day). The rules are in `ContactsMirror`; this reads and writes the Contacts store.
@MainActor
public final class ContactsSync: ObservableObject {
    public static let shared = ContactsSync()
    public static let enabledKey = "ea.contacts.sync"
    private static let stateKey = "ea.contacts.state"
    private static let log = Logger(subsystem: SharedConfig.logSubsystem, category: "contacts")

    @Published public private(set) var lastRun: Date?
    @Published public private(set) var lastSummary: String?
    @Published public private(set) var lastError: String?

    public var engineProvider: (() async -> SyncEngine)?
    private let store = CNContactStore()
    private var observer: NSObjectProtocol?
    private var debounce: Task<Void, Never>?
    private var running = false

    public var enabled: Bool { UserDefaults.standard.bool(forKey: Self.enabledKey) }
    /// The Contacts module (Settings, Modules) is on. Off, Contacts are not read or written on this device.
    public var moduleOn: Bool { SharedConfig.shared.moduleSaidOn(.contacts) }
    public var authorized: Bool {
        let s = CNContactStore.authorizationStatus(for: .contacts)
        #if os(iOS)
        if #available(iOS 18.0, *) { return s == .authorized || s == .limited }
        #endif
        return s == .authorized
    }

    public func requestAccess() async -> Bool {
        (try? await store.requestAccess(for: .contacts)) ?? false
    }

    private var state: [String: [String: String]] {
        get { UserDefaults.standard.data(forKey: Self.stateKey).flatMap { try? JSONDecoder().decode([String: [String: String]].self, from: $0) } ?? [:] }
        set { UserDefaults.standard.set(try? JSONEncoder().encode(newValue), forKey: Self.stateKey) }
    }

    public func scheduleRun(after seconds: Double = 4) {
        guard enabled, moduleOn, authorized else { return }
        debounce?.cancel()
        debounce = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            if !Task.isCancelled { await self?.runNow(reason: "change") }
        }
    }

    public func runNow(reason: String) async {
        guard enabled, moduleOn, authorized, let provider = engineProvider, !running else { return }
        running = true
        defer { running = false }
        if observer == nil {
            observer = NotificationCenter.default.addObserver(forName: .CNContactStoreDidChange, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.scheduleRun(after: 5) }
            }
        }
        let engine = await provider()
        let device = engine.config.deviceId
        guard !device.isEmpty else { return }
        lastError = nil
        do {
            let contacts = try fetchAll()
            let people = (try? await engine.store.all(kind: .person, includeDeleted: true)) ?? engine.list(.person)
            let me = myCardId()
            let plan = ContactsMirror.plan(people: people, contacts: contacts, state: state, deviceId: device, protected: Set([me].compactMap { $0 }))
            var newState = state
            for (k, v) in plan.state { newState[k] = v }
            var added = 0, updated = 0, written = 0, created = 0
            for c in plan.newPeople {
                var f = c.card.personFields.filter { $0.value != .null }
                f["apple"] = .object(["id": .string(c.id), "device": .string(device)].merging(c.id == me ? ["me": .bool(true)] : [:]) { a, _ in a })
                if let e = await engine.create(kind: .person, fields: f) { newState[e.id] = c.card.comparable; added += 1 }
            }
            for l in plan.links { _ = await engine.update(l.personId, fields: ["apple": .object(["id": .string(l.contactId), "device": .string(device)])]) }
            for (id, card) in plan.patches { _ = await engine.update(id, fields: card.personFields); updated += 1 }
            let save = CNSaveRequest()
            var pending = 0
            for w in plan.writes {
                guard let existing = try? store.unifiedContact(withIdentifier: w.contactId, keysToFetch: Self.keys) else { continue }
                let m = existing.mutableCopy() as! CNMutableContact
                Self.apply(w.card, to: m)
                save.update(m)
                pending += 1; written += 1
            }
            var made: [(String, CNMutableContact)] = []
            for c in plan.creates {
                let m = CNMutableContact()
                Self.apply(c.card, to: m)
                save.add(m, toContainerWithIdentifier: nil)
                made.append((c.personId, m))
                pending += 1
            }
            for d in plan.cardDeletes {
                guard let existing = try? store.unifiedContact(withIdentifier: d.contactId, keysToFetch: [CNContactIdentifierKey as CNKeyDescriptor]) else { continue }
                save.delete(existing.mutableCopy() as! CNMutableContact)
                newState.removeValue(forKey: d.personId)
                pending += 1
            }
            if pending > 0 { try store.execute(save) }
            // Mark the person on My Card, so merging duplicates of the owner keeps that one.
            if let me, let mine = people.first(where: { !$0.isDeleted && $0.fields["apple"]?.objectValue?["id"]?.stringValue == me && $0.fields["apple"]?.objectValue?["me"]?.boolValue != true }) {
                _ = await engine.update(mine.id, fields: ["apple": .object(["id": .string(me), "device": .string(device), "me": .bool(true)])])
            }
            for (personId, m) in made {
                _ = await engine.update(personId, fields: ["apple": .object(["id": .string(m.identifier), "device": .string(device)])])
                newState[personId] = ContactCard(person: engine.get(personId) ?? Entity.placeholder).comparable
                created += 1
            }
            // With limited access (iOS 18) the cards not chosen are missing, not deleted; and many cards gone at once
            // is the store being rebuilt or iCloud Contacts switched off. Nobody is deleted in the app then.
            var limited = false
            #if os(iOS)
            if #available(iOS 18.0, *) { limited = CNContactStore.authorizationStatus(for: .contacts) == .limited }
            #endif
            let linkedCount = people.filter { p in
                guard !p.isDeleted, case .object(let o)? = p.fields["apple"], let id = o["id"]?.stringValue else { return false }
                return !id.isEmpty
            }.count
            let massGone = plan.personDeletes.count >= 3 && plan.personDeletes.count * 3 > linkedCount
            if limited || massGone {
                if !plan.personDeletes.isEmpty { lastError = "\(plan.personDeletes.count) people are missing from Contacts; they were kept in the app" }
            } else {
                for id in plan.personDeletes { await engine.softDelete(id); newState.removeValue(forKey: id) }
            }
            state = newState
            await reportFeature(engine, device: device)
            lastRun = Date()
            lastSummary = "\(added) added, \(updated) updated from Contacts; \(written) updated, \(created) added, \(plan.cardDeletes.count) merged duplicates removed in Contacts; \(plan.personDeletes.count) removed"
            if added + updated + written + created + plan.personDeletes.count + plan.cardDeletes.count > 0 {
                Self.log.notice("contacts (\(reason, privacy: .public)): \(self.lastSummary ?? "", privacy: .public)")
            }
        } catch {
            lastError = error.localizedDescription
            Self.log.error("contacts sync failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    static let keys: [CNKeyDescriptor] = [
        CNContactIdentifierKey, CNContactGivenNameKey, CNContactFamilyNameKey, CNContactNicknameKey, CNContactOrganizationNameKey,
        CNContactJobTitleKey, CNContactBirthdayKey, CNContactPhoneNumbersKey, CNContactEmailAddressesKey, CNContactPostalAddressesKey,
        CNContactDatesKey,
    ].map { $0 as CNKeyDescriptor } + [CNContactFormatter.descriptorForRequiredKeys(for: .fullName)]

    /// Tell the hub this build understands repeated numbers and merged duplicates (device feature "contacts-merge"),
    /// so its nightly tidy may change the people this device links. Once per device.
    private func reportFeature(_ engine: SyncEngine, device: String) async {
        let key = "ea.contacts.feature.\(device)"
        guard !UserDefaults.standard.bool(forKey: key) else { return }
        var features = engine.get(device)?.fields["features"]?.arrayValue ?? []
        if !features.contains(.string("contacts-merge")) { features.append(.string("contacts-merge")) }
        let done = await engine.apply(Patch(id: device, kind: .device, space: .personal, ts: ISO.now(), fields: ["features": .array(features)]))
        if done != nil { UserDefaults.standard.set(true, forKey: key) }
    }

    /// My Card's identifier (macOS keeps one; iOS has no API for it).
    private func myCardId() -> String? {
        #if os(macOS)
        return try? store.unifiedMeContactWithKeys(toFetch: [CNContactIdentifierKey as CNKeyDescriptor]).identifier
        #else
        return nil
        #endif
    }

    private func fetchAll() throws -> [AppleContact] {
        var out: [AppleContact] = []
        let req = CNContactFetchRequest(keysToFetch: Self.keys)
        req.unifyResults = true
        try store.enumerateContacts(with: req) { c, _ in out.append(AppleContact(id: c.identifier, card: Self.card(c))) }
        return out
    }

    static func card(_ c: CNContact) -> ContactCard {
        var k = ContactCard()
        func opt(_ s: String) -> String? { s.isEmpty ? nil : s }
        k.given = opt(c.givenName); k.family = opt(c.familyName); k.nickname = opt(c.nickname)
        k.organization = opt(c.organizationName); k.jobTitle = opt(c.jobTitle)
        k.name = CNContactFormatter.string(from: c, style: .fullName) ?? ""
        if k.name.isEmpty { k.name = c.organizationName }
        if let b = c.birthday, let m = b.month, let d = b.day {
            k.birthday = b.year.map { String(format: "%04d-%02d-%02d", $0, m, d) } ?? String(format: "--%02d-%02d", m, d)
        }
        func label(_ l: String?) -> String? { l.map { CNLabeledValue<NSString>.localizedString(forLabel: $0) }.flatMap { $0.isEmpty ? nil : $0.lowercased() } }
        k.phones = c.phoneNumbers.map { .init(label: label($0.label), value: $0.value.stringValue) }
        k.emails = c.emailAddresses.map { .init(label: label($0.label), value: $0.value as String) }
        k.dates = c.dates.compactMap { d in
            guard let s = dateString(d.value as DateComponents) else { return nil }
            let l = d.label.map { CNLabeledValue<NSDateComponents>.localizedString(forLabel: $0).lowercased() }
            return .init(label: l?.isEmpty == false ? l : nil, date: s)
        }
        k.addresses = c.postalAddresses.map { a in
            let v = a.value
            return .init(label: label(a.label), street: opt(v.street), city: opt(v.city), state: opt(v.state), postal_code: opt(v.postalCode), country: opt(v.country))
        }
        k.dedupe()
        return k
    }

    private static func appleLabel(_ l: String?) -> String? {
        switch l?.lowercased() {
        case "mobile", "cell": return CNLabelPhoneNumberMobile
        case "iphone": return CNLabelPhoneNumberiPhone
        case "home": return CNLabelHome
        case "work": return CNLabelWork
        case "main": return CNLabelPhoneNumberMain
        case nil, "": return nil
        default: return l
        }
    }

    /// Write a card, keeping the labels Apple already has for values that did not change.
    static func apply(_ k: ContactCard, to m: CNMutableContact) {
        if let g = k.given ?? (k.family == nil ? k.name : nil) { m.givenName = g } else { m.givenName = "" }
        m.familyName = k.family ?? ""
        m.nickname = k.nickname ?? ""
        m.organizationName = k.organization ?? ""
        m.jobTitle = k.jobTitle ?? ""
        m.birthday = k.birthday.flatMap(components)
        let oldPhones = m.phoneNumbers
        m.phoneNumbers = k.phones.map { p in
            if let old = oldPhones.first(where: { ContactsMirror.digits($0.value.stringValue) == ContactsMirror.digits(p.value) }) { return old }
            return CNLabeledValue(label: appleLabel(p.label), value: CNPhoneNumber(stringValue: p.value))
        }
        let oldEmails = m.emailAddresses
        m.emailAddresses = k.emails.map { e in
            if let old = oldEmails.first(where: { ($0.value as String).lowercased() == e.value.lowercased() }) { return old }
            return CNLabeledValue(label: appleLabel(e.label), value: e.value as NSString)
        }
        let oldDates = m.dates
        m.dates = k.dates.compactMap { d in
            if let old = oldDates.first(where: { dateString($0.value as DateComponents) == d.date }) { return old }
            guard let dc = components(d.date) else { return nil }
            let label: String? = switch d.label?.lowercased() {
            case "anniversary": CNLabelDateAnniversary
            case nil, "", "other": CNLabelOther
            default: d.label
            }
            return CNLabeledValue(label: label, value: dc as NSDateComponents)
        }
        let oldAddresses = m.postalAddresses
        m.postalAddresses = k.addresses.map { a in
            if let old = oldAddresses.first(where: { ContactsMirror.addressKey(card(addressOnly: $0.value)) == ContactsMirror.addressKey(a) }) { return old }
            let v = CNMutablePostalAddress()
            v.street = a.street ?? ""; v.city = a.city ?? ""; v.state = a.state ?? ""; v.postalCode = a.postal_code ?? ""; v.country = a.country ?? ""
            return CNLabeledValue(label: appleLabel(a.label), value: v.copy() as! CNPostalAddress)
        }
    }

    /// YYYY-MM-DD or --MM-DD as date components (no year for the second).
    static func components(_ s: String) -> DateComponents? {
        var dc = DateComponents()
        let parts = s.split(separator: "-").map(String.init).filter { !$0.isEmpty }
        if s.hasPrefix("--"), parts.count == 2 { dc.month = Int(parts[0]); dc.day = Int(parts[1]) }
        else if parts.count == 3 { dc.year = Int(parts[0]); dc.month = Int(parts[1]); dc.day = Int(parts[2]) }
        return dc.month == nil || dc.day == nil ? nil : dc
    }

    static func dateString(_ v: DateComponents) -> String? {
        guard let m = v.month, let d = v.day else { return nil }
        return v.year.map { String(format: "%04d-%02d-%02d", $0, m, d) } ?? String(format: "--%02d-%02d", m, d)
    }

    private static func card(addressOnly v: CNPostalAddress) -> ContactCard.Address {
        .init(street: v.street, city: v.city, postal_code: v.postalCode)
    }
}

extension Entity {
    /// An empty person, for code paths that need an entity when the real one is gone.
    static var placeholder: Entity { Entity(id: "", kind: .person, fields: [:]) }
}
#endif
