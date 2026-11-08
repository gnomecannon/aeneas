import SwiftUI
import EACore

/// People: the owner's contacts (two-way with Apple Contacts) and everything remembered about each of them.
struct PeopleView: View {
    @EnvironmentObject var engine: SyncEngine
    @State private var query = ""
    @State private var adding = false

    private var shown: [Entity] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        return engine.list(.person)
            .filter { q.isEmpty || [$0.str("name"), $0.str("nickname"), $0.str("organization"), $0.str("relationship")].contains { $0.lowercased().contains(q) } }
            .sorted { $0.str("name").localizedCaseInsensitiveCompare($1.str("name")) == .orderedAscending }
    }

    var body: some View {
        List {
            ForEach(shown) { p in
                NavigationLink { PersonDetailView(personId: p.id) } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(p.str("name")).font(.body)
                        let sub = [p.str("relationship"), p.str("organization")].filter { !$0.isEmpty }.joined(separator: ", ")
                        if !sub.isEmpty { Text(sub).font(.caption).foregroundStyle(.secondary) }
                    }
                }
                .deleteSwipe(p.id, label: "Remove")
            }
        }
        .listStyle(.plain)
        .overlay { if shown.isEmpty { EmptyState(text: query.isEmpty ? "No people yet. Turn on Sync Apple Contacts in Settings, People." : "No matches") } }
        .searchable(text: $query, prompt: "Search people")
        .navigationTitle("People")
        .toolbar { ToolbarItem(placement: .primaryAction) { Button { adding = true } label: { Label("Add", systemImage: "plus") } } }
        .sheet(isPresented: $adding) { PersonEditView(personId: nil) }
    }
}

struct PersonDetailView: View {
    @EnvironmentObject var engine: SyncEngine
    var personId: String
    @State private var editing = false

    private var person: Entity? { engine.get(personId) }

    /// Facts about them: linked by id, kept with their name before they were in contacts, or naming them.
    private var known: [Entity] {
        guard let p = person else { return [] }
        return TodayExtras.factsAbout(p, among: engine.list(.person), facts: engine.list(.fact))
    }

    private func objects(_ k: String) -> [[String: JSONValue]] {
        (person?.fields[k]?.arrayValue ?? []).compactMap { if case .object(let o) = $0 { return o }; return nil }
    }

    var body: some View {
        List {
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
                SwiftUI.Section {
                    if known.isEmpty {
                        Text("Tell the assistant or capture things about \(p.str("given_name").isEmpty ? p.str("name") : p.str("given_name")) and they show here.").font(.callout).foregroundStyle(.secondary)
                    }
                    ForEach(known) { f in
                        Text(StyleGuard.dashes(f.str("value"))).deleteSwipe(f.id, label: "Forget")
                    }
                } header: { Text("What you've told me") }
                RelatedSection(id: personId, excludingWhy: ["About them"])
            } else {
                Text("This person was removed.").foregroundStyle(.secondary)
            }
        }
        .navigationTitle(person?.str("given_name").isEmpty == false ? person!.str("given_name") : "Person")
        .toolbar { ToolbarItem(placement: .primaryAction) { Button("Edit") { editing = true }.disabled(person == nil) } }
        .sheet(isPresented: $editing) { PersonEditView(personId: personId) }
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

/// Settings, People: whether this device mirrors Apple Contacts.
struct PeopleSettingsView: View {
    @AppStorage(ContactsSync.enabledKey) private var enabled = false
    @ObservedObject private var sync = ContactsSync.shared
    @State private var note: String?

    var body: some View {
        Form {
            SwiftUI.Section {
                Toggle("Sync Apple Contacts on this device", isOn: $enabled)
                    .onChange(of: enabled) { _, on in
                        guard on else { return }
                        Task {
                            if await sync.requestAccess() { note = nil; await sync.runNow(reason: "turned on") }
                            else { enabled = false; note = "Contacts access was not allowed. Allow it in System Settings, Privacy, Contacts." }
                        }
                    }
            } footer: {
                Text("Turn this on for one device only, ideally the Mac. Contacts are copied both ways: details the assistant saves reach Apple Contacts, and edits there reach the app. Removing someone here never deletes their contact card.")
            }
            if let s = sync.lastSummary, enabled { SwiftUI.Section("Last sync") { Text(s).font(.callout); if let r = sync.lastRun { Text(r.formatted(date: .abbreviated, time: .shortened)).font(.caption).foregroundStyle(.secondary) } } }
            if let e = sync.lastError ?? note { SwiftUI.Section { Text(e).foregroundStyle(.orange) } }
        }
        .navigationTitle("People")
    }
}
