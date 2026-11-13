import SwiftUI
import EACore
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// Helpers shared by the Ops, Hosts, Journal and Snippets screens.
enum Homelab {
    static func copy(_ text: String) {
        #if canImport(UIKit)
        UIPasteboard.general.string = text
        #elseif canImport(AppKit)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        #endif
    }

    /// "4 min ago", "3 h ago", "2 days ago"; "in 5 days" for the future.
    static func ago(_ date: Date?, now: Date = Date()) -> String {
        guard let date else { return "" }
        let s = now.timeIntervalSince(date)
        let a = abs(s)
        let text: String
        if a < 60 { text = "1 min" }
        else if a < 3600 { text = "\(Int(a / 60)) min" }
        else if a < 48 * 3600 { text = "\(Int(a / 3600)) h" }
        else { text = "\(Int(a / 86400)) days" }
        return s >= 0 ? "\(text) ago" : "in \(text)"
    }

    static func ago(_ iso: String?) -> String { ago(ISO.date(iso)) }

    /// "45 s", "12 min", "3 h 5 min", "2 days 4 h".
    static func duration(_ seconds: TimeInterval) -> String {
        let s = Int(max(0, seconds))
        if s < 60 { return "\(s) s" }
        let d = s / 86400, h = (s % 86400) / 3600, m = (s % 3600) / 60
        if d > 0 { return h > 0 ? "\(d) day\(d == 1 ? "" : "s") \(h) h" : "\(d) day\(d == 1 ? "" : "s")" }
        if h > 0 { return m > 0 ? "\(h) h \(m) min" : "\(h) h" }
        return "\(m) min"
    }

    static func trimmed(_ s: String) -> String { s.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// A host name as the hub keys it (hub/src/memory.ts hostsSummary): trimmed and lowercased.
    static func hostKey(_ s: String) -> String { trimmed(s).lowercased() }

    /// Whether an item's `host` names this machine. Names were compared as written, so "NAS" and "nas" were two
    /// machines here while the hub, which lowercases them, showed one.
    static func sameHost(_ a: String, _ b: String) -> Bool {
        let k = hostKey(a)
        return !k.isEmpty && k == hostKey(b)
    }

    /// Every host name the synced data mentions: runbooks, journal, snippets, monitors and `host:` facts, each once
    /// in the hub's lowercase form.
    @MainActor
    static func knownHosts(_ engine: SyncEngine) -> [String] {
        var set = Set<String>()
        for k in [Kind.runbook, .journal, .snippet, .monitor] {
            for e in engine.list(k) { let h = hostKey(e.str("host")); if !h.isEmpty { set.insert(h) } }
        }
        for f in engine.list(.fact) where f.str("key").hasPrefix("host:") {
            let h = hostKey(String(f.str("key").dropFirst(5)))
            if !h.isEmpty { set.insert(h) }
        }
        return set.sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
    }

    /// The same derivation as the hub's `GET /hosts`, from what is synced here, keyed by the lowercased name as the
    /// hub keys it. A name written with capitals made a second row before.
    @MainActor
    static func localHosts(_ engine: SyncEngine) -> [HostSummary] {
        var m: [String: HostSummary] = [:]
        func touch(_ host: String) -> String? {
            let k = hostKey(host)
            guard !k.isEmpty else { return nil }
            if m[k] == nil { m[k] = HostSummary(host: k) }
            return k
        }
        for e in engine.list(.runbook) { if let k = touch(e.str("host")) { m[k]?.runbooks += 1 } }
        for e in engine.list(.snippet) { if let k = touch(e.str("host")) { m[k]?.snippets += 1 } }
        for e in engine.list(.journal) {
            guard let k = touch(e.str("host")) else { continue }
            m[k]?.journal_entries += 1
            let at = e.string("at") ?? e.created_at
            if let last = m[k]?.last_change, !ISO.isAfter(at, last) { continue }
            m[k]?.last_change = at
        }
        for f in engine.list(.fact) where f.str("key").hasPrefix("host:") { _ = touch(String(f.str("key").dropFirst(5))) }
        for e in engine.list(.monitor) { _ = touch(e.str("host")) }
        return m.values.sorted { $0.host.localizedCaseInsensitiveCompare($1.host) == .orderedAscending }
    }

    /// Fresh copies from the hub (`GET /entities/:id`), read at the same time; any that cannot be read are left out.
    static func fresh(_ ids: [String], client c: HubClient) async -> [Entity] {
        await withTaskGroup(of: Entity?.self) { group in
            for id in ids { group.addTask { try? await c.entity(id) } }
            var out: [Entity] = []
            for await e in group { if let e { out.append(e) } }
            return out
        }
    }

    /// A filter menu's hosts: each machine once, in the hub's lowercase form, however its items spell it.
    static func hostKeys(_ items: [Entity]) -> [String] {
        Array(Set(items.map { hostKey($0.str("host")) }.filter { !$0.isEmpty })).sorted()
    }

    static func errorText(_ error: Error) -> String {
        if let h = error as? HubError {
            if case .http(let status, let message) = h {
                if status == 404 { return "The hub does not have this yet." }
                return message.isEmpty ? "The hub answered \(status)." : message
            }
            return h.errorDescription ?? "The hub did not answer."
        }
        return error.localizedDescription
    }
}

extension ScenePhase {
    /// Whether a screen's 30 s refresh runs: not in the background (a minimized Mac window, the app put away), and on
    /// the iPhone and iPad not while inactive either. A Mac window behind another app's keeps refreshing, so Ops on a
    /// second display stays current.
    var refreshes: Bool {
        #if os(macOS)
        return self != .background
        #else
        return self == .active
        #endif
    }
}

// MARK: Status vocabulary

/// Monitor state as text, symbol and color together.
enum MonitorStatus: String {
    case up, down, unknown, off

