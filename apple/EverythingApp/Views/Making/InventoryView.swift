import SwiftUI
import EACore

/// Parts, gear and materials on hand, grouped by category. Project parts lists are checked against these names.
struct InventoryView: View {
    @EnvironmentObject var engine: SyncEngine
    @State private var query = ""
    @State private var creating = false
    @State private var editing: Entity?
    @State private var deleting: Entity?

    static let categories = ["component", "gear", "material", "tool", "other"]

    private var items: [Entity] { engine.list(.inventory) }

    private var groups: [(category: String, items: [Entity])] {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        let hits = items.filter { e in
            needle.isEmpty || ([e.str("name"), e.str("location")] + e.stringArray("tags")).joined(separator: " ").lowercased().contains(needle)
        }
        return Self.categories.compactMap { c in
            let list = hits.filter { ($0.str("category").isEmpty ? "other" : $0.str("category")) == c }
                .sorted { $0.str("name").localizedCaseInsensitiveCompare($1.str("name")) == .orderedAscending }
            return list.isEmpty ? nil : (c, list)
        }
    }

    var body: some View {
        List {
            ForEach(groups, id: \.category) { g in
                SwiftUI.Section {
                    ForEach(g.items) { e in
                        InventoryRow(item: e)
                            .contentShape(Rectangle())
                            .onTapGesture { editing = e }
                            .swipeActions(edge: .trailing) {
                                Button("Delete", role: .destructive) { deleting = e }
                            }
                            .contextMenu {
                                Button("Edit") { editing = e }
                                Button("Delete", role: .destructive) { deleting = e }
                            }
                    }
                } header: {
                    Text("\(g.category.capitalized) \(g.items.count)")
                }
            }
        }
        .overlay {
            if items.isEmpty {
                ContentUnavailableView {
                    Label("Nothing in the inventory yet", systemImage: "shippingbox")
                } description: {
                    Text("Tap Add item for each part, tool or material you have. Project parts with the same name count as on hand.")
                } actions: {
                    Button("Add item") { creating = true }.buttonStyle(.borderedProminent)
                }
            } else if groups.isEmpty {
                ContentUnavailableView.search(text: query)
            }
        }
        .searchable(text: $query, prompt: "Name, location or tag")
        .navigationTitle("Inventory")
        .toolbar {
            ToolbarItem(placement: .primaryAction) { Button { creating = true } label: { Label("Add item", systemImage: "plus") } }
        }
        .sheet(isPresented: $creating) { InventoryEditSheet(item: nil) }
        .sheet(item: $editing) { e in InventoryEditSheet(item: e) }
        .confirmationDialog("Delete \(deleting?.str("name") ?? "this item")?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                if let e = deleting { Task { await engine.softDelete(e.id) } }
                deleting = nil
            }
        }
        .refreshable { await engine.sync() }
    }
}

struct InventoryRow: View {
    var item: Entity

    var body: some View {
        let tags = item.stringArray("tags")
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 3) {
                Text(StyleGuard.dashes(item.str("name")))
                HStack(spacing: 8) {
                    if !item.str("location").isEmpty { Label(item.str("location"), systemImage: "mappin").labelStyle(.titleAndIcon) }
                    if !tags.isEmpty { Text(tags.map { "#" + $0 }.joined(separator: " ")) }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            Spacer(minLength: 6)
            Text("\(Making.num(item.number("qty") ?? 1))\(item.str("unit").isEmpty ? "" : " " + item.str("unit"))")
                .font(.body.monospaced())
        }
        .accessibilityElement(children: .combine)
    }
}

struct InventoryEditSheet: View {
    @EnvironmentObject var engine: SyncEngine
    @Environment(\.dismiss) private var dismiss
    var item: Entity?

    @State private var name = ""
    @State private var category = "component"
    @State private var qty = "1"
    @State private var unit = ""
    @State private var location = ""
    @State private var tags = ""
    @State private var notes = ""
    @State private var confirmDelete = false

    /// The quantity typed, or nil when it is not a number of 0 or more. An empty or mistyped field was saved as 1, so
    /// clearing it to say none were left recorded one; Save now waits for a number.
    private var qtyValue: Double? {
        let t = qty.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: ".")
        guard let v = Double(t), v.isFinite, v >= 0 else { return nil }
        return v
    }

    var body: some View {
        NavigationStack {
            Form {
                SwiftUI.Section {
                    TextField("Name", text: $name).font(.title3)
                    Picker("Category", selection: $category) {
                        ForEach(InventoryView.categories, id: \.self) { Text($0.capitalized).tag($0) }
                    }
                    HStack {
                        Text("Quantity")
                        Spacer()
                        TextField("1", text: $qty).multilineTextAlignment(.trailing).font(.body.monospaced()).numericKeyboard().frame(maxWidth: 90)
                        TextField("unit", text: $unit).frame(maxWidth: 80)
                    }
                } footer: {
                    if qtyValue == nil { Text("Type how many there are, 0 when none are left.") }
                }
                SwiftUI.Section {
                    TextField("Location (bin, shelf, drawer)", text: $location)
                    TextField("Tags, comma separated", text: $tags)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                    TextField("Notes", text: $notes, axis: .vertical).lineLimit(1...4)
                }
                if item != nil {
                    SwiftUI.Section { Button("Delete item", role: .destructive) { confirmDelete = true } }
                }
            }
            .formStyle(.grouped)
            .navigationTitle(item == nil ? "Add item" : "Edit item")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(item == nil ? "Add" : "Save") { save() }.disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || qtyValue == nil)
                }
            }
            .confirmationDialog("Delete this item?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete", role: .destructive) {
                    if let e = item { Task { await engine.softDelete(e.id) } }
                    dismiss()
                }
            }
            .onAppear(perform: load)
        }
        #if os(macOS)
        .frame(minWidth: 440, minHeight: 400)
        #endif
    }

    private func load() {
        guard let e = item else { return }
        name = e.str("name")
        category = e.str("category", "other")
        qty = Making.num(e.number("qty") ?? 1)
        unit = e.str("unit")
        location = e.str("location")
        tags = e.stringArray("tags").joined(separator: ", ")
        notes = e.str("notes")
    }

    private func save() {
        func opt(_ s: String) -> JSONValue {
            let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
            return t.isEmpty ? .null : .string(t)
        }
        var f: [String: JSONValue] = [
            "name": .string(name.trimmingCharacters(in: .whitespaces)),
            "category": .string(category),
            "qty": .number(qtyValue ?? 1),
            "tags": .array(tags.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.map { .string($0) }),
            "unit": opt(unit),
            "location": opt(location),
            "notes": opt(notes)
        ]
        Task {
            if let e = item {
                _ = await engine.update(e.id, fields: f)
            } else {
                f = f.filter { !$0.value.isNull }
                _ = await engine.create(kind: .inventory, fields: f)
            }
        }
        dismiss()
    }
}
