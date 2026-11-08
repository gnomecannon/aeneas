import SwiftUI
import EACore

/// One decision at a time: the hub picks one option and this shows it. The list below is for upkeep.
struct FoodView: View {
    @EnvironmentObject var engine: SyncEngine
    @State private var snack = false
    @State private var mode: String?
    @State private var budget = ""
    @State private var result: FoodPickResult?
    @State private var excluded: [String] = []
    @State private var ordered: String?
    @State private var busy = false
    @State private var error: String?
    @State private var creating = false
    @State private var editing: Entity?
    @State private var deleting: Entity?

    static let modes = ["delivery", "restaurant", "grab", "home"]

    private var meal: String { snack ? "snack" : (Calendar.current.component(.hour, from: Date()) < 15 ? "lunch" : "dinner") }

    private var options: [Entity] {
        engine.list(.food_option).sorted { $0.str("name").localizedCaseInsensitiveCompare($1.str("name")) == .orderedAscending }
    }

    var body: some View {
        let opts = options
        List {
            SwiftUI.Section { pickCard } header: { Text("What to eat") }

            SwiftUI.Section {
                if opts.isEmpty {
                    Text("No food options yet. Tap + to add the places and meals you like, then Pick for me.")
                        .foregroundStyle(.secondary)
                }
                ForEach(opts) { o in
                    FoodOptionRow(option: o)
                        .contentShape(Rectangle())
                        .onTapGesture { editing = o }
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) { deleting = o } label: { Label("Delete", systemImage: "trash") }
                        }
                        .swipeActions(edge: .leading) {
                            let avoid = o.bool("avoid") == true
                            Button { Task { await engine.update(o.id, fields: ["avoid": .bool(!avoid)]) } } label: {
                                Label(avoid ? "Allow" : "Avoid", systemImage: avoid ? "checkmark.circle" : "nosign")
                            }
                            .tint(avoid ? .green : .orange)
                        }
                        .contextMenu {
                            Button("Edit") { editing = o }
                            Button("Delete", role: .destructive) { deleting = o }
                        }
                }
            } header: { Text("Options, \(opts.count)") }
        }
        .navigationTitle("Food")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { creating = true } label: { Label("Add option", systemImage: "plus") }
            }
        }
        .sheet(isPresented: $creating) { FoodOptionEditor(option: nil) }
        .sheet(item: $editing) { o in FoodOptionEditor(option: o) }
        .confirmationDialog("Delete this option?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible, presenting: deleting) { o in
            Button("Delete \(o.str("name"))", role: .destructive) { Task { await engine.softDelete(o.id) }; deleting = nil }
        } message: { _ in Text("To keep it but never have it picked, use Avoid instead.") }
        .refreshable { await engine.sync() }
        .onChange(of: snack) { reset() }
        .onChange(of: mode) { reset() }
    }

    // MARK: pick card

    @ViewBuilder private var pickCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(meal.capitalized).font(.title2.weight(.bold))
                Spacer()
                Toggle("Snack", isOn: $snack).toggleStyle(.button)
            }
            FlowLayout(spacing: 8) {
                modeChip(nil, "Any")
                ForEach(Self.modes, id: \.self) { m in modeChip(m, m.capitalized) }
            }
            HStack(spacing: 10) {
                TextField("Budget, optional", text: $budget)
                    .numericKeyboard()
                    .textFieldStyle(.roundedBorder)
                    .frame(maxWidth: 170)
                Spacer(minLength: 0)
                Button { Task { await ask(exclude: []) } } label: {
                    Label(busy ? "Picking" : "Pick for me", systemImage: "sparkles").frame(minWidth: 120)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(busy || (!budget.isEmpty && BodyFmt.parse(budget) == nil))
            }
        }
        .padding(.vertical, 4)

        if let e = error { BodyErrorRow(text: e) }

        if let r = result {
            if let name = ordered {
                VStack(alignment: .leading, spacing: 8) {
                    Label("Ordered \(StyleGuard.dashes(name)). Done for this \(meal).", systemImage: "checkmark.circle.fill")
                        .font(.headline).foregroundStyle(.green)
                    Button("Pick again") { reset() }.buttonStyle(.bordered)
                }
                .padding(.vertical, 4)
            } else if let p = r.pick {
                pickResult(p, r)
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    Text(r.why.isEmpty ? "Nothing fits. Add an option, or drop the budget or mode." : StyleGuard.dashes(r.why))
                    HStack {
                        Button("Add an option") { creating = true }.buttonStyle(.bordered)
                        if !excluded.isEmpty { Button("Start over") { Task { await ask(exclude: []) } }.buttonStyle(.bordered) }
                    }
                }
                .padding(.vertical, 4)
            }
        }
    }

    private func pickResult(_ p: Entity, _ r: FoodPickResult) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(StyleGuard.dashes(p.str("name"))).font(.title.weight(.semibold))
            let items = p.stringArray("items")
            if !items.isEmpty { Text(items.joined(separator: ", ")).font(.body) }
            if let notes = p.string("notes"), !notes.isEmpty { Text(StyleGuard.dashes(notes)).font(.subheadline) }
            HStack(spacing: 8) {
                BodyTag(text: p.str("kind").capitalized)
                if let c = p.number("cost") { Text(BodyFmt.money(c)) }
            }
            .font(.subheadline)
            if !r.why.isEmpty {
                Text("Why: \(StyleGuard.dashes(r.why))").font(.subheadline).foregroundStyle(.secondary)
            }
            HStack(spacing: 10) {
                Button { Task { await order(p) } } label: { Label("Order this", systemImage: "checkmark").frame(maxWidth: .infinity) }
                    .buttonStyle(.borderedProminent)
                Button { Task { await ask(exclude: excluded + [p.id]) } } label: { Label("Another", systemImage: "arrow.clockwise").frame(maxWidth: .infinity) }
                    .buttonStyle(.bordered)
            }
            .controlSize(.large)
            .disabled(busy)
            if let ru = r.runner_up {
                Text("Runner up: \(StyleGuard.dashes(ru.str("name")))\(ru.number("cost").map { ", \(BodyFmt.money($0))" } ?? "")")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if !excluded.isEmpty {
                Text("Skipped \(excluded.count) so far").font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 6)
    }

    private func modeChip(_ value: String?, _ label: String) -> some View {
        Chip(text: label, selected: mode == value) { mode = value }
            .accessibilityAddTraits(mode == value ? .isSelected : [])
    }

    // MARK: actions

    private func reset() {
        result = nil
        excluded = []
        ordered = nil
        error = nil
    }

    private func ask(exclude: [String]) async {
        guard let c = engine.client else { error = "Picking needs the hub. Set it up in Settings."; return }
        busy = true
        error = nil
        ordered = nil
        defer { busy = false }
        do {
            let r = try await c.foodPick(FoodPickRequest(meal: meal, mode: mode, budget: BodyFmt.parse(budget), exclude: exclude.isEmpty ? nil : exclude))
            result = r
            excluded = exclude
        } catch {
            self.error = "Could not reach the hub to pick: \(error.localizedDescription)"
        }
    }

    private func order(_ p: Entity) async {
        guard let c = engine.client else { error = "Recording the order needs the hub."; return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            let updated = try await c.foodPicked(id: p.id)
            await engine.absorb(updated)
            ordered = p.str("name")
        } catch {
            self.error = "Could not record the order: \(error.localizedDescription)"
        }
    }
}