    init(_ monitor: Entity) {
        if monitor.bool("enabled") == false { self = .off; return }
        switch monitor.str("state") {
        case "up": self = .up
        case "down": self = .down
        default: self = .unknown
        }
    }

    var label: String {
        switch self {
        case .up: return "Up"
        case .down: return "Down"
        case .unknown: return "Unknown"
        case .off: return "Off"
        }
    }
    var symbol: String {
        switch self {
        case .up: return "checkmark.circle.fill"
        case .down: return "xmark.octagon.fill"
        case .unknown: return "questionmark.circle.fill"
        case .off: return "pause.circle"
        }
    }
    var color: Color {
        switch self {
        case .up: return .green
        case .down: return .red
        case .unknown: return .gray
        case .off: return .secondary
        }
    }
    /// Sort order on the board: down first, off last.
    var rank: Int {
        switch self {
        case .down: return 0
        case .unknown: return 1
        case .up: return 2
        case .off: return 3
        }
    }
}

/// One job of a backup machine as the hub last read it (the monitor's `jobs`): backup, verification or restore test.
struct BackupJobLine: Identifiable, Equatable {
    var job: String
    var state: String
    var running: Bool
    var lastGood: Date?
    var lastRun: Date?
    var maxHours: Int
    var error: String?
    var id: String { job }

    /// The lines of a backup monitor read as a whole machine; empty for any other monitor.
    /// A machine away keeps its last read, so a job fine then can be past its limit now: such a line is over the limit
    /// (red) whatever the stored state says.
    static func lines(_ monitor: Entity, now: Date = Date()) -> [BackupJobLine] {
        guard monitor.str("type") == "backup", let jobs = monitor.fields["jobs"]?.arrayValue else { return [] }
        return jobs.compactMap { v in
            guard let o = v.objectValue, let job = o["job"]?.stringValue else { return nil }
            var line = BackupJobLine(job: job, state: o["state"]?.stringValue ?? "ok", running: o["running"]?.boolValue ?? false,
                                     lastGood: ISO.date(o["last_good"]?.stringValue), lastRun: ISO.date(o["last_run"]?.stringValue),
                                     maxHours: Int(o["max_hours"]?.doubleValue ?? 0), error: o["error"]?.stringValue)
            if line.state == "ok", line.maxHours > 0, let good = line.lastGood, now.timeIntervalSince(good) > Double(line.maxHours) * 3600 {
                line.state = "stale"
            }
            return line
        }
    }

    var label: String {
        switch job {
        case "verify": return "Verification"
        case "restore": return "Restore test"
        default: return "Backup"
        }
    }
    var ok: Bool { state == "ok" }
    /// "last good 10 h ago", "failed 2 h ago; last good 26 h ago", "not set up on this machine".
    var text: String {
        let good = lastGood.map { "last good \(Homelab.ago($0))" } ?? ""
        let run = running ? "running now" : ""
        func join(_ parts: String...) -> String { parts.filter { !$0.isEmpty }.joined(separator: "; ") }
        switch state {
        case "missing": return "not set up on this machine"
        case "never": return join(run, "no good run on record")
        case "failed": return join(run, lastRun.map { "failed \(Homelab.ago($0))" } ?? "failed", good)
        case "stale": return join(run, "\(good), over the \(maxHours) h limit")
        default: return join(run, good)
        }
    }
    /// The time the line is about: when it failed, else the last good run.
    var at: Date? { state == "failed" ? lastRun : lastGood }
}

/// A backup machine's jobs, one line each: a mark, the job, and when it last went well or what went wrong.
struct BackupJobsList: View {
    var lines: [BackupJobLine]
    var showTimes = false

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(lines) { l in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: l.ok ? MonitorStatus.up.symbol : MonitorStatus.down.symbol)
                        .foregroundStyle(l.ok ? Color.green : Color.red)
                    Text(l.label).fontWeight(.semibold).frame(minWidth: 86, alignment: .leading)
                    VStack(alignment: .leading, spacing: 1) {
                        // Wraps instead of being cut off in a list row.
                        Text(l.text).foregroundStyle(l.ok ? Color.secondary : Color.red).fixedSize(horizontal: false, vertical: true)
                        if showTimes, let at = l.at { Text(at.shortDateTime).foregroundStyle(.secondary) }
                    }
                }
                .font(.caption)
                .accessibilityElement(children: .combine)
            }
        }
    }
}

