import SwiftUI
import UniformTypeIdentifiers
import EACore

private let pmNames = ["keepass": "Built-in vault", "bitwarden": "Bitwarden", "1password": "1Password", "lastpass": "LastPass"]

/// Settings, Connections, Password manager: LastPass, 1Password or Bitwarden (also a self-hosted Vaultwarden) through
/// its CLI on the hub's machine (LastPass also on another one it reaches, like a Mac already signed in), or the hub's own
/// KeePass file for someone with no password manager, so the assistant can use a password in a command without seeing
/// it. Every item except the ones left out here (or only the ones chosen) may be used, each command that uses one waits for approval, and the value is cut from
/// the output.
struct PasswordManagerSection: View {
    @EnvironmentObject var engine: SyncEngine
    var view: Connections.PasswordManager
    var reload: () async -> Void
    @State private var hosts: [CommandHost] = []
    @State private var provider = "keepass"
    @State private var server = ""
    @State private var host = ""
    @State private var status: PasswordManagerStatus?
    @State private var email = ""
    @State private var password = ""
    @State private var code = ""
    @State private var token = ""
    @State private var query = ""
    @State private var found: [String]?
    @State private var busy = false
    @State private var message: (ok: Bool, text: String)?
    @State private var confirmUnlink = false

    private var name: String { pmNames[provider] ?? provider }
    private var localOnly: Bool { provider != "lastpass" }
    private var chosen: Bool { view.linked && view.provider == provider && (localOnly || view.host == host) }
    private var installed: Bool { status?.installed[provider] == true }
    private var signedIn: Bool { chosen && status?.signed_in == true }

