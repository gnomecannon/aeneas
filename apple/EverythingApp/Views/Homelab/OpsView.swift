import SwiftUI
import EACore

/// Homelab ops: one summary line, what is down with Acknowledge, every monitor, incidents, renewals due and recent changes.
/// Monitors and incidents come from the synced store; the hub's `GET /ops` adds 24 h uptime and the 7 day incident count.
struct OpsView: View {
    @EnvironmentObject var engine: SyncEngine
    @EnvironmentObject var model: AppModel
    @State private var board: OpsBoard?
    @State private var boardNote: String?
    @State private var loadedAt: Date?
    @State private var creating = false
    @State private var acking: Entity?
    @State private var editingEntry: Entity?

    private var monitors: [Entity] {
        engine.list(.monitor).sorted { (MonitorStatus($0).rank, $0.str("name").lowercased()) < (MonitorStatus($1).rank, $1.str("name").lowercased()) }
    }
    private var down: [Entity] { monitors.filter { MonitorStatus($0) == .down } }
    private var others: [Entity] { monitors.filter { MonitorStatus($0) != .down } }

    private var openIncidents: [Entity] {
        engine.list(.incident).filter { ($0.string("closed_at") ?? "").isEmpty }.sorted { $0.str("opened_at") > $1.str("opened_at") }
    }
    private var closedThisWeek: [Entity] {
        let cutoff = Date().addingTimeInterval(-7 * 86400)
        return engine.list(.incident).filter { ($0.date("closed_at") ?? .distantPast) >= cutoff }.sorted { $0.str("closed_at") > $1.str("closed_at") }
    }
    private func openIncident(for monitor: Entity) -> Entity? { openIncidents.first { $0.str("monitor_id") == monitor.id } }

    private var uptime: [String: Double] { board?.uptimeByName ?? [:] }

    private var dueSoon: [Entity] {
        let limit = Date().addingTimeInterval(30 * 86400)
        return engine.watches.filter { ($0.date("due") ?? .distantFuture) <= limit }
    }
    private var recentChanges: [Entity] { Array(engine.list(.journal).sorted(by: JournalOrder.newestFirst).prefix(10)) }

    var body: some View {
        List {
            SwiftUI.Section {
                OpsSummary(monitors: monitors, updated: loadedAt ?? engine.lastSync, note: boardNote)
            }

            if !down.isEmpty {
                SwiftUI.Section("Down") {
                    ForEach(down) { m in
                        NavigationLink { MonitorDetailView(id: m.id) } label: {
                            DownRow(monitor: m, incident: openIncident(for: m), onAck: { acking = $0 })
                        }
                    }
                }
            }

            if !others.isEmpty {
                SwiftUI.Section(down.isEmpty ? "Monitors" : "Other monitors") {
                    ForEach(others) { m in
                        NavigationLink { MonitorDetailView(id: m.id) } label: {
                            MonitorRow(monitor: m, uptime: uptime[m.str("name")])
                        }
                        .swipeActions(edge: .trailing) {
                            Button("Check now") { Task { await check(m) } }.tint(.blue)
                        }
                    }
                }
            }

            incidentsSection

            if !dueSoon.isEmpty {
                SwiftUI.Section {
                    ForEach(dueSoon) { w in
                        Button { model.section = .renewals } label: { DueRow(watch: w) }
                            .buttonStyle(.plain)
                    }
                } header: {
                    Text("Due in 30 days")
                }
            }

            SwiftUI.Section {
                if recentChanges.isEmpty {
                    Text("Nothing logged yet.").font(.subheadline).foregroundStyle(.secondary)
                }
                ForEach(recentChanges) { j in
                    Button { editingEntry = j } label: { ChangeRow(entry: j) }.buttonStyle(.plain)
                }
                Button("Open change journal") { model.section = .journal }
            } header: {
                Text("Recent changes")
            }
        }
        .navigationTitle("Ops")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { creating = true } label: { Label("Add monitor", systemImage: "plus") }
            }
        }
        .overlay {
            if monitors.isEmpty {
                ContentUnavailableView {
                    Label("No monitors yet", systemImage: "waveform.path.ecg")
                } description: {
                    Text("Tap Add monitor to have the hub check a host by ping, port, web address, certificate or name lookup.")
                } actions: {
                    Button("Add monitor") { creating = true }.buttonStyle(.borderedProminent)
                }
            }
        }
        .sheet(isPresented: $creating) { MonitorEditor(monitor: nil, host: nil) }
        .sheet(item: $acking) { inc in AckSheet(incident: inc) }
        .sheet(item: $editingEntry) { e in JournalEditor(entry: e) }
        .refreshable { await engine.sync(); await loadBoard() }
        .task {
            while !Task.isCancelled {
                await loadBoard()
                try? await Task.sleep(for: .seconds(30))
            }
        }
    }

    @ViewBuilder
    private var incidentsSection: some View {
        // Open incidents whose monitor is already shown under Down are not repeated here.
        let downIds = Set(down.map(\.id))
        let open = openIncidents.filter { !downIds.contains($0.str("monitor_id")) }
        let count7d = board?.incidents_7d
        SwiftUI.Section {
            if open.isEmpty && closedThisWeek.isEmpty {
                Text("No incidents in 7 days.").font(.subheadline).foregroundStyle(.secondary)
            }
            ForEach(open) { inc in IncidentRow(incident: inc, onAck: { acking = inc }) }
            ForEach(closedThisWeek) { inc in IncidentRow(incident: inc, onAck: nil) }
        } header: {
            HStack {
                Text("Incidents")
                Spacer()
                Text("\(openIncidents.count) open" + (count7d.map { ", \($0) in 7 days" } ?? "")).textCase(nil)
            }
        }
    }

    private func loadBoard() async {
        guard let c = engine.client else {
            boardNote = "Not connected to the hub. Showing what is synced."
            return
        }
        do {
            board = try await c.opsBoard()
            loadedAt = Date()
            boardNote = nil
        } catch HubError.http(let status, _) where status == 404 {
            boardNote = "This hub has no uptime data."
        } catch {
            boardNote = "Could not reach the hub. Showing what is synced."
        }
    }

    private func check(_ m: Entity) async {
        guard let c = engine.client, let e = try? await c.checkMonitor(id: m.id) else { return }
        await engine.absorb(e)
    }
}

