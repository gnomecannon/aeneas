import SwiftUI
import UniformTypeIdentifiers
import EACore

/// Machines with their fix notes (kind `runbook`), change journal, snippets and monitors. Find a host, or type a new name to start one.
/// Since 2026-11-19 not in the Library: the Overview has a card per machine. This list stays the Machines section for
/// links to it.
struct HostsView: View {
    @EnvironmentObject var engine: SyncEngine
    @State private var hubHosts: [HostSummary] = []
    @State private var query = ""
    @State private var openHost: String?
    @State private var asking = false
    @State private var newName = ""

    /// Local counts win (they include edits not pushed yet); the hub adds hosts this device has not synced. Both are
    /// keyed by the lowercased name, as the hub keys them, so one machine is one row however its name was written.
    private var hosts: [HostSummary] {
        var byName: [String: HostSummary] = [:]
        for h in hubHosts { byName[Homelab.hostKey(h.host)] = h }
        for h in Homelab.localHosts(engine) { byName[Homelab.hostKey(h.host)] = h }
        return byName.values.sorted { $0.host.localizedCaseInsensitiveCompare($1.host) == .orderedAscending }
    }

    private var typed: String { Homelab.trimmed(query).lowercased() }
    private var shown: [HostSummary] { typed.isEmpty ? hosts : hosts.filter { $0.host.lowercased().contains(typed) } }

    private var intro: some View {
        Text("Every computer you run. Each keeps fix notes (what broke on it and the exact steps that fixed it), a log of changes and command snippets. The assistant writes the fix notes when you finish a troubleshooting chat, so next time the answer is already here.")
            .font(.footnote).foregroundStyle(.secondary)
    }

    /// A name typed that no machine has yet: the way to start its page.
    private var openTyped: some View {
        Button { openHost = typed } label: { Label("Open \(typed)", systemImage: "plus.circle") }
    }

    private var list: some View {
        List {
            if typed.isEmpty {
                SwiftUI.Section { intro }
            }
            if !typed.isEmpty, !hosts.contains(where: { $0.host.lowercased() == typed }) {
                SwiftUI.Section { openTyped }
            }
            ForEach(shown) { h in
                NavigationLink { HostDetailView(host: h.host) } label: { HostRow(summary: h) }
            }
        }
    }

    /// A wide window: a card for each machine, as many across as fit at 360 points each (2 across a screen of 1040
    /// points, 4 across a 1920 window), by name. A card opens the machine's page as its row does.
    private var cards: some View {
        WidePage {
            if typed.isEmpty { intro }
            if !typed.isEmpty, !hosts.contains(where: { $0.host.lowercased() == typed }) { openTyped }
            CardGrid(minWidth: 360) {
                ForEach(shown) { h in
                    NavigationLink { HostDetailView(host: h.host) } label: { HostRow(summary: h).gridCard() }
                        .buttonStyle(.plain)
                }
            }
        }
    }

    var body: some View {
        WideReader { wide in
            if wide { cards } else { list }
        }
        .searchable(text: $query, prompt: "Find or add a machine")
        .navigationTitle("Machines")
        .navigationDestination(item: $openHost) { HostDetailView(host: $0) }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { newName = ""; asking = true } label: { Label("Add machine", systemImage: "plus") }
            }
        }
        .alert("Open or add a machine", isPresented: $asking) {
            TextField("Machine name", text: $newName)
                .autocorrectionDisabled()
                #if os(iOS)
                .textInputAutocapitalization(.never)
                #endif
            Button("Open") {
                let h = Homelab.trimmed(newName).lowercased()
                if !h.isEmpty { openHost = h }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("A machine appears in the list once it has fix notes, a logged change, a snippet or a monitor.")
        }
        .overlay {
            if hosts.isEmpty && typed.isEmpty {
                ContentUnavailableView {
                    Label("No machines yet", systemImage: "desktopcomputer")
                } description: {
                    Text("Tap + and type a machine name to start its fix notes, change log and snippets.")
                } actions: {
                    Button("Add machine") { newName = ""; asking = true }.buttonStyle(.themedProminent)
                }
            }
        }
        .task(id: engine.lastSync) { await loadHub() }
        .refreshable { await engine.sync(); await loadHub() }
    }

    private func loadHub() async {
        guard let c = engine.client, let h = try? await c.hostSummaries() else { return }
        hubHosts = h
    }
}

struct HostRow: View {
    @EnvironmentObject var engine: SyncEngine
    var summary: HostSummary

