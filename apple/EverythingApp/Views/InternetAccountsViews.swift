import SwiftUI
import AuthenticationServices
import EACore

/// Settings, Connections, Internet Accounts on the iPhone, iPad and Mac (gnomecannon/aeneas#10, #23), as in the web,
/// Windows and Android apps: every iCloud, Google and other mail account, each opened to what it brings in (Mail,
/// Calendars, and Reminders on the first iCloud account), Read only, the Aeneas modules that read it (Receipts and
/// renewals, with Read now), its calendars and Remove; and Add Account (iCloud, Google with an app password, or another
/// provider).
/// The Apple apps had only iCloud Mail and Sign in with Google, so accounts added elsewhere could not be seen,
/// switched or removed here, and a hub reached by Direct link has no browser to fall back on.

/// What the Connections screens show, shared by the list and an account's own page.
@MainActor
final class ConnectionsStore: ObservableObject {
    @Published var c: Connections?
    @Published var loadError: String?
    /// The hub's calendar accounts, while Calendar accounts is on.
    @Published var calendars: HubCalendars?
    @Published var calendarsError: String?

    func load(_ client: HubClient?, calendarsOn: Bool) async {
        guard let client else { return }
        do { c = try await client.connections(); loadError = nil } catch { loadError = error.localizedDescription }
        guard calendarsOn else { calendars = nil; return }
        do { calendars = try await client.calendars(); calendarsError = nil } catch { calendars = nil; calendarsError = error.localizedDescription }
    }

    /// The account Apple Reminders' switch sits on: the first iCloud one.
    var remindersAccount: String? { c?.internet?.first { $0.kind == "icloud" }?.key }
}

/// The accounts, each a row that opens its page, Apple Reminders on its own line while no iCloud account is linked,
/// and Add Account.
struct InternetAccountsSection: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var engine: SyncEngine
    @ObservedObject var store: ConnectionsStore
    var note: (ok: Bool, text: String)?
    let reload: () async -> Void

    private var mailOn: Bool { model.isOn(.mail) || model.modules.isOnListed(.mailInbox) }
    private var canAdd: Bool { mailOn || model.isOn(.calendars) }

    var body: some View {
        SwiftUI.Section {
            if let accounts = store.c?.internet {
                ForEach(accounts) { a in
                    PageLink { AccountSettingsView(key: a.key, store: store, reload: reload) } label: { row(a) }
                }
                if accounts.isEmpty { Text("No accounts yet.").foregroundStyle(.secondary) }
                if store.remindersAccount == nil { RemindersSwitch(standalone: true) }
                if canAdd {
                    PageLink { AddAccountView(store: store, reload: reload) } label: { Label("Add Account", systemImage: "plus.circle") }
                } else {
                    Text("To add an account, turn on Mail, Receipts and renewals, or Calendar accounts in Settings, Modules.").font(.footnote).foregroundStyle(.secondary)
                }
            } else if let c = store.c {
                // A hub from before Internet Accounts: its accounts to look at, and what to do.
                ForEach((c.icloud?.accounts ?? []) + (c.google?.accounts ?? [])) { a in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(a.email).font(.body.weight(.semibold))
                        if let e = a.last_error, !e.isEmpty { Text(e).font(.caption).foregroundStyle(.dangerText) }
                    }
                }
                Text("This hub is older than the app. Update the hub in Settings, About, then add, change or remove accounts here.").font(.footnote).foregroundStyle(.warnText)
            }
            if let note { Text(note.text).font(.footnote).foregroundStyle(note.ok ? AnyShapeStyle(.secondary) : AnyShapeStyle(.dangerText)) }
        } header: {
            Text("Internet Accounts")
        } footer: {
            Text("Your iCloud, Google and other mail accounts, and what each brings into Aeneas. Passwords stay on your hub and are never shown again.")
        }
        .themedRow()
    }

    private func row(_ a: InternetAccount) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(a.email).font(.body.weight(.semibold))
            Text("\(a.kindLabel): \(a.summary(mail: model.modules.isOnListed(.mailInbox), calendars: model.isOn(.calendars), receipts: model.isOn(.mail), reminders: a.key == store.remindersAccount && model.isOn(.appleReminders)))")
                .font(.footnote).foregroundStyle(.secondary)
            if let e = a.last_error, !e.isEmpty { Text(e).font(.caption).foregroundStyle(.dangerText).lineLimit(2) }
        }
    }
}