// MARK: Rows

/// The one line that says whether everything is fine: "All 12 up", "2 down", with the rest beside it.
struct OpsSummary: View {
    var monitors: [Entity]
    var updated: Date?
    var note: String?

    var body: some View {
        let states = monitors.map(MonitorStatus.init).filter { $0 != .off }
        let up = states.filter { $0 == .up }.count
        let down = states.filter { $0 == .down }.count
        let unknown = states.filter { $0 == .unknown }.count
        let (label, detail, status): (String, String, MonitorStatus) = {
            if states.isEmpty { return ("No monitors", "", .off) }
            let parts = [(up, "up"), (unknown, "unknown")].filter { $0.0 > 0 }.map { "\($0.0) \($0.1)" }.joined(separator: ", ")
            if down > 0 { return ("\(down) down", parts, .down) }
            if unknown > 0 { return ("\(unknown) unknown", up > 0 ? "\(up) up" : "", .unknown) }
            return ("All \(up) up", "", .up)
        }()
        let off = monitors.count - states.count
        HStack(spacing: 14) {
            Image(systemName: status.symbol)
                .font(.system(size: 34))
                .foregroundStyle(status.color)
            VStack(alignment: .leading, spacing: 3) {
                Text(label).font(.title2.weight(.bold)).foregroundStyle(status == .off ? Color.primary : status.color)
                let extra = [detail, off > 0 ? "\(off) off" : ""].filter { !$0.isEmpty }.joined(separator: ", ")
                if !extra.isEmpty { Text(extra).font(.subheadline) }
                if let note { Text(note).font(.caption).foregroundStyle(.secondary) }
                else if let updated { Text("Updated \(Homelab.ago(updated))").font(.caption).foregroundStyle(.secondary) }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
    }
}

struct MonitorRow: View {
    var monitor: Entity
    var uptime: Double?

    var body: some View {
        let status = MonitorStatus(monitor)
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(StyleGuard.dashes(monitor.str("name"))).font(.body.weight(.medium))
                Text("\(monitor.str("type")) \(monitor.str("target"))").font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1)
                Text(MonitorText.stats(monitor, uptime: uptime)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                if let d = monitor.string("last_detail"), !d.isEmpty { Text(d).font(.caption).lineLimit(2) }
            }
            Spacer(minLength: 6)
            MonitorStatusPill(status: status)
        }
        .padding(.vertical, 2)
    }
}

