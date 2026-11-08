import SwiftUI
import EACore

/// Facts by category (edit, delete) and rules (toggle, edit).
struct MemoryView: View {
    @EnvironmentObject var engine: SyncEngine
    @State private var editingFact: Entity?
    @State private var editingRule: Entity?
    @State private var newFact = false
    @State private var newRule = false

    private var factsByCategory: [(FactCategory, [Entity])] {
        FactCategory.allCases.compactMap { c in
            let f = engine.facts.filter { $0.str("category") == c.rawValue }.sorted { $0.str("key") < $1.str("key") }
            return f.isEmpty ? nil : (c, f)
        }
    }

    var body: some View {
        List {
            ForEach(factsByCategory, id: \.0) { cat, facts in
                SwiftUI.Section(header: Text(cat.rawValue.capitalized).font(.headline)) {
                    ForEach(facts) { f in
                        VStack(alignment: .leading, spacing: 3) {
                            HStack {
                                Text(f.str("key")).font(.subheadline.weight(.semibold))
                                if f.bool("private") == true { Image(systemName: "lock").font(.caption) }
                                Spacer()
                                if let c = f.number("confidence") { Text(String(format: "%.0f%%", c * 100)).font(.caption).foregroundStyle(.secondary) }
                            }
                            Text(StyleGuard.dashes(f.str("value"))).font(.body)
                        }
                        .contentShape(Rectangle())
                        .onTapGesture { editingFact = f }
                        .swipeActions { Button("Delete", role: .destructive) { Task { await engine.softDelete(f.id) } } }
                        .contextMenu {
                            Button("Edit") { editingFact = f }
                            Button("Delete", role: .destructive) { Task { await engine.softDelete(f.id) } }
                        }
                    }
                }
            }
            SwiftUI.Section(header: Text("Rules").font(.headline)) {
                ForEach(engine.rules.sorted { $0.str("text") < $1.str("text") }) { r in
                    HStack(spacing: 12) {
                        Toggle("", isOn: Binding(get: { r.bool("active") ?? true }, set: { v in Task { _ = await engine.update(r.id, fields: ["active": .bool(v)]) } })).labelsHidden()
                        VStack(alignment: .leading, spacing: 3) {
                            Text(StyleGuard.dashes(r.str("text"))).font(.body)
                            HStack(spacing: 8) {
                                Text(r.str("enforce"))
                                if let p = r.string("pattern"), !p.isEmpty { Text("/\(p)/\(r.str("flags", "g"))").font(.caption.monospaced()) }
                            }
                            .font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                    }
                    .contentShape(Rectangle())
                    .onTapGesture { editingRule = r }
                    .contextMenu {
                        Button("Edit") { editingRule = r }
                        Button("Delete", role: .destructive) { Task { await engine.softDelete(r.id) } }
                    }
                }
                if engine.rules.isEmpty { Text("No rules").foregroundStyle(.secondary) }
            }
        }
        .listStyle(.plain)
        .navigationTitle("Memory")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu { Button("New fact") { newFact = true }; Button("New rule") { newRule = true } } label: { Label("New", systemImage: "plus") }
            }
        }
        .sheet(item: $editingFact) { FactEditView(fact: $0) }
        .sheet(isPresented: $newFact) { FactEditView(fact: nil) }
        .sheet(item: $editingRule) { RuleEditView(rule: $0) }
        .sheet(isPresented: $newRule) { RuleEditView(rule: nil) }
        .refreshable { await engine.sync() }
    }
}

struct FactEditView: View {
    @EnvironmentObject var engine: SyncEngine
    @Environment(\.dismiss) private var dismiss
    var fact: Entity?
    @State private var category: FactCategory = .preference
    @State private var key = ""
    @State private var value = ""
    @State private var source = "user"
    @State private var confidence = 1.0
    @State private var isPrivate = false

    var body: some View {
        NavigationStack {
            Form {
                Picker("Category", selection: $category) { ForEach(FactCategory.allCases, id: \.self) { Text($0.rawValue).tag($0) } }
                TextField("Key (e.g. dog:name)", text: $key)
                TextField("Value", text: $value, axis: .vertical).lineLimit(2...8)
                TextField("Source", text: $source)
                Slider(value: $confidence, in: 0...1, step: 0.05) { Text("Confidence \(Int(confidence * 100))%") }
                Toggle("Private (never sent to a cloud model)", isOn: $isPrivate)
                if let f = fact { SwiftUI.Section { Button("Delete", role: .destructive) { Task { await engine.softDelete(f.id) }; dismiss() } } }
            }
            .navigationTitle(fact == nil ? "New fact" : "Edit fact")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { save() }.disabled(key.isEmpty || value.isEmpty) }
            }
            .onAppear {
                guard let f = fact?.decoded(FactFields.self) else { return }
                category = f.category; key = f.key; value = f.value; source = f.source ?? "user"; confidence = f.confidence ?? 1; isPrivate = f.private ?? false
            }
        }
        #if os(macOS)
        .frame(minWidth: 480, minHeight: 420)
        #endif
    }

    private func save() {
        let fields: [String: JSONValue] = ["category": .string(category.rawValue), "key": .string(key), "value": .string(value), "source": .string(source), "confidence": .number(confidence), "private": .bool(isPrivate)]
        Task {
            if let f = fact { _ = await engine.update(f.id, fields: fields) } else { _ = await engine.create(kind: .fact, fields: fields) }
        }
        dismiss()
    }
}

struct RuleEditView: View {
    @EnvironmentObject var engine: SyncEngine
    @Environment(\.dismiss) private var dismiss
    var rule: Entity?
    @State private var text = ""
    @State private var enforce: RuleEnforce = .both
    @State private var pattern = ""
    @State private var flags = "g"
    @State private var replacement = ""
    @State private var active = true

    var body: some View {
        NavigationStack {
            Form {
                TextField("Rule text", text: $text, axis: .vertical).lineLimit(2...6)
                Picker("Enforce", selection: $enforce) { ForEach(RuleEnforce.allCases, id: \.self) { Text($0.rawValue).tag($0) } }
                TextField("Pattern (regex source)", text: $pattern).font(.body.monospaced())
                TextField("Flags", text: $flags)
                TextField("Replacement", text: $replacement)
                Toggle("Active", isOn: $active)
                if let r = rule { SwiftUI.Section { Button("Delete", role: .destructive) { Task { await engine.softDelete(r.id) }; dismiss() } } }
            }
            .navigationTitle(rule == nil ? "New rule" : "Edit rule")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { save() }.disabled(text.isEmpty) }
            }
            .onAppear {
                guard let r = rule?.decoded(RuleFields.self) else { return }
                text = r.text; enforce = r.enforce; pattern = r.pattern ?? ""; flags = r.flags ?? "g"; replacement = r.replacement ?? ""; active = r.active ?? true
            }
        }
        #if os(macOS)
        .frame(minWidth: 480, minHeight: 420)
        #endif
    }

    private func save() {
        var fields: [String: JSONValue] = ["text": .string(text), "enforce": .string(enforce.rawValue), "active": .bool(active), "flags": .string(flags)]
        fields["pattern"] = pattern.isEmpty ? .null : .string(pattern)
        fields["replacement"] = replacement.isEmpty ? .null : .string(replacement)
        Task {
            if let r = rule { _ = await engine.update(r.id, fields: fields) } else { _ = await engine.create(kind: .rule, fields: fields) }
        }
        dismiss()
    }
}