/// Apple Reminders' switch: the module's own (one setting for every device), moved here from Settings, Modules. The
/// iPhone and Mac sync Reminders themselves; iCloud does not give Reminders to servers.
struct RemindersSwitch: View {
    @EnvironmentObject var model: AppModel
    /// On its own line, while no iCloud account is linked.
    var standalone = false
    @State private var pending: Bool?
    @State private var error: String?

    var body: some View {
        Toggle(isOn: Binding(get: { pending ?? model.isOn(.appleReminders) }, set: { v in
            pending = v
            error = nil
            Task {
                do { try await model.setModules([AppModule.appleReminders.rawValue: v]) } catch { self.error = error.localizedDescription }
                pending = nil
            }
        })) {
            VStack(alignment: .leading, spacing: 2) {
                Text(standalone ? "Reminders on your iPhone and Mac" : "Reminders")
                Text(standalone ? "Synced by your iPhone and Mac. Once you add your iCloud account, this switch is on it." : "Synced by your iPhone and Mac").font(.caption).foregroundStyle(.secondary)
            }
        }
        .disabled(pending != nil)
        if let error { Text(error).font(.caption).foregroundStyle(.dangerText) }
        if model.isOn(.appleReminders) { RemindersOnThisDevice() }
    }
}

/// This device's side of Reminders sync: its own switch, access, the last sync and Sync now.
struct RemindersOnThisDevice: View {
    @ObservedObject private var sync = RemindersSync.shared

    private var device: String {
        #if os(macOS)
        "this Mac"
        #else
        UIDevice.current.userInterfaceIdiom == .pad ? "this iPad" : "this iPhone"
        #endif
    }

    var body: some View {
        Toggle("Sync on \(device)", isOn: Binding(get: { sync.enabled }, set: { on in
            // Turning it on here is the person asking for it, so access is asked for now if it never was.
            if on { Task { await sync.turnOn() } } else { sync.enabled = false }
        }))
        if sync.enabled {
            switch sync.access {
            case .notDetermined:
                Button("Allow access to Reminders") { Task { await sync.requestAccess() } }
            case .denied, .restricted, .writeOnly:
                Text("Reminders access is off. Turn on Full Access for Aeneas in \(systemSettingsName.replacingOccurrences(of: "Open ", with: "")).")
                    .font(.caption).foregroundStyle(.secondary)
                Button(systemSettingsName) { openPrivacySettings("Privacy_Reminders") }
            case .full:
                LabeledContent("Last sync", value: sync.lastRun.map { $0.formatted(date: .abbreviated, time: .shortened) } ?? "Not yet")
                if let s = sync.lastSummary { Text(s).font(.caption).foregroundStyle(.secondary) }
                if let e = sync.lastError { Text(e).font(.caption).foregroundStyle(.dangerText) }
                Button(sync.running ? "Syncing" : "Sync now") { Task { await sync.runNow(reason: "button") } }.disabled(sync.running)
            }
        }
    }
}