/// A down monitor with its error, how long it has been down, and Acknowledge.
struct DownRow: View {
    var monitor: Entity
    var incident: Entity?
    var onAck: (Entity) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(StyleGuard.dashes(monitor.str("name"))).font(.body.weight(.semibold))
                Spacer(minLength: 6)
                MonitorStatusPill(status: .down)
            }
            Text("\(monitor.str("type")) \(monitor.str("target"))").font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1)
            let err = incident?.string("last_error") ?? monitor.string("last_error")
            if let err, !err.isEmpty { Text(err).font(.subheadline).foregroundStyle(.red).lineLimit(3) }
            if let d = monitor.string("last_detail"), !d.isEmpty, !(err ?? "").contains(d) { Text(d).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
            if let inc = incident {
                Text(MonitorText.downFor(inc)).font(.caption).foregroundStyle(.secondary)
                if let ack = inc.string("acknowledged_at") {
                    Text(MonitorText.acked(ack, note: inc.string("ack_note"))).font(.caption)
                } else {
                    Button("Acknowledge") { onAck(inc) }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                }
            }
        }
        .padding(.vertical, 4)
    }
}

struct IncidentRow: View {
    var incident: Entity
    var onAck: (() -> Void)?

    var body: some View {
        let open = (incident.string("closed_at") ?? "").isEmpty
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(StyleGuard.dashes(incident.str("name"))).font(.body.weight(.medium))
                Spacer(minLength: 6)
                HomelabPill(text: open ? "Open" : "Closed", symbol: open ? "exclamationmark.circle.fill" : "checkmark.circle", color: open ? .red : .green)
            }
            if let err = incident.string("last_error"), !err.isEmpty {
                Text(err).font(.caption).foregroundStyle(open ? Color.red : Color.secondary).lineLimit(2)
            }
            Text(MonitorText.incidentTimes(incident)).font(.caption).foregroundStyle(.secondary)
            if let ack = incident.string("acknowledged_at") {
                Text(MonitorText.acked(ack, note: incident.string("ack_note"))).font(.caption)
            } else if open, let onAck {
                Button("Acknowledge", action: onAck).buttonStyle(.borderedProminent).controlSize(.small)
            } else {
                Text("Not acknowledged").font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }
}

private struct DueRow: View {
    var watch: Entity
    var body: some View {
        let due = watch.date("due")
        let overdue = (due ?? .distantFuture) < Date()
        HStack {
            Text(StyleGuard.dashes(watch.str("title"))).lineLimit(2)
            Spacer(minLength: 6)
            VStack(alignment: .trailing, spacing: 2) {
                Text(overdue ? "Overdue" : "Due \(Homelab.ago(due))").font(.caption.weight(.semibold)).foregroundStyle(overdue ? Color.red : Color.secondary)
                if let due { Text(due.formatted(date: .abbreviated, time: .omitted)).font(.caption2).foregroundStyle(.secondary) }
            }
        }
        .contentShape(Rectangle())
    }
}

private struct ChangeRow: View {
    var entry: Entity
    var body: some View {
        let risk = JournalRisk(rawValue: entry.str("risk")) ?? .low
        VStack(alignment: .leading, spacing: 2) {
            Text(StyleGuard.dashes(entry.str("what"))).lineLimit(2)
            HStack(spacing: 6) {
                Text(entry.str("host")).monospaced()
                Text(risk.label).foregroundStyle(risk.color)
                Text(Homelab.ago(entry.string("at")))
            }
            .font(.caption).foregroundStyle(.secondary)
        }
        .contentShape(Rectangle())
    }
}

enum MonitorText {
    static func stats(_ m: Entity, uptime: Double?) -> String {
        var parts: [String] = []
        if MonitorStatus(m) == .off { parts.append("not checked while off") }
        else {
            if let ms = m.number("last_latency_ms"), MonitorStatus(m) != .down { parts.append("\(Int(ms.rounded())) ms") }
            parts.append(m.string("last_check").map { "checked \(Homelab.ago($0))" } ?? "never checked")
        }
        if let u = uptime { parts.append("\(JSONValue.number(u).displayString)% in 24 h") }
        return parts.joined(separator: ", ")
    }

