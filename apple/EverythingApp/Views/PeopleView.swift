import SwiftUI
import EACore

/// People: the owner's contacts (two-way with Apple Contacts) and everything remembered about each of them.
struct PeopleView: View {
    @EnvironmentObject var engine: SyncEngine
    @EnvironmentObject var model: AppModel
    @State private var query = ""
    @State private var adding = false

    private var shown: [Entity] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        return engine.list(.person)
            .filter { q.isEmpty || [$0.str("name"), $0.str("nickname"), $0.str("organization"), $0.str("relationship")].contains { $0.lowercased().contains(q) } }
            .sorted { $0.str("name").localizedCaseInsensitiveCompare($1.str("name")) == .orderedAscending }
    }

    var body: some View {
        // The rows are swiped to remove someone, so the cards are for the Mac only (WideReader).
        WideReader(macOnly: true) { wide in
            if wide { cards } else { list }
        }
        .overlay { if shown.isEmpty { EmptyState(text: query.isEmpty ? "No people yet. Switch Contacts on in Settings, Accounts, or tap + to add someone." : "No matches") } }
        .searchable(text: $query, prompt: "Search people")
        .navigationTitle("People")
        .toolbar { ToolbarItem(placement: .primaryAction) { Button { adding = true } label: { Label("Add", systemImage: "plus") } } }
        .sheet(isPresented: $adding) { PersonEditView(personId: nil) }
    }
}