    var body: some View {
        // A monitor that is switched off says nothing about the machine, so it is left out of the pill.
        let monitors = engine.list(.monitor).filter { Homelab.sameHost($0.str("host"), summary.host) }.map(MonitorStatus.init).filter { $0 != .off }
        let down = monitors.filter { $0 == .down }.count
        let up = monitors.filter { $0 == .up }.count
        HStack(alignment: .center, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(summary.host).font(.body.monospaced().weight(.semibold))
                Text(details).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
            Spacer(minLength: 6)
            if down > 0 {
                HomelabPill(text: "\(down) down", symbol: MonitorStatus.down.symbol, tone: .danger)
            } else if !monitors.isEmpty, up == monitors.count {
                HomelabPill(text: up == 1 ? "Up" : "\(up) up", symbol: MonitorStatus.up.symbol, tone: .ok)
            } else if !monitors.isEmpty {
                HomelabPill(text: "\(monitors.count - up) unknown", symbol: MonitorStatus.unknown.symbol, color: .gray)
            }
        }
        .padding(.vertical, 2)
    }

    private var details: String {
        let s = summary
        var parts = [
            s.runbooks > 0 ? "fix notes" : "no fix notes",
            "\(s.journal_entries) change\(s.journal_entries == 1 ? "" : "s")",
            "\(s.snippets) snippet\(s.snippets == 1 ? "" : "s")"
        ]
        parts.append(s.last_change.map { "changed \(Homelab.ago($0))" } ?? "no changes logged")
        return parts.joined(separator: ", ")
    }
}

// MARK: Machine page

/// The page of one machine, service or place (its card on the Overview): how it is, its checks with Propose a fix and
/// Acknowledge while one is down, its readings now with their graphs and bounds, its History (steps planned, a line
/// for a change made by hand, and everything that happened, newest first), then its fix notes and snippets. Checks,
/// incidents and the history come from the synced store, so the page still shows them when the hub cannot be reached;
/// the grouping (GET /ops `things`) and the readings come from the hub.
struct HostDetailView: View {
    @EnvironmentObject var engine: SyncEngine
    @EnvironmentObject var model: AppModel
    @Environment(\.scenePhase) private var scenePhase
    @ObservedObject private var feed = OpsBoardFeed.shared
    @ObservedObject private var readingsFeed = ReadingsFeed.shared
    var host: String

    @State private var newRunbook = false
    @State private var addingEntry = false
    @State private var newSnippet = false
    @State private var newMonitor = false
    @State private var acking: Entity?
    /// Checks being run by hand right now, and what went wrong with a hand check.
    @State private var checking: Set<String> = []
    @State private var checkFailures: [String: CheckFailure] = [:]
    @State private var editingSensor: Entity?
    @State private var proposingSensor: String?
    @State private var sensorError: String?
    @State private var exportDoc: SensorCSVFile?
    @State private var exportName = ""
    /// A planned step about to be dropped, and one of your own history lines about to be deleted, each asked first.
    @State private var dropping: Entity?
    @State private var deletingLine: Entity?

    /// The name as the hub keys it.
    private var key: String { Homelab.hostKey(host) }
    /// The hub's thing of this name: nil before the board is in, from a hub before 2026-11-19, or for a name it does not know.
    private var hubThing: TechThing? { feed.board?.things?.first { $0.name == key } }

    private var runbooks: [Entity] { engine.list(.runbook).filter { Homelab.sameHost($0.str("host"), host) }.sorted { $0.updated_at > $1.updated_at } }
    private var snippets: [Entity] {
        engine.list(.snippet).filter { Homelab.sameHost($0.str("host"), host) }
            .sorted { $0.str("title").localizedCaseInsensitiveCompare($1.str("title")) == .orderedAscending }
    }

    /// The hub's grouping, and any check that names this machine: one added here a moment ago is not in the grouping
    /// until the next board. Without a grouping, a check with no host is this machine's when its target names it.
    private var checks: [Entity] {
        let thing = hubThing
        let ids = Set(thing?.monitors ?? [])
        return engine.list(.monitor).filter { m in
            if ids.contains(m.id) { return true }
            let h = m.str("host")
            return Homelab.sameHost(h.isEmpty && thing == nil ? Tech.targetHost(type: m.str("type"), target: m.str("target")) : h, key)
        }
        .sorted { (MonitorStatus($0).rank, $0.str("name").lowercased()) < (MonitorStatus($1).rank, $1.str("name").lowercased()) }
    }

    /// CPU, memory and disks first, then the rest; none while Sensors is off.
    private var readings: [Entity] {
        guard model.isOn(.sensors) else { return [] }
        let thing = hubThing
        let names = Set(thing?.sensors ?? [])
        return engine.list(.sensor).filter { s in names.contains(s.str("name")) || (thing == nil && Homelab.sameHost(s.str("location"), key)) }
            .sorted { (Tech.readingOrder($0.str("name")), $0.str("name")) < (Tech.readingOrder($1.str("name")), $1.str("name")) }
    }

