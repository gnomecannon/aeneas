import SwiftUI
import EACore

struct WatchRootView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        TabView(selection: $model.page) {
            NavigationStack { WatchVoiceView(ask: model.ask, hum: model.hum) }.tag(WatchPage.voice)
            NavigationStack { WatchNowView() }.tag(WatchPage.now)
            NavigationStack { WatchTodayView() }.tag(WatchPage.today)
            NavigationStack { WatchLogView() }.tag(WatchPage.log)
            NavigationStack { ActivityView() }.tag(WatchPage.activity)
            NavigationStack { WeightView() }.tag(WatchPage.weight)
        }
        .tabViewStyle(.verticalPage)
        .overlay(alignment: .top) {
            if let c = model.activityCheckin {
                VStack(spacing: 6) {
                    Text(StyleGuard.dashes(c.title)).font(.caption.weight(.semibold)).lineLimit(2).multilineTextAlignment(.center)
                    HStack(spacing: 6) {
                        Button("Still on it") { Task { await model.answerCheckin(stop: false) } }
                        Button("Stop") { Task { await model.answerCheckin(stop: true) } }.tint(.orange)
                    }
                    .controlSize(.mini)
                }
                .padding(8)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                .padding(.horizontal, 6)
                .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(.default, value: model.activityCheckin)
        .sheet(item: Binding(get: { model.permissionOffer.map(WatchOffer.init) }, set: { if $0 == nil { model.permissionOffer = nil } })) { offer in
            WatchPermissionsView(needs: offer.needs).environmentObject(model)
        }
    }
}

struct WatchOffer: Identifiable {
    let needs: [PermissionNeed]
    var id: String { needs.map(\.id).joined(separator: ",") }
}

/// What the modules that are on need from the Watch, after its first setup or when a module is switched on. Continue
/// asks for each in turn; Not now asks for nothing.
struct WatchPermissionsView: View {
    @EnvironmentObject var model: AppModel
    let needs: [PermissionNeed]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                Text("Your modules need").font(.headline)
                ForEach(needs) { n in
                    VStack(alignment: .leading, spacing: 2) {
                        Label(n.permission.title, systemImage: n.permission.symbol).font(.footnote.weight(.semibold))
                        Text(n.permission == .microphone ? "Hears you only while you record a hum." : n.permission.purpose).font(.caption2)
                        Text(n.forLine).font(.caption2).foregroundStyle(.secondary)
                    }
                }
                Button("Continue") { Task { await model.grantOffered(needs) } }.tint(.blue)
                Button("Not now") { model.permissionOffer = nil }
            }
        }
    }
}

/// One line of sync state. The Watch reaches the hub only through the iPhone.
/// Tapping it opens the relay diagnostics.
struct OfflineDot: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var engine: SyncEngine
    @State private var showDiagnostics = false

    private var label: String {
        if engine.status == .online { return "Online" }
        if engine.phoneUnreachable { return engine.outboxCount > 0 ? "iPhone not reachable, \(engine.outboxCount) queued" : "iPhone not reachable" }
        if engine.status == .connecting { return "Syncing" }
        return engine.outboxCount > 0 ? "Offline, \(engine.outboxCount) queued" : "Offline"
    }

    var body: some View {
        Button { showDiagnostics = true } label: {
            HStack(spacing: 4) {
                Circle().fill(engine.status == .online ? Color.green : Color.orange).frame(width: 6, height: 6)
                Text(label).font(.caption2).foregroundStyle(.secondary).lineLimit(1).minimumScaleFactor(0.8)
            }
        }
        .buttonStyle(.plain)
        .sheet(isPresented: $showDiagnostics) { RelayDiagnosticsView() }
    }
}

/// Activation state, reachability, companion app, last relay error, and a live health check.
struct RelayDiagnosticsView: View {
    @EnvironmentObject var engine: SyncEngine
    @Environment(\.dismiss) private var dismiss
    @State private var result: String?
    @State private var trying = false
    @State private var tick = 0

    private var d: [String: String] { _ = tick; return WatchLink.shared.diagnostics }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 6) {
                Text("iPhone link").font(.headline)
                row("Session", d["activation"] ?? "")
                row("Reachable", d["isReachable"] ?? "")
                row("Phone app", (d["isCompanionAppInstalled"] == "true") ? "installed" : "not installed")
                row("Relays", d["relayCount"] ?? "0")
                if let s = d["lastRelayStatus"], !s.isEmpty { row("Last status", s + " at " + shortTime(d["lastRelayAt"])) }
                if let e = d["lastRelayError"], !e.isEmpty {
                    Text("Last error").font(.caption2).foregroundStyle(.secondary)
                    Text(e).font(.caption2)
                    Text(shortTime(d["lastRelayErrorAt"])).font(.caption2).foregroundStyle(.secondary)
                }
                if let se = engine.lastError, !se.isEmpty { row("Sync", se) }
                Button(trying ? "Trying" : "Try now") { tryNow() }.disabled(trying)
                if let r = result { Text(r).font(.caption2) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .onAppear { tick += 1 }
    }

    @ViewBuilder
    private func row(_ k: String, _ v: String) -> some View {
        HStack(alignment: .top) {
            Text(k).font(.caption2).foregroundStyle(.secondary)
            Spacer()
            Text(v).font(.caption2).multilineTextAlignment(.trailing)
        }
    }

    private func shortTime(_ iso: String?) -> String {
        guard let dte = ISO.date(iso) else { return "" }
        return dte.formatted(date: .omitted, time: .standard)
    }

    private func tryNow() {
        trying = true
        result = nil
        Task {
            if let c = engine.client {
                do {
                    let h = try await c.health()
                    result = "Hub OK, version \(h.version ?? "?"), seq \(h.db_seq ?? 0)"
                    await engine.sync()
                } catch {
                    result = (error as? HubError)?.errorDescription ?? error.localizedDescription
                }
            } else {
                result = "No client"
            }
            tick += 1
            trying = false
        }
    }
}
