import SwiftUI
import EACore

/// The pet: one-tap logging, custody this week, what is due, and the journal.
struct PetView: View {
    @EnvironmentObject var engine: SyncEngine
    @State private var creating = false
    @State private var editing: Entity?
    @State private var deleting: Entity?
    @State private var flash: BodyFlash?
    @State private var showOlder = false

    static let nameKey = "ea.petName"
    /// The owner's pet, from the hub's profile (Settings or the Pet page names it); "Pet" until one is named.
    static var pet: String { UserDefaults.standard.string(forKey: nameKey).flatMap { $0.isEmpty ? nil : $0 } ?? "Pet" }

    struct Quick: Identifiable {
        var id: String { label }
        var label: String
        var symbol: String
        var type: String
        var note: String
    }
    static let quick: [Quick] = [
        Quick(label: "Walked", symbol: "figure.walk", type: "note", note: "Walked"),
        Quick(label: "Fed", symbol: "fork.knife", type: "food", note: "Fed"),
        Quick(label: "Meds", symbol: "pills", type: "med", note: "Meds given")
    ]

    /// What is on the calendar for him in the next 60 days (his name, a vet, a groomer), read from the calendar itself.
    private var plans: [(event: Entity, day: Date)] {
        let from = Calendar.current.startOfDay(for: Date())
        let to = from.addingTimeInterval(60 * 86400)
        let pattern = "\\b(\(Self.pet)|vet|vets|veterinar\\w*|groom\\w*)\\b"
        let dayOnly = DateFormatter()
        dayOnly.dateFormat = "yyyy-MM-dd"
        dayOnly.calendar = Calendar(identifier: .gregorian)
        dayOnly.timeZone = .current
        return engine.list(.event)
            .filter { $0.space != .work && $0.str("title").range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil }
            .compactMap { e -> (event: Entity, day: Date)? in
                // An all-day plan is its date, whatever offset it was written with.
                let d = e.bool("all_day") == true ? dayOnly.date(from: String(e.str("start").prefix(10))) : e.date("start")
                guard let d, d >= from, d < to else { return nil }
                return (e, d)
            }
            .sorted { $0.day < $1.day }
            .prefix(10)
            .map { $0 }
    }

    private var events: [Entity] {
        engine.list(.pet_event)
            .filter { $0.str("pet").trimmingCharacters(in: .whitespaces).caseInsensitiveCompare(Self.pet) == .orderedSame }
            .sorted { ($0.date("at") ?? .distantPast) > ($1.date("at") ?? .distantPast) }
    }