    /// The hub's thing, or one worked out from this page's checks and readings (a place stays a place offline).
    private func thing(_ checks: [Entity], _ readings: [Entity]) -> TechThing {
        hubThing ?? Tech.localThings(monitors: checks, sensors: readings).first { $0.name == key }
            ?? TechThing(name: key, label: host, kind: .machine, monitors: checks.map(\.id), sensors: readings.map { $0.str("name") })
    }

    var body: some View {
        ScrollViewReader { proxy in
            page
                #if DEBUG && os(iOS)
                // `-EAScrollTo history` (DebugHooks): the History, for screenshots, once the readings are in.
                .task {
                    guard let to = UserDefaults.standard.string(forKey: "EAScrollTo") else { return }
                    try? await Task.sleep(for: .seconds(3))
                    proxy.scrollTo(to, anchor: .top)
                }
                #endif
        }
    }

    @ViewBuilder
    private var page: some View {
        let checks = self.checks
        let readings = self.readings
        let me = thing(checks, readings)
        let hubBackup = me.hub ? feed.board?.hub_backup ?? [] : []
        let status = Tech.status(of: me, monitors: Dictionary(checks.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a }),
                                 sensors: Dictionary(readings.map { ($0.str("name"), $0) }, uniquingKeysWith: { a, _ in a }), hubBackup: hubBackup)
        let incidents = engine.list(.incident)
        let open = incidents.filter { ($0.string("closed_at") ?? "").isEmpty }
        let uptime = feed.board?.uptimeByName ?? [:]
        let ids = Set(checks.map(\.id))
        let journal = engine.list(.journal)
        let history = TechHistory.items(journal: journal, incidents: incidents, runbooks: engine.list(.runbook),
                                        hostOf: { ids.contains($0) ? key : nil }, host: key)
        let planned = TechHistory.plannedSteps(journal, host: key)
        // A wide window: how it is now on the left (what it is, its purpose, checks and readings), and on the right
        // what happened and what is written down (history, fix notes, snippets), each a list of its own (SplitList).
        SplitList {
            SwiftUI.Section {
                VStack(alignment: .leading, spacing: 6) {
                    if me.kind == .machine { identity(me) }
                    TechStatusPill(status: status)
                    let words = about(me)
                    if !words.isEmpty { Text(words).font(.subheadline).foregroundStyle(.secondary) }
                }
                .padding(.vertical, 2)
                .accessibilityElement(children: .combine)
            }

            if me.kind == .machine {
                SwiftUI.Section("Purpose") { PurposeRows(name: key) }
            }

            if !checks.isEmpty || !hubBackup.isEmpty || me.kind != .place {
                SwiftUI.Section {
                    if !hubBackup.isEmpty { HubBackupRow(lines: hubBackup) }
                    if checks.isEmpty && hubBackup.isEmpty {
                        Text("No checks on \(me.label). A ping says whether it is on; a port or web address says whether a service on it answers.")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                    ForEach(checks) { m in
                        NavigationLink { MonitorDetailView(id: m.id) } label: {
                            if MonitorStatus(m) == .down {
                                DownRow(monitor: m, incident: MonitorText.openIncident(for: m, in: open), checking: checking.contains(m.id),
                                        checkError: failure(m), onAck: { acking = $0 })
                            } else {
                                MonitorRow(monitor: m, uptime: m.str("type") == "backup" ? nil : uptime[m.str("name")],
                                           checking: checking.contains(m.id), checkError: failure(m))
                            }
                        }
                        .modifier(CheckNowActions(busy: checking.contains(m.id), onDelete: { Task { await engine.softDelete(m.id) } }) { Task { await check(m) } })
                    }
                    Button("Add check") { newMonitor = true }
                } header: {
                    Text("Checks")
                }
            }

            if !readings.isEmpty || me.reachable {
                SwiftUI.Section {
                    if readings.isEmpty {
                        Text("No readings yet. With Sensors on, the hub reads its CPU, memory, disks and temperatures every 10 minutes.")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                    if let sensorError { Text(sensorError).font(.caption).foregroundStyle(.dangerText) }
                    ForEach(readings) { s in readingCard(s, on: me) }
                } header: {
                    Text("Now")
                }
            }
        } second: {
            historySection(history, planned: planned)

            SwiftUI.Section {
                if runbooks.isEmpty {
                    Text("No fix notes for \(me.label) yet. They are what broke here and how it was fixed. The assistant writes them when you finish a troubleshooting chat about \(me.label), or start them yourself.")
                        .font(.subheadline).foregroundStyle(.secondary)
                    Button("Start fix notes") { newRunbook = true }
                } else {
                    ForEach(runbooks) { rb in
                        NavigationLink { RunbookDetailView(id: rb.id) } label: { RunbookRow(runbook: rb) }
                            .deleteSwipe(rb.id)
                    }
                }
            } header: {
                Text("Fix notes")
            }

            SwiftUI.Section {
                if snippets.isEmpty {
                    Text("No snippets for \(me.label).").font(.subheadline).foregroundStyle(.secondary)
                }
                ForEach(snippets) { s in
                    NavigationLink { SnippetDetailView(id: s.id) } label: { SnippetRow(snippet: s, showHost: false) }
                        .deleteSwipe(s.id)
                }
                Button("New snippet") { newSnippet = true }
            } header: {
                Text("Snippets")
            }
        }
        .navigationTitle(me.label)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button("Check", systemImage: "waveform.path.ecg") { newMonitor = true }
                    Button("Change", systemImage: "list.bullet.clipboard") { addingEntry = true }
                    Button("Snippet", systemImage: "chevron.left.forwardslash.chevron.right") { newSnippet = true }
                    Button("Fix notes", systemImage: "book") { newRunbook = true }
                } label: {
                    Label("Add", systemImage: "plus")
                }
            }
        }
        .sheet(isPresented: $newRunbook) { RunbookEditor(entry: nil, host: host) }
        .sheet(isPresented: $addingEntry) { JournalEditor(entry: nil, fixedHost: host) }
        .sheet(isPresented: $newSnippet) { SnippetEditor(entry: nil, host: host) }
        .sheet(isPresented: $newMonitor) { MonitorEditor(monitor: nil, host: key) }
        .sheet(item: $acking) { inc in AckSheet(incident: inc) }
        .sheet(item: $editingSensor) { s in SensorSettingsView(sensor: s) }
        .fileExporter(isPresented: Binding(get: { exportDoc != nil }, set: { if !$0 { exportDoc = nil } }), document: exportDoc,
                      contentType: .commaSeparatedText, defaultFilename: exportName) { _ in exportDoc = nil }
        .confirmationDialog("Drop this planned step?", isPresented: Binding(get: { dropping != nil }, set: { if !$0 { dropping = nil } }),
                            titleVisibility: .visible, presenting: dropping) { e in
            Button("Didn't do it", role: .destructive) { Task { await engine.softDelete(e.id) } }
        } message: { _ in
            Text("It did not happen, so it stays out of the history.")
        }
        .confirmationDialog("Delete this line from the history?", isPresented: Binding(get: { deletingLine != nil }, set: { if !$0 { deletingLine = nil } }),
                            titleVisibility: .visible, presenting: deletingLine) { e in
            Button("Delete", role: .destructive) { Task { await engine.softDelete(e.id) } }
        }
        .refreshable { await engine.sync(); await load(maxAge: 0) }
        // Each check's own fields (when it ran, the error, a backup's job lines) and each reading's latest value reach
        // no device by sync, and the Overview stops loading once a page is pushed: read them every 30 s while shown.
        .task(id: scenePhase.refreshes) {
            guard scenePhase.refreshes else { return }
            while !Task.isCancelled {
                await load(maxAge: 25)
                try? await Task.sleep(for: .seconds(30))
            }
        }
    }

    /// "Computer · Ubuntu 26.04 LTS", "Printer · HP LaserJet Pro M404", "Network device", or "Not identified": what kind
    /// of device the hub is sure it is, and what it runs or its model when it gave one. Never the facts behind it.
    @ViewBuilder
    private func identity(_ t: TechThing) -> some View {
        if t.kind == .machine {
            let line = Tech.identityLine(t)
            let kind = Text(t.category?.one ?? "Not identified").font(.headline)
            if line.isEmpty { kind } else { Text("\(kind)\(Text(" · \(line)").foregroundStyle(.secondary))") }
        }
    }

    /// One reading on this page, named as people say it ("Disk /"). Before the first load the card says its graph comes
    /// from the hub; after it, an empty series is fewer than 2 readings.
    private func readingCard(_ s: Entity, on me: TechThing) -> some View {
        let points: [SensorPoint]? = readingsFeed.loadedAt == nil ? nil : readingsFeed.series[s.id] ?? []
        let title: String? = me.kind == .place ? nil : Tech.readingLabel(s.str("name"), thing: me.name)
        return SensorCard(sensor: s, points: points, title: title, showLocation: false,
                          onSettings: { editingSensor = s }, onExport: { Task { await export(s) } },
                          onPropose: { Task { await propose(s) } }, proposing: proposingSensor == s.id)
    }

    /// History: steps planned on top (Done, Didn't do it), a line for a change made by hand, then what happened.
    private func historySection(_ history: [HistoryItem], planned: [Entity]) -> some View {
        SwiftUI.Section {
            if !planned.isEmpty { Text("Planned, not done yet").font(.subheadline.weight(.semibold)).id("history") }
            ForEach(planned) { e in
                PlannedStepRow(entry: e, onDone: { markDone(e) }, onDrop: { dropping = e })
            }
            NoteChangeRow(host: key).id(planned.isEmpty ? "history" : "note-change")
            HistoryRows(items: history, onDelete: { deletingLine = $0 })
        } header: {
            Text("History")
        }
    }

    /// Done on a planned step: it happened now, so it joins the history.
    private func markDone(_ e: Entity) {
        Task { _ = await engine.update(e.id, fields: ["outcome": .string("done"), "at": .string(ISO.now())]) }
    }

    /// "The machine the hub runs on; the hub reads it and the assistant can run commands on it."
    private func about(_ t: TechThing) -> String {
        let parts = [
            t.hub ? "the machine the hub runs on" : "",
            t.kind == .service ? "a service on the internet" : t.kind == .place ? "sensor boards here" : "",
            t.reachable ? "the hub reads it and the assistant can run commands on it"
                : t.reports_itself ? "its Aeneas app sends its readings"
                : t.kind == .machine && !t.hub ? "checked from the hub" : ""
        ].filter { !$0.isEmpty }
        guard !parts.isEmpty else { return "" }
        let s = parts.joined(separator: "; ")
        return s.prefix(1).uppercased() + s.dropFirst() + "."
    }

    /// The board (fresh checks, open incidents and the grouping) and, with Sensors on, the readings.
    private func load(maxAge: TimeInterval) async {
        async let board: Void = feed.load(engine, maxAge: maxAge)
        if model.isOn(.sensors) { await readingsFeed.load(engine, maxAge: maxAge) }
        await board
    }

    /// A hand check's error, until a newer check of that monitor is in.
    private func failure(_ m: Entity) -> String? {
        guard let f = checkFailures[m.id], f.lastCheck == m.string("last_check") else { return nil }
        return f.text
    }

    private func check(_ m: Entity) async {
        guard !checking.contains(m.id) else { return }
        guard let c = engine.client else {
            checkFailures[m.id] = CheckFailure(text: "Checking needs the hub.", lastCheck: m.string("last_check"))
            return
        }
        checking.insert(m.id)
        checkFailures[m.id] = nil
        defer { checking.remove(m.id) }
        do {
            await engine.absorb(try await c.checkMonitor(id: m.id))
        } catch {
            checkFailures[m.id] = CheckFailure(text: "Check failed: \(Homelab.errorText(error))", lastCheck: engine.get(m.id)?.string("last_check"))
        }
    }

    /// A reading that alerts opens a chat where the assistant looks into it and proposes one fix, which runs only when approved.
    private func propose(_ s: Entity) async {
        guard let c = engine.client else { sensorError = "Proposing a fix needs the hub."; return }
        proposingSensor = s.id
        sensorError = nil
        defer { proposingSensor = nil }
        do { model.openChat(try await c.proposeSensorFix(name: s.str("name"))) }
        catch { sensorError = "Could not start a fix: \(Homelab.errorText(error))" }
    }

    private func export(_ s: Entity) async {
        guard let c = engine.client else { sensorError = "Export needs the hub."; return }
        sensorError = nil
        do {
            let text = try await c.sensorCSV(name: s.str("name"), days: 30)
            exportName = "\(s.str("name"))-30d-\(PetCustody.dateString(Date())).csv"
            exportDoc = SensorCSVFile(text: text)
        } catch {
            sensorError = "Could not export: \(Homelab.errorText(error))"
        }
    }
}

