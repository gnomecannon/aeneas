import SwiftUI
import EACore

/// The hub's ops board (`GET /ops`), one copy for every Ops screen: a second Ops window, or Ops opened again, reads
/// the copy loaded in the last 25 s instead of asking the hub again.
@MainActor
final class OpsBoardFeed: ObservableObject {
    static let shared = OpsBoardFeed()
    @Published private(set) var board: OpsBoard?
    @Published private(set) var loadedAt: Date?
    @Published private(set) var note: String?
    /// The hub the board came from: after a switch to another hub, its board is not shown.
    private var hub = ""
    private var triedAt: Date?
    private var loading: Task<Void, Never>?

    /// Loads the board unless it was asked for less than `maxAge` seconds ago; a load already running is waited for.
    func load(_ engine: SyncEngine, maxAge: TimeInterval = 0) async {
        if let loading { await loading.value; return }
        if engine.config.hubURL != hub { board = nil; loadedAt = nil; note = nil; triedAt = nil }
        if maxAge > 0, let triedAt, Date().timeIntervalSince(triedAt) < maxAge { return }
        let task = Task { await self.fetch(engine) }
        loading = task
        await task.value
        loading = nil
    }

    private func fetch(_ engine: SyncEngine) async {
        triedAt = Date()
        hub = engine.config.hubURL
        guard let c = engine.client else {
            note = "Not connected to the hub. Showing what is synced."
            return
        }
        do {
            let b = try await c.opsBoard()
            board = b
            loadedAt = Date()
            note = nil
            // Each check's own fields (when it ran, a backup's job lines) and an open incident's latest error and
            // failed count are written on the hub without a sync change, so the board's copies are the fresh ones.
            // All of them in one go: one at a time, each monitor was a write and a redraw of every screen.
            await engine.absorb(b.monitors.map(\.entity) + b.incidents_open)
        } catch HubError.http(let status, _) where status == 404 {
            note = "This hub has no uptime data."
        } catch {
            note = "Could not reach the hub. Showing what is synced."
        }
    }
}

/// What went wrong with a hand check of one monitor, shown on its row until a newer check is in.
struct CheckFailure {
    var text: String
    var lastCheck: String?
}

/// Homelab ops: one summary line, what is down with Acknowledge, every monitor, incidents, renewals due and recent changes.
/// Monitors and incidents come from the synced store; the hub's `GET /ops` adds 24 h uptime and the 7 day incident count.
struct OpsView: View {
    @EnvironmentObject var engine: SyncEngine
    @EnvironmentObject var model: AppModel
    @ObservedObject private var feed = OpsBoardFeed.shared
    @Environment(\.scenePhase) private var scenePhase
    @State private var creating = false
    @State private var acking: Entity?
    @State private var editingEntry: Entity?
    /// Monitors being checked by hand right now, and what went wrong with a hand check.
    @State private var checking: Set<String> = []
    @State private var checkFailures: [String: CheckFailure] = [:]

    private var board: OpsBoard? { feed.board }

    private var monitors: [Entity] {
        engine.list(.monitor).sorted { (MonitorStatus($0).rank, $0.str("name").lowercased()) < (MonitorStatus($1).rank, $1.str("name").lowercased()) }
    }
    private var down: [Entity] { monitors.filter { MonitorStatus($0) == .down } }
    /// What is not down: the checks, and the backup machines in a section of their own.
    private var others: [Entity] { monitors.filter { MonitorStatus($0) != .down && $0.str("type") != "backup" } }
    private var backups: [Entity] { monitors.filter { MonitorStatus($0) != .down && $0.str("type") == "backup" } }

    private var openIncidents: [Entity] {
        engine.list(.incident).filter { ($0.string("closed_at") ?? "").isEmpty }.sorted { $0.str("opened_at") > $1.str("opened_at") }
    }
    private var closedThisWeek: [Entity] {
        let cutoff = Date().addingTimeInterval(-7 * 86400)
        return engine.list(.incident).filter { ($0.date("closed_at") ?? .distantPast) >= cutoff }.sorted { $0.str("closed_at") > $1.str("closed_at") }
    }
    private func openIncident(for monitor: Entity) -> Entity? { MonitorText.openIncident(for: monitor, in: openIncidents) }