/// One account's page: what it brings in, Read only, the Aeneas modules that read it, its calendars and Remove.
struct AccountSettingsView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var engine: SyncEngine
    @Environment(\.dismiss) private var dismiss
    let key: String
    @ObservedObject var store: ConnectionsStore
    let reload: () async -> Void

    @State private var busy = false
    @State private var message: (ok: Bool, text: String)?
    @State private var confirmRemove = false
    /// A switch whose change removes the account (its last use), waiting for a yes.
    @State private var lastUse: Change?
    @State private var stopCalendars = false

    struct Change: Identifiable { let id = UUID(); var what: String; var inbox: Bool?; var receipts: Bool? }

    private var account: InternetAccount? { store.c?.internet?.first { $0.key == key } }
    /// Receipts and renewals reads this address through its Sign in with Google link.
    private var viaGoogle: Bool { guard let a = account, a.kind != "google" else { return false }; return store.c?.internet?.contains { $0.kind == "google" && $0.email == a.email } ?? false }
    private static let lastUseText = "Nothing else uses this account, so it is removed and its password deleted from the hub. What was filed from its mail stays, and the account itself stays with your provider."

    var body: some View {
        Form {
            if let a = account { content(a) } else { Text("This account is not linked any more.").foregroundStyle(.secondary).themedRow() }
        }
        .formStyle(.grouped)
        .themedScreen()
        .navigationTitle(account?.email ?? "Account")
        .confirmationDialog(lastUse.map { "Turn \($0.what) off?" } ?? "", isPresented: Binding(get: { lastUse != nil }, set: { if !$0 { lastUse = nil } }), titleVisibility: .visible, presenting: lastUse) { ch in
            Button("Turn off and remove", role: .destructive) { set(inbox: ch.inbox, receipts: ch.receipts) }
        } message: { _ in Text(Self.lastUseText) }
        .confirmationDialog("Remove \(account?.email ?? "this account")?", isPresented: $confirmRemove, titleVisibility: .visible) {
            Button("Remove Account", role: .destructive) { remove() }
        } message: {
            Text("Its password is deleted from the hub, and so is its mail on the Mail screen\(account?.features.calendars == true ? "; its calendars stop syncing" : ""). What was filed from its mail stays, and the account itself stays with your provider.")
        }
        .confirmationDialog("Stop keeping \(account?.email ?? "its")'s calendars in step?", isPresented: $stopCalendars, titleVisibility: .visible) {
            Button("Stop syncing", role: .destructive) { act { try await $0.stopCalendarSync(email: account?.email ?? "") } }
        } message: {
            Text("Its events stay in the app as they are; repeating ones are taken out.\(account.map { $0.features.lastUseOff(calendars: false) } == true ? " \(Self.lastUseText)" : "")")
        }
    }

    @ViewBuilder private func content(_ a: InternetAccount) -> some View {
        let mail = model.modules.isOnListed(.mailInbox) && a.features.inbox != nil
        let calendars = model.isOn(.calendars) && a.features.calendars != nil
        let reminders = a.key == store.remindersAccount
        if mail || calendars || reminders {
            SwiftUI.Section {
                if mail {
                    Toggle("Mail", isOn: Binding(get: { a.features.inbox == true }, set: { v in change("Mail", a, inbox: v) })).disabled(busy)
                }
                if calendars {
                    Toggle("Calendars", isOn: Binding(get: { a.features.calendars == true }, set: { v in
                        if v { act { c in _ = try await c.linkICloudCalendars(email: a.email, password: nil); return "Choose the calendars to keep in step." } } else { stopCalendars = true }
                    })).disabled(busy)
                }
                if reminders { RemindersSwitch() }
            } header: {
                Text(a.kindLabel)
            } footer: {
                if reminders && model.isOn(.appleReminders) {
                    Text(InternetAccount.remindersNote + (a.read_only == true ? " Read only does not reach them: your iPhone and Mac write them through Apple's own Reminders." : ""))
                }
            }
            .themedRow()
        }
        SwiftUI.Section {
            if a.hasReadOnlySwitch {
                Toggle("Read only", isOn: Binding(get: { a.read_only == true }, set: { v in act { c in _ = try await c.setAccountFeatures(key: a.key, readOnly: v); return v ? "Read only: Aeneas changes nothing in this account now." : "Aeneas may change this account again, as you ask it to." } })).disabled(busy)
            } else if a.kind == "google" {
                LabeledContent("Read only", value: "Always")
            }
            if let e = a.last_error, !e.isEmpty { Text(e).font(.footnote).foregroundStyle(.dangerText) }
            if let message { Text(message.text).font(.footnote).foregroundStyle(message.ok ? AnyShapeStyle(.secondary) : AnyShapeStyle(.dangerText)) }
        } footer: {
            if a.kind == "google" {
                Text("Signed in with Google, the hub may read this mail and nothing else, so it can't show in Mail. To see it in Mail, add it again as Google with an app password; Receipts and renewals goes on reading it here.")
            } else if a.read_only == true {
                Text(InternetAccount.readOnlyNote)
            }
        }
        .themedRow()
        if model.isOn(.mail) && a.features.receipts != nil {
            SwiftUI.Section {
                Toggle(isOn: Binding(get: { a.features.receipts == true }, set: { v in change("Receipts and renewals", a, receipts: v) })) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Receipts and renewals")
                        Text("Files renewals, bills and vet visits from its mail").font(.caption).foregroundStyle(.secondary)
                    }
                }
                .disabled(busy || a.kind == "google" || viaGoogle)
                if a.features.receipts == true, let r = a.receipts {
                    Text(r.summary).font(.footnote)
                    LabeledContent("Last checked", value: a.last_sync.flatMap(ISO.date).map(\.shortDateTime) ?? "Never")
                    let waiting = r.to_read ?? 0
                    Button(store.c?.google?.reading == true ? "Reading the waiting mail" : waiting > 0 ? "Read now (\(waiting) waiting)" : "Read now") {
                        act { c in _ = try await c.readMailNow(account: a.key); return "Reading the waiting mail now. It stops for any chat." }
                    }
                    .disabled(busy || store.c?.google?.reading == true)
                }
            } header: {
                Text("Aeneas modules that read this account")
            } footer: {
                Text(viaGoogle
                     ? "Receipts and renewals reads this address through its Sign in with Google link, so each mail is filed once."
                     : "Receipts and renewals: the hub checks for new mail every 15 minutes and reads it \(ConnectionsSettingsView.readTimes(store.c?.google?.times)) when no game is using the GPU. For receipts, folders are opened read-only and nothing is marked read; the mail itself is never kept.")
            }
            .themedRow()
        }
        if model.isOn(.calendars), a.features.calendars == true {
            AccountCalendarsSection(email: a.email, store: store, reload: reload)
        }
        SwiftUI.Section {
            Button("Remove Account", role: .destructive) { confirmRemove = true }.disabled(busy)
        }
        .themedRow()
    }

    /// Mail or Receipts and renewals on or off; the last use of the account asks first, since the hub then removes it.
    private func change(_ what: String, _ a: InternetAccount, inbox: Bool? = nil, receipts: Bool? = nil) {
        if a.features.lastUseOff(inbox: inbox, receipts: receipts) { lastUse = Change(what: what, inbox: inbox, receipts: receipts); return }
        set(inbox: inbox, receipts: receipts)
    }

    private func set(inbox: Bool?, receipts: Bool?) {
        act { c in
            let r = try await c.setAccountFeatures(key: key, inbox: inbox, receipts: receipts)
            if r.removed == true { dismiss() }
            return r.removed == true ? (r.message ?? "Removed.") : nil
        }
    }

    private func remove() {
        act { c in
            let m = try await c.removeAccount(key: key)
            dismiss()
            return m
        }
    }

    /// One call to the hub, then everything that shows it: the accounts, the module list and this device's events.
    private func act(_ f: @escaping (HubClient) async throws -> String?) {
        guard let client = engine.client else { return }
        busy = true
        message = nil
        Task {
            do { if let t = try await f(client) { message = (true, t) } } catch { message = (false, error.localizedDescription) }
            await reload()
            await model.refreshModules()
            EventMirrorSync.shared.scheduleRun(after: 1)
            busy = false
        }
    }
}

