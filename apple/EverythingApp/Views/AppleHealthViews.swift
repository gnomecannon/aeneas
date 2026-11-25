import SwiftUI
import EACore

/// Apple Health in the app, said plainly wherever it is used (App Review 2.5.1: HealthKit must be clearly named in
/// the app): its row in Settings, Accounts, From this iPhone, its own page, and the first part of the Health screen.
/// The iPhone and iPad only; the Mac has no Apple Health.

/// Apple Health's look, as Apple's own apps show it: a red heart on white. Drawn from the heart.fill symbol, not
/// Apple's icon.
struct AppleHealthIcon: View {
    var size: CGFloat = 28

    /// Health's red, kept the same in dark mode, as the icon is.
    static let red = Color(red: 1, green: 0.176, blue: 0.333)

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: size * 0.23, style: .continuous)
        shape.fill(.white)
            .overlay(shape.strokeBorder(.black.opacity(0.12), lineWidth: 0.5))
            .overlay(Image(systemName: "heart.fill").font(.system(size: size * 0.56)).foregroundStyle(Self.red))
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

#if os(iOS)
/// This device's Apple Health switch, one for its row in From this iPhone and its page, so both show the same. On
/// switches the Health module on when it is off and asks for Health access right there.
@MainActor
final class AppleHealthSwitch: ObservableObject {
    static let shared = AppleHealthSwitch()
    @Published private(set) var here = SharedConfig.shared.healthImportEnabled
    @Published private(set) var busy = false
    /// What the last switch or Send now said.
    @Published var note: (ok: Bool, text: String)?

    func refresh() { here = SharedConfig.shared.healthImportEnabled }

    /// Syncing now: the module, this device's switch, and never in sample mode.
    func on(_ model: AppModel) -> Bool { here && model.isOn(.health) && !model.config.sampleMode }

    func set(_ on: Bool, model: AppModel, engine: SyncEngine) {
        // Sample mode: the switch stays off, so no sample reading goes into the person's own Health.
        guard !model.config.sampleMode else { return }
        guard on else {
            SharedConfig.shared.healthImportEnabled = false
            here = false
            note = nil
            return
        }
        run {
            if !model.modules.isOnListed(.health) { try await model.setModules([AppModule.health.rawValue: true], offer: false) }
            SharedConfig.shared.healthImportEnabled = true
            self.here = true
            return await HealthImporter.shared.requestAndImport(into: engine)
        }
    }

    /// Send now: what is new in Apple Health goes to the hub, and what was logged in Aeneas goes to Apple Health.
    func sendNow(engine: SyncEngine) {
        run { await HealthImporter.shared.requestAndImport(into: engine) }
    }

    private func run(_ f: @escaping () async throws -> String) {
        busy = true
        note = nil
        Task {
            defer { busy = false }
            do {
                let r = try await f()
                note = (!r.hasPrefix("Could not") && !r.hasPrefix("Health permission"), r)
            } catch {
                note = (false, (error as? HubError)?.errorDescription ?? error.localizedDescription)
            }
        }
    }
}