// MARK: rows

struct FoodOptionRow: View {
    var option: Entity
    var body: some View {
        let avoid = option.bool("avoid") == true
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(StyleGuard.dashes(option.str("name"))).font(.headline).strikethrough(avoid).lineLimit(2)
                Spacer(minLength: 4)
                if avoid { BodyStatusPill(text: "Avoid", symbol: "nosign", color: .red) }
            }
            HStack(spacing: 8) {
                BodyTag(text: option.str("kind").capitalized)
                if let r = option.number("rating") { Text("\(Int(r)) of 5") }
                if let c = option.number("cost") { Text(BodyFmt.money(c)) }
                let n = Int(option.number("times_picked") ?? 0)
                if n > 0 {
                    Text("Picked \(n) time\(n == 1 ? "" : "s")\(option.date("last_picked").map { ", last \(BodyFmt.ago($0))" } ?? "")").lineLimit(1)
                }
            }
            .font(.caption).foregroundStyle(.secondary)
            let items = option.stringArray("items")
            if !items.isEmpty { Text(items.joined(separator: ", ")).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
            if let notes = option.string("notes"), !notes.isEmpty { Text(StyleGuard.dashes(notes)).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
            let tags = option.stringArray("tags")
            if !tags.isEmpty { Text(tags.joined(separator: "  ")).font(.caption2).foregroundStyle(.secondary) }
        }
        .padding(.vertical, 2)
        .opacity(avoid ? 0.7 : 1)
    }
}