/// An iCloud account's calendars: which to keep in step, where new events go (none while Read only), Sync now.
struct AccountCalendarsSection: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var engine: SyncEngine
    let email: String
    @ObservedObject var store: ConnectionsStore
    let reload: () async -> Void
    @State private var busy = false
    @State private var message: (ok: Bool, text: String)?

    private var account: HubCalendars.Account? { store.calendars?.accounts.first { $0.email.lowercased() == email.lowercased() } }

    var body: some View {
        SwiftUI.Section {
            if let a = account {
                ForEach(a.calendars) { cal in
                    Toggle(isOn: Binding(get: { cal.chosen }, set: { on in
                        var chosen = a.calendars.filter(\.chosen).map(\.url)
                        if on { chosen.append(cal.url) } else { chosen.removeAll { $0 == cal.url } }
                        let target = a.target.flatMap { chosen.contains($0) ? $0 : nil }
                        act { _ = try await $0.chooseCalendars(email: a.email, chosen: chosen, target: target); return on ? "\(cal.name) is kept in step." : "\(cal.name) is no longer synced; its events stay as they are." }
                    })) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(cal.name)
                            if !cal.writable { Text("read only").font(.caption).foregroundStyle(.secondary) }
                        }
                    }
                    .disabled(busy)
                }
                if a.read_only != true {
                    let writable = a.calendars.filter { $0.chosen && $0.writable }
                    Picker("New events go to", selection: Binding(get: { a.target ?? "" }, set: { t in
                        let chosen = a.calendars.filter(\.chosen).map(\.url)
                        act { _ = try await $0.chooseCalendars(email: a.email, chosen: chosen, target: t.isEmpty ? nil : t); return t.isEmpty ? "Events made in Aeneas stay in the app." : "Events made in Aeneas go to \(a.calendars.first { $0.url == t }?.name ?? "that calendar")." }
                    })) {
                        Text("Keep them in the app").tag("")
                        ForEach(writable) { Text($0.name).tag($0.url) }
                    }
                    .disabled(busy)
                }
                LabeledContent("Last sync", value: a.last_sync.flatMap(ISO.date).map(\.shortDateTime) ?? "Not yet")
                if let e = a.last_error, !e.isEmpty { Text(e).font(.caption).foregroundStyle(.dangerText) }
                Button(busy ? "Syncing" : "Sync now") {
                    act { c in
                        let v = try await c.syncCalendarsNow()
                        return v.accounts.first { $0.email == a.email }?.last_error ?? "Synced."
                    }
                }
                .disabled(busy)
            } else if let e = store.calendarsError {
                Text("The calendars could not be read: \(e)").font(.footnote).foregroundStyle(.dangerText)
            } else {
                ProgressView()
            }
            if let message { Text(message.text).font(.footnote).foregroundStyle(message.ok ? AnyShapeStyle(.secondary) : AnyShapeStyle(.dangerText)) }
        } header: {
            Text("Calendars to keep in step")
        } footer: {
            Text(account?.read_only == true
                 ? "Read only: the hub reads these calendars every 5 minutes and writes none of them. New events made in Aeneas stay in the app, and changes to these events stay in iCloud's version."
                 : "The hub syncs the chosen calendars every 5 minutes and soon after you change an event here: title, times and place, both ways. Notes, alerts and invitees stay as they are in iCloud. Repeating events come in but are changed in iCloud only. Work events never leave the hub.")
        }
        .themedRow()
    }

    /// One call to the hub, then the calendars, the module list (whether the hub keeps them now) and a mirror run so
    /// this device steps aside or back at once.
    private func act(_ f: @escaping (HubClient) async throws -> String) {
        guard let client = engine.client else { return }
        busy = true
        message = nil
        Task {
            do { message = (true, try await f(client)) } catch { message = (false, error.localizedDescription) }
            await reload()
            await model.refreshModules()
            EventMirrorSync.shared.scheduleRun(after: 1)
            await engine.sync()
            busy = false
        }
    }
}