    private var uptime: [String: Double] { board?.uptimeByName ?? [:] }

    private var dueSoon: [Entity] {
        let limit = Date().addingTimeInterval(30 * 86400)
        return engine.watches.filter { ($0.date("due") ?? .distantFuture) <= limit }
    }
    private var recentChanges: [Entity] { Array(engine.list(.journal).sorted(by: JournalOrder.newestFirst).prefix(10)) }

    var body: some View {
        List {
            SwiftUI.Section {
                OpsSummary(monitors: monitors, hubBackup: board?.hub_backup ?? [], updated: feed.loadedAt ?? engine.lastSync, note: feed.note)
            }

            // A section of the list, not an overlay: the summary, incidents and recent changes below stay readable.
            if monitors.isEmpty {
                SwiftUI.Section {
                    ContentUnavailableView {
                        Label("No monitors yet", systemImage: "waveform.path.ecg")
                    } description: {
                        Text("Tap Add monitor to have the hub check a host by ping, port, web address, certificate or name lookup.")
                    } actions: {
                        Button("Add monitor") { creating = true }.buttonStyle(.borderedProminent)
                    }
                }
            }

            if !down.isEmpty {
                SwiftUI.Section("Down") {
                    ForEach(down) { m in
                        NavigationLink { MonitorDetailView(id: m.id) } label: {
                            DownRow(monitor: m, incident: openIncident(for: m), checking: checking.contains(m.id), checkError: failure(m), onAck: { acking = $0 })
                        }
                        .modifier(CheckNowActions(busy: checking.contains(m.id)) { Task { await check(m) } })
                    }
                }
            }

            if !others.isEmpty {
                SwiftUI.Section(down.isEmpty ? "Monitors" : "Other monitors") {
                    ForEach(others) { m in
                        NavigationLink { MonitorDetailView(id: m.id) } label: {
                            MonitorRow(monitor: m, uptime: uptime[m.str("name")], checking: checking.contains(m.id), checkError: failure(m))
                        }
                        .modifier(CheckNowActions(busy: checking.contains(m.id)) { Task { await check(m) } })
                    }
                }
            }

            let hubBackup = board?.hub_backup ?? []
            if !backups.isEmpty || !hubBackup.isEmpty {
                SwiftUI.Section {
                    if !hubBackup.isEmpty { HubBackupRow(lines: hubBackup) }
                    ForEach(backups) { m in
                        NavigationLink { MonitorDetailView(id: m.id) } label: {
                            MonitorRow(monitor: m, uptime: nil, checking: checking.contains(m.id), checkError: failure(m))
                        }
                        .modifier(CheckNowActions(busy: checking.contains(m.id)) { Task { await check(m) } })
                    }
                } header: {
                    Text("Backups")
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
        .sheet(isPresented: $creating) { MonitorEditor(monitor: nil, host: nil) }
        .sheet(item: $acking) { inc in AckSheet(incident: inc) }
        .sheet(item: $editingEntry) { e in JournalEditor(entry: e) }
        .refreshable { await engine.sync(); await feed.load(engine) }
        // Every 30 s while the window can be seen; a minimized window or the app put away stops asking the hub.
        .task(id: scenePhase.refreshes) {
            guard scenePhase.refreshes else { return }
            while !Task.isCancelled {
                await feed.load(engine, maxAge: 25)
                try? await Task.sleep(for: .seconds(30))
            }
        }
    }

    @ViewBuilder
    private var incidentsSection: some View {
        // Open incidents whose monitor is already shown under Down are not repeated here.
        let downIds = Set(down.map(\.id))
        let open = openIncidents.filter { !downIds.contains($0.str("monitor_id")) }
        let underDown = openIncidents.count - open.count
        let count7d = board?.incidents_7d
        SwiftUI.Section {
            if openIncidents.isEmpty && closedThisWeek.isEmpty {
                Text("No incidents in 7 days.").font(.subheadline).foregroundStyle(.secondary)
            } else if underDown > 0 {
                // The header counts every open incident; this says where the ones not listed here are.
                Text(open.isEmpty ? "The open one\(underDown == 1 ? " is" : "s are") under Down." : "\(underDown) more open under Down.")
                    .font(.subheadline).foregroundStyle(.secondary)
            }
            ForEach(open) { inc in IncidentRow(incident: inc, onAck: { acking = inc }) }
            ForEach(closedThisWeek) { inc in IncidentRow(incident: inc, onAck: nil) }
        } header: {
            HStack {
                Text("Incidents")
                Spacer()
                Text("\(openIncidents.count) open" + (count7d.map { ", \($0) opened in 7 days" } ?? "")).textCase(nil)
            }
        }
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
}

/// Check now on a monitor row: swiped on the iPhone and iPad, from the right-click menu on the Mac.
struct CheckNowActions: ViewModifier {
    var busy: Bool
    var action: () -> Void

    func body(content: Content) -> some View {
        content
            .swipeActions(edge: .trailing) {
                Button("Check now", action: action).tint(.blue).disabled(busy)
            }
            .contextMenu {
                Button("Check now", systemImage: "arrow.clockwise", action: action).disabled(busy)
            }
    }
}

/// "Checking" while a hand check runs, then its error if it failed.
struct CheckProgress: View {
    var checking: Bool
    var error: String?

    var body: some View {
        if checking {
            HStack(spacing: 6) {
                ProgressView().controlSize(.small)
                Text("Checking").font(.caption).foregroundStyle(.secondary)
            }
        } else if let error {
            Text(error).font(.caption).foregroundStyle(.red).lineLimit(3)
        }
    }
}

// MARK: Rows

/// The one line that says whether everything is fine: "All 12 up", "2 down", with the rest beside it.
struct OpsSummary: View {
    var monitors: [Entity]
    /// This hub's own backup lines: a row under Backups, so it counts like a monitor (it said "All up" over a red row).
    var hubBackup: [HubBackupLine] = []
    var updated: Date?
    var note: String?

    private var states: [MonitorStatus] {
        var s = monitors.map(MonitorStatus.init).filter { $0 != .off }
        if !hubBackup.isEmpty { s.append(hubBackup.allSatisfy(\.ok) ? .up : .down) }
        return s
    }

    var body: some View {
        let states = self.states
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
        let off = monitors.filter { MonitorStatus($0) == .off }.count
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
    var checking = false
    var checkError: String?

    var body: some View {
        let status = MonitorStatus(monitor)
        let jobs = BackupJobLine.lines(monitor)
        let away = MonitorText.away(monitor)
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(StyleGuard.dashes(monitor.str("name"))).font(.body.weight(.medium))
                if !jobs.isEmpty {
                    BackupJobsList(lines: jobs)
                    if let note = MonitorText.backupNote(monitor, jobs: jobs) {
                        Text(note).font(.caption).foregroundStyle(away ? Color.orange : status == .down ? Color.red : Color.secondary).lineLimit(3)
                    }
                    Text(MonitorText.checked(monitor)).font(.caption2).foregroundStyle(.secondary)
                } else {
                    let err = MonitorText.error(monitor)
                    Text("\(monitor.str("type")) \(monitor.str("target"))").font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1)
                    Text(MonitorText.stats(monitor, uptime: uptime)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    if let d = monitor.string("last_detail"), !d.isEmpty, !(err ?? "").contains(d) { Text(d).font(.caption).lineLimit(2) }
                    // The last check's error: a check that failed short of down, or a hand check of one that is off.
                    if let err { Text(StyleGuard.dashes(err)).font(.caption).foregroundStyle(status == .down ? Color.red : Color.secondary).lineLimit(2) }
                }
                CheckProgress(checking: checking, error: checkError)
            }
            Spacer(minLength: 6)
            if away {
                HomelabPill(text: "Away", symbol: "moon.zzz", color: .gray)
            } else {
                MonitorStatusPill(status: status)
            }
        }
        .padding(.vertical, 2)
    }
}

/// The hub's own data on Ops: its nightly copy, a second folder, the copy to storage and the live copy, a line each.
struct HubBackupRow: View {
    var lines: [HubBackupLine]

    var body: some View {
        let bad = lines.contains { !$0.ok }
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text("This hub").font(.body.weight(.medium))
                ForEach(lines) { l in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Image(systemName: l.ok ? MonitorStatus.up.symbol : MonitorStatus.down.symbol)
                            .foregroundStyle(l.ok ? Color.green : Color.red)
                        Text(l.label).fontWeight(.semibold).frame(minWidth: 86, alignment: .leading)
                        Text(Self.text(l)).foregroundStyle(l.ok ? Color.secondary : Color.red).fixedSize(horizontal: false, vertical: true)
                    }
                    .font(.caption)
                    .accessibilityElement(children: .combine)
                }
            }
            Spacer(minLength: 6)
            MonitorStatusPill(status: bad ? .down : .up)
        }
        .padding(.vertical, 2)
    }

