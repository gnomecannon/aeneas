import SwiftUI
import EACore

/// Watches (renewals and expiries) grouped by urgency.
struct RenewalsView: View {
    @EnvironmentObject var engine: SyncEngine
    @State private var editing: Entity?
    @State private var creating = false
    /// What they cost together, from the hub (the assistant reads the same numbers).
    @State private var totals: RenewalTotals?

    private struct Group: Identifiable { var id: String { title }; var title: String; var items: [Entity] }

    /// Changes when a renewal is added, changed or removed, so the totals load again.
    private var watchesSignature: String { "\(engine.watches.count)|\(engine.watches.map(\.updated_at).max() ?? "")" }

    private static func money(_ v: Double) -> String { v.formatted(.currency(code: Locale.current.currency?.identifier ?? "USD")) }

    private var totalsLine: String? {
        guard let t = totals, t.count > 0 else { return nil }
        var line = "\(Self.money(t.monthly_total)) a month, \(Self.money(t.yearly_total)) a year, for \(t.count) renewal\(t.count == 1 ? "" : "s") with a cost"
        if !t.left_out.isEmpty { line += "; \(t.left_out.count) not counted because \(t.left_out.count == 1 ? "it does" : "they do") not repeat" }
        return line
    }

    private var groups: [Group] {
        let cal = Calendar.current
        let today = cal.startOfDay(for: Date())
        let soon = cal.date(byAdding: .day, value: 30, to: today) ?? today
        var overdue: [Entity] = [], next30: [Entity] = [], later: [Entity] = []
        for w in engine.watches {
            guard let d = w.date("due") else { later.append(w); continue }
            if cal.startOfDay(for: d) < today { overdue.append(w) }
            else if d <= soon { next30.append(w) }
            else { later.append(w) }
        }
        return [Group(title: "Overdue", items: overdue), Group(title: "Next 30 days", items: next30), Group(title: "Later", items: later)].filter { !$0.items.isEmpty }
    }

    var body: some View {
        WideReader { wide in
            if wide { cards } else { list }
        }
        .overlay { if engine.watches.isEmpty { EmptyState(text: "No renewals yet.\nAdd certificates, subscriptions, prescriptions, warranties and domains to stay ahead of them.") } }
        .navigationTitle("Renewals")
        .toolbar { ToolbarItem(placement: .primaryAction) { Button { creating = true } label: { Label("New", systemImage: "plus") } } }
        .sheet(item: $editing) { w in WatchEditView(watch: w) }
        .sheet(isPresented: $creating) { WatchEditView(watch: nil) }
        .refreshable { await engine.sync(); await loadTotals() }
        .task(id: watchesSignature) { await loadTotals() }
    }

    private func loadTotals() async {
        guard let c = engine.client, let t = try? await c.renewalTotals() else { return }
        totals = t
    }

    private var list: some View {
        List {
            if let line = totalsLine {
                Text(line).font(.footnote).foregroundStyle(.secondary).listRowSeparator(.hidden)
            }
            ForEach(groups) { g in
                SwiftUI.Section(header: Text(g.title).font(.headline).pinnedHeader()) {
                    ForEach(g.items) { w in
                        WatchRow(watch: w, onEdit: { editing = w })
                    }
                }
            }
        }
        .listStyle(.plain)
    }

    /// A wide window: Overdue, Next 30 days and Later one under the other as before, each a grid of cards, as many
    /// across as fit at 400 points each (2 across a screen of 1040 points, 4 across a 1920 window), which leaves
    /// the date and the Renewed button their room. A card is a row's own words and button, with the same click and
    /// right-click menu.
    private var cards: some View {
        WidePage {
            if let line = totalsLine {
                Text(line).font(.footnote).foregroundStyle(.secondary)
            }
            ForEach(groups) { g in
                WideSection(g.title) {
                    CardGrid(minWidth: 400) {
                        ForEach(g.items) { w in
                            WatchRow(watch: w, onEdit: { editing = w }, card: true)
                        }
                    }
                }
            }
        }
    }
}

struct WatchRow: View {
    @EnvironmentObject var engine: SyncEngine
    var watch: Entity
    var onEdit: () -> Void
    /// A card in the wide window's grid instead of a list row: the same words on a card's fill, all of it clickable.
    var card = false
    @Environment(\.dynamicTypeSize) private var typeSize

    private var probeStatus: (text: String, ok: Bool?)? {
        guard let f = watch.decoded(WatchFields.self), let url = f.probe_url, !url.isEmpty else { return nil }
        if let err = f.last_probe_error, !err.isEmpty { return ("Probe failed: \(err)", false) }
        if let p = f.last_probe, let d = ISO.date(p) { return ("Probed \(Calendar.current.isDateInToday(d) ? d.shortTime : d.formatted(date: .abbreviated, time: .omitted))", true) }
        return ("Not probed yet", nil)
    }