    static func downFor(_ inc: Entity) -> String {
        let opened = inc.date("opened_at") ?? Date()
        let fails = Int(inc.number("checks_failed") ?? 0)
        return "Down \(Homelab.duration(Date().timeIntervalSince(opened))), \(fails) check\(fails == 1 ? "" : "s") failed"
    }

    static func incidentTimes(_ inc: Entity) -> String {
        let opened = inc.date("opened_at")
        let closed = inc.date("closed_at")
        let fails = Int(inc.number("checks_failed") ?? 0)
        var parts = ["opened \(opened?.shortDateTime ?? "")"]
        if let closed, let opened { parts.append("lasted \(Homelab.duration(closed.timeIntervalSince(opened)))") }
        else if let opened { parts.append("down \(Homelab.duration(Date().timeIntervalSince(opened)))") }
        parts.append("\(fails) check\(fails == 1 ? "" : "s") failed")
        return parts.joined(separator: ", ")
    }

    static func acked(_ at: String, note: String?) -> String {
        let n = note.map(Homelab.trimmed) ?? ""
        return "Acknowledged \(Homelab.ago(at))" + (n.isEmpty ? "" : ": \(StyleGuard.dashes(n))")
    }

    static let targetHint: [String: String] = [
        "ping": "192.168.1.20",
        "tcp": "192.168.1.20:22",
        "http": "http://127.0.0.1:8787/health",
        "tls": "https://core.example.ts.net:8787",
        "dns": "core.example.ts.net",
        "backup": "mac:laptop or windows:desktop#verify"
    ]
}

// MARK: Acknowledge

struct AckSheet: View {
    @EnvironmentObject var engine: SyncEngine
    @Environment(\.dismiss) private var dismiss
    var incident: Entity
    @State private var note = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                SwiftUI.Section {
                    Text(StyleGuard.dashes(incident.str("name"))).font(.headline)
                    if let err = incident.string("last_error"), !err.isEmpty { Text(err).foregroundStyle(.red) }
                    Text(MonitorText.downFor(incident)).font(.subheadline).foregroundStyle(.secondary)
                }
                SwiftUI.Section {
                    TextField("Note", text: $note, prompt: Text("What did you do? Optional"), axis: .vertical)
                        .lineLimit(1...4)
                        .onSubmit { Task { await ack() } }
                } footer: {
                    Text("With a note, this also goes into the change journal.")
                }
                SwiftUI.Section {
                    Button {
                        Task { await ack() }
                    } label: {
                        HStack {
                            Spacer()
                            if busy { ProgressView().controlSize(.small) }
                            Text("Acknowledge").font(.body.weight(.semibold))
                            Spacer()
                        }
                        .frame(minHeight: 36)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(busy || engine.client == nil)
                    if engine.client == nil {
                        Text("Acknowledging needs the hub. Set it up in Settings.").font(.subheadline).foregroundStyle(.secondary)
                    }
                    if let error { Text(error).font(.subheadline).foregroundStyle(.red) }
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Acknowledge")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
        #if os(macOS)
        .frame(minWidth: 420, minHeight: 360)
        #endif
    }

    private func ack() async {
        guard let c = engine.client, !busy else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            let updated = try await c.acknowledgeIncident(id: incident.id, note: note)
            await engine.absorb(updated)
            Task { await engine.sync() }
            dismiss()
        } catch {
            self.error = Homelab.errorText(error)
        }
    }
}

// MARK: Monitor detail

struct MonitorDetailView: View {
    @EnvironmentObject var engine: SyncEngine
    var id: String
    @State private var history: [MonitorCheck]?
    @State private var historyError: String?
    @State private var checking = false
    @State private var checkError: String?
    @State private var editing = false
    @State private var acking: Entity?

    var body: some View {
        if let m = engine.get(id), !m.isDeleted {
            content(m)
        } else {
            ContentUnavailableView("Monitor deleted", systemImage: "trash", description: Text("Go back to Ops."))
        }
    }

