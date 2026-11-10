import SwiftUI
import EACore

/// Settings, About: the hub's own software. Check for updates lists what is new; Update hub runs the update on the hub
/// machine, which restarts the hub and goes back by itself when the new version does not start. The assistant can do
/// the same ("update the hub").
struct HubUpdateSection: View {
    @EnvironmentObject var engine: SyncEngine
    @State private var info: HubUpdateInfo?
    @State private var busy = false
    @State private var error: String?
    /// While an update runs the hub restarts, so a failed read means "restarting", not an error.
    @State private var watching = false
    @State private var unreachable = false

    private static let words: [String: String] = [
        "starting": "Starting", "checking": "Looking for the newest version", "installing": "Installing",
        "restarting": "Restarting the hub", "rolling_back": "Going back to the version it had", "done": "Updated",
        "up_to_date": "Already up to date", "rolled_back": "Went back to the version it had", "failed": "Did not update",
    ]

    var body: some View {
        SwiftUI.Section("Hub software") {
            if let i = info {
                if let c = i.commit {
                    Text("This hub runs version \(String(c.prefix(7)))\(ISO.date(i.committed_at).map { " from \($0.shortDateTime)" } ?? "").")
                        .font(.callout)
                }
                if watching || (i.running && i.last_run?.running == true), let run = i.last_run {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text(unreachable ? "The hub is restarting; this reconnects by itself." : Self.words[run.state] ?? run.message)
                            .font(.callout)
                    }
                } else {
                    if i.checked_at != nil, i.behind == 0, i.reason == nil {
                        Text("Up to date.").font(.callout).foregroundStyle(.green)
                    }
                    if i.behind > 0 {
                        Text(i.behind == 1 ? "1 change is newer than this hub:" : "\(i.behind) changes are newer than this hub:").font(.callout)
                        ForEach(i.changes.prefix(8)) { c in Text(c.title).font(.caption) }
                    }
                    if let r = i.reason { Text(r).font(.caption).foregroundStyle(.secondary) }
                    if let run = i.last_run, !run.running {
                        Text("Last update \(ISO.date(run.at)?.shortDateTime ?? run.at): \(run.message)")
                            .font(.caption)
                            .foregroundStyle(run.state == "failed" || run.state == "rolled_back" ? .orange : .secondary)
                    }
                    if i.installed_with_git {
                        Button(busy ? "Checking" : "Check for updates") { Task { await check() } }.disabled(busy)
                    }
                    if i.can_update {
                        Button("Update hub") { Task { await start() } }.disabled(busy)
                        Text("The hub restarts in a minute or two, and goes back to this version by itself if the new one does not start.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            } else {
                Text(engine.client == nil ? "Hub not configured." : (error ?? "Loading")).foregroundStyle(.secondary)
            }
            if info != nil, let e = error { Text(e).font(.caption).foregroundStyle(.orange) }
        }
        .task { await load() }
        .task(id: watching) { await watch() }
    }

    private func message(_ e: Error) -> String { (e as? HubError)?.errorDescription ?? e.localizedDescription }

    private func load() async {
        guard let c = engine.client else { return }
        do {
            let i = try await c.hubUpdate()
            info = i
            if i.running { watching = true }
        } catch { self.error = message(error) }
    }

    private func check() async {
        guard let c = engine.client else { return }
        busy = true
        defer { busy = false }
        error = nil
        do { info = try await c.checkHubUpdate() } catch { self.error = message(error) }
    }

    private func start() async {
        guard let c = engine.client else { return }
        busy = true
        defer { busy = false }
        error = nil
        do {
            let r = try await c.startHubUpdate()
            info?.last_run = r.run
            info?.running = true
            info?.can_update = false
            watching = true
        } catch { self.error = message(error) }
    }

    /// Every 3 s until the run ends, for up to ten minutes (far past any update).
    private func watch() async {
        guard watching, let c = engine.client else { return }
        let until = Date().addingTimeInterval(600)
        while watching, Date() < until, !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            do {
                let i = try await c.hubUpdate()
                unreachable = false
                info = i
                if !i.running {
                    watching = false
                    if i.last_run?.state == "done", let fresh = try? await c.checkHubUpdate() { info = fresh }
                }
            } catch { unreachable = true }
        }
        watching = false
    }
}