    var body: some View {
        let f = watch.decoded(WatchFields.self)
        let due = watch.date("due")
        // At the largest text sizes Renewed goes under the words and each line of small words wraps: held to one
        // line beside one another, the kind, the days left and Renewed made the row wider than the screen, and the
        // list showed it cut at both edges.
        let stacked = typeSize.isAccessibilitySize
        let row = stacked ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8)) : AnyLayout(HStackLayout(alignment: .top, spacing: 12))
        let line = stacked ? AnyLayout(FlowLayout(spacing: 8)) : AnyLayout(HStackLayout(spacing: 8))
        row {
            VStack(alignment: .leading, spacing: 4) {
                Text(StyleGuard.dashes(watch.str("title"))).font(.title3)
                if stacked {
                    FlowLayout(spacing: 8) { kindAndDaysLeft(f, due); dueDate(due) }
                } else {
                    // Beside Renewed on a phone the date was cut ("Dec 6, 2..."): this year's date goes without its year,
                    // and a date that still does not fit goes on a line of its own.
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 8) { kindAndDaysLeft(f, due); dueDate(due) }
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(spacing: 8) { kindAndDaysLeft(f, due) }
                            dueDate(due)
                        }
                    }
                }
                line {
                    if f?.autopay == true { Text("Autopay") }
                    if let c = f?.cost { Text(c.formatted(.currency(code: Locale.current.currency?.identifier ?? "USD"))) }
                    if let r = f?.repeat, !r.isEmpty { Text(RepeatRule.words(r)) }
                    if let p = probeStatus {
                        HStack(spacing: 3) {
                            Image(systemName: p.ok == true ? "checkmark.shield" : (p.ok == false ? "exclamationmark.shield" : "shield"))
                            Text(p.text).lineLimit(1)
                        }
                        .foregroundStyle(p.ok == false ? AnyShapeStyle(.dangerText) : AnyShapeStyle(.secondary))
                    }
                }
                .font(.caption).foregroundStyle(.secondary)
                if let r = f?.renewed_at, let d = ISO.date(r) {
                    Text("Renewed \(d.formatted(date: .abbreviated, time: .omitted))").font(.caption2).foregroundStyle(.secondary)
                }
            }
            if !stacked { Spacer(minLength: 8) }
            // Autopay renews by itself; only a renewal the owner has to do gets the button.
            if f?.autopay != true {
                Button("Renewed") { Task { await engine.renewWatch(watch.id) } }.buttonStyle(.themedProminent).fixedSize()
            }
        }
        .padding(.vertical, card ? 0 : 4)
        .gridCard(if: card)
        .contentShape(Rectangle())
        .onTapGesture { onEdit() }
        .contextMenu {
            Button("Edit") { onEdit() }
            if let u = f?.url, let link = URL(string: u) { Link("Open renewal page", destination: link) }
            Button("Delete", role: .destructive) { Task { await engine.softDelete(watch.id) } }
        }
    }

    /// The kind (Subscription, Domain...) and the days left.
    @ViewBuilder private func kindAndDaysLeft(_ f: WatchFields?, _ due: Date?) -> some View {
        Text(f?.category.rawValue.capitalized ?? "Other")
            .font(.caption.weight(.medium))
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(Color.secondary.opacity(0.15), in: Capsule())
            .fixedSize()
        Text(daysLeftLabel(due)).font(.subheadline.weight(.semibold)).foregroundStyle(daysLeftColor(due)).fixedSize()
    }

    /// The due date: "Dec 6" this year, "Jan 5, 2027" in another.
    @ViewBuilder private func dueDate(_ due: Date?) -> some View {
        if let d = due {
            let thisYear = Calendar.current.isDate(d, equalTo: Date(), toGranularity: .year)
            Text(thisYear ? d.formatted(.dateTime.month(.abbreviated).day()) : d.formatted(date: .abbreviated, time: .omitted))
                .font(.caption).foregroundStyle(.secondary).fixedSize()
        }
    }
}

struct WatchEditView: View {
    @EnvironmentObject var engine: SyncEngine
    @Environment(\.dismiss) private var dismiss
    var watch: Entity?
    @State private var title = ""
    @State private var category: WatchCategory = .subscription
    @State private var due = Calendar.current.date(byAdding: .month, value: 1, to: Date()) ?? Date()
    @State private var leadDays = 7
    @State private var repeats = false
    @State private var every = 1
    @State private var unit: RepeatRule.Unit = .years
    @State private var probeURL = ""
    @State private var hasCost = false
    @State private var cost = ""
    @State private var url = ""
    @State private var notes = ""
    @State private var autopay = false