    @ViewBuilder
    private func content(_ m: Entity) -> some View {
        let status = MonitorStatus(m)
        let incident = engine.list(.incident).first { $0.str("monitor_id") == m.id && ($0.string("closed_at") ?? "").isEmpty }
        List {
            SwiftUI.Section {
                HStack(spacing: 12) {
                    Image(systemName: status.symbol).font(.system(size: 30)).foregroundStyle(status.color)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(status.label).font(.title2.weight(.bold)).foregroundStyle(status == .off ? Color.primary : status.color)
                        Text("\(m.str("type")) \(m.str("target"))").font(.callout.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                    }
                }
                .accessibilityElement(children: .combine)
                Button {
                    Task { await check(m) }
                } label: {
                    HStack {
                        Spacer()
                        if checking { ProgressView().controlSize(.small) }
                        Text(checking ? "Checking" : "Check now").font(.body.weight(.semibold))
                        Spacer()
                    }
                    .frame(minHeight: 32)
                }
                .buttonStyle(.borderedProminent)
                .disabled(checking || engine.client == nil)
                if engine.client == nil { Text("Checking needs the hub.").font(.caption).foregroundStyle(.secondary) }
                if let checkError { Text(checkError).font(.subheadline).foregroundStyle(.red) }
            }

            if let inc = incident {
                SwiftUI.Section("Incident") {
                    IncidentRow(incident: inc, onAck: { acking = inc })
                }
            }

            SwiftUI.Section("Last check") {
                LabeledContent("Checked", value: m.string("last_check").map { Homelab.ago($0) } ?? "Never")
                if let ms = m.number("last_latency_ms") { LabeledContent("Latency", value: "\(Int(ms.rounded())) ms") }
                if let d = m.string("last_detail"), !d.isEmpty, !(m.string("last_error") ?? "").contains(d) { Text(d).font(.subheadline).textSelection(.enabled) }
                LabeledContent("Last OK", value: m.string("last_ok").map { Homelab.ago($0) } ?? "Never")
                if let n = m.number("consecutive_fails"), n > 0 { LabeledContent("Failed in a row", value: "\(Int(n))") }
                if let err = m.string("last_error"), !err.isEmpty {
                    Text(err).font(.subheadline).foregroundStyle(status == .down ? Color.red : Color.secondary).textSelection(.enabled)
                }
            }

            SwiftUI.Section("Last 24 h") {
                if let historyError {
                    Text(historyError).font(.subheadline).foregroundStyle(.secondary)
                } else if let rows = history {
                    let fails = rows.filter { !$0.ok }.count
                    Text("\(rows.count) checks, \(fails) failed").font(.subheadline)
                    if rows.isEmpty {
                        Text("No checks in 24 h.").font(.caption).foregroundStyle(.secondary)
                    } else {
                        UptimeStrip(rows: rows)
                    }
                    let errors = MonitorHistory.lastErrors(rows)
                    if !errors.isEmpty {
                        ForEach(errors, id: \.at) { r in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(r.error ?? "Failed").font(.caption).foregroundStyle(.red)
                                Text(ISO.date(r.at)?.shortDateTime ?? r.at).font(.caption2).foregroundStyle(.secondary)
                            }
                        }
                    }
                } else {
                    HStack { ProgressView().controlSize(.small); Text("Loading").foregroundStyle(.secondary) }
                }
            }

            SwiftUI.Section("Settings") {
                if let h = m.string("host"), !h.isEmpty {
                    NavigationLink { HostDetailView(host: h) } label: {
                        LabeledContent("Host", value: h)
                    }
                }
                if let e = m.string("expect"), !e.isEmpty { LabeledContent("Expect", value: e) }
                LabeledContent("Every", value: "\(Int(m.number("interval_s") ?? 60)) s")
                LabeledContent("Timeout", value: "\(Int(m.number("timeout_s") ?? 5)) s")
                LabeledContent("Down after", value: "\(Int(m.number("fails_before_down") ?? 3)) failed checks")
            }
        }
        .navigationTitle(StyleGuard.dashes(m.str("name")))
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar { ToolbarItem(placement: .primaryAction) { Button("Edit") { editing = true } } }
        .sheet(isPresented: $editing) { MonitorEditor(monitor: m, host: nil) }
        .sheet(item: $acking) { inc in AckSheet(incident: inc) }
        .task(id: m.string("last_check")) { await loadHistory() }
        .refreshable { await engine.sync(); await loadHistory() }
    }

    private func loadHistory() async {
        guard let c = engine.client else { historyError = "History needs the hub."; return }
        do {
            history = try await c.monitorHistory(id: id, hours: 24)
            historyError = nil
        } catch {
            historyError = Homelab.errorText(error)
        }
    }

    private func check(_ m: Entity) async {
        guard let c = engine.client else { return }
        checking = true
        checkError = nil
        defer { checking = false }
        do {
            let e = try await c.checkMonitor(id: m.id)
            await engine.absorb(e)
            await loadHistory()
        } catch {
            checkError = Homelab.errorText(error)
        }
    }
}