/// What this machine is for, in the owner's words: its fact `host:<name>` in Memory, which the assistant reads whenever
/// the machine comes up and writes itself when told ("pve1 runs the domain controllers"). Read from the synced facts,
/// so it shows and saves offline; saving it empty removes it.
struct PurposeRows: View {
    @EnvironmentObject var engine: SyncEngine
    var name: String
    @State private var editing = false
    @State private var text = ""

    private var key: String { "host:\(Homelab.hostKey(name))" }
    private var fact: Entity? { engine.list(.fact).first { Homelab.hostKey($0.str("key")) == key } }

    var body: some View {
        let value = fact?.str("value") ?? ""
        if editing {
            TextField("What it is for", text: $text, prompt: Text("Proxmox host for the domain controllers; backups go to the NAS at night"), axis: .vertical)
                .lineLimit(3...8)
            HStack(spacing: 12) {
                Button("Save") { Task { await save() } }.buttonStyle(.themedProminent)
                Button("Cancel") { editing = false }.buttonStyle(.bordered)
            }
            .controlSize(.small)
        } else {
            if value.isEmpty {
                Text("What it is for and how it is set up. The assistant reads this whenever \(name) comes up.")
                    .font(.subheadline).foregroundStyle(.secondary)
            } else {
                Text(StyleGuard.dashes(value)).textSelection(.enabled)
            }
            Button(value.isEmpty ? "Add" : "Edit") { text = value; editing = true }
        }
    }