    var body: some View {
        SwiftUI.Section {
            Picker("Password manager", selection: $provider) {
                Text("Built-in vault (KeePass)").tag("keepass")
                Text("Bitwarden or Vaultwarden").tag("bitwarden")
                Text("1Password").tag("1password")
                Text("LastPass").tag("lastpass")
            }
            if provider == "lastpass" {
                Picker("Runs on", selection: $host) {
                    ForEach(hosts) { h in Text(h.local ? "\(h.name) (the hub)" : h.name).tag(h.name) }
                }
            }
            if !chosen {
                Button(provider == "keepass" ? "Make the vault" : localOnly ? "Use \(name)" : "Use \(name) on \(host)") {
                    let p = provider, h = localOnly ? "" : host, n = name
                    act { try await $0.linkPasswordManager(provider: p, host: h); return p == "keepass" ? "The built-in vault is ready." : "\(n) chosen." }
                }
                .disabled(busy || (!localOnly && host.isEmpty))
            }
            if let s = status, provider != "keepass" {
                Text(installed ? "\(name) CLI is installed on \(s.host)\(chosen ? (signedIn ? ", signed in\(s.account.map { " as \($0)" } ?? "")." : ", not signed in.") : ".")" : "\(name) CLI is not installed on \(s.host).")
                    .font(.footnote)
                if !installed, provider == "bitwarden" {
                    Button(busy ? "Installing..." : "Install the Bitwarden CLI") { act { try await $0.installPasswordManager(provider: "bitwarden"); return "The Bitwarden CLI is installed." } }.disabled(busy)
                } else if !installed, let hint = s.install_hint { Text("Install it there: \(hint)").font(.footnote).foregroundStyle(.secondary).textSelection(.enabled) }
            }
            if chosen && provider == "keepass" && status != nil && !signedIn {
                Text("The vault file is there but its master password is not known here.").font(.footnote).foregroundStyle(.secondary)
                SecureField("Master password", text: $password).textContentType(.password)
                Button("Open") { let p = password; act { try await $0.signInPasswordManager(password: p); return "The vault opens." } }.disabled(busy || password.isEmpty)
            }
            if chosen && provider == "keepass" && signedIn { KeePassItems(busy: $busy, act: act) }
            if chosen && installed && !signedIn && provider != "keepass" {
                if provider == "bitwarden" {
                    TextField("Bitwarden email", text: $email).textContentType(.username).autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never).keyboardType(.emailAddress)
                        #endif
                    SecureField("Master password", text: $password).textContentType(.password)
                    TextField("Authenticator code, if you use one", text: $code).textContentType(.oneTimeCode)
                        #if os(iOS)
                        .keyboardType(.numberPad)
                        #endif
                    TextField("Server, only for Vaultwarden or the EU cloud", text: $server).autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never).keyboardType(.URL)
                        #endif
                    Button("Sign in") {
                        let e = email.trimmingCharacters(in: .whitespaces), p = password, c = code.trimmingCharacters(in: .whitespaces), sv = server.trimmingCharacters(in: .whitespaces)
                        act { try await $0.signInPasswordManager(email: e, password: p, code: c.isEmpty ? nil : c, server: sv.isEmpty ? nil : sv); return "Signed in to Bitwarden." }
                    }
                    .disabled(busy || password.isEmpty)
                } else if provider == "lastpass" {
                    TextField("LastPass email", text: $email).textContentType(.username).autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never).keyboardType(.emailAddress)
                        #endif
                    SecureField("Master password", text: $password).textContentType(.password)
                    TextField("Authenticator code, if you use one", text: $code).textContentType(.oneTimeCode)
                        #if os(iOS)
                        .keyboardType(.numberPad)
                        #endif
                    Button("Sign in") {
                        let e = email.trimmingCharacters(in: .whitespaces), p = password, c = code.trimmingCharacters(in: .whitespaces)
                        act { try await $0.signInPasswordManager(email: e, password: p, code: c.isEmpty ? nil : c); return "Signed in to LastPass." }
                    }
                    .disabled(busy || email.isEmpty || password.isEmpty)
                } else {
                    SecureField("Service account token (ops_...)", text: $token)
                    Button("Save token") { let t = token.trimmingCharacters(in: .whitespaces); act { try await $0.signInPasswordManager(token: t); return "1Password linked." } }
                        .disabled(busy || token.isEmpty)
                }
            }
            if signedIn && view.everyItem {
                let left = view.excluded ?? []
                Picker("Items the assistant may use", selection: Binding(get: { "all" }, set: { v in if v == "chosen" { act { try await $0.setPasswordManagerAccess(access: "chosen"); return "Only the items you choose now." } } })) {
                    Text("Every item, except the ones left out").tag("all")
                    Text("Only items I choose").tag("chosen")
                }
                .disabled(busy)
                Text("The assistant learns only item names, by searching, never a password, and every command that uses one waits for your approval. An item left out is never read, even if a command names it.")
                    .font(.footnote).foregroundStyle(.secondary)
                if left.isEmpty { Text("Nothing left out yet. Search to leave out items or whole folders.").font(.footnote).foregroundStyle(.secondary) }
                ForEach(left, id: \.self) { n in
                    HStack {
                        Label(n.hasSuffix("/") ? "Folder \(n)" : n, systemImage: n.hasSuffix("/") ? "folder.badge.minus" : "key.slash")
                        Spacer()
                        Button("Use again") { let rest = left.filter { $0 != n }; act { try await $0.setPasswordManagerAccess(excluded: rest); return "The assistant may use \(n) again." } }
                            .buttonStyle(.borderless).font(.footnote)
                    }
                }
                HStack {
                    TextField("Search \(name) item names", text: $query).autocorrectionDisabled().onSubmit(search)
                    Button("Search", action: search).disabled(busy)
                }
                if let found {
                    let folders = Array(Set(found.filter { $0.contains("/") }.map { String($0[...$0.lastIndex(of: "/")!]) })).sorted().filter { !left.contains($0) }
                    let fresh = found.filter { !left.contains($0) }
                    if fresh.isEmpty && folders.isEmpty { Text("No other items match.").font(.footnote).foregroundStyle(.secondary) }
                    ForEach(folders, id: \.self) { f in
                        Button { act { try await $0.setPasswordManagerAccess(excluded: left + [f]); return "Folder \(f) left out." } } label: { Label("Leave out folder \(f)", systemImage: "folder.badge.minus") }
                            .disabled(busy)
                    }
                    ForEach(fresh, id: \.self) { n in
                        Button { act { try await $0.setPasswordManagerAccess(excluded: left + [n]); return "\(n) left out." } } label: { Label("Leave out \(n)", systemImage: "minus.circle") }
                            .disabled(busy)
                    }
                }
            }
            if signedIn && !view.everyItem {
                if view.access != nil {
                    Button("Let it use every item, except ones I leave out") { act { try await $0.setPasswordManagerAccess(access: "all"); return "Every item, except the ones left out." } }
                        .disabled(busy).font(.footnote)
                }
                if view.allowed.isEmpty { Text("No items allowed yet. Search and allow the ones the assistant may use.").font(.footnote).foregroundStyle(.secondary) }
                ForEach(view.allowed, id: \.self) { n in
                    HStack {
                        Label(n, systemImage: "key")
                        Spacer()
                        Button("Remove", role: .destructive) { let rest = view.allowed.filter { $0 != n }; act { try await $0.allowPasswordManagerItems(rest); return "\(n) is no longer allowed." } }
                            .buttonStyle(.borderless).font(.footnote)
                    }
                }
                HStack {
                    TextField("Search \(name) item names", text: $query).autocorrectionDisabled().onSubmit(search)
                    Button("Search", action: search).disabled(busy)
                }
                if let found {
                    let fresh = found.filter { !view.allowed.contains($0) }
                    if fresh.isEmpty { Text("No other items match.").font(.footnote).foregroundStyle(.secondary) }
                    ForEach(fresh, id: \.self) { n in
                        Button { let all = view.allowed + [n]; act { try await $0.allowPasswordManagerItems(all); return "\(n) allowed." } } label: { Label("Allow \(n)", systemImage: "plus.circle") }
                            .disabled(busy)
                    }
                }
            }
            if view.linked {
                Button("Unlink \(pmNames[view.provider ?? ""] ?? "the password manager")", role: .destructive) { confirmUnlink = true }.disabled(busy)
                    .confirmationDialog("Unlink the password manager?", isPresented: $confirmUnlink, titleVisibility: .visible) {
                        Button("Unlink", role: .destructive) { act { try await $0.unlinkPasswordManager(); return "Unlinked." } }
                    } message: { Text(view.provider == "keepass" ? "The assistant stops being able to use its items. The vault file and its master password stay on the hub." : "The assistant stops being able to use its items.") }
            }
            if let m = message { Text(m.text).font(.footnote).foregroundStyle(m.ok ? Color.secondary : Color.red) }
        } header: {
            Text("Password manager")
        } footer: {
            Text("Lets the assistant use a password in a command on your machines without ever seeing it. It may use every item except the ones left out here (or only the ones you choose), every command that uses one waits for your approval, and the value is hidden from what the command prints. A master password goes to the password manager's own CLI and is not kept. No password manager? The built-in vault is a KeePass file the hub keeps, which any KeePass app opens.")
        }
        .themedRow()
        .task {
            provider = view.provider ?? "keepass"
            email = view.account ?? ""
            if let c = engine.client, let h = try? await c.commandHosts() { hosts = h.filter { $0.os != "windows" } }
            host = view.host ?? hosts.first(where: \.local)?.name ?? hosts.first?.name ?? ""
            await refresh()
        }
        .onChange(of: provider) { _, _ in Task { await refresh() } }
        .onChange(of: host) { _, _ in Task { await refresh() } }
    }

    private func refresh() async {
        guard let c = engine.client, !host.isEmpty || localOnly else { return }
        status = try? await c.passwordManagerStatus(provider: provider, host: host)
    }

    private func search() {
        let q = query
        act { found = try await $0.passwordManagerItems(query: q); return "" }
    }

    private func act(_ f: @escaping (HubClient) async throws -> String) {
        guard let client = engine.client else { return }
        busy = true
        message = nil
        Task {
            do { let t = try await f(client); message = t.isEmpty ? nil : (true, t) } catch { message = (false, error.localizedDescription) }
            password = ""; code = ""; token = ""
            await reload()
            await refresh()
            busy = false
        }
    }
}