    /// "last 11 h ago; 30 kept, encrypted", "running".
    static func text(_ l: HubBackupLine) -> String {
        let parts = [l.at.map { "last \(Homelab.ago($0))" } ?? "", l.text].filter { !$0.isEmpty }
        return parts.isEmpty ? (l.ok ? "fine" : "not fine") : parts.joined(separator: "; ")
    }
}

/// A down monitor with its error, how long it has been down, and Acknowledge.
struct DownRow: View {
    var monitor: Entity
    var incident: Entity?
    var checking = false
    var checkError: String?
    var onAck: (Entity) -> Void

    var body: some View {
        let name = monitor.str("name")
        // Down with its machine (`joined_incident`): the incident is the machine's, acknowledged on the machine's own row.
        let joined = incident.map { $0.str("monitor_id") != monitor.id } ?? false
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(StyleGuard.dashes(name)).font(.body.weight(.semibold))
                Spacer(minLength: 6)
                MonitorStatusPill(status: .down)
            }
            let jobs = BackupJobLine.lines(monitor)
            if jobs.isEmpty {
                // The monitor's own error is the latest; the incident's is from when it opened, or the last board load.
                // A machine's incident has the machine's error, never this monitor's.
                let err = MonitorText.error(monitor) ?? (joined ? nil : incident?.string("last_error"))
                Text("\(monitor.str("type")) \(monitor.str("target"))").font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1)
                if let err, !err.isEmpty { Text(StyleGuard.dashes(err)).font(.subheadline).foregroundStyle(.red).lineLimit(3) }
                if let d = monitor.string("last_detail"), !d.isEmpty, !(err ?? "").contains(d) { Text(d).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
            } else {
                BackupJobsList(lines: jobs)
                // A failing job line already says what is wrong; otherwise the error does (ssh refused, away too long).
                if let note = MonitorText.backupNote(monitor, jobs: jobs) { Text(note).font(.subheadline).foregroundStyle(.red).lineLimit(3) }
            }
            if let inc = incident {
                if joined {
                    // The machine's own row lists what went down with it; this row says only which machine.
                    Text("Down with \(StyleGuard.dashes(inc.str("name"))): its machine stopped answering.").font(.caption)
                } else {
                    if let also = MonitorText.alsoDown(inc, except: name) { Text(also).font(.caption) }
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
            CheckProgress(checking: checking, error: checkError)
        }
        .padding(.vertical, 4)
    }
}

