import SwiftUI
import EACore

/// A service that needs your own key or app (Gmail, Confluence, Steam playtime): the hub's guide for it, one step at a
/// time, with this hub's own values to copy, the service's own page, and at the end the fields to paste, saved to the
/// hub and checked. The same guide the web app shows (`GET /connections/guides/:service`).
struct OwnKeyGuideView: View {
    @EnvironmentObject var engine: SyncEngine
    @Environment(\.dismiss) private var dismiss
    let service: String
    var onDone: () -> Void = {}

    @State private var guide: OwnKeyGuide?
    @State private var loadError: String?
    @State private var index = 0
    @State private var values: [String: String] = [:]
    @State private var busy = false
    @State private var message: (ok: Bool, text: String)?
    @State private var copied: String?
    @State private var showAnyway = false

    var body: some View {
        Form {
            if let g = guide, let w = g.warning, !showAnyway {
                // The hub's address stops this service from working: say so first, not after ten minutes of steps.
                SwiftUI.Section {
                    Text("Not on this hub yet. \(w)").foregroundStyle(.red)
                    Text("Everything else works without it. Once the hub has a Tailscale address, open this guide from that address and the steps fill in the right values.")
                        .foregroundStyle(.secondary)
                    Button("Show the steps anyway") { showAnyway = true }
                }
            } else if let g = guide {
                let step = g.steps[index]
                if let w = g.warning {
                    SwiftUI.Section { Text(w).foregroundStyle(.red) }
                }
                SwiftUI.Section {
                    Text(step.text)
                    if let link = step.link, let url = URL(string: link.url) {
                        Link(destination: url) { Label(link.label, systemImage: "arrow.up.right.square") }
                    }
                    ForEach(step.copy ?? [], id: \.self) { c in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(c.label).font(.footnote).foregroundStyle(.secondary)
                            HStack(alignment: .firstTextBaseline) {
                                Text(c.value).font(.callout.monospaced()).textSelection(.enabled)
                                Spacer()
                                Button(copied == c.value ? "Copied" : "Copy") { Homelab.copy(c.value); copied = c.value }
                                    .buttonStyle(.borderless)
                            }
                        }
                    }
                    if let fields = step.fields {
                        ForEach(fields, id: \.self) { f in
                            let binding = Binding(get: { values[f.id] ?? "" }, set: { values[f.id] = $0 })
                            Group {
                                if f.secret { SecureField(f.label, text: binding) } else { TextField(f.label, text: binding) }
                            }
                            .textContentType(.none)
                            .autocorrectionDisabled()
                            #if os(iOS)
                            .textInputAutocapitalization(.never)
                            #endif
                        }
                        Button(busy ? "Checking" : step.test != nil ? "Save and check" : "Save") { save(g, step) }
                            .disabled(busy || fields.contains { (values[$0.id] ?? "").trimmingCharacters(in: .whitespaces).isEmpty })
                    }
                    if let m = message { Text(m.text).foregroundStyle(m.ok ? Color.secondary : Color.red) }
                } header: {
                    Text("Step \(index + 1) of \(g.steps.count): \(step.title)")
                } footer: {
                    Text("About \(g.minutes) minutes in all. Values you paste are kept on your hub only and never shown again.")
                }
                SwiftUI.Section {
                    HStack {
                        Button("Back") { index -= 1; message = nil }.disabled(index == 0)
                        Spacer()
                        if index < g.steps.count - 1 { Button("Next") { index += 1; message = nil } }
                    }
                    .buttonStyle(.borderless)
                }
            } else if let e = loadError {
                Text(e).foregroundStyle(.red)
            } else {
                ProgressView()
            }
        }
        .navigationTitle(guide?.title ?? "Setup guide")
        .task { await load() }
    }

    private func load() async {
        guard guide == nil, let c = engine.client else { return }
        do { guide = try await withDeadline(20) { try await c.ownKeyGuide(service: service) } }
        catch { loadError = (error as? HubError)?.errorDescription ?? error.localizedDescription }
    }

    private func save(_ g: OwnKeyGuide, _ step: OwnKeyGuide.Step) {
        guard let c = engine.client, let route = step.save else { return }
        let body = Dictionary(uniqueKeysWithValues: (step.fields ?? []).map { ($0.id, (values[$0.id] ?? "").trimmingCharacters(in: .whitespaces)) })
        busy = true
        message = nil
        Task {
            defer { busy = false }
            do {
                try await withDeadline(30) { try await c.ownKeySave(path: route.path, values: body) }
                var text = "Saved. "
                if let t = step.test {
                    let r = try await withDeadline(30) { try await c.ownKeyTest(path: t.path) }
                    guard r.ok else { message = (false, r.message); return }
                    text = r.message + " "
                }
                values = [:]
                message = (true, text + g.after)
                onDone()
            } catch {
                message = (false, (error as? HubError)?.errorDescription ?? error.localizedDescription)
            }
        }
    }
}