    private func save() async {
        let next = String(Homelab.trimmed(text).prefix(2000))
        if let f = fact {
            if next.isEmpty { await engine.softDelete(f.id) }
            else if next != f.str("value") { _ = await engine.update(f.id, fields: ["value": .string(next)]) }
        } else if !next.isEmpty {
            _ = await engine.create(kind: .fact, fields: [
                "category": .string("host"), "key": .string(key), "value": .string(next), "source": .string("user"), "confidence": .number(1)
            ])
        }
        editing = false
    }
}

// MARK: Runbooks

struct RunbookRow: View {
    var runbook: Entity

    var body: some View {
        let sections = RunbookText.sections(runbook.str("body")).filter { $0.title != nil }.count
        let commands = runbook.fields["commands"]?.arrayValue?.count ?? 0
        VStack(alignment: .leading, spacing: 3) {
            Text(StyleGuard.dashes(runbook.str("title"))).font(.body.weight(.medium))
            HStack(spacing: 8) {
                Text("\(sections) section\(sections == 1 ? "" : "s")")
                Text("\(commands) command\(commands == 1 ? "" : "s")")
                if let v = runbook.string("last_verified") { Text("verified \(Homelab.ago(v))") }
                else { Text("updated \(Homelab.ago(runbook.updated_at))") }
            }
            .font(.caption).foregroundStyle(.secondary).lineLimit(1)
        }
        .padding(.vertical, 2)
    }
}