    var body: some View {
        let all = events
        let cutoff = Date().addingTimeInterval(-30 * 86400)
        let recent = all.filter { ($0.date("at") ?? .distantPast) >= cutoff }
        let older = all.filter { ($0.date("at") ?? .distantPast) < cutoff }
        let today = Calendar.current.startOfDay(for: Date())
        let due = all.filter { e in e.date("next_due").map { $0 >= today } ?? false }
            .sorted { ($0.date("next_due") ?? .distantFuture) < ($1.date("next_due") ?? .distantFuture) }

        List {
            SwiftUI.Section {
                quickRow(all)
                if let f = flash {
                    BodyFlashRow(flash: f, undo: f.undoId.map { id in { Task { await engine.softDelete(id) }; flash = nil } })
                }
            } header: { Text("Log now") }

            SwiftUI.Section { CustodyCard() } header: { Text("Custody") }

            let planned = plans
            if !due.isEmpty || !planned.isEmpty {
                SwiftUI.Section {
                    ForEach(due) { e in PetDueRow(event: e).contentShape(Rectangle()).onTapGesture { editing = e } }
                    ForEach(planned, id: \.event.id) { p in PetPlanRow(title: p.event.str("title"), day: p.day) }
                } header: { Text("Next due") }
            }

            SwiftUI.Section {
                if recent.isEmpty {
                    Text("Nothing logged in the last 30 days. Tap Walked, Fed or Meds above, or + for a vet visit or anything else.")
                        .foregroundStyle(.secondary)
                }
                ForEach(recent) { e in eventRow(e) }
            } header: { Text("Last 30 days, \(recent.count) event\(recent.count == 1 ? "" : "s")") }

            if !older.isEmpty {
                SwiftUI.Section {
                    if showOlder {
                        ForEach(older) { e in eventRow(e) }
                    }
                    Button(showOlder ? "Hide older events" : "Show \(older.count) older event\(older.count == 1 ? "" : "s")") { showOlder.toggle() }
                }
            }
        }
        .navigationTitle(Self.pet)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { creating = true } label: { Label("Add event", systemImage: "plus") }
            }
        }
        .sheet(isPresented: $creating) { PetEventEditor(event: nil) }
        .sheet(item: $editing) { e in PetEventEditor(event: e) }
        .confirmationDialog("Delete this event?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible, presenting: deleting) { e in
            Button("Delete", role: .destructive) { Task { await engine.softDelete(e.id) }; deleting = nil }
        } message: { e in Text(PetEventEditor.summary(e)) }
        .refreshable { await engine.sync() }
        .task(id: flash?.id) {
            guard flash != nil else { return }
            try? await Task.sleep(for: .seconds(8))
            if !Task.isCancelled { flash = nil }
        }
    }

    /// The three one-tap buttons, each with how long ago it last happened.
    private func quickRow(_ all: [Entity]) -> some View {
        HStack(spacing: 10) {
            ForEach(Self.quick) { q in
                let last = all.first { $0.str("type") == q.type && $0.str("note") == q.note }.flatMap { $0.date("at") }
                Button {
                    Task {
                        let e = await engine.create(kind: .pet_event, fields: [
                            "pet": .string(Self.pet), "type": .string(q.type), "at": .string(ISO.now()), "note": .string(q.note)
                        ])
                        flash = BodyFlash(text: "\(q.label) logged at \(Date().shortTime)", undoId: e?.id)
                    }
                } label: {
                    VStack(spacing: 4) {
                        Image(systemName: q.symbol).font(.title2)
                        Text(q.label).font(.headline)
                        Text(last.map { BodyFmt.ago($0) } ?? "not yet")
                            .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                    .frame(maxWidth: .infinity, minHeight: 76)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.bordered)
                .accessibilityLabel("\(q.label) \(Self.pet)")
                .accessibilityValue(last.map { "Last \(BodyFmt.ago($0))" } ?? "Not logged yet")
            }
        }
        .padding(.vertical, 4)
    }

    private func eventRow(_ e: Entity) -> some View {
        PetEventRow(event: e)
            .contentShape(Rectangle())
            .onTapGesture { editing = e }
            .swipeActions(edge: .trailing) {
                Button(role: .destructive) { deleting = e } label: { Label("Delete", systemImage: "trash") }
            }
            .contextMenu {
                Button("Edit") { editing = e }
                Button("Delete", role: .destructive) { deleting = e }
            }
    }
}

// MARK: custody

/// Custody. Handoffs (below) answer it now; the older "<pet> week" info plan rule (alternating weeks from an
/// anchor) is still read when no handoff has been logged.
enum PetCustody {
    struct State { var withMe: Bool; var nextHandoff: Date?; var alternating: Bool }

    @MainActor static func rule(in engine: SyncEngine, pet: String = PetView.pet) -> Entity? {
        engine.list(.plan_rule).first {
            $0.str("type") == "info" && $0.bool("active") != false
                && $0.str("title").trimmingCharacters(in: .whitespaces).caseInsensitiveCompare("\(pet) week") == .orderedSame
        }
    }

    static func monday(of d: Date, cal: Calendar = .current) -> Date {
        let day = cal.startOfDay(for: d)
        let back = (cal.component(.weekday, from: day) + 5) % 7  // weekday 2 is Monday
        return cal.date(byAdding: .day, value: -back, to: day) ?? day
    }

    /// The anchor's date part read as a local date, like the hub's `parseLocalDate`.
    static func anchorDate(_ s: String) -> Date? {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = .current
        f.dateFormat = "yyyy-MM-dd"
        return f.date(from: String(s.prefix(10)))
    }

