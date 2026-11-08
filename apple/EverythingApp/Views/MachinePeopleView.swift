import SwiftUI
import CoreImage.CIFilterBuiltins
import EACore

/// Settings, People on this machine: give someone a hub of their own on the machine this hub runs on, in one step
/// (deploy/people.sh does the work as root; hub/src/hubs.ts passes the request on). Then two things are left: share
/// the machine on Tailscale, and scan the pairing code on their phone. Shown on the machine owner's hub only.
struct MachinePeopleView: View {
    @EnvironmentObject var engine: SyncEngine
    @State private var list: HubsList?
    @State private var error: String?
    @State private var name = ""
    @State private var request: HubRequest?
    @State private var op: String?
    @State private var busy = false
    @State private var confirmStop: PersonHub?

    private static let tailscaleMachines = URL(string: "https://login.tailscale.com/admin/machines")!

    var body: some View {
        Form {
            SwiftUI.Section {
                Text("Give someone a hub of their own on this machine: their own notes, chats, settings and devices, apart from yours. They use the model this machine runs; when you both ask at once, the hubs take turns.")
                if let note = list?.admin_note { Text(note).font(.callout).foregroundStyle(.secondary) }
            }
            .themedRow()

            if let list, !list.available, list.reason == "not_set_up" {
                SwiftUI.Section {
                    Text(list.setup_command).font(.system(.callout, design: .monospaced)).textSelection(.enabled)
                } header: { Text("One step first") } footer: {
                    Text("Run this once on the hub's machine, in a terminal (it asks for your password there). Then come back here.")
                }
                .themedRow()
            }

            if let list, list.available {
                SwiftUI.Section("Hubs here") {
                    ForEach(list.hubs) { h in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                HubBadge(identity: h.identity, label: h.owner ? "\(h.name) (you)" : h.name)
                                Spacer()
                                Text(h.up ? "Running" : "Not answering").font(.caption).foregroundStyle(h.up ? Color.green : Color.orange)
                            }
                            if let a = h.address { Text(a).font(.caption).foregroundStyle(.secondary).textSelection(.enabled) }
                            if !h.owner {
                                HStack {
                                    Button("New pairing code") { start("pair") { try await $0.pairHub(account: h.account) } }
                                    Spacer()
                                    Button("Stop", role: .destructive) { confirmStop = h }
                                }
                                .buttonStyle(.borderless).disabled(working)
                            }
                        }
                    }
                }
                .themedRow()

                SwiftUI.Section {
                    TextField("Their first name", text: $name)
                        .disabled(working)
                    Button(working && op == "add" ? "Adding" : "Add") {
                        let n = name.trimmingCharacters(in: .whitespaces)
                        start("add") { try await $0.addHub(name: n) }
                        name = ""
                    }
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || working)
                } header: { Text("Add a person") } footer: {
                    Text("It takes a minute or two. Their hub gets its own address and color on this machine.")
                }
                .themedRow()
            }

            if let r = request {
                SwiftUI.Section {
                    if !r.finished { Label(r.step ?? "Waiting for the machine to start on it", systemImage: "hourglass") }
                    if r.state == "failed" { Text(r.error ?? "That did not work.").foregroundStyle(.red) }
                    if r.state == "done", op == "stop" { Text("\(r.name ?? "Their")’s hub is stopped. Their data stays on this machine.") }
                    if r.state == "done", op != "stop", let p = r.pairing { nextSteps(r, p) }
                }
                .themedRow()
            }
            if let error { Text(error).foregroundStyle(.red).themedRow() }
        }
        .formStyle(.grouped)
        .themedScreen()
        .navigationTitle("People on this machine")
        .task { await load() }
        .confirmationDialog("Stop \(confirmStop?.name ?? "")’s hub?", isPresented: Binding(get: { confirmStop != nil }, set: { if !$0 { confirmStop = nil } }), titleVisibility: .visible) {
            Button("Stop their hub", role: .destructive) {
                if let h = confirmStop { start("stop") { try await $0.stopHub(account: h.account) } }
                confirmStop = nil
            }
        } message: {
            Text("Their devices stop syncing and its address goes off. Their data stays on this machine, in their own account.")
        }
    }

    private var working: Bool { busy || (request.map { !$0.finished } ?? false) }

    @ViewBuilder private func nextSteps(_ r: HubRequest, _ p: HubRequest.Pairing) -> some View {
        let who = r.name ?? "them"
        if let a = r.address {
            HubBadge(identity: HubIdentity(name: r.name, color: r.color), label: "\(who)’s hub is ready")
            Text(a).font(.callout).textSelection(.enabled)
        }
        Text("1. Share this machine with \(who) on Tailscale: in the admin console, open Machines, choose this machine, then Share. They accept with their own Tailscale account, free.")
        Link("Open the Tailscale admin console", destination: Self.tailscaleMachines)
        Text("2. On \(who)’s phone: install Aeneas and Tailscale, then scan this code with the camera.\(p.code.map { " Or type \($0) with the address above." } ?? "") It works once, for 10 minutes; if it runs out, press New pairing code beside their name.")
        if let app = p.app, let image = qr(app) {
            image.interpolation(.none).resizable().scaledToFit().frame(maxWidth: 220).padding(8).background(Color.white)
                .clipShape(RoundedRectangle(cornerRadius: 8)).frame(maxWidth: .infinity)
                .accessibilityLabel("QR code that pairs \(who)’s phone")
        }
        if let note = list?.admin_note ?? r.note { Text(note).font(.caption).foregroundStyle(.secondary) }
    }

    private func load() async {
        guard let c = engine.client else { error = "Not connected to the hub"; return }
        do { list = try await withDeadline(15) { try await c.hubs() }; error = nil }
        catch { self.error = (error as? HubError)?.errorDescription ?? error.localizedDescription }
    }

    /// Sends one request, then follows it every two seconds until it is done or failed.
    private func start(_ kind: String, _ send: @escaping @Sendable (HubClient) async throws -> HubRequestStarted) {
        guard let c = engine.client else { return }
        op = kind
        busy = true
        error = nil
        request = nil
        Task {
            defer { busy = false }
            do {
                let id = try await withDeadline(20) { try await send(c) }.request_id
                while true {
                    let r = try await withDeadline(15) { try await c.hubRequest(id) }
                    request = r
                    if r.finished { break }
                    try await Task.sleep(nanoseconds: 2_000_000_000)
                }
                await load()
            } catch {
                self.error = (error as? HubError)?.errorDescription ?? error.localizedDescription
            }
        }
    }

    private func qr(_ text: String) -> Image? {
        let f = CIFilter.qrCodeGenerator()
        f.message = Data(text.utf8)
        f.correctionLevel = "M"
        guard let out = f.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)), let cg = CIContext().createCGImage(out, from: out.extent) else { return nil }
        return Image(decorative: cg, scale: 1)
    }
}