struct RunbookDetailView: View {
    @EnvironmentObject var engine: SyncEngine
    @Environment(\.dismiss) private var dismiss
    var id: String
    @State private var editing = false
    @State private var confirmDelete = false
    @State private var expanded: Set<Int> = []

    var body: some View {
        if let rb = engine.get(id), !rb.isDeleted {
            content(rb)
        } else {
            ContentUnavailableView("Fix notes deleted", systemImage: "trash", description: Text("Go back to the machine."))
        }
    }

    @ViewBuilder
    private func content(_ rb: Entity) -> some View {
        let f = rb.decoded(RunbookFields.self)
        let sections = RunbookText.sections(rb.str("body"))
        List {
            SwiftUI.Section {
                HStack(spacing: 6) {
                    HomelabPill(text: rb.str("host"), symbol: "server.rack")
                    if let v = f?.last_verified {
                        HomelabPill(text: "Verified \(Homelab.ago(v))", symbol: "checkmark.seal", tone: .ok)
                    } else {
                        HomelabPill(text: "Not verified", symbol: "seal", color: .secondary)
                    }
                }
                Text("Updated \(Homelab.ago(rb.updated_at))").font(.caption).foregroundStyle(.secondary)
            }

            if let cmds = f?.commands, !cmds.isEmpty {
                SwiftUI.Section("Commands") {
                    ForEach(Array(cmds.enumerated()), id: \.offset) { _, c in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text(StyleGuard.dashes(c.label.isEmpty ? "Command" : c.label)).font(.subheadline.weight(.medium))
                                Spacer()
                                Text(c.host.isEmpty ? c.user : "\(c.user)@\(c.host)").font(.caption.monospaced()).foregroundStyle(.secondary)
                            }
                            HStack(alignment: .top, spacing: 8) {
                                CommandBlock(text: c.command)
                                HomelabCopyButton(text: c.command).labelStyle(.iconOnly).controlSize(.small)
                            }
                        }
                        .padding(.vertical, 2)
                    }
                }
            }

            if sections.allSatisfy({ RunbookText.isBlank($0) }) {
                SwiftUI.Section {
                    Text("Empty. Tap Edit to write it.").foregroundStyle(.secondary)
                }
            }
            ForEach(sections) { s in
                if let title = s.title {
                    SwiftUI.Section {
                        DisclosureGroup(isExpanded: binding(s.id, default: s.id == sections.last?.id)) {
                            RunbookBlocksView(blocks: s.blocks)
                        } label: {
                            Text(StyleGuard.dashes(title)).font(.headline)
                        }
                    }
                } else if !RunbookText.isBlank(s) {
                    SwiftUI.Section { RunbookBlocksView(blocks: s.blocks) }
                }
            }
        }
        .navigationTitle(StyleGuard.dashes(rb.str("title")))
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItem(placement: .primaryAction) { Button("Edit") { editing = true } }
            ToolbarItem {
                Menu {
                    Button("Mark verified now", systemImage: "checkmark.seal") {
                        Task { _ = await engine.update(rb.id, fields: ["last_verified": .string(ISO.now())]) }
                    }
                    Divider()
                    Button("Delete fix notes", systemImage: "trash", role: .destructive) { confirmDelete = true }
                } label: {
                    Label("More", systemImage: "ellipsis.circle")
                }
            }
        }
        .confirmationDialog("Delete these fix notes?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                Task { await engine.softDelete(rb.id) }
                dismiss()
            }
        } message: {
            Text(StyleGuard.dashes(rb.str("title")))
        }
        .sheet(isPresented: $editing) { RunbookEditor(entry: rb, host: rb.str("host")) }
    }

    /// Sections start collapsed except the newest; `expanded` holds the ones the user flipped.
    private func binding(_ id: Int, default open: Bool) -> Binding<Bool> {
        Binding(get: { expanded.contains(id) != open }, set: { now in
            if now != open { expanded.insert(id) } else { expanded.remove(id) }
        })
    }
}