    static func dateString(_ d: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = .current
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: d)
    }

    static func state(rule: Entity, now: Date = Date(), cal: Calendar = .current) -> State {
        let mon = monday(of: now, cal: cal)
        guard let a = rule.string("alternating_anchor"), let ad = anchorDate(a) else { return State(withMe: true, nextHandoff: nil, alternating: false) }
        let days = cal.dateComponents([.day], from: monday(of: ad, cal: cal), to: mon).day ?? 0
        let weeks = Int((Double(days) / 7).rounded())
        return State(withMe: weeks % 2 == 0, nextHandoff: cal.date(byAdding: .day, value: 7, to: mon), alternating: true)
    }
}

extension PetCustody {
    /// The cycle when nothing on record says otherwise (the hub's DEFAULT_CYCLE_DAYS).
    static let defaultCycleDays = 7

    /// Where the pet is now from the last handoff logged, as the hub's `custodyOf` works it. Past the predicted
    /// handoff with nothing logged, the swap is assumed to have happened on schedule.
    struct Now { var withMe: Bool; var since: Date; var next: Date; var cycleDays: Int; var handoff: Entity }

    @MainActor static func handoffs(in engine: SyncEngine, pet: String = PetView.pet) -> [Entity] {
        engine.list(.pet_event)
            .filter { $0.str("type") == "custody" && ["me", "other"].contains($0.str("with")) && $0.str("pet").caseInsensitiveCompare(pet) == .orderedSame && ISO.date($0.str("at")) != nil }
            .sorted { (ISO.date($0.str("at")) ?? .distantPast) > (ISO.date($1.str("at")) ?? .distantPast) }
    }

    static func ownCycle(_ e: Entity) -> Int? { e.number("cycle_days").map { max(1, Int($0.rounded())) } }

    /// The hub's `cycleIn`: its own cycle, else the nearest older handoff's, else the days since the one before
    /// (1 to 60), else the default. `all` is newest first.
    static func cycle(_ e: Entity, in all: [Entity]) -> Int {
        if let own = ownCycle(e) { return own }
        guard let t = ISO.date(e.str("at")) else { return defaultCycleDays }
        let older = all.filter { $0.id != e.id && (ISO.date($0.str("at")) ?? .distantFuture) < t }
        for o in older { if let c = ownCycle(o) { return c } }
        if let prev = older.first.flatMap({ ISO.date($0.str("at")) }) {
            let gap = Int((t.timeIntervalSince(prev) / 86400).rounded())
            if (1...60).contains(gap) { return gap }
        }
        return defaultCycleDays
    }

    static func adding(_ days: Int, to d: Date, cal: Calendar = .current) -> Date { cal.date(byAdding: .day, value: days, to: d) ?? d }

    @MainActor static func now(in engine: SyncEngine, at now: Date = Date()) -> Now? {
        let all = handoffs(in: engine)
        guard let last = all.first(where: { (ISO.date($0.str("at")) ?? .distantFuture) <= now }),
              let start = ISO.date(last.str("at")) else { return nil }
        let days = cycle(last, in: all)
        var since = start
        var withMe = last.str("with") == "me"
        var next = ISO.date(last.string("next_due")) ?? adding(days, to: start)
        while next <= now {
            since = next
            withMe.toggle()
            next = adding(days, to: since)
        }
        return Now(withMe: withMe, since: since, next: next, cycleDays: days, handoff: last)
    }

    static func cycleWords(_ d: Int) -> String {
        d % 7 == 0 ? (d == 7 ? "every week" : "every \(d / 7) weeks") : "every \(d) days"
    }
}

/// Where the pet is, from the last handoff logged. One tap logs the next one on the day it really happens; the
/// next handoff is predicted from the cycle (a week unless changed) and can be moved by hand.
struct CustodyCard: View {
    @EnvironmentObject var engine: SyncEngine
    @State private var busy = false