/// Add Account: iCloud (an app-specific password), Google (an app password: Mail and Receipts and renewals with one
/// password, nothing to set up at Google), or another provider. Sign in with Google, which reads mail for Receipts and
/// renewals only, is offered once the hub's own Google app is added under App keys.
struct AddAccountView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var engine: SyncEngine
    @Environment(\.dismiss) private var dismiss
    @Environment(\.webAuthenticationSession) private var webAuth
    @ObservedObject var store: ConnectionsStore
    let reload: () async -> Void

    enum Kind: String, CaseIterable, Identifiable { case icloud, google, other; var id: String { rawValue } }
    @State private var kind: Kind = .icloud
    @State private var email = ""
    @State private var password = ""
    @State private var host = ""
    @State private var port = "993"
    @State private var user = ""
    @State private var busy = false
    @State private var message: (ok: Bool, text: String)?

    private var mailOn: Bool { model.isOn(.mail) || model.modules.isOnListed(.mailInbox) }
    private var kinds: [Kind] { Kind.allCases.filter { $0 == .icloud ? (mailOn || model.isOn(.calendars)) : mailOn } }
    private var ready: Bool {
        !email.trimmingCharacters(in: .whitespaces).isEmpty && !password.trimmingCharacters(in: .whitespaces).isEmpty
            && (kind != .other || !host.trimmingCharacters(in: .whitespaces).isEmpty)
    }

    var body: some View {
        Form {
            if kinds.count > 1 {
                SwiftUI.Section {
                    Picker("Kind of account", selection: $kind) {
                        ForEach(kinds) { k in Text(k == .icloud ? "iCloud" : k == .google ? "Google" : "Another provider").tag(k) }
                    }
                    .pickerStyle(.segmented)
                }
                .themedRow()
            }
            SwiftUI.Section {
                TextField(kind == .icloud ? "Apple Account email" : "Email address", text: $email)
                    .textContentType(.username)
                    .autocorrectionDisabled()
                    #if os(iOS)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.emailAddress)
                    #endif
                if kind == .other {
                    TextField("IMAP server, like imap.example.com", text: $host)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                        #endif
                    TextField("Port", text: $port)
                        #if os(iOS)
                        .keyboardType(.numberPad)
                        #endif
                    TextField("Username, if it is not the address", text: $user)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                }
                SecureField(kind == .icloud ? "App-specific password" : "App password", text: $password)
                    .textContentType(.password)
                switch kind {
                case .icloud: Link(destination: URL(string: "https://account.apple.com/account/manage")!) { Label("Open account.apple.com", systemImage: "arrow.up.right.square") }
                case .google: Link(destination: URL(string: "https://myaccount.google.com/apppasswords")!) { Label("Open Google's app passwords", systemImage: "arrow.up.right.square") }
                case .other: EmptyView()
                }
                Button(busy ? "Checking" : "Add Account") { add() }
                    .disabled(busy || !ready)
                if let message { Text(message.text).font(.footnote).foregroundStyle(message.ok ? AnyShapeStyle(.secondary) : AnyShapeStyle(.dangerText)) }
            } footer: {
                switch kind {
                case .icloud:
                    Text("Apple has no sign-in for mail or calendars, so the hub uses an app-specific password: at account.apple.com, open Sign-In and Security, App-Specific Passwords, and make one named Aeneas. It is kept only on your hub.")
                case .google:
                    Text("Turn on 2-Step Verification for your Google Account, then make an app password named Aeneas. Google shows it once, as 16 letters. One app password works for Mail and for Receipts and renewals, and nothing is set up at Google.")
                case .other:
                    Text("Your provider's help pages give its IMAP server and port, and where to make an app password. The hub connects with TLS only (most often port 993), and only to servers on the internet, never one on your own network.")
                }
            }
            .themedRow()
            if kind == .icloud {
                SwiftUI.Section {
                    PageLink { OwnKeyGuideView(service: "icloud") { Task { await reload() } } } label: { Label("Step by step, with the guide", systemImage: "list.number") }
                }
                .themedRow()
            }
            if kind == .google, model.isOn(.mail), store.c?.google?.app == true {
                SwiftUI.Section {
                    Button { signInWithGoogle() } label: { Label(busy ? "Waiting for Google" : "Sign in with Google", systemImage: "envelope.badge.person.crop") }
                        .disabled(busy)
                } header: {
                    Text("Or, for Receipts and renewals only")
                } footer: {
                    Text("Google lets the hub read mail and nothing else this way, so the account can't show in Mail.")
                }
                .themedRow()
            }
        }
        .formStyle(.grouped)
        .themedScreen()
        .navigationTitle("Add Account")
        .onAppear { if !kinds.contains(kind), let k = kinds.first { kind = k } }
    }

    private func add() {
        guard let client = engine.client else { return }
        let address = email.trimmingCharacters(in: .whitespaces)
        let pass = password.trimmingCharacters(in: .whitespaces)
        busy = true
        message = nil
        Task {
            do {
                switch kind {
                case .icloud:
                    // With only Calendar accounts on, the account is linked for its calendars.
                    if mailOn { try await client.linkICloudMail(email: address, password: pass) }
                    else { _ = try await client.linkICloudCalendars(email: address, password: pass) }
                case .google:
                    try await client.linkImap(email: address, password: pass, gmail: true)
                case .other:
                    let u = user.trimmingCharacters(in: .whitespaces)
                    try await client.linkImap(email: address, password: pass, gmail: false, host: host.trimmingCharacters(in: .whitespaces), port: Int(port) ?? 993, user: u.isEmpty ? nil : u)
                }
                password = ""
                await reload()
                busy = false
                dismiss()
            } catch {
                message = (false, error.localizedDescription)
                busy = false
            }
        }
    }

    /// Google's account chooser in a secure browser sheet; the hub sends it back to everythingapp://google.
    private func signInWithGoogle() {
        guard let client = engine.client else { return }
        busy = true
        message = nil
        Task {
            defer { busy = false }
            do {
                let url = try await client.googleSignInURL()
                let back = try await webAuth.authenticate(using: url, callbackURLScheme: "everythingapp")
                let q = URLComponents(url: back, resolvingAgainstBaseURL: false)?.queryItems ?? []
                if let err = q.first(where: { $0.name == "error" })?.value { message = (false, err) }
                else { message = (true, q.first(where: { $0.name == "message" })?.value ?? "Gmail linked.") }
            } catch let e as ASWebAuthenticationSessionError where e.code == .canceledLogin {
                message = (false, "Sign-in cancelled.")
            } catch {
                message = (false, error.localizedDescription)
            }
            await reload()
        }
    }
}