struct IncidentRow: View {
    var incident: Entity
    /// A monitor that went down with this machine: its own name is not listed as also down with it.
    var alsoExcept: String? = nil
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
                Text(StyleGuard.dashes(err)).font(.caption).foregroundStyle(open ? Color.red : Color.secondary).lineLimit(2)
            }
            if let also = MonitorText.alsoDown(incident, except: alsoExcept) { Text(also).font(.caption) }
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
    /// Its own open incident, or its machine's when it went down with the machine (`joined_incident`).
    static func openIncident(for m: Entity, in incidents: [Entity]) -> Entity? {
        let open = incidents.filter { ($0.string("closed_at") ?? "").isEmpty }
        return open.first { $0.str("monitor_id") == m.id } ?? m.string("joined_incident").flatMap { j in open.first { $0.id == j } }
    }

    /// An off monitor checked by hand since it was turned off: the hub ran it (it only opens and closes nothing).
    static func handChecked(_ m: Entity) -> Bool {
        guard let last = m.string("last_check") else { return false }
        guard let offAt = m.field_ts["enabled"] else { return true }
        return ISO.isAfter(last, offAt)
    }

    /// Off and not checked by hand since: what it last said is from before it was turned off.
    private static func quiet(_ m: Entity) -> Bool { MonitorStatus(m) == .off && !handChecked(m) }

    /// A backup machine whose last check could not reach it (a laptop away from home): still up, with `last_error`
    /// set, and its job lines as last read.
    static func away(_ m: Entity) -> Bool {
        guard m.str("type") == "backup", MonitorStatus(m) == .up, !(m.string("last_error") ?? "").isEmpty else { return false }
        // The last check did reach it (a job failing, not down yet): that error is the machine's, not an absence.
        if let reached = m.string("last_reached"), let last = m.string("last_check"), !ISO.isAfter(last, reached) { return false }
        return true
    }

    /// The last check's error, if it is worth showing.
    static func error(_ m: Entity) -> String? {
        guard !quiet(m), let e = m.string("last_error"), !e.isEmpty else { return nil }
        return e
    }

    /// Under a backup machine's job lines: "Not reached since 2 days ago: <error>" when it is away; otherwise its
    /// error, unless a failing job line already says it.
    static func backupNote(_ m: Entity, jobs: [BackupJobLine]) -> String? {
        guard let err = error(m) else { return nil }
        if away(m) {
            let since = m.string("last_reached") ?? m.string("last_ok")
            return "Not reached since \(since.map { Homelab.ago($0) } ?? "it was added"): \(StyleGuard.dashes(err))"
        }
        let said = jobs.contains { l in
            guard !l.ok, let e = l.error, !e.isEmpty else { return false }
            return err.range(of: e, options: .caseInsensitive) != nil
        }
        return said ? nil : StyleGuard.dashes(err)
    }

    /// "checked 4 min ago", "tried 1 min ago" for a machine away, or why not.
    static func checked(_ m: Entity) -> String {
        if quiet(m) { return "not checked while off" }
        guard let last = m.string("last_check") else { return "never checked" }
        return "\(away(m) ? "tried" : "checked") \(Homelab.ago(last))"
    }

    static func stats(_ m: Entity, uptime: Double?) -> String {
        var parts: [String] = []
        if quiet(m) { parts.append("not checked while off") }
        else {
            if let ms = m.number("last_latency_ms"), MonitorStatus(m) != .down { parts.append("\(Int(ms.rounded())) ms") }
            parts.append(checked(m))
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

    /// "Also down with it: Ollama, nas ping (Tailscale)": a machine's other monitors that went down with it, without
    /// `except` (the monitor whose row or page this is).
    static func alsoDown(_ inc: Entity, except: String? = nil) -> String? {
        let names = (inc.fields["also_down"]?.arrayValue?.compactMap(\.stringValue) ?? []).filter { $0 != except }
        return names.isEmpty ? nil : "Also down with it: " + names.map(StyleGuard.dashes).joined(separator: ", ")
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
        "backup": "mac:laptop, windows:desktop or linux:me@nas"
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
                    // Its monitor's error is the latest; the incident's own was written when it opened.
                    let err = engine.get(incident.str("monitor_id")).flatMap(MonitorText.error) ?? incident.string("last_error")
                    if let err, !err.isEmpty { Text(StyleGuard.dashes(err)).foregroundStyle(.red) }
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
    @Environment(\.scenePhase) private var scenePhase
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
        let away = MonitorText.away(m)
        let incident = MonitorText.openIncident(for: m, in: engine.list(.incident))
        List {
            SwiftUI.Section {
                HStack(spacing: 12) {
                    Image(systemName: away ? "moon.zzz.fill" : status.symbol).font(.system(size: 30)).foregroundStyle(away ? Color.gray : status.color)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(away ? "Away" : status.label).font(.title2.weight(.bold)).foregroundStyle(status == .off || away ? Color.primary : status.color)
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
                    // Down with its machine: the incident is the machine's, and this monitor is one of those down with it.
                    if inc.str("monitor_id") != m.id {
                        Text("Down with \(StyleGuard.dashes(inc.str("name"))): its machine stopped answering.").font(.subheadline)
                    }
                    IncidentRow(incident: inc, alsoExcept: m.str("name"), onAck: { acking = inc })
                }
            }

            let jobs = BackupJobLine.lines(m)
            if !jobs.isEmpty {
                SwiftUI.Section {
                    BackupJobsList(lines: jobs, showTimes: true)
                    if let note = MonitorText.backupNote(m, jobs: jobs), away {
                        Text(note).font(.subheadline).foregroundStyle(.orange)
                    }
                } header: {
                    Text("Jobs")
                } footer: {
                    Text("Read together in one ssh login. Limits: " + jobs.map { "\($0.label.lowercased()) \($0.maxHours) h" }.joined(separator: ", ") + ".")
                }
            }

            SwiftUI.Section("Last check") {
                LabeledContent("Checked", value: m.string("last_check").map { Homelab.ago($0) } ?? "Never")
                if let ms = m.number("last_latency_ms") { LabeledContent("Latency", value: "\(Int(ms.rounded())) ms") }
                if jobs.isEmpty, let d = m.string("last_detail"), !d.isEmpty, !(m.string("last_error") ?? "").contains(d) { Text(d).font(.subheadline).textSelection(.enabled) }
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
                        UptimeStrip(rows: rows, intervalS: m.number("interval_s"))
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
        .refreshable { await engine.sync(); await refreshMonitor(); await loadHistory() }
        // Ops stops loading its board once this page is pushed, and each check's own fields (when it ran, the error,
        // a backup's job lines) reach no device by sync: read this monitor every 30 s while it is shown.
        .task(id: scenePhase.refreshes) {
            guard scenePhase.refreshes else { return }
            while !Task.isCancelled {
                await refreshMonitor()
                try? await Task.sleep(for: .seconds(30))
            }
        }
    }

    /// This monitor, and its open incident (its own or its machine's), whose failed count and latest error are
    /// written on the hub without a sync change as well.
    private func refreshMonitor() async {
        guard let c = engine.client else { return }
        let incident = engine.get(id).flatMap { MonitorText.openIncident(for: $0, in: engine.list(.incident)) }
        await engine.absorb(await Homelab.fresh([id] + (incident.map { [$0.id] } ?? []), client: c))
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

    /// The window cut by time into `min(maxCells, window / interval)` equal slices, so a slice holds about one check
    /// at the monitor's interval: red when any check in it failed, green when all passed, empty when nothing was
    /// checked (a machine away, a monitor made today). One cell per check hid those gaps behind a full green day.
    /// The web client cuts it the same way.
    static func cells(_ rows: [MonitorCheck], hours: Double = 24, now: Date = Date(), maxCells: Int = 144, intervalS: Double? = nil) -> [Cell] {
        let end = now.timeIntervalSince1970, start = end - hours * 3600
        let byInterval = intervalS.map { $0 > 0 ? Int((hours * 3600 / $0).rounded(.down)) : maxCells } ?? maxCells
        let count = max(1, min(maxCells, byInterval))
        var cells = Array(repeating: Cell(ok: nil, checks: 0, fails: 0), count: count)
        let width = (end - start) / Double(count)
        for r in rows {
            guard let t = ISO.date(r.at)?.timeIntervalSince1970, t >= start, t <= end else { continue }
            let i = min(count - 1, Int((t - start) / width))
            cells[i].checks += 1
            if !r.ok { cells[i].fails += 1 }
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
    /// The monitor's `interval_s`: a slice is about one check long.
    var intervalS: Double? = nil

    var body: some View {
        let cells = MonitorHistory.cells(rows, intervalS: intervalS)
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
    /// The fields as loaded, to send only what was changed here.
    @State private var loaded: [String: JSONValue] = [:]

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
                        TextField("Expect", text: $expect, prompt: Text(type == "http" ? "Status code or body text, optional" : type == "backup" ? "Hours: 28, or 28,verify=200,restore=900" : "Expected address, optional"))
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
        case "backup": return "One monitor per machine: mac:, windows: or linux: then the ssh destination. The hub reads the backup, its verification and, on Linux, the restore test in one ssh login, and the machine is down when any of them failed or is too old. Add #verify or #restore to watch one job only."
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
        loaded = fields()
    }

    private func fields() -> [String: JSONValue] {
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
        return f
    }

    private func save() {
        let f = fields()
        if let m = monitor {
            // Only what was changed here, each with a new time: every field used to go, so a monitor turned off on
            // another device while this was open came back on.
            let changed = f.filter { loaded[$0.key] != $0.value }
            if !changed.isEmpty { Task { _ = await engine.update(m.id, fields: changed) } }
        } else {
            Task { _ = await engine.create(kind: .monitor, fields: f.filter { !$0.value.isNull }) }
        }
        dismiss()
    }
}