    var body: some View {
        if let c = PetCustody.now(in: engine) {
            VStack(alignment: .leading, spacing: 8) {
                Label(c.withMe ? "With you" : "At the other home", systemImage: c.withMe ? "house.fill" : "arrow.left.arrow.right")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(c.withMe ? Color.green : Color.orange)
                Text("Since \(BodyFmt.day(c.since)). Next handoff \(BodyFmt.day(c.next)), \(BodyFmt.inDays(c.next)), \(PetCustody.cycleWords(c.cycleDays)).")
                    .font(.subheadline).foregroundStyle(.secondary)
                Button { log(withMe: !c.withMe, cycle: c.cycleDays) } label: {
                    Label(c.withMe ? "Dropped him off" : "Picked him up", systemImage: c.withMe ? "car.fill" : "house.fill").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(busy)
                Picker("Repeats", selection: Binding(get: { c.cycleDays }, set: { setCycle($0, on: c) })) {
                    ForEach(Array(Set([7, 14, 21, 28, c.cycleDays])).sorted(), id: \.self) { Text(PetCustody.cycleWords($0)).tag($0) }
                }
                DatePicker("Next handoff", selection: Binding(get: { c.next }, set: { setNext($0, on: c) }), in: Date()..., displayedComponents: .date)
            }
            .padding(.vertical, 4)
        } else {
            VStack(alignment: .leading, spacing: 10) {
                if let rule = PetCustody.rule(in: engine) {
                    let s = PetCustody.state(rule: rule)
                    Text(s.withMe ? "With you this week (old weekly rule)" : "At the other home this week (old weekly rule)").font(.subheadline).foregroundStyle(.secondary)
                }
                Text("Where is \(PetView.pet) right now?").font(.headline)
                Text("Tap it on the day the pet changes hands. The next handoff is predicted a week out (change the cycle after), with a reminder the day before.")
                    .font(.subheadline).foregroundStyle(.secondary)
                HStack(spacing: 10) {
                    Button { log(withMe: true, cycle: PetCustody.defaultCycleDays) } label: { Label("With me", systemImage: "house.fill").frame(maxWidth: .infinity) }
                        .buttonStyle(.borderedProminent)
                    Button { log(withMe: false, cycle: PetCustody.defaultCycleDays) } label: { Label("At the other home", systemImage: "arrow.left.arrow.right").frame(maxWidth: .infinity) }
                        .buttonStyle(.bordered)
                }
                .controlSize(.large)
                .disabled(busy)
            }
            .padding(.vertical, 4)
        }
    }

    private func log(withMe: Bool, cycle: Int) {
        busy = true
        let at = Date()
        Task {
            _ = await engine.create(kind: .pet_event, fields: [
                "pet": .string(PetView.pet),
                "type": "custody",
                "at": .string(ISO.string(at)),
                "with": .string(withMe ? "me" : "other"),
                "cycle_days": .number(Double(cycle)),
                "next_due": .string(ISO.string(PetCustody.adding(cycle, to: at))),
                "note": .string(withMe ? "Picked up" : "Dropped off at the other home")
            ])
            busy = false
        }
    }

    private func setCycle(_ days: Int, on c: PetCustody.Now) {
        guard days != c.cycleDays, let start = ISO.date(c.handoff.str("at")) else { return }
        if c.since > start {
            Task { _ = await engine.create(kind: .pet_event, fields: assumedHandoff(c, cycle: days, nextDue: PetCustody.adding(days, to: c.since))) }
            return
        }
        Task { _ = await engine.update(c.handoff.id, fields: ["cycle_days": .number(Double(days)), "next_due": .string(ISO.string(PetCustody.adding(days, to: start)))]) }
    }

    /// Moves the predicted handoff to another day, keeping its time of day.
    private func setNext(_ day: Date, on c: PetCustody.Now) {
        let cal = Calendar.current
        let t = cal.dateComponents([.hour, .minute], from: c.next)
        let d = cal.date(bySettingHour: t.hour ?? 12, minute: t.minute ?? 0, second: 0, of: day) ?? day
        guard !cal.isDate(d, inSameDayAs: c.next) else { return }
        if let start = ISO.date(c.handoff.str("at")), c.since > start {
            Task { _ = await engine.create(kind: .pet_event, fields: assumedHandoff(c, cycle: c.cycleDays, nextDue: d)) }
            return
        }
        Task { _ = await engine.update(c.handoff.id, fields: ["next_due": .string(ISO.string(d))]) }
    }

    /// The swap the card assumes happened on schedule, written as a handoff so a change can rest on it. When a
    /// predicted handoff passed with nothing logged, the card counts it as made; moving the next handoff (or the
    /// cycle) wrote onto the last logged handoff, which undid the assumed swap and flipped who has him.
    private func assumedHandoff(_ c: PetCustody.Now, cycle: Int, nextDue: Date) -> [String: JSONValue] {
        [
            "pet": .string(PetView.pet),
            "type": "custody",
            "at": .string(ISO.string(c.since)),
            "with": .string(c.withMe ? "me" : "other"),
            "cycle_days": .number(Double(cycle)),
            "next_due": .string(ISO.string(nextDue)),
            "note": .string(c.withMe ? "Picked up on schedule" : "Dropped off at the other home on schedule")
        ]
    }
}

// MARK: rows

private func petTypeLabel(_ t: String) -> String {
    switch t {
    case "vet": return "Vet"
    case "med": return "Meds"
    case "incident": return "Incident"
    case "custody": return "Custody"
    case "weight": return "Weight"
    case "food": return "Food"
    default: return "Note"
    }
}

private func petTypeColor(_ t: String) -> Color {
    switch t {
    case "vet": return .blue
    case "med": return .purple
    case "incident": return .red
    case "custody": return .orange
    case "food": return .green
    default: return .secondary
    }
}

struct PetEventRow: View {
    var event: Entity
    var body: some View {
        let type = event.str("type")
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                BodyTag(text: petTypeLabel(type), color: petTypeColor(type))
                Text(StyleGuard.dashes(event.str("note"))).lineLimit(2)
                Spacer(minLength: 4)
                if let d = event.date("at") {
                    Text(Calendar.current.isDateInToday(d) ? d.shortTime : d.formatted(.dateTime.month(.abbreviated).day().hour().minute()))
                        .font(.caption).foregroundStyle(.secondary).fixedSize()
                }
            }
            let cost = event.number("cost")
            let next = event.date("next_due")
            if cost != nil || next != nil {
                HStack(spacing: 10) {
                    if let c = cost { Text("Cost \(BodyFmt.money(c))") }
                    if let n = next { Text("Next due \(BodyFmt.day(n))") }
                }
                .font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }
}

private struct PetDueRow: View {
    var event: Entity
    var body: some View {
        let d = event.date("next_due") ?? Date()
        let days = Calendar.current.dateComponents([.day], from: Calendar.current.startOfDay(for: Date()), to: Calendar.current.startOfDay(for: d)).day ?? 0
        let color: Color = days <= 1 ? .red : (days <= 7 ? .orange : .secondary)
        HStack(spacing: 10) {
            BodyTag(text: petTypeLabel(event.str("type")), color: petTypeColor(event.str("type")))
            Text(StyleGuard.dashes(event.str("note"))).lineLimit(1)
            Spacer(minLength: 4)
            VStack(alignment: .trailing, spacing: 2) {
                Text(BodyFmt.inDays(d)).font(.subheadline.weight(.semibold)).foregroundStyle(color)
                Text(BodyFmt.day(d)).font(.caption).foregroundStyle(.secondary)
            }
            .fixedSize()
        }
    }
}

/// A calendar plan about him, shown with what is due.
private struct PetPlanRow: View {
    var title: String
    var day: Date
    var body: some View {
        HStack(spacing: 10) {
            BodyTag(text: "Calendar", color: .blue)
            Text(StyleGuard.dashes(title)).lineLimit(1)
            Spacer(minLength: 4)
            VStack(alignment: .trailing, spacing: 2) {
                Text(BodyFmt.inDays(day)).font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                Text(BodyFmt.day(day)).font(.caption).foregroundStyle(.secondary)
            }
            .fixedSize()
        }
    }
}

// MARK: editor

struct PetEventEditor: View {
    @EnvironmentObject var engine: SyncEngine
    @Environment(\.dismiss) private var dismiss
    var event: Entity?