enum JournalRisk: String, CaseIterable, Identifiable {
    case low, medium, high
    var id: String { rawValue }
    var label: String { rawValue.capitalized + " risk" }
    var color: Color {
        switch self {
        case .low: return .green
        case .medium: return .orange
        case .high: return .red
        }
    }
    var symbol: String {
        switch self {
        case .low: return "shield"
        case .medium: return "exclamationmark.shield"
        case .high: return "exclamationmark.triangle.fill"
        }
    }
}

/// `running`: an approved change the hub is running now; `interrupted`: it was cut off (a timeout, or the hub restarted
/// while it ran), so whether it finished is not known. The hub sets both; they showed as Done before.
enum JournalOutcome: String, CaseIterable, Identifiable {
    case planned, running, done, failed, interrupted, reverted
    var id: String { rawValue }
    var label: String { rawValue.capitalized }
    var color: Color {
        switch self {
        case .planned: return .blue
        case .running: return .blue
        case .done: return .green
        case .failed: return .red
        case .interrupted: return .orange
        case .reverted: return .orange
        }
    }
    var symbol: String {
        switch self {
        case .planned: return "clock"
        case .running: return "hourglass"
        case .done: return "checkmark"
        case .failed: return "xmark"
        case .interrupted: return "exclamationmark.triangle"
        case .reverted: return "arrow.uturn.backward"
        }
    }
}

// MARK: Small views

/// A capsule with a symbol and a word, so status never depends on color alone.
struct HomelabPill: View {
    var text: String
    var symbol: String? = nil
    var color: Color = .secondary

    var body: some View {
        HStack(spacing: 4) {
            if let symbol { Image(systemName: symbol).imageScale(.small) }
            Text(text)
        }
        .font(.caption.weight(.semibold))
        .padding(.horizontal, 8).padding(.vertical, 3)
        .foregroundStyle(color)
        .background(color.opacity(0.14), in: Capsule())
        .fixedSize()
    }
}

struct MonitorStatusPill: View {
    var status: MonitorStatus
    var body: some View { HomelabPill(text: status.label, symbol: status.symbol, color: status.color) }
}

/// Copies `text` and says "Copied" for a moment.
struct HomelabCopyButton: View {
    var text: String
    var title: String = "Copy"
    var prominent = false
    @State private var copied = false

    var body: some View {
        Button {
            Homelab.copy(text)
            copied = true
            Task { try? await Task.sleep(for: .seconds(1.5)); copied = false }
        } label: {
            Label(copied ? "Copied" : title, systemImage: copied ? "checkmark" : "doc.on.doc")
        }
        .buttonStyle(.bordered)
        .tint(prominent ? .accentColor : nil)
        .accessibilityLabel(copied ? "Copied" : title)
    }
}

/// A monospaced block of command text that can be selected.
struct CommandBlock: View {
    var text: String
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(text)
                .font(.callout.monospaced())
                .textSelection(.enabled)
                .fixedSize(horizontal: true, vertical: false)
                .padding(10)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
    }
}

/// A host name field with a menu of the hosts already known.
struct HostField: View {
    @Binding var host: String
    var hosts: [String]
    var prompt = "Host, for example pve1"

    var body: some View {
        HStack {
            TextField("Host", text: $host, prompt: Text(prompt))
                .autocorrectionDisabled()
                #if os(iOS)
                .textInputAutocapitalization(.never)
                #endif
            if !hosts.isEmpty {
                Menu {
                    ForEach(hosts, id: \.self) { h in Button(h) { host = h } }
                } label: {
                    Image(systemName: "chevron.down.circle")
                }
                .menuStyle(.button)
                .buttonStyle(.borderless)
                .fixedSize()
                .accessibilityLabel("Pick a known host")
            }
        }
    }
}