/// App keys (called Keys until 2026-11-24): the hub's own registrations a service needs before anyone can sign in
/// (Google app for Sign in with Google, Atlassian app for Confluence, Steam key), each made once with its guide. Apart
/// from the accounts and services, at the end, since they are made once and then rarely looked at; each shows only
/// while its module is on. Each row says what it is for and whether the hub has it, as a status, and opens its own page
/// (a saved key was drawn as "Set", which read like a button and did nothing when tapped).
struct AppKeysSection: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject var store: ConnectionsStore
    let reload: () async -> Void

    private var keys: [AppKey.Shown] { store.c.map { c in AppKey.shown(in: c) { model.isOn($0) } } ?? [] }

    var body: some View {
        if !keys.isEmpty {
            SwiftUI.Section {
                // Why these are asked for, before the rows: optional, and each only for the feature it names.
                Text(AppKey.intro).font(.footnote).foregroundStyle(.secondary)
                ForEach(keys) { k in
                    PageLink { AppKeyView(key: k.key, store: store, reload: reload) } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(alignment: .firstTextBaseline) {
                                Text(k.key.name)
                                Spacer()
                                AppKeyStatus(added: k.added).font(.callout)
                            }
                            Text(k.key.purpose).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            } header: {
                Text("App keys")
            }
            .themedRow()
        }
    }
}