/// Renders a runbook section: sub-headings, paragraphs with inline markdown, and code blocks with Copy.
struct RunbookBlocksView: View {
    var blocks: [RunbookText.Block]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, b in
                switch b {
                case .heading(let t):
                    Text(StyleGuard.dashes(t)).font(.subheadline.weight(.semibold)).padding(.top, 4)
                case .text(let t):
                    Text(RunbookText.inline(StyleGuard.dashes(t))).font(.callout).textSelection(.enabled)
                case .code(let t):
                    HStack(alignment: .top, spacing: 8) {
                        CommandBlock(text: t)
                        HomelabCopyButton(text: t).labelStyle(.iconOnly).controlSize(.small)
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }
}

/// Splits runbook markdown into `##` sections and simple blocks. Dated sections look like `## 2026-10-28: what happened`.
enum RunbookText {
    enum Block: Equatable { case heading(String), text(String), code(String) }
    struct Section: Identifiable { var id: Int; var title: String?; var blocks: [Block] }

    static func isBlank(_ s: Section) -> Bool { s.title == nil && s.blocks.isEmpty }

    static func sections(_ body: String) -> [Section] {
        var out: [Section] = [Section(id: 0, title: nil, blocks: [])]
        var para: [String] = []
        var code: [String]? = nil

        func flushPara() {
            let t = para.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !t.isEmpty { out[out.count - 1].blocks.append(.text(t)) }
            para = []
        }

        for raw in body.components(separatedBy: "\n") {
            let line = raw.trimmingCharacters(in: CharacterSet(charactersIn: "\r"))
            if line.trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                if let c = code {
                    out[out.count - 1].blocks.append(.code(c.joined(separator: "\n")))
                    code = nil
                } else {
                    flushPara()
                    code = []
                }
                continue
            }
            if code != nil { code?.append(line); continue }
            if line.hasPrefix("## ") {
                flushPara()
                out.append(Section(id: out.count, title: String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces), blocks: []))
            } else if line.hasPrefix("#") {
                flushPara()
                let t = line.drop { $0 == "#" }.trimmingCharacters(in: .whitespaces)
                // The top `# host` line repeats the page title.
                if !(line.hasPrefix("# ") && out.count == 1 && out[0].blocks.isEmpty) && !t.isEmpty {
                    out[out.count - 1].blocks.append(.heading(t))
                }
            } else if line.trimmingCharacters(in: .whitespaces).isEmpty {
                flushPara()
            } else {
                para.append(line)
            }
        }
        if let c = code { out[out.count - 1].blocks.append(.code(c.joined(separator: "\n"))) }
        flushPara()
        return out
    }

    /// Inline markdown (bold, code, links) with line breaks kept; list markers become bullets.
    static func inline(_ text: String) -> AttributedString {
        let lines = text.components(separatedBy: "\n").map { line -> String in
            let t = line.trimmingCharacters(in: .whitespaces)
            if t.hasPrefix("- ") || t.hasPrefix("* ") { return "• " + t.dropFirst(2) }
            return line
        }
        let joined = lines.joined(separator: "\n")
        return (try? AttributedString(markdown: joined, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(joined)
    }
}

struct RunbookEditor: View {
    @EnvironmentObject var engine: SyncEngine
    @Environment(\.dismiss) private var dismiss
    var entry: Entity?
    var host: String

    private struct CommandDraft: Identifiable { let id = UUID(); var label = ""; var user = "root"; var host = ""; var command = "" }

    @State private var title = ""
    @State private var bodyText = ""
    @State private var commands: [CommandDraft] = []
    @State private var confirmDelete = false
    /// What the editor opened with, so Save writes only what was edited here and can tell when the notes changed
    /// elsewhere (the assistant appends a section when a troubleshooting chat closes) while the sheet was open.
    @State private var loadedTitle = ""
    @State private var loadedBody = ""
    @State private var loadedCommands: JSONValue = .array([])
    @State private var loadedRawCommands: JSONValue = .null
    @State private var conflict: String?

    var body: some View {
        NavigationStack {
            Form {
                if let conflict {
                    SwiftUI.Section { Text(conflict).font(.subheadline).foregroundStyle(.dangerText) }
                }
                SwiftUI.Section {
                    TextField("Title", text: $title).font(.title3)
                }
                SwiftUI.Section {
                    TextEditor(text: $bodyText)
                        .font(.callout.monospaced())
                        .frame(minHeight: 240)
                    Button("Add a dated section") {
                        let day = Date().formatted(Date.ISO8601FormatStyle(timeZone: .current).year().month().day())
                        if !bodyText.isEmpty && !bodyText.hasSuffix("\n") { bodyText += "\n" }
                        bodyText += "\n## \(day): "
                    }
                } header: {
                    Text("Body")
                } footer: {
                    Text("Markdown. Each change gets a section that starts with ## and the date.")
                }
                SwiftUI.Section("Commands") {
                    ForEach($commands) { $c in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                TextField("Label", text: $c.label)
                                Button(role: .destructive) { commands.removeAll { $0.id == c.id } } label: { Image(systemName: "minus.circle.fill") }
                                    .buttonStyle(.borderless)
                                    .foregroundStyle(.dangerText)
                                    .accessibilityLabel("Remove \(c.label.isEmpty ? "command" : c.label)")
                            }
                            HStack {
                                TextField("User", text: $c.user).font(.callout.monospaced())
                                Text("@").foregroundStyle(.secondary)
                                TextField("Host", text: $c.host).font(.callout.monospaced())
                            }
                            TextField("Command", text: $c.command, axis: .vertical).font(.callout.monospaced()).lineLimit(1...6)
                        }
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                    }
                    Button("Add command") { commands.append(CommandDraft(host: host)) }
                }
                if entry != nil {
                    SwiftUI.Section { Button("Delete fix notes", role: .destructive) { confirmDelete = true } }
                }
            }
            .formStyle(.grouped)
            .navigationTitle(entry == nil ? "New fix notes" : "Edit fix notes")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { save() }.disabled(Homelab.trimmed(title).isEmpty) }
            }
            .confirmationDialog("Delete these fix notes?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete", role: .destructive) {
                    if let e = entry { Task { await engine.softDelete(e.id) } }
                    dismiss()
                }
            }
            .onAppear(perform: load)
        }
        #if os(macOS)
        .frame(minWidth: 560, minHeight: 640)
        #endif
    }

    private func load() {
        guard let e = entry else {
            title = "Fix notes: \(host)"
            bodyText = "# \(host)\n"
            return
        }
        let f = e.decoded(RunbookFields.self)
        title = e.str("title")
        bodyText = e.str("body")
        commands = (f?.commands ?? []).map { CommandDraft(label: $0.label, user: $0.user, host: $0.host, command: $0.command) }
        loadedTitle = title
        loadedBody = bodyText
        loadedCommands = commandsJSON()
        loadedRawCommands = e.fields["commands"] ?? .null
    }

    private func commandsJSON() -> JSONValue {
        .array(commands.compactMap { c in
            let cmd = Homelab.trimmed(c.command)
            guard !cmd.isEmpty else { return nil }
            return .object([
                "label": .string(Homelab.trimmed(c.label)),
                "user": .string(Homelab.trimmed(c.user)),
                "host": .string(Homelab.trimmed(c.host).isEmpty ? host : Homelab.trimmed(c.host)),
                "command": .string(cmd)
            ])
        })
    }

    /// Saving wrote every field from what the sheet opened with, so a section the assistant appended while it was open
    /// was erased. Now only edited fields are written. When the body was edited and the saved body changed since the
    /// sheet opened: text added at the end (a new dated section) is kept after the edit, and any other change refuses
    /// the save, as do commands edited here and elsewhere at once.
    private func save() {
        guard let e = entry else {
            let f: [String: JSONValue] = [
                "host": .string(host),
                "title": .string(Homelab.trimmed(title)),
                "body": .string(bodyText),
                "commands": commandsJSON()
            ]
            Task { _ = await engine.create(kind: .runbook, fields: f) }
            dismiss()
            return
        }
        let live = engine.get(e.id) ?? e
        var f: [String: JSONValue] = [:]
        if Homelab.trimmed(title) != Homelab.trimmed(loadedTitle) { f["title"] = .string(Homelab.trimmed(title)) }
        if bodyText != loadedBody {
            let now = live.str("body")
            if now == loadedBody {
                f["body"] = .string(bodyText)
            } else if now.hasPrefix(loadedBody) {
                let added = String(now.dropFirst(loadedBody.count))
                var merged = bodyText
                if !merged.isEmpty && !merged.hasSuffix("\n") && !added.hasPrefix("\n") { merged += "\n" }
                merged += added
                f["body"] = .string(merged)
            } else {
                conflict = "These fix notes were changed somewhere else while you had them open. Copy your edit, then Cancel and open them again."
                return
            }
        }
        let cmds = commandsJSON()
        if cmds != loadedCommands {
            if (live.fields["commands"] ?? .null) != loadedRawCommands {
                conflict = "The commands were changed somewhere else while you had them open. Cancel and open the fix notes again."
                return
            }
            f["commands"] = cmds
        }
        if !f.isEmpty { Task { _ = await engine.update(e.id, fields: f) } }
        dismiss()
    }
}