enum MonitorHistory {
    struct Cell { var ok: Bool?; var checks: Int; var fails: Int }

    /// One cell per check when there are 144 or fewer in the window; otherwise 144 equal slices,
    /// red when any check in the slice failed, empty when nothing was checked.
    static func cells(_ rows: [MonitorCheck], hours: Double = 24, now: Date = Date(), maxCells: Int = 144) -> [Cell] {
        let end = now.timeIntervalSince1970, start = end - hours * 3600
        let checks = rows.compactMap { r -> (t: Double, ok: Bool)? in
            guard let d = ISO.date(r.at)?.timeIntervalSince1970, d >= start, d <= end else { return nil }
            return (d, r.ok)
        }.sorted { $0.t < $1.t }
        if checks.count <= maxCells { return checks.map { Cell(ok: $0.ok, checks: 1, fails: $0.ok ? 0 : 1) } }
        var cells = Array(repeating: Cell(ok: nil, checks: 0, fails: 0), count: maxCells)
        let width = (end - start) / Double(maxCells)
        for c in checks {
            let i = min(maxCells - 1, Int((c.t - start) / width))
            cells[i].checks += 1
            if !c.ok { cells[i].fails += 1 }
            cells[i].ok = cells[i].fails == 0
        }
        return cells
    }

    /// The last failed checks, newest first, each error once.
    static func lastErrors(_ rows: [MonitorCheck], limit: Int = 5) -> [MonitorCheck] {
        var out: [MonitorCheck] = []
        var seen = Set<String>()
        for r in rows.sorted(by: { $0.at > $1.at }) where !r.ok {
            let key = r.error ?? ""
            if seen.contains(key) { continue }
            seen.insert(key)
            out.append(r)
            if out.count >= limit { break }
        }
        return out
    }
}

/// The 24 h strip: green cells passed, red cells failed, grey cells had no check.
struct UptimeStrip: View {
    var rows: [MonitorCheck]

    var body: some View {
        let cells = MonitorHistory.cells(rows)
        let fails = rows.filter { !$0.ok }.count
        VStack(spacing: 4) {
            Canvas { ctx, size in
                guard !cells.isEmpty else { return }
                let w = size.width / CGFloat(cells.count)
                let gap: CGFloat = w > 3 ? 1 : 0
                for (i, c) in cells.enumerated() {
                    let rect = CGRect(x: CGFloat(i) * w, y: 0, width: max(1, w - gap), height: size.height)
                    let color: Color = c.ok == nil ? .gray.opacity(0.25) : (c.ok! ? .green : .red)
                    ctx.fill(Path(roundedRect: rect, cornerRadius: min(2, w / 3)), with: .color(color))
                }
            }
            .frame(height: 26)
            HStack {
                Text("24 h ago")
                Spacer()
                Text("Now")
            }
            .font(.caption2).foregroundStyle(.secondary)
        }
        .accessibilityElement()
        .accessibilityLabel("\(rows.count) checks in 24 hours, \(fails) failed")
    }
}

// MARK: Monitor editor

struct MonitorEditor: View {
    @EnvironmentObject var engine: SyncEngine
    @Environment(\.dismiss) private var dismiss
    var monitor: Entity?
    var host: String?

    private static let types = ["ping", "tcp", "http", "tls", "dns", "backup"]

    @State private var name = ""
    @State private var hostText = ""
    @State private var type = "ping"
    @State private var target = ""
    @State private var expect = ""
    @State private var interval = 60
    @State private var timeout = 5
    @State private var failsBeforeDown = 3
    @State private var enabled = true
    @State private var confirmDelete = false

    private var valid: Bool { !Homelab.trimmed(name).isEmpty && !Homelab.trimmed(target).isEmpty }