    @State private var type = "vet"
    @State private var at = Date()
    @State private var note = ""
    @State private var cost = ""
    @State private var hasNext = false
    @State private var next = Calendar.current.date(byAdding: .month, value: 1, to: Date()) ?? Date()
    @State private var loadedHasNext = false
    @State private var loadedNext = Date()
    @State private var confirmDelete = false

    static let types = ["vet", "med", "incident", "custody", "weight", "food", "note"]

    static func summary(_ e: Entity) -> String {
        let when = e.date("at").map { $0.shortDateTime } ?? ""
        let note = e.str("note")
        return [petTypeLabel(e.str("type")), note, when].filter { !$0.isEmpty }.joined(separator: ", ")
    }

    var body: some View {
        NavigationStack {
            Form {
                Picker("Type", selection: $type) {
                    ForEach(Self.types, id: \.self) { Text(petTypeLabel($0)).tag($0) }
                }
                DatePicker("When", selection: $at)
                TextField(type == "weight" ? "Weight, for example 62 lb" : "Note", text: $note, axis: .vertical).lineLimit(1...4)
                TextField("Cost, optional", text: $cost).numericKeyboard()
                SwiftUI.Section {
                    Toggle("Next due date", isOn: $hasNext)
                    if hasNext { DatePicker("Due", selection: $next, displayedComponents: [.date]) }
                } footer: {
                    Text("A next due date gets a reminder the day before.")
                }
                if event != nil {
                    SwiftUI.Section {
                        Button("Delete event", role: .destructive) { confirmDelete = true }
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle(event == nil ? "New event" : "Edit event")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { save() }.disabled(!cost.isEmpty && BodyFmt.parse(cost) == nil) }
            }
            .confirmationDialog("Delete this event?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete", role: .destructive) {
                    if let e = event { Task { await engine.softDelete(e.id) } }
                    dismiss()
                }
            }
            .onAppear(perform: load)
        }
        #if os(macOS)
        .frame(minWidth: 440, minHeight: 440)
        #endif
    }