/// Settings, Accounts, From this iPhone, Apple Health (1.0.17 had it in Settings, Connections): the switch, what
/// Aeneas reads from Apple Health and writes to it, Send now, and how many readings came from it. In sample mode the
/// switch stays off and says why, and the rest shows as it would.
struct AppleHealthSettingsView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var engine: SyncEngine
    @ObservedObject private var health = AppleHealthSwitch.shared
    @State private var counts: Connections.Health?
    @State private var loadError: String?

    private var sample: Bool { model.config.sampleMode }
    private var syncing: Bool { health.on(model) }

    var body: some View {
        ScrollViewReader { proxy in
            form
                .task {
                    #if DEBUG
                    // `-EAAccountsScroll writes|hub`: the page opens scrolled to that part (screenshots).
                    if let id = UserDefaults.standard.string(forKey: "EAAccountsScroll"), ["writes", "hub"].contains(id) {
                        try? await Task.sleep(for: .seconds(1))
                        proxy.scrollTo(id, anchor: .top)
                    }
                    #endif
                }
        }
        .navigationTitle("Apple Health")
        .navigationBarTitleDisplayMode(.inline)
        .task { health.refresh(); await load() }
        .onChange(of: health.busy) { _, busy in if !busy { Task { await load() } } }
        .refreshable { await load() }
    }

    private var form: some View {
        Form {
            SwiftUI.Section {
                HStack(spacing: 12) {
                    AppleHealthIcon(size: 40)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Apple Health").font(.headline)
                        Text("Aeneas and Apple Health keep your readings the same, both ways.").font(.caption).foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 2)
                .accessibilityElement(children: .combine)
                Toggle("Sync with Apple Health", isOn: Binding(get: { syncing }, set: { health.set($0, model: model, engine: engine) }))
                    .disabled(sample || health.busy)
                if sample {
                    Text(HealthImporter.sampleOff).font(.footnote).foregroundStyle(.secondary)
                } else if syncing {
                    Button(health.busy ? "Sending" : "Send now") { health.sendNow(engine: engine) }
                        .disabled(health.busy)
                }
                if let n = health.note {
                    Text(n.text).font(.footnote).foregroundStyle(n.ok ? AnyShapeStyle(.secondary) : AnyShapeStyle(.dangerText))
                }
            } footer: {
                Text("For this \(deviceKind) only. New readings go to your hub each time you open the app (at most every 15 minutes) and when Apple Health has new ones. What you log goes to Apple Health a few seconds after it syncs.")
            }
            .themedRow()

            SwiftUI.Section {
                ForEach(HealthImporter.readsShown) { row($0) }
            } header: {
                Text("What Aeneas reads from Apple Health")
            } footer: {
                Text("Only the types you allow when Apple Health asks. What Aeneas wrote is not read back, so nothing comes in twice.")
            }
            .themedRow()

            SwiftUI.Section {
                ForEach(HealthImporter.writesShown) { row($0) }
            } header: {
                Text("What Aeneas writes to Apple Health")
            } footer: {
                Text("What you log in Aeneas, on any of your devices. Change or delete it in Aeneas and Apple Health changes too.")
            }
            .themedRow()
            .id("writes")

            SwiftUI.Section {
                if let h = counts {
                    LabeledContent("Readings from Apple Health", value: "\(h.total)")
                    LabeledContent("Last sync", value: h.last_import.flatMap(ISO.date).map(\.shortDateTime) ?? "Never")
                } else if let loadError {
                    Text(loadError).font(.footnote).foregroundStyle(.dangerText)
                } else {
                    ProgressView()
                }
            } header: {
                Text("On your hub")
            } footer: {
                Text("See them all in Library, Body and home, Health, each reading from Apple Health marked with a heart.")
            }
            .themedRow()
            .id("hub")
        }
        .formStyle(.grouped)
        .themedScreen()
    }

    private func row(_ s: HealthImporter.Shown) -> some View {
        HStack(spacing: 12) {
            Image(systemName: s.symbol).foregroundStyle(.tint).frame(width: 26).accessibilityHidden(true)
            Text(s.title)
            Spacer(minLength: 8)
            if !s.detail.isEmpty { Text(s.detail).font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.trailing) }
        }
        .accessibilityElement(children: .combine)
    }

    private func load() async {
        guard let client = engine.client else { loadError = "Set up the hub connection first."; return }
        do { counts = try await client.connections().health; loadError = nil } catch { loadError = (error as? HubError)?.errorDescription ?? error.localizedDescription }
    }
}

/// The first part of the Health screen on the iPhone and iPad: Apple Health, whether this device syncs with it, and
/// the way to its page.
struct AppleHealthStatus: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject private var health = AppleHealthSwitch.shared
    /// A card in the wide window's grid instead of list rows.
    var card = false

    private var state: String {
        if model.config.sampleMode { return HealthImporter.sampleOff }
        guard health.on(model) else { return "Not synced with Apple Health" }
        guard let d = model.config.lastHealthImport else { return "Synced with Apple Health" }
        return "Synced with Apple Health, last \(d.shortDateTime)"
    }

    var body: some View {
        if card {
            VStack(alignment: .leading, spacing: 10) {
                label
                PageLink { AppleHealthSettingsView() } label: { Text("Apple Health settings") }
            }
            .gridCard()
            .task { health.refresh() }
        } else {
            label
            PageLink { AppleHealthSettingsView() } label: { Text("Apple Health settings") }
                .task { health.refresh() }
        }
    }

    private var label: some View {
        HStack(spacing: 12) {
            AppleHealthIcon()
            VStack(alignment: .leading, spacing: 2) {
                Text("Apple Health")
                Text(state).font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }
}
#endif