/// One app key's own page: whether the hub has it, what it is, why the service asks for it, what in Aeneas uses it and
/// what works without it, and one action that opens the guide: Set it up, or Replace with a new key (the guide's last
/// step saves the new one in place of the old).
struct AppKeyView: View {
    @EnvironmentObject var model: AppModel
    let key: AppKey
    @ObservedObject var store: ConnectionsStore
    let reload: () async -> Void

    /// From the hub's latest answer, so the page says Added as soon as the guide has saved the key.
    private var added: Bool { store.c.flatMap { c in key.added(in: c) { model.isOn($0) } } ?? false }

    var body: some View {
        Form {
            SwiftUI.Section {
                LabeledContent("Status") { AppKeyStatus(added: added) }
            } footer: {
                Text(key.purpose)
            }
            .themedRow()
            explained("What it is", key.what)
            explained("Why \(key.by) asks for it", key.why)
            explained("What uses it", key.uses)
            explained("Without it", key.without)
            SwiftUI.Section {
                PageLink { OwnKeyGuideView(service: key.service) { Task { await reload() } } } label: {
                    Label(added ? "Replace with a new key" : "Set it up", systemImage: added ? "arrow.triangle.2.circlepath" : "key")
                }
            } footer: {
                if added { Text(key.replacing) }
            }
            .themedRow()
        }
        .formStyle(.grouped)
        .themedScreen()
        .navigationTitle(key.name)
    }

    private func explained(_ title: String, _ text: String) -> some View {
        SwiftUI.Section { Text(text) } header: { Text(title) }
            .themedRow()
    }
}

/// An app key's state as a status, not a verb: Added, with a checkmark in the theme's ok color, or Not added.
struct AppKeyStatus: View {
    let added: Bool

    var body: some View {
        if added {
            Label("Added", systemImage: "checkmark.circle.fill").foregroundStyle(.okText)
        } else {
            Text("Not added").foregroundStyle(.secondary)
        }
    }
}