    private func load() {
        guard let e = event else { return }
        type = Self.types.contains(e.str("type")) ? e.str("type") : "note"
        at = e.date("at") ?? at
        note = e.str("note")
        cost = e.number("cost").map(BodyFmt.number) ?? ""
        if let n = e.date("next_due") { hasNext = true; next = n }
        loadedHasNext = hasNext
        loadedNext = next
    }

    /// Whether the due date differs from what the editor opened with (on/off, or another day).
    private var nextChanged: Bool {
        hasNext != loadedHasNext || (hasNext && !Calendar.current.isDate(next, inSameDayAs: loadedNext))
    }

    private func save() {
        let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
        var f: [String: JSONValue] = [
            "pet": .string(PetView.pet),
            "type": .string(type),
            "at": .string(ISO.string(at)),
            "note": trimmed.isEmpty ? .null : .string(trimmed),
            "cost": BodyFmt.parse(cost).map { .number($0) } ?? .null
        ]
        // Due at 09:00 local on the chosen day, as the web does; the hub plans the reminder from it. Written only when
        // the user changed it: an edit always rewrote it, so on a custody handoff the hub took the prediction as set by
        // hand and stopped moving it with the handoff (hub/src/pets.ts syncHandoffs), and the next handoff stayed at
        // 09:00 on the old day.
        if event == nil || nextChanged {
            let cal = Calendar.current
            let due = cal.date(bySettingHour: 9, minute: 0, second: 0, of: next) ?? next
            f["next_due"] = hasNext ? .string(ISO.string(due)) : .null
        }
        Task {
            if let e = event {
                _ = await engine.update(e.id, fields: f)
            } else {
                _ = await engine.create(kind: .pet_event, fields: f.filter { !$0.value.isNull })
            }
        }
        dismiss()
    }
}