    var body: some View {
        NavigationStack {
            Form {
                TextField("Title", text: $title).font(.title3)
                Toggle("Pays itself (autopay)", isOn: $autopay)
                if autopay { Text("No reminder, and the date moves on by itself once it passes.").font(.caption).foregroundStyle(.secondary) }
                Picker("Category", selection: $category) { ForEach(WatchCategory.allCases, id: \.self) { Text($0.rawValue.capitalized).tag($0) } }
                DatePicker("Due", selection: $due, displayedComponents: [.date])
                if !autopay { Stepper("Remind \(leadDays) day\(leadDays == 1 ? "" : "s") before", value: $leadDays, in: 0...365) }
                Toggle("Repeat after renewal", isOn: $repeats)
                if repeats {
                    Stepper("Every \(every)", value: $every, in: 1...120)
                    Picker("Unit", selection: $unit) { ForEach([RepeatRule.Unit.days, .weeks, .months, .years], id: \.self) { Text($0.rawValue).tag($0) } }
                    Text(repeatString ?? "").font(.caption).foregroundStyle(.secondary)
                }
                SwiftUI.Section("Certificate probe") {
                    TextField("https://host to read the TLS certificate", text: $probeURL).autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never).keyboardType(.URL)
                        #endif
                    if let f = watch?.decoded(WatchFields.self), let p = f.probe_url, !p.isEmpty {
                        if let e = f.last_probe_error, !e.isEmpty { Text("Last probe failed: \(e)").font(.caption).foregroundStyle(.dangerText) }
                        else if let d = ISO.date(f.last_probe) { Text("Last probed \(d.shortDateTime), due set from the certificate").font(.caption).foregroundStyle(.secondary) }
                    }
                }
                SwiftUI.Section("Details") {
                    Toggle("Cost", isOn: $hasCost)
                    if hasCost { TextField("Amount", text: $cost).numericKeyboard() }
                    TextField("Where to renew or cancel (URL)", text: $url).autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never).keyboardType(.URL)
                        #endif
                    TextField("Notes", text: $notes, axis: .vertical).lineLimit(2...6)
                }
                if let w = watch {
                    SwiftUI.Section {
                        // Autopay renews by itself: nothing to mark.
                        if !autopay { Button("Renewed") { Task { await engine.renewWatch(w.id) }; dismiss() } }
                        Button("Delete", role: .destructive) { Task { await engine.softDelete(w.id) }; dismiss() }
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle(watch == nil ? "New renewal" : "Edit renewal")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { save() }.disabled(title.trimmingCharacters(in: .whitespaces).isEmpty || (repeats && repeatString == nil) || (!probeURL.isEmpty && !probeURL.lowercased().hasPrefix("https://"))) }
            }
            .onAppear(perform: load)
        }
        #if os(macOS)
        .frame(minWidth: 480, minHeight: 520)
        #endif
    }

    private var repeatString: String? {
        guard repeats else { return nil }
        let s = RepeatRule(n: every, unit: unit).description
        return RepeatRule.parse(s) != nil ? s : nil
    }

    private func load() {
        guard let w = watch, let f = w.decoded(WatchFields.self) else { return }
        title = f.title
        category = f.category
        due = ISO.date(f.due) ?? due
        leadDays = f.lead_days ?? 7
        if let r = f.repeat, let rule = RepeatRule.parse(r) { repeats = true; every = rule.n; unit = rule.unit }
        probeURL = f.probe_url ?? ""
        if let c = f.cost { hasCost = true; cost = JSONValue.number(c).displayString }
        url = f.url ?? ""
        notes = f.notes ?? ""
        autopay = f.autopay ?? false
    }

    private func save() {
        var f: [String: JSONValue] = [
            "title": .string(title.trimmingCharacters(in: .whitespaces)),
            "category": .string(category.rawValue),
            "due": .string(ISO.string(due)),
            "lead_days": .number(Double(leadDays)),
            "autopay": .bool(autopay)
        ]
        f["repeat"] = repeatString.map { .string($0) } ?? .null
        f["probe_url"] = probeURL.isEmpty ? .null : .string(probeURL.trimmingCharacters(in: .whitespaces))
        f["cost"] = (hasCost ? Double(cost.replacingOccurrences(of: ",", with: ".")) : nil).map { .number($0) } ?? .null
        f["url"] = url.isEmpty ? .null : .string(url.trimmingCharacters(in: .whitespaces))
        f["notes"] = notes.isEmpty ? .null : .string(notes)
        Task {
            if let w = watch { _ = await engine.update(w.id, fields: f) }
            else {
                f = f.filter { !$0.value.isNull }
                _ = await engine.create(kind: .watch, fields: f)
            }
        }
        dismiss()
    }
}
