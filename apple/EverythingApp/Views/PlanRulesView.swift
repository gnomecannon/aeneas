import SwiftUI
import EACore

/// Standing constraints for the block planner: blackouts, commitments, preferences.
struct PlanRulesView: View {
    @EnvironmentObject var engine: SyncEngine
    @State private var editing: Entity?
    @State private var creating = false

    var body: some View {
        List {
            ForEach(engine.planRules) { r in
                PlanRuleRow(rule: r, onEdit: { editing = r })
            }
        }
        .listStyle(.plain)
        .overlay { if engine.planRules.isEmpty { EmptyState(text: "No plan rules.\nAdd work hours, custody weeks and quiet evenings so the planner never schedules over them.") } }
        .navigationTitle("Plan rules")
        .toolbar { ToolbarItem(placement: .primaryAction) { Button { creating = true } label: { Label("New", systemImage: "plus") } } }
        .sheet(item: $editing) { r in PlanRuleEditView(rule: r) }
        .sheet(isPresented: $creating) { PlanRuleEditView(rule: nil) }
    }
}

struct PlanRuleRow: View {
    @EnvironmentObject var engine: SyncEngine
    var rule: Entity
    var onEdit: () -> Void

    var body: some View {
        let f = rule.decoded(PlanRuleFields.self)
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(StyleGuard.dashes(rule.str("title"))).font(.title3)
                HStack(spacing: 8) {
                    Text(f?.type.rawValue.capitalized ?? "")
                        .font(.caption.weight(.medium))
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(Color.secondary.opacity(0.15), in: Capsule())
                        .fixedSize()
                    Text("\(f?.start ?? "") to \(f?.end ?? "")").fixedSize()
                    if f?.alternating_anchor != nil { Text("alternating weeks").lineLimit(1) }
                }
                .font(.caption).foregroundStyle(.secondary)
                Text((f?.days ?? []).map { $0.rawValue.capitalized }.joined(separator: " ")).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Toggle("Active", isOn: Binding(get: { f?.active ?? true }, set: { v in Task { await engine.update(rule.id, fields: ["active": .bool(v)]) } }))
                .labelsHidden()
        }
        .contentShape(Rectangle())
        .onTapGesture { onEdit() }
        .contextMenu {
            Button("Edit") { onEdit() }
            Button("Delete", role: .destructive) { Task { await engine.softDelete(rule.id) } }
        }
    }
}

struct PlanRuleEditView: View {
    @EnvironmentObject var engine: SyncEngine
    @Environment(\.dismiss) private var dismiss
    var rule: Entity?
    @State private var title = ""
    @State private var type: PlanRuleType = .blackout
    @State private var days: Set<Weekday> = [.mon, .tue, .wed, .thu, .fri]
    @State private var start = LocalPlanner.time(on: Date(), hhmm: "09:00") ?? Date()
    @State private var end = LocalPlanner.time(on: Date(), hhmm: "17:00") ?? Date()
    @State private var untilMidnight = false
    @State private var alternating = false
    @State private var anchor = Date()
    @State private var note = ""
    @State private var active = true

    private var startString: String { hhmm(start) }
    private var endString: String { untilMidnight ? "24:00" : hhmm(end) }
    private var valid: Bool {
        guard !title.trimmingCharacters(in: .whitespaces).isEmpty, !days.isEmpty else { return false }
        guard let s = LocalPlanner.minutes(startString), let e = LocalPlanner.minutes(endString) else { return false }
        return e > s
    }