extension PeopleView {
    /// One name with how you know them under it: a row of the list, and a card's words.
    private func name(_ p: Entity) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(p.str("name")).font(.body)
            let sub = [p.str("relationship"), p.str("organization")].filter { !$0.isEmpty }.joined(separator: ", ")
            if !sub.isEmpty { Text(sub).font(.caption).foregroundStyle(.secondary) }
        }
    }

    /// Which device mirrors Apple Contacts, with the way to Settings, Accounts, where the switch is (it was in Settings,
    /// People until 2026-11-24).
    @ViewBuilder private var contactsLine: some View {
        if model.isOn(.contacts), query.isEmpty {
            let device = engine.sources?.contacts
            let mine = device?.device != nil && device?.device == engine.config.deviceId
            let other = device?.device.flatMap { $0 == engine.config.deviceId ? nil : (device?.name ?? "") }
            PageLink { AccountsSettingsView() } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Apple Contacts").font(.subheadline)
                    Text("\(AccountTexts.contactsSummary(device: other, mine: mine, here: "this \(deviceKind)")). Switched in Settings, Accounts.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }

    private var list: some View {
        List {
            contactsLine
            ForEach(shown) { p in
                PageLink { PersonDetailView(personId: p.id) } label: { name(p) }
                    .deleteSwipe(p.id, label: "Remove")
            }
        }
        .listStyle(.plain)
    }

    /// A wide Mac window: a card for each person, as many across as fit, in the list's order. A click opens the
    /// person; Remove is in the right-click menu, as on a row.
    private var cards: some View {
        WidePage {
            contactsLine.buttonStyle(.plain)
            CardGrid {
                ForEach(shown) { p in
                    PageLink { PersonDetailView(personId: p.id) } label: { name(p).gridCard() }
                        .buttonStyle(.plain)
                        .deleteSwipe(p.id, label: "Remove")
                }
            }
        }
    }
}

struct PersonDetailView: View {
    @EnvironmentObject var engine: SyncEngine
    var personId: String
    @State private var editing = false
    @State private var editingFact: Entity?
    /// Which sections of what you've told me the owner opened or closed, kept on this device ("likes:1,history:0").
    /// The others start open when they hold something and closed when empty.
    @AppStorage("people.sections") private var sectionsRaw = ""
    /// The chevron's column grows with the text size, as on Memory.
    @ScaledMetric(relativeTo: .caption) private var chevronWidth: CGFloat = 12

    private var person: Entity? { engine.get(personId) }

    /// Facts about them: linked by id, kept with their name before they were in contacts, or naming them.
    private var known: [Entity] {
        guard let p = person else { return [] }
        return TodayExtras.factsAbout(p, among: engine.list(.person), facts: engine.list(.fact))
    }

    /// What they are called on this page: their first name, else their whole name.
    private var called: String {
        guard let p = person else { return "" }
        return p.str("given_name").isEmpty ? p.str("name") : p.str("given_name")
    }

    private func objects(_ k: String) -> [[String: JSONValue]] {
        (person?.fields[k]?.arrayValue ?? []).compactMap { if case .object(let o) = $0 { return o }; return nil }
    }

    var body: some View {
        // A wide window: who they are and how to reach them on the left, what you have told the app about them and
        // what is related on the right, each a list of its own (SplitList).
        SplitList {
            if let p = person {
                SwiftUI.Section {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(p.str("name")).font(.title2.bold())
                        let sub = [p.str("nickname").isEmpty ? "" : "\"\(p.str("nickname"))\"", p.str("relationship"), [p.str("job_title"), p.str("organization")].filter { !$0.isEmpty }.joined(separator: ", ")].filter { !$0.isEmpty }
                        if !sub.isEmpty { Text(sub.joined(separator: "  ·  ")).foregroundStyle(.secondary) }
                    }
                }
                let phones = objects("phones"), emails = objects("emails"), addresses = objects("addresses")
                let dates = objects("dates")
                if !phones.isEmpty || !emails.isEmpty || !addresses.isEmpty || !p.str("birthday").isEmpty || !dates.isEmpty {
                    SwiftUI.Section {
                        ForEach(Array(phones.enumerated()), id: \.offset) { _, o in
                            let v = o["value"]?.stringValue ?? ""
                            Link(destination: URL(string: "tel:\(v.filter { $0.isNumber || $0 == "+" })") ?? URL(string: "tel:")!) {
                                LabeledContent(o["label"]?.stringValue?.capitalized ?? "Phone", value: v)
                            }
                        }
                        ForEach(Array(emails.enumerated()), id: \.offset) { _, o in
                            let v = o["value"]?.stringValue ?? ""
                            Link(destination: URL(string: "mailto:\(v)") ?? URL(string: "mailto:")!) { LabeledContent(o["label"]?.stringValue?.capitalized ?? "Email", value: v) }
                        }
                        ForEach(Array(addresses.enumerated()), id: \.offset) { _, o in
                            let line = ["street", "city", "state", "postal_code"].compactMap { o[$0]?.stringValue }.filter { !$0.isEmpty }.joined(separator: ", ")
                            Link(destination: URL(string: "https://maps.apple.com/?q=\(line.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "")")!) {
                                LabeledContent(o["label"]?.stringValue?.capitalized ?? "Address", value: line)
                            }
                        }
                        if !p.str("birthday").isEmpty { LabeledContent("Birthday", value: Self.birthday(p.str("birthday"))) }
                        ForEach(Array(dates.enumerated()), id: \.offset) { _, o in
                            let label = o["label"]?.stringValue ?? ""
                            LabeledContent(label.isEmpty || label == "other" ? "Date" : label.capitalized, value: Self.birthday(o["date"]?.stringValue ?? ""))
                        }
                    }
                }
            } else {
                Text("This person was removed.").foregroundStyle(.secondary)
            }
        } second: {
            if let p = person {
                let facts = known
                if facts.isEmpty {
                    SwiftUI.Section {
                        Text("Tell the assistant or capture things about \(called) and they show here, or add them below.").font(.callout).foregroundStyle(.secondary)
                    } header: { Text("What you've told me") }
                }
                // Likes, Dislikes and Gift ideas always show, so there is somewhere to add one; the others only when
                // they hold something.
                ForEach(PersonFacts.groups(p, facts: facts).filter { $0.add != nil || !$0.items.isEmpty }) { g in
                    let open = isOpen(g)
                    SwiftUI.Section {
                        if open {
                            if g.items.isEmpty, let empty = g.empty { Text(empty).font(.callout).foregroundStyle(.secondary) }
                            ForEach(g.items) { f in factRow(f, gift: g.section == .giftIdeas) }
                            if let add = g.add { AddPersonFact(category: add, person: p, called: called) }
                        }
                    } header: { heading(g, open: open) }
                }
                RelatedSection(id: personId, excludingWhy: ["About them"])
            }
        }
        .navigationTitle(person?.str("given_name").isEmpty == false ? person!.str("given_name") : "Person")
        .toolbar { ToolbarItem(placement: .primaryAction) { Button("Edit") { editing = true }.disabled(person == nil) } }
        .sheet(isPresented: $editing) { PersonEditView(personId: personId) }
        .sheet(item: $editingFact) { FactEditView(fact: $0) }
    }

    private var chosen: [String: Bool] {
        var out: [String: Bool] = [:]
        for part in sectionsRaw.split(separator: ",") {
            let kv = part.split(separator: ":")
            if kv.count == 2 { out[String(kv[0])] = kv[1] == "1" }
        }
        return out
    }

    private func isOpen(_ g: PersonFacts.Group) -> Bool { chosen[g.id] ?? !g.items.isEmpty }

    private func toggle(_ g: PersonFacts.Group) {
        var c = chosen
        c[g.id] = !isOpen(g)
        sectionsRaw = c.keys.sorted().map { "\($0):\(c[$0] == true ? 1 : 0)" }.joined(separator: ",")
    }

    /// A section's heading: its name and how many, and a tap opens or closes it.
    private func heading(_ g: PersonFacts.Group, open: Bool) -> some View {
        Button { toggle(g) } label: {
            HStack(spacing: 6) {
                Image(systemName: open ? "chevron.down" : "chevron.right").font(.caption.weight(.semibold)).frame(width: chevronWidth)
                Text(g.title).font(.headline)
                Text("\(g.items.count)").font(.subheadline).foregroundStyle(.secondary)
                Spacer()
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .textCase(nil)
        .accessibilityLabel("\(g.title), \(g.items.count)")
        .accessibilityValue(open ? "Open" : "Closed")
        .accessibilityHint(open ? "Closes this section" : "Opens this section")
    }

    /// One thing remembered about them: a tap edits it (as on Memory), a swipe or the right-click menu forgets it. A
    /// gift idea also says what it is for and has Mark given (today's date) or Mark not given; a given one is dimmed, with the day.
    private func factRow(_ f: Entity, gift: Bool) -> some View {
        let given = gift ? f.str("given_at") : ""
        let meta = [f.str("occasion").isEmpty ? "" : "For \(f.str("occasion"))", given.isEmpty ? "" : "Given \(Self.birthday(given))"].filter { !$0.isEmpty }
        return HStack(alignment: .firstTextBaseline, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(StyleGuard.dashes(f.str("value"))).foregroundStyle(given.isEmpty ? .primary : .secondary)
                if gift, !meta.isEmpty { Text(meta.joined(separator: "  ·  ")).font(.caption).foregroundStyle(.secondary) }
            }
            Spacer(minLength: 0)
            if gift {
                Button(given.isEmpty ? "Mark given" : "Mark not given") { setGiven(f, given.isEmpty) }
                    .buttonStyle(.borderless)
                    .font(.callout)
                    .accessibilityHint(given.isEmpty ? "Marks it given today" : "Marks it not given yet")
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { editingFact = f }
        .accessibilityAction(named: "Edit") { editingFact = f }
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            Button(role: .destructive) { Task { await engine.softDelete(f.id) } } label: { Label("Forget", systemImage: "trash") }
        }
        .contextMenu {
            Button("Edit") { editingFact = f }
            if gift { Button(given.isEmpty ? "Mark given" : "Mark not given") { setGiven(f, given.isEmpty) } }
            Button(role: .destructive) { Task { await engine.softDelete(f.id) } } label: { Label("Forget", systemImage: "trash") }
        }
    }

    /// Marks a gift idea given on this device's day, or not given.
    private func setGiven(_ f: Entity, _ on: Bool) {
        Task { _ = await engine.update(f.id, fields: ["given_at": on ? .string(ISO.localDay()) : .null]) }
    }

    static func birthday(_ s: String) -> String {
        let f = DateFormatter()
        f.locale = .current
        if s.hasPrefix("--") {
            let p = s.dropFirst(2).split(separator: "-")
            guard p.count == 2, let m = Int(p[0]), let d = Int(p[1]), m >= 1, m <= 12 else { return s }
            return "\(f.monthSymbols[m - 1]) \(d)"
        }
        f.dateFormat = "yyyy-MM-dd"
        guard let d = f.date(from: s) else { return s }
        return d.formatted(date: .long, time: .omitted)
    }
}

/// The Add field of Likes, Dislikes and Gift ideas on a person's page: a fact of that category about them, keyed by
/// its value as everywhere (`PersonFacts.key`).
private struct AddPersonFact: View {
    @EnvironmentObject var engine: SyncEngine
    let category: FactCategory
    let person: Entity
    let called: String
    @State private var text = ""

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var words: (placeholder: String, label: String) {
        switch category {
        case .like: return ("Something they like", "Add something \(called) likes")
        case .dislike: return ("Something they dislike", "Add something \(called) dislikes")
        default: return ("A gift idea", "Add a gift idea for \(called)")
        }
    }

    var body: some View {
        HStack {
            TextField(words.placeholder, text: $text)
                .onSubmit(add)
                .submitLabel(.done)
                .accessibilityLabel(words.label)
            Button("Add", action: add).buttonStyle(.borderless).disabled(trimmed.isEmpty)
        }
    }

    private func add() {
        let value = trimmed
        guard !value.isEmpty else { return }
        text = ""
        let fields: [String: JSONValue] = [
            "category": .string(category.rawValue), "key": .string(PersonFacts.key(category, value: value)), "value": .string(value),
            "person_id": .string(person.id), "person": .string(person.str("name")), "source": "user", "confidence": .number(1),
        ]
        Task { _ = await engine.create(kind: .fact, fields: fields) }
    }
}

/// Add or edit a person. Changes reach Apple Contacts through the device that syncs contacts.
struct PersonEditView: View {
    @EnvironmentObject var engine: SyncEngine
    @Environment(\.dismiss) private var dismiss
    var personId: String?
    @State private var given = ""
    @State private var family = ""
    @State private var nickname = ""
    @State private var relationship = ""
    @State private var organization = ""
    @State private var jobTitle = ""
    @State private var birthday = ""
    @State private var phones: [Row] = []
    @State private var emails: [Row] = []
    @State private var addresses: [Addr] = []
    @State private var dates: [DateRow] = []
    @State private var loaded = false

    // `kept` holds what the editor does not show (an address's country, above all). Saving used to drop it.
    struct Row: Identifiable { let id = UUID(); var label = ""; var value = ""; var kept: [String: JSONValue] = [:] }
    struct DateRow: Identifiable { let id = UUID(); var label = ""; var date = ""; var kept: [String: JSONValue] = [:] }
    struct Addr: Identifiable { let id = UUID(); var label = ""; var street = ""; var city = ""; var state = ""; var postal = ""; var kept: [String: JSONValue] = [:] }

    var body: some View {
        NavigationStack {
            Form {
                SwiftUI.Section {
                    TextField("First name", text: $given)
                    TextField("Last name", text: $family)
                    TextField("Nickname", text: $nickname)
                    TextField("How you know them", text: $relationship)
                }
                SwiftUI.Section("Phone") {
                    ForEach($phones) { $r in HStack { TextField("Label", text: $r.label).frame(maxWidth: 90); TextField("Number", text: $r.value) } }
                        .onDelete { phones.remove(atOffsets: $0) }
                    Button("Add phone") { phones.append(Row(label: "mobile")) }
                }
                SwiftUI.Section("Email") {
                    ForEach($emails) { $r in HStack { TextField("Label", text: $r.label).frame(maxWidth: 90); TextField("Email", text: $r.value) } }
                        .onDelete { emails.remove(atOffsets: $0) }
                    Button("Add email") { emails.append(Row(label: "home")) }
                }
                SwiftUI.Section("Address") {
                    ForEach($addresses) { $a in
                        VStack {
                            TextField("Label", text: $a.label)
                            TextField("Street", text: $a.street)
                            HStack { TextField("City", text: $a.city); TextField("State", text: $a.state).frame(maxWidth: 70); TextField("ZIP", text: $a.postal).frame(maxWidth: 80) }
                        }
                    }
                    .onDelete { addresses.remove(atOffsets: $0) }
                    Button("Add address") { addresses.append(Addr(label: "home")) }
                }
                SwiftUI.Section {
                    TextField("Company", text: $organization)
                    TextField("Job title", text: $jobTitle)
                    TextField("Birthday (YYYY-MM-DD or --MM-DD)", text: $birthday)
                }
                SwiftUI.Section {
                    ForEach($dates) { $d in HStack { TextField("Label", text: $d.label).frame(maxWidth: 120); TextField("YYYY-MM-DD or --MM-DD", text: $d.date) } }
                        .onDelete { dates.remove(atOffsets: $0) }
                    Button("Add date") { dates.append(DateRow(label: "anniversary")) }
                } header: { Text("Dates") } footer: { Text("Anniversaries and other days to remember. They show on Today two weeks ahead.") }
            }
            .navigationTitle(personId == nil ? "New person" : "Edit")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { save() }.disabled(given.trimmingCharacters(in: .whitespaces).isEmpty && family.trimmingCharacters(in: .whitespaces).isEmpty) }
            }
            .onAppear(perform: load)
        }
        #if os(macOS)
        .frame(minWidth: 460, minHeight: 560)
        #endif
    }

    private func load() {
        guard !loaded else { return }
        loaded = true
        guard let id = personId, let p = engine.get(id) else { return }
        given = p.str("given_name").isEmpty && p.str("family_name").isEmpty ? p.str("name") : p.str("given_name")
        family = p.str("family_name"); nickname = p.str("nickname"); relationship = p.str("relationship")
        organization = p.str("organization"); jobTitle = p.str("job_title"); birthday = p.str("birthday")
        func rows(_ k: String) -> [Row] { (p.fields[k]?.arrayValue ?? []).compactMap { if case .object(let o) = $0 { return Row(label: o["label"]?.stringValue ?? "", value: o["value"]?.stringValue ?? "", kept: o) }; return nil } }
        phones = rows("phones"); emails = rows("emails")
        dates = (p.fields["dates"]?.arrayValue ?? []).compactMap { if case .object(let o) = $0 { return DateRow(label: o["label"]?.stringValue ?? "", date: o["date"]?.stringValue ?? "", kept: o) }; return nil }
        addresses = (p.fields["addresses"]?.arrayValue ?? []).compactMap {
            guard case .object(let o) = $0 else { return nil }
            return Addr(label: o["label"]?.stringValue ?? "", street: o["street"]?.stringValue ?? "", city: o["city"]?.stringValue ?? "", state: o["state"]?.stringValue ?? "", postal: o["postal_code"]?.stringValue ?? "", kept: o)
        }
    }

    private func save() {
        func t(_ s: String) -> JSONValue { let v = s.trimmingCharacters(in: .whitespaces); return v.isEmpty ? .null : .string(v) }
        func labeled(_ r: [Row]) -> JSONValue {
            .array(r.filter { !$0.value.trimmingCharacters(in: .whitespaces).isEmpty }.map { x in
                var o = x.kept
                o["value"] = .string(x.value.trimmingCharacters(in: .whitespaces))
                o["label"] = x.label.isEmpty ? nil : .string(x.label)
                return .object(o)
            })
        }
        let name = [given, family].map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.joined(separator: " ")
        var f: [String: JSONValue] = [
            "name": .string(name), "given_name": t(given), "family_name": t(family), "nickname": t(nickname), "relationship": t(relationship),
            "organization": t(organization), "job_title": t(jobTitle), "birthday": t(birthday), "phones": labeled(phones), "emails": labeled(emails),
            "addresses": .array(addresses.filter { !($0.street + $0.city + $0.postal).trimmingCharacters(in: .whitespaces).isEmpty || !($0.kept["country"]?.stringValue ?? "").isEmpty }.map { a in
                var o = a.kept
                for (k, v) in [("label", a.label), ("street", a.street), ("city", a.city), ("state", a.state), ("postal_code", a.postal)] { o[k] = v.isEmpty ? nil : .string(v) }
                return .object(o)
            }),
            "dates": .array(dates.filter { !$0.date.trimmingCharacters(in: .whitespaces).isEmpty }.map { d in
                var o = d.kept
                o["date"] = .string(d.date.trimmingCharacters(in: .whitespaces))
                let label = d.label.trimmingCharacters(in: .whitespaces)
                o["label"] = label.isEmpty ? nil : .string(label.lowercased())
                return .object(o)
            }),
        ]
        Task {
            if let id = personId { _ = await engine.update(id, fields: f) }
            else { f = f.filter { $0.value != .null }; _ = await engine.create(kind: .person, fields: f) }
            dismiss()
        }
    }
}