// MARK: editor

struct FoodOptionEditor: View {
    @EnvironmentObject var engine: SyncEngine
    @Environment(\.dismiss) private var dismiss
    var option: Entity?

    @State private var name = ""
    @State private var kind = "delivery"
    @State private var items = ""
    @State private var loadedItems = ""
    @State private var tags: [String] = []
    @State private var avoid = false
    @State private var rating = 0
    @State private var cost = ""
    @State private var confirmDelete = false

    static let tagChoices = ["protein", "plant", "sushi", "spicy", "sweet-sauce", "tomato", "fried", "cheap"]

    var body: some View {
        NavigationStack {
            Form {
                TextField("Name, for example Sushi delivery", text: $name).font(.title3)
                Picker("Kind", selection: $kind) {
                    ForEach(FoodView.modes, id: \.self) { Text($0.capitalized).tag($0) }
                }
                TextField("What to order, one per line", text: $items, axis: .vertical).lineLimit(1...6)
                TextField("Cost, optional", text: $cost).numericKeyboard()
                Picker("Rating", selection: $rating) {
                    Text("None").tag(0)
                    ForEach(1...5, id: \.self) { Text("\($0)").tag($0) }
                }
                SwiftUI.Section {
                    FlowLayout(spacing: 8) {
                        ForEach(Self.tagChoices, id: \.self) { t in
                            Chip(text: t, selected: tags.contains(t)) {
                                if let i = tags.firstIndex(of: t) { tags.remove(at: i) } else { tags.append(t) }
                            }
                            .accessibilityAddTraits(tags.contains(t) ? .isSelected : [])
                        }
                    }
                    .padding(.vertical, 4)
                } header: { Text("Tags") } footer: {
                    Text("Protein and plant are preferred. Sweet sauce, fried and tomato are picked less.")
                }
                SwiftUI.Section {
                    Toggle("Avoid, never pick", isOn: $avoid)
                }
                if option != nil {
                    SwiftUI.Section {
                        Button("Delete option", role: .destructive) { confirmDelete = true }
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle(option == nil ? "New option" : "Edit option")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { save() }
                        .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || (!cost.isEmpty && BodyFmt.parse(cost) == nil))
                }
            }
            .confirmationDialog("Delete this option?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete", role: .destructive) {
                    if let o = option { Task { await engine.softDelete(o.id) } }
                    dismiss()
                }
            } message: { Text("To keep it but never have it picked, turn on Avoid instead.") }
            .onAppear(perform: load)
        }
        #if os(macOS)
        .frame(minWidth: 460, minHeight: 520)
        #endif
    }

    private func load() {
        guard let o = option else { return }
        name = o.str("name")
        kind = FoodView.modes.contains(o.str("kind")) ? o.str("kind") : "delivery"
        // One per line: items were joined and split on commas, so "Chicken, rice bowl" came back as two items.
        items = o.stringArray("items").joined(separator: "\n")
        loadedItems = items
        tags = o.stringArray("tags")
        avoid = o.bool("avoid") == true
        rating = Int(o.number("rating") ?? 0)
        cost = o.number("cost").map(BodyFmt.number) ?? ""
    }

    private func save() {
        // Unedited items are kept exactly as they were.
        let list = items == loadedItems && option != nil
            ? (option?.stringArray("items") ?? [])
            : items.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        var f: [String: JSONValue] = [
            "name": .string(name.trimmingCharacters(in: .whitespaces)),
            "kind": .string(kind),
            "items": .array(list.map { .string($0) }),
            "tags": .array(tags.map { .string($0) }),
            "avoid": .bool(avoid),
            "rating": rating > 0 ? .number(Double(rating)) : .null,
            "cost": BodyFmt.parse(cost).map { .number($0) } ?? .null
        ]
        Task {
            if let o = option {
                _ = await engine.update(o.id, fields: f)
            } else {
                f = f.filter { !$0.value.isNull }
                _ = await engine.create(kind: .food_option, fields: f)
            }
        }
        dismiss()
    }
}