    var body: some View {
        NavigationStack {
            Form {
                SwiftUI.Section {
                    TextField("Name", text: $name, prompt: Text("Name, for example storage ping"))
                    HostField(host: $hostText, hosts: Homelab.knownHosts(engine), prompt: "Host, optional")
                }
                SwiftUI.Section {
                    Picker("Type", selection: $type) { ForEach(Self.types, id: \.self) { Text($0).tag($0) } }
                        .pickerStyle(.segmented)
                    TextField("Target", text: $target, prompt: Text(MonitorText.targetHint[type] ?? ""))
                        .font(.callout.monospaced())
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        .keyboardType(type == "http" || type == "tls" ? .URL : .default)
                        #endif
                    if type == "http" || type == "dns" || type == "backup" {
                        TextField("Expect", text: $expect, prompt: Text(type == "http" ? "Status code or body text, optional" : type == "backup" ? "Most hours since the last good run, default 28" : "Expected address, optional"))
                            .autocorrectionDisabled()
                            #if os(iOS)
                            .textInputAutocapitalization(.never)
                            #endif
                    }
                } footer: {
                    Text(typeHelp)
                }
                SwiftUI.Section {
                    Stepper("Check every \(interval) s", value: $interval, in: 10...3600, step: 10)
                    Stepper("Timeout \(timeout) s", value: $timeout, in: 1...60)
                    Stepper("Down after \(failsBeforeDown) failed check\(failsBeforeDown == 1 ? "" : "s")", value: $failsBeforeDown, in: 1...20)
                    Toggle("On", isOn: $enabled)
                }
                if monitor != nil {
                    SwiftUI.Section { Button("Delete monitor", role: .destructive) { confirmDelete = true } }
                }
            }
            .formStyle(.grouped)
            .navigationTitle(monitor == nil ? "New monitor" : "Edit monitor")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { save() }.disabled(!valid) }
            }
            .confirmationDialog("Delete this monitor?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete", role: .destructive) {
                    if let m = monitor { Task { await engine.softDelete(m.id) } }
                    dismiss()
                }
            } message: {
                Text("The hub stops checking it. Past incidents stay.")
            }
            .onAppear(perform: load)
        }
        #if os(macOS)
        .frame(minWidth: 480, minHeight: 540)
        #endif
    }

    private var typeHelp: String {
        switch type {
        case "ping": return "One ping to a host name or IP address."
        case "tcp": return "Connects to host:port."
        case "http": return "Fetches the URL. OK on 2xx or 3xx, or when it matches Expect."
        case "tls": return "Checks the certificate is valid for more than 14 days."
        case "backup": return "Reads a ProjectBackup job over ssh from the hub: mac:, windows: or linux: then the ssh destination, with #verify or #restore for those jobs. OK when the latest run succeeded and the last good one is recent."
        default: return "Looks up the name. OK when any address comes back, or the expected one."
        }
    }

    private func load() {
        guard let m = monitor else { hostText = host ?? ""; return }
        name = m.str("name")
        hostText = m.str("host")
        type = Self.types.contains(m.str("type")) ? m.str("type") : "ping"
        target = m.str("target")
        expect = m.str("expect")
        interval = Int(m.number("interval_s") ?? 60)
        timeout = Int(m.number("timeout_s") ?? 5)
        failsBeforeDown = Int(m.number("fails_before_down") ?? 3)
        enabled = m.bool("enabled") ?? true
    }

    private func save() {
        let h = Homelab.trimmed(hostText), ex = Homelab.trimmed(expect)
        var f: [String: JSONValue] = [
            "name": .string(Homelab.trimmed(name)),
            "type": .string(type),
            "target": .string(Homelab.trimmed(target)),
            "interval_s": .number(Double(interval)),
            "timeout_s": .number(Double(timeout)),
            "fails_before_down": .number(Double(failsBeforeDown)),
            "enabled": .bool(enabled)
        ]
        f["host"] = h.isEmpty ? .null : .string(h)
        f["expect"] = ex.isEmpty || !(type == "http" || type == "dns" || type == "backup") ? .null : .string(ex)
        Task {
            if let m = monitor { _ = await engine.update(m.id, fields: f) }
            else { _ = await engine.create(kind: .monitor, fields: f.filter { !$0.value.isNull }) }
        }
        dismiss()
    }
}