    var body: some View {
        NavigationStack {
            Form {
                TextField("Title", text: $title).font(.title3)
                Picker("Type", selection: $type) { ForEach(PlanRuleType.allCases, id: \.self) { Text($0.rawValue.capitalized).tag($0) } }
                    .pickerStyle(.segmented)
                Text(typeHelp).font(.caption).foregroundStyle(.secondary)
                SwiftUI.Section("Days") {
                    FlowLayout(spacing: 8) {
                        ForEach(Weekday.allCases, id: \.self) { d in
                            Chip(text: d.rawValue.capitalized, selected: days.contains(d)) {
                                if days.contains(d) { days.remove(d) } else { days.insert(d) }
                            }
                        }
                    }
                    HStack {
                        Button("Weekdays") { days = [.mon, .tue, .wed, .thu, .fri] }
                        Button("Weekend") { days = [.sat, .sun] }
                        Button("Every day") { days = Set(Weekday.allCases) }
                    }
                    .buttonStyle(.borderless).font(.caption)
                }
                SwiftUI.Section("Hours") {
                    DatePicker("Start", selection: $start, displayedComponents: [.hourAndMinute])
                    Toggle("Until midnight", isOn: $untilMidnight)
                    if !untilMidnight { DatePicker("End", selection: $end, displayedComponents: [.hourAndMinute]) }
                    Text("\(startString) to \(endString)").font(.caption).foregroundStyle(.secondary)
                }
                SwiftUI.Section("Alternating weeks") {
                    Toggle("Only every other week", isOn: $alternating)
                    if alternating {
                        DatePicker("Anchor week", selection: $anchor, displayedComponents: [.date])
                        Text("Applies on the anchor's week and every second week after and before it.").font(.caption).foregroundStyle(.secondary)
                    }
                }
                SwiftUI.Section {
                    TextField("Note", text: $note, axis: .vertical).lineLimit(1...4)
                    Toggle("Active", isOn: $active)
                }
                if let r = rule {
                    SwiftUI.Section { Button("Delete", role: .destructive) { Task { await engine.softDelete(r.id) }; dismiss() } }
                }
            }
            .formStyle(.grouped)
            .navigationTitle(rule == nil ? "New plan rule" : "Edit plan rule")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { save() }.disabled(!valid) }
            }
            .onAppear(perform: load)
        }
        #if os(macOS)
        .frame(minWidth: 480, minHeight: 560)
        #endif
    }

    private var typeHelp: String {
        switch type {
        case .blackout: return "Never schedule here."
        case .commitment: return "Fixed time, shown on the plan."
        case .preference: return "Prefer blocks here when there is room."
        case .info: return "Just a note on the week (custody, say); nothing is blocked."
        }
    }

    private func hhmm(_ d: Date) -> String {
        let c = Calendar.current.dateComponents([.hour, .minute], from: d)
        return LocalPlanner.hhmm((c.hour ?? 0) * 60 + (c.minute ?? 0))
    }

    private func load() {
        guard let r = rule, let f = r.decoded(PlanRuleFields.self) else { return }
        title = f.title
        type = f.type
        days = Set(f.days)
        start = LocalPlanner.time(on: Date(), hhmm: f.start) ?? start
        if f.end == "24:00" { untilMidnight = true } else { end = LocalPlanner.time(on: Date(), hhmm: f.end) ?? end }
        if let a = f.alternating_anchor, let d = LocalPlanner.date(a) { alternating = true; anchor = d }
        note = f.note ?? ""
        active = f.active ?? true
    }

    private func save() {
        let ordered = Weekday.allCases.filter { days.contains($0) }
        var f: [String: JSONValue] = [
            "title": .string(title.trimmingCharacters(in: .whitespaces)),
            "type": .string(type.rawValue),
            "days": .array(ordered.map { .string($0.rawValue) }),
            "start": .string(startString),
            "end": .string(endString),
            "active": .bool(active)
        ]
        f["alternating_anchor"] = alternating ? .string(LocalPlanner.dateString(anchor)) : .null
        f["note"] = note.isEmpty ? .null : .string(note)
        Task {
            if let r = rule { _ = await engine.update(r.id, fields: f) }
            else { _ = await engine.create(kind: .plan_rule, fields: f.filter { !$0.value.isNull }) }
        }
        dismiss()
    }
}