/// The built-in vault's items: add one (an empty password is made up on the hub), remove one, take the file to a
/// KeePass app, or bring in a KeePass file the owner already has.
private struct KeePassItems: View {
    @EnvironmentObject var engine: SyncEngine
    @Binding var busy: Bool
    var act: (@escaping (HubClient) async throws -> String) -> Void
    @State private var entries: [KeePassEntry] = []
    @State private var title = ""
    @State private var username = ""
    @State private var password = ""
    @State private var url = ""
    @State private var master: String?
    @State private var fileURL: URL?
    @State private var importing = false
    @State private var picked: Data?
    @State private var pickedPassword = ""

    var body: some View {
        Group {
            if entries.isEmpty { Text("Nothing in the vault yet. Add a login below.").font(.footnote).foregroundStyle(.secondary) }
            ForEach(entries) { e in
                HStack {
                    VStack(alignment: .leading) {
                        Text(e.title)
                        if !e.username.isEmpty || !e.url.isEmpty { Text([e.username, e.url].filter { !$0.isEmpty }.joined(separator: "  ")).font(.caption).foregroundStyle(.secondary) }
                    }
                    Spacer()
                    Button("Remove", role: .destructive) { let t = e.title; act { try await $0.removeKeepassEntry(title: t); await load(); return "\(t) removed." } }
                        .buttonStyle(.borderless).font(.footnote).disabled(busy)
                }
            }
            TextField("Name, like NAS admin", text: $title).autocorrectionDisabled()
            TextField("Username", text: $username).textContentType(.username).autocorrectionDisabled()
                #if os(iOS)
                .textInputAutocapitalization(.never)
                #endif
            SecureField("Password (empty: make a strong one)", text: $password).textContentType(.newPassword)
            TextField("Address (optional)", text: $url).autocorrectionDisabled()
                #if os(iOS)
                .textInputAutocapitalization(.never).keyboardType(.URL)
                #endif
            Button("Add to the vault") {
                let t = title.trimmingCharacters(in: .whitespaces), u = username, p = password, a = url
                title = ""; username = ""; password = ""; url = ""
                act { try await $0.putKeepassEntry(title: t, username: u.isEmpty ? nil : u, password: p.isEmpty ? nil : p, url: a.isEmpty ? nil : a); await load(); return p.isEmpty ? "\(t) saved with a new random password." : "\(t) saved." }
            }
            .disabled(busy || title.trimmingCharacters(in: .whitespaces).isEmpty)
            if let master {
                HStack { Text(master).font(.footnote.monospaced()).textSelection(.enabled); Spacer(); Button("Hide") { self.master = nil }.buttonStyle(.borderless) }
            } else {
                Button("Show the master password") { act { m in let pw = try await m.keepassMaster(); await MainActor.run { master = pw }; return "" } }.disabled(busy)
            }
            if let fileURL {
                ShareLink(item: fileURL) { Label("Share the vault file", systemImage: "square.and.arrow.up") }
            } else {
                Button("Get the vault file") { act { c in let d = try await c.keepassFile(); let u = FileManager.default.temporaryDirectory.appendingPathComponent("passwords.kdbx"); try d.write(to: u, options: .completeFileProtection); await MainActor.run { fileURL = u }; return "" } }.disabled(busy)
            }
            Button("Use a KeePass file you already have") { importing = true }.disabled(busy)
            if picked != nil {
                SecureField("Its master password", text: $pickedPassword).textContentType(.password)
                Button("Use this file") {
                    let d = picked!, p = pickedPassword
                    picked = nil; pickedPassword = ""
                    act { let n = try await $0.importKeepass(d, password: p); await load(); return "Your KeePass file is the vault now (\(n) items). The old one is kept beside it on the hub. Allow the items the assistant may use below." }
                }
                .disabled(busy || pickedPassword.isEmpty)
            }
            Text("The vault is a KeePass file. Open it in KeePassXC, KeePassDX, Strongbox or KeePassium with its master password to see or change a password.").font(.footnote).foregroundStyle(.secondary)
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [UTType(filenameExtension: "kdbx") ?? .data, .data]) { r in
            guard case .success(let u) = r else { return }
            let scoped = u.startAccessingSecurityScopedResource()
            defer { if scoped { u.stopAccessingSecurityScopedResource() } }
            picked = try? Data(contentsOf: u)
        }
        .task { await load() }
    }

    private func load() async {
        if let c = engine.client, let e = try? await c.keepassEntries() { await MainActor.run { entries = e } }
    }
}
