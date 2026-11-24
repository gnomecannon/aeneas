import SwiftUI
import EACore
#if os(iOS)
import UIKit
#endif

/// Settings, Accounts on the iPhone, iPad and Mac (since 2026-11-24), as in the web, Windows and Android apps: every
/// mail and calendar account once, each opening its own page; Add account, one sheet; what comes in from this device's
/// own Apple accounts (Calendars, Reminders, Contacts, and Health on the iPhone), one switch each; and Work. Adding a
/// mailbox took Settings, Modules first, then Connections, then Add Account, and an account's switches stayed hidden
/// until their module was on; Calendars were set in three places and Reminders had three controls. Here a switch turns
/// its module on itself. The texts are the web's (EACore AccountTexts and InternetAccount, kept the same).

/// The device's kind in a title: iPhone, iPad or Mac.
@MainActor var deviceKind: String {
    #if os(macOS)
    "Mac"
    #else
    UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone"
    #endif
}

/// What the Accounts screens show, shared by the list and an account's own page.
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
}

/// Settings, Accounts: the accounts, From this iPhone (iPad, Mac), and Work.
struct AccountsSettingsView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var engine: SyncEngine
    @StateObject private var store = ConnectionsStore()
    @State private var adding = false
    /// An account's page opened from here without a tap: just added, or `-EAAccount <address>` in Debug builds.
    @State private var opened: String?
    /// Calendars or Reminders of From this iPhone, opened by its row.
    @State private var devicePage: FromThisDeviceSection.DevicePage?
    /// What came back from an older Google sign-in (everythingapp://google), said under the accounts.
    @State private var note: (ok: Bool, text: String)?

    var body: some View {
        ScrollViewReader { proxy in
            Form {
                if engine.client == nil {
                    Text("Set up the hub connection first.").foregroundStyle(.secondary).themedRow()
                } else {
                    accounts
                    FromThisDeviceSection(health: store.c?.health, page: $devicePage).id("device")
                    WorkSpaceSection().themedRow().id("work")
                }
            }
            .task {
                #if DEBUG
                // `-EAAccountsScroll device|work`: the page opens scrolled to that part (screenshots).
                if let id = UserDefaults.standard.string(forKey: "EAAccountsScroll") {
                    try? await Task.sleep(for: .seconds(1))
                    proxy.scrollTo(id, anchor: .top)
                }
                #endif
            }
        }
        .formStyle(.grouped)
        .themedScreen()
        .navigationTitle("Accounts")
        .task { await load(); openFromLaunchArgument() }
        .onAppear { takeGoogleReturn() }
        .onChange(of: model.googleReturn) { _, _ in takeGoogleReturn() }
        .refreshable { await load() }
        .pageDestination(item: $opened) { key in AccountSettingsView(key: key, store: store, reload: { await load() }) }
        .pageDestination(item: $devicePage) { p in
            switch p {
            case .calendars: DeviceCalendarsView()
            case .reminders: DeviceRemindersView()
            }
        }
        .sheet(isPresented: $adding) {
            AddAccountSheet { key in
                await load()
                try? await Task.sleep(for: .milliseconds(400))
                opened = key
            }
        }
    }

    @ViewBuilder private var accounts: some View {
        SwiftUI.Section {
            if let list = store.c?.internet {
                ForEach(list) { a in
                    PageLink { AccountSettingsView(key: a.key, store: store, reload: { await load() }) } label: { AccountRowLabel(account: a) }
                }
                if list.isEmpty { Text("No accounts yet.").foregroundStyle(.secondary) }
                Button { adding = true } label: { AddAccountRowLabel() }
                    .buttonStyle(.borderless)
            } else if let c = store.c {
                // A hub from before Internet Accounts: its accounts to look at, and what to do.
                ForEach((c.icloud?.accounts ?? []) + (c.google?.accounts ?? [])) { a in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(a.email).font(.body.weight(.semibold))
                        if let e = a.last_error, !e.isEmpty { Text(e).font(.caption).foregroundStyle(.dangerText) }
                    }
                }
                Text("This hub is older than the app. Update the hub in Settings, About, then add, change or remove accounts here.").font(.footnote).foregroundStyle(.warnText)
            } else if let e = store.loadError {
                Text(e).foregroundStyle(.dangerText)
            } else {
                ProgressView()
            }
            if let note { Text(note.text).font(.footnote).foregroundStyle(note.ok ? AnyShapeStyle(.secondary) : AnyShapeStyle(.dangerText)) }
        } header: {
            Text("Accounts")
        } footer: {
            Text(AccountTexts.accountsFooter)
        }
        .themedRow()
    }

    private func load() async {
        await store.load(engine.client, calendarsOn: model.isOn(.calendars))
    }

    /// An older Google sign-in that came back through everythingapp://google instead of the browser sheet.
    private func takeGoogleReturn() {
        guard let r = model.googleReturn else { return }
        model.googleReturn = nil
        note = (r.ok, r.text)
        Task { await load() }
    }

    private func openFromLaunchArgument() {
        #if DEBUG
        guard let want = UserDefaults.standard.string(forKey: "EAAccount")?.lowercased(), !want.isEmpty, opened == nil,
              let a = store.c?.internet?.first(where: { $0.key == want || $0.email.lowercased() == want }) else { return }
        UserDefaults.standard.removeObject(forKey: "EAAccount")
        opened = a.key
        #endif
    }
}

/// An account's row: a letter badge, the address, what it brings in, its kind on the right.
struct AccountRowLabel: View {
    @EnvironmentObject var model: AppModel
    let account: InternetAccount

    var body: some View {
        HStack(spacing: 12) {
            LetterBadge(text: account.badgeLetter)
            VStack(alignment: .leading, spacing: 2) {
                Text(account.email).lineLimit(1).truncationMode(.middle)
                Text(account.broughtIn { model.isOn($0) }).font(.caption).foregroundStyle(.secondary)
                if let e = account.last_error, !e.isEmpty { Text(e).font(.caption).foregroundStyle(.dangerText).lineLimit(2) }
            }
            Spacer(minLength: 8)
            Text(account.kindShort).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

/// The last row of the accounts: Add account.
struct AddAccountRowLabel: View {
    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "plus")
                .font(.body.weight(.semibold))
                .foregroundStyle(.tint)
                .frame(width: 32, height: 32)
                .overlay(Circle().strokeBorder(.tint, style: StrokeStyle(lineWidth: 1, dash: [3, 2])))
            Text("Add account").foregroundStyle(.tint)
            Spacer()
        }
        .contentShape(Rectangle())
        .padding(.vertical, 2)
    }
}

/// A round badge with the first letter of an address, in the theme's accent.
struct LetterBadge: View {
    let text: String
    var body: some View {
        Text(text)
            .font(.callout.weight(.semibold))
            .foregroundStyle(.onAccent)
            .frame(width: 32, height: 32)
            .background(Circle().fill(.tint))
            .accessibilityHidden(true)
    }
}

// MARK: From this iPhone

/// From this iPhone (iPad, Mac): what this device's own accounts hold, one switch each, and a chevron to the choices
/// where there are more. Calendars is this device reading and writing Apple Calendar (it switches the Apple Calendar
/// module on when that is off, and asks for calendar access here); Reminders is this device's Reminders sync (the Apple
/// Reminders module on with it); Contacts makes this device the one that mirrors them; Health is the iPhone's import.
struct FromThisDeviceSection: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var engine: SyncEngine
    @ObservedObject private var importer = CalendarImporter.shared
    @ObservedObject private var reminders = RemindersSync.shared
    @ObservedObject private var contacts = ContactsSync.shared
    @AppStorage(ContactsSync.enabledKey) private var contactsHere = false
    /// This device's own Calendars switch (SharedConfig.appleCalendarHere), kept here so the row redraws.
    @State private var calendarsHere = SharedConfig.shared.appleCalendarHere
    #if os(iOS)
    @State private var healthHere = SharedConfig.shared.healthImportEnabled
    #endif
    let health: Connections.Health?
    @Binding var page: DevicePage?

    @State private var busy: String?
    @State private var note: (ok: Bool, text: String)?
    /// The device that mirrors Contacts now, while this one asks to take over.
    @State private var takeOver: String?

    enum DevicePage: String, Hashable, Identifiable { case calendars, reminders; var id: String { rawValue } }

    private var sample: Bool { model.config.sampleMode }
    private var here: String { "this \(deviceKind)" }
    private var calendarsOn: Bool { model.isOn(.appleCalendar) && calendarsHere }
    private var remindersOn: Bool { model.isOn(.appleReminders) && reminders.enabled }
    private var contactsOn: Bool { model.isOn(.contacts) && contactsHere }

    var body: some View {
        SwiftUI.Section {
            if sample {
                Text("Sample mode leaves \(here)'s own calendars, reminders and contacts out, so nothing of the sample goes into them.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            DeviceSourceRow(title: "Calendars", symbol: "calendar", summary: calendarsSummary, isOn: calendarsOn, disabled: sample || busy != nil,
                            set: setCalendars, open: { page = .calendars })
            if calendarsOn { accessNote(importer.access, what: "Calendar", pane: "Privacy_Calendars") }
            DeviceSourceRow(title: "Reminders", symbol: "checklist", summary: remindersSummary, isOn: remindersOn, disabled: sample || busy != nil,
                            set: setReminders, open: { page = .reminders })
            if remindersOn { accessNote(reminders.access, what: "Reminders", pane: "Privacy_Reminders") }
            DeviceSourceRow(title: "Contacts", symbol: "person.crop.circle", summary: contactsSummary, isOn: contactsOn, disabled: sample || busy != nil,
                            set: setContacts, open: nil)
            #if os(iOS)
            if model.platform == .iphone {
                DeviceSourceRow(title: "Health", symbol: "heart", summary: healthSummary, isOn: model.isOn(.health) && healthHere, disabled: sample || busy != nil,
                                set: setHealth, open: nil)
            }
            #endif
            if let note { Text(note.text).font(.footnote).foregroundStyle(note.ok ? AnyShapeStyle(.secondary) : AnyShapeStyle(.dangerText)) }
        } header: {
            Text("From this \(deviceKind)")
        } footer: {
            Text(AccountTexts.devicesFooter(deviceKind))
        }
        .themedRow()
        .confirmationDialog("Mirror Contacts on \(here)?", isPresented: Binding(get: { takeOver != nil }, set: { if !$0 { takeOver = nil } }), titleVisibility: .visible, presenting: takeOver) { _ in
            Button("Take over") { turnContactsOn() }
        } message: { name in
            Text(AccountTexts.takeOverContacts(from: name, here: here))
        }
        .task {
            importer.refreshAccess()
            reminders.refreshAccess()
            calendarsHere = SharedConfig.shared.appleCalendarHere
        }
    }

    // MARK: summaries

    private var calendarsSummary: String {
        guard calendarsOn else { return "Off on \(here)" }
        switch importer.access {
        case .notDetermined: return "Calendar access not asked yet"
        case .denied, .restricted, .writeOnly: return "Calendar access is off"
        case .full: break
        }
        let personal = SharedConfig.hubKeepsCalendars(model.modules) ? "iCloud through your hub" : (EventMirror.named(.personal, facts: engine.facts) ?? "Default calendar")
        let work = engine.sources.map { $0.calendars.filter(\.work).count } ?? importer.selected.count
        return AccountTexts.calendarsSummary(personal: personal, work: work)
    }

    private var remindersSummary: String {
        guard remindersOn else { return "Off on \(here)" }
        if reminders.access != .full && reminders.access != .notDetermined { return "Reminders access is off" }
        guard let lists = engine.sources?.lists else { return "Every list" }
        return AccountTexts.listsSummary(on: lists.filter(\.on).count, total: lists.count)
    }

    private var contactsSummary: String {
        let device = engine.sources?.contacts
        let mine = contactsOn && (device?.device == nil || device?.device == engine.config.deviceId)
        let other = device?.device.flatMap { $0 == engine.config.deviceId ? nil : (device?.name ?? "") }
        return AccountTexts.contactsSummary(device: other, mine: mine, here: here)
    }

    #if os(iOS)
    private var healthSummary: String {
        guard model.isOn(.health) && healthHere else { return "Off on \(here)" }
        guard let h = health, let iso = h.last_import, let d = ISO.date(iso) else { return "Nothing sent yet" }
        return "\(h.total) readings, last sent \(d.shortDateTime)"
    }
    #endif

    /// Access refused in the system's settings: what to do, under the row.
    @ViewBuilder private func accessNote(_ access: CalendarImporter.Access, what: String, pane: String) -> some View {
        switch access {
        case .denied, .restricted, .writeOnly:
            VStack(alignment: .leading, spacing: 6) {
                Text("\(what) access is off. Turn on Full Access for Aeneas in \(systemSettingsName.replacingOccurrences(of: "Open ", with: "")).")
                    .font(.caption).foregroundStyle(.secondary)
                Button(systemSettingsName) { openPrivacySettings(pane) }.buttonStyle(.borderless)
            }
        default:
            EmptyView()
        }
    }

    // MARK: switches

    /// A module this device's switch needs, switched on for every device when it is off. The permission is asked
    /// right here, so the module's own permission screen is not offered as well.
    private func needModule(_ m: AppModule) async throws {
        if !model.modules.isOnListed(m) { try await model.setModules([m.rawValue: true], offer: false) }
    }

    private func run(_ key: String, _ f: @escaping () async throws -> String?) {
        busy = key
        note = nil
        Task {
            defer { busy = nil }
            do { if let t = try await f() { note = (true, t) } } catch { note = (false, (error as? HubError)?.errorDescription ?? error.localizedDescription) }
        }
    }

    private func setCalendars(_ on: Bool) {
        guard on else {
            SharedConfig.shared.appleCalendarHere = false
            calendarsHere = false
            return
        }
        run("calendars") {
            try await needModule(.appleCalendar)
            SharedConfig.shared.appleCalendarHere = true
            calendarsHere = true
            importer.refreshAccess()
            if importer.access == .notDetermined { await importer.requestAccess(facts: engine.facts) }
            await importer.runIfReady(reason: "turned on")
            await EventMirrorSync.shared.runIfReady(reason: "turned on")
            return nil
        }
    }

    private func setReminders(_ on: Bool) {
        guard on else { reminders.enabled = false; return }
        run("reminders") {
            try await needModule(.appleReminders)
            await reminders.turnOn()
            return nil
        }
    }

    private func setContacts(_ on: Bool) {
        guard on else { contactsHere = false; return }
        let device = engine.sources?.contacts
        if let other = device?.device, other != engine.config.deviceId { takeOver = device?.name ?? ""; return }
        turnContactsOn()
    }

    private func turnContactsOn() {
        run("contacts") {
            try await needModule(.contacts)
            guard await contacts.requestAccess() else {
                contactsHere = false
                return "Contacts access was not allowed. Allow it in \(systemSettingsName.replacingOccurrences(of: "Open ", with: "")), Privacy, Contacts."
            }
            // The switch makes this device the one (ContactsSync settles it with the hub).
            contactsHere = true
            await contacts.runNow(reason: "turned on")
            return nil
        }
    }

    #if os(iOS)
    private func setHealth(_ on: Bool) {
        guard on else {
            SharedConfig.shared.healthImportEnabled = false
            healthHere = false
            return
        }
        run("health") {
            try await needModule(.health)
            SharedConfig.shared.healthImportEnabled = true
            healthHere = true
            return await HealthImporter.shared.requestAndImport(into: engine)
        }
    }
    #endif
}

/// One row of From this iPhone: a symbol, the name and what it is set to, a switch, and a chevron to its choices when
/// it has more.
struct DeviceSourceRow: View {
    let title: String
    let symbol: String
    let summary: String
    let isOn: Bool
    let disabled: Bool
    let set: (Bool) -> Void
    let open: (() -> Void)?

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: symbol)
                .font(.body.weight(.medium))
                .foregroundStyle(.tint)
                .frame(width: 28)
                .accessibilityHidden(true)
            if let open {
                // Plain, so the name keeps the text color and the row's switch takes its own taps.
                Button(action: open) { label }.buttonStyle(.plain)
            } else {
                label
            }
            Toggle(title, isOn: Binding(get: { isOn }, set: set))
                .labelsHidden()
                .toggleStyle(.switch)
                .disabled(disabled)
            if let open {
                Button(action: open) { chevron }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("\(title) choices")
            } else {
                // The same room as a chevron, so every row's switch lines up.
                chevron.hidden().accessibilityHidden(true)
            }
        }
        .padding(.vertical, 2)
    }

    private var chevron: some View {
        Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
    }

    private var label: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).foregroundStyle(.primary)
            Text(summary).font(.caption).foregroundStyle(.secondary).lineLimit(2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }
}

// MARK: One account

/// One account's page: what it brings in (Mail, Receipts and renewals, an iCloud account's Calendars with its calendar
/// list and where new events go, Read only), its sign-in (the app password, when the hub last used it, Replace), and
/// Remove account. Switching one on turns its module on; switching off the last use asks first, since the hub then
/// removes the account.
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
    @State private var replacing = false
    @State private var newPassword = ""
    @State private var addingPassword = false

    struct Change: Identifiable { let id = UUID(); var what: String; var inbox: Bool?; var receipts: Bool? }

    /// The account, or, for an older Google sign-in (its key is the bare address) that an app password has since taken
    /// over, the account that did: Add an app password comes back here.
    private var account: InternetAccount? {
        store.c?.internet?.first { $0.key == key } ?? (key.contains(":") ? nil : store.c?.internet?.first { $0.email == key && $0.kind != "google" })
    }
    private static let lastUseText = "Nothing else uses this account, so it is removed and its password deleted from the hub. What was filed from its mail stays, and the account itself stays with your provider."

    var body: some View {
        ScrollViewReader { proxy in
            Form {
                if let a = account { content(a) } else { Text("This account is not linked any more.").foregroundStyle(.secondary).themedRow() }
            }
            .task {
                #if DEBUG
                // `-EAAccountsScroll signin`: an account's page opens scrolled to Sign-in (screenshots).
                if UserDefaults.standard.string(forKey: "EAAccountsScroll") == "signin" {
                    try? await Task.sleep(for: .seconds(1))
                    proxy.scrollTo("signin", anchor: .top)
                }
                #endif
            }
        }
        .formStyle(.grouped)
        .themedScreen()
        .navigationTitle(account?.email ?? "Account")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .confirmationDialog(lastUse.map { "Turn \($0.what) off?" } ?? "", isPresented: Binding(get: { lastUse != nil }, set: { if !$0 { lastUse = nil } }), titleVisibility: .visible, presenting: lastUse) { ch in
            Button("Turn off and remove", role: .destructive) { set(inbox: ch.inbox, receipts: ch.receipts) }
        } message: { _ in Text(Self.lastUseText) }
        .confirmationDialog("Remove \(account?.email ?? "this account")?", isPresented: $confirmRemove, titleVisibility: .visible) {
            Button("Remove account", role: .destructive) { remove() }
        } message: {
            Text("Its password is deleted from the hub, and so is its mail on the Mail screen\(account?.features.calendars == true ? "; its calendars stop syncing" : ""). What was filed from its mail stays, and the account itself stays with your provider.")
        }
        .confirmationDialog("Stop keeping \(account?.email ?? "its")'s calendars in step?", isPresented: $stopCalendars, titleVisibility: .visible) {
            Button("Stop syncing", role: .destructive) {
                let last = account.map { $0.features.lastUseOff(calendars: false) } == true
                act { c in
                    let m = try await c.stopCalendarSync(email: account?.email ?? "")
                    if last { dismiss() }
                    return m
                }
            }
        } message: {
            Text("Its events stay in the app as they are; repeating ones are taken out.\(account.map { $0.features.lastUseOff(calendars: false) } == true ? " \(Self.lastUseText)" : "")")
        }
        .sheet(isPresented: $addingPassword) {
            AddAccountSheet(prefill: account?.email) { _ in await reload() }
        }
    }

    private func listed(_ m: AppModule) -> Bool { model.modules.isOnListed(m) }

    @ViewBuilder private func content(_ a: InternetAccount) -> some View {
        SwiftUI.Section {
            if let day = a.google_removed_at.flatMap(ISO.date) {
                Text(InternetAccount.googleRemovedNote(day.formatted(date: .abbreviated, time: .omitted))).font(.footnote).foregroundStyle(.secondary)
            }
            if a.features.inbox != nil {
                feature("Mail", note: AccountTexts.inboxNote, a.shows(.inbox, isOn: listed)) { flip(.inbox, $0, a) }
            }
            if a.features.receipts != nil {
                feature("Receipts and renewals", note: AccountTexts.receiptsNote, a.shows(.receipts, isOn: listed)) { flip(.receipts, $0, a) }
                    .disabled(busy || a.kind == "google")
                if a.shows(.receipts, isOn: listed), let r = a.receipts {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(r.summary).font(.footnote)
                        Text("Last checked \(a.last_sync.flatMap(ISO.date).map(\.shortDateTime) ?? "never")").font(.caption).foregroundStyle(.secondary)
                        let waiting = r.to_read ?? 0
                        Button(store.c?.google?.reading == true ? "Reading the waiting mail" : waiting > 0 ? "Read now (\(waiting) waiting)" : "Read now") {
                            act { c in _ = try await c.readMailNow(account: a.key); return "Reading the waiting mail now. It stops for any chat." }
                        }
                        .buttonStyle(.borderless)
                        .disabled(busy || store.c?.google?.reading == true)
                    }
                    .padding(.leading, 12)
                }
            }
            if a.kind == "icloud", a.features.calendars != nil {
                feature("Calendars", note: AccountTexts.calendarsNote, a.shows(.calendars, isOn: listed)) { flip(.calendars, $0, a) }
            }
            if a.hasReadOnlySwitch {
                feature("Read only", note: a.read_only == true ? InternetAccount.readOnlyNote : AccountTexts.readOnlyNote, a.read_only == true) { v in
                    act { c in _ = try await c.setAccountFeatures(key: a.key, readOnly: v); return nil }
                }
            } else if a.kind == "google" {
                LabeledContent("Read only", value: "Always")
            }
            if let message { Text(message.text).font(.footnote).foregroundStyle(message.ok ? AnyShapeStyle(.secondary) : AnyShapeStyle(.dangerText)) }
        } header: {
            Text(a.kind == "imap" ? a.kindLabel : a.kindShort)
        } footer: {
            if a.shows(.receipts, isOn: listed) {
                Text("Receipts and renewals: the hub checks for new mail every 15 minutes and reads it \(ConnectionsSettingsView.readTimes(store.c?.google?.times)) when no game is using the GPU. For receipts, folders are opened read-only and nothing is marked read; the mail itself is never kept.")
            }
        }
        .themedRow()
        if a.shows(.calendars, isOn: listed) {
            AccountCalendarsSection(email: a.email, store: store, reload: reload)
        }
        signIn(a).id("signin")
        SwiftUI.Section {
            Button("Remove account", role: .destructive) { confirmRemove = true }.disabled(busy)
        }
        .themedRow()
    }

    /// A switch with one line under it saying what it does.
    private func feature(_ title: String, note: String, _ isOn: Bool, set: @escaping (Bool) -> Void) -> some View {
        Toggle(isOn: Binding(get: { isOn }, set: set)) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                Text(note).font(.caption).foregroundStyle(.secondary)
            }
        }
        .disabled(busy)
    }

    /// Sign-in: the app password, when the hub last used it, and Replace; the older Google sign-in offers an app password.
    @ViewBuilder private func signIn(_ a: InternetAccount) -> some View {
        SwiftUI.Section {
            if a.kind == "google" {
                Text(InternetAccount.olderGoogleNote).font(.footnote).foregroundStyle(.secondary)
                Button { addingPassword = true } label: { Label("Add an app password", systemImage: "key") }
            } else {
                LabeledContent(a.kind == "icloud" ? "App-specific password" : "App password") {
                    Text(a.checked_at.flatMap(ISO.date).map { "Last checked \($0.shortDateTime)" } ?? a.linked_at.flatMap(ISO.date).map { "Added \($0.formatted(date: .abbreviated, time: .omitted))" } ?? "")
                }
                if let e = a.last_error, !e.isEmpty { Text(e).font(.footnote).foregroundStyle(.dangerText) }
                if replacing {
                    SecureField("New \(a.kind == "icloud" ? "app-specific password" : "app password")", text: $newPassword)
                        .textContentType(.password)
                    HStack {
                        Button(busy ? "Checking" : "Save") {
                            let p = newPassword
                            act { c in
                                try await c.replacePassword(a, password: p)
                                newPassword = ""
                                replacing = false
                                return "The new password works. It replaced the old one."
                            }
                        }
                        .disabled(busy || newPassword.trimmingCharacters(in: .whitespaces).isEmpty)
                        Spacer()
                        Button("Cancel") { replacing = false; newPassword = "" }
                    }
                    .buttonStyle(.borderless)
                } else {
                    Button("Replace") { replacing = true }.disabled(busy)
                }
            }
        } header: {
            Text("Sign-in")
        } footer: {
            if a.kind != "google" { Text("The hub checks a new one before it replaces the old. It is kept on your hub only and never shown again.") }
        }
        .themedRow()
    }

    /// A switch on or off. On switches its module on when that is off; off of the last use asks first, since the hub
    /// then removes the account.
    private func flip(_ f: AccountFeature, _ on: Bool, _ a: InternetAccount) {
        let does: Bool? = f == .inbox ? a.features.inbox : f == .receipts ? a.features.receipts : a.features.calendars
        if on {
            act { c in
                if !model.modules.isOnListed(f.module) { try await model.setModules([f.module.rawValue: true]) }
                guard does != true else { return nil }
                switch f {
                case .calendars:
                    _ = try await c.linkICloudCalendars(email: a.email, password: nil)
                    return "Choose the calendars to keep in step."
                case .inbox: _ = try await c.setAccountFeatures(key: a.key, inbox: true)
                case .receipts: _ = try await c.setAccountFeatures(key: a.key, receipts: true)
                }
                return nil
            }
            return
        }
        guard does == true else { return }
        switch f {
        case .calendars: stopCalendars = true
        case .inbox: change("Mail", a, inbox: false)
        case .receipts: change("Receipts and renewals", a, receipts: false)
        }
    }

    private func change(_ what: String, _ a: InternetAccount, inbox: Bool? = nil, receipts: Bool? = nil) {
        if a.features.lastUseOff(inbox: inbox, receipts: receipts) { lastUse = Change(what: what, inbox: inbox, receipts: receipts); return }
        set(inbox: inbox, receipts: receipts)
    }

    private func set(inbox: Bool?, receipts: Bool?) {
        let key = account?.key ?? self.key
        act { c in
            let r = try await c.setAccountFeatures(key: key, inbox: inbox, receipts: receipts)
            if r.removed == true { dismiss() }
            return r.removed == true ? (r.message ?? "Removed.") : nil
        }
    }

    private func remove() {
        let key = account?.key ?? self.key
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
            do { if let t = try await f(client) { message = (true, t) } } catch { message = (false, (error as? HubError)?.errorDescription ?? error.localizedDescription) }
            await reload()
            await model.refreshModules()
            EventMirrorSync.shared.scheduleRun(after: 1)
            busy = false
        }
    }
}

/// An iCloud account's calendars: which to keep in step, where new events go (none while Read only), Sync now. Where
/// the hub's new events go is set here only; Apple Calendar's own is in From this iPhone, Calendars, and the two never
/// both apply (while the hub keeps the iCloud calendars, devices leave personal events to it).
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

// MARK: Add account

/// Add account as a sheet of its own (from Accounts, an older Google sign-in's Add an app password, and the Mail
/// screen with no mailbox): the form with Cancel, closed once the account is added.
struct AddAccountSheet: View {
    @Environment(\.dismiss) private var dismiss
    var prefill: String? = nil
    var onAdded: (String) async -> Void = { _ in }

    var body: some View {
        NavigationStack {
            AddAccountView(prefill: prefill, inSheet: true) { key in
                dismiss()
                await onAdded(key)
            }
        }
        #if os(macOS)
        .frame(minWidth: 480, minHeight: 620)
        #endif
    }
}

/// Add account, one sheet: 1. Which account? (iCloud, Google, Other mail); 2. Sign in (the address and an app
/// password, or an IMAP server's details); 3. What it brings in (Mail and Receipts and renewals on, an iCloud account's
/// Calendars off). Add account switches on the modules those need and has the hub check the sign-in (EACore
/// HubClient.addAccount). `prefill` (an older Google sign-in's Add an app password) chooses Google with its address.
struct AddAccountView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var engine: SyncEngine
    @Environment(\.dismiss) private var dismiss
    var prefill: String? = nil
    var inSheet = false
    var onAdded: (String) async -> Void = { _ in }

    @State private var form = NewAccount(kind: .icloud, email: "", password: "")
    @State private var port = "993"
    @State private var busy = false
    @State private var message: String?

    private func wants(_ f: AccountFeature) -> Binding<Bool> {
        Binding(get: { form.want.contains(f) }, set: { on in if on { form.want.insert(f) } else { form.want.remove(f) } })
    }

    var body: some View {
        Form {
            SwiftUI.Section {
                Picker("Which account?", selection: $form.kind) {
                    Text("iCloud").tag(NewAccount.Kind.icloud)
                    Text("Google").tag(NewAccount.Kind.google)
                    Text("Other mail").tag(NewAccount.Kind.other)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
            } header: {
                Text("Which account?")
            }
            .themedRow()

            SwiftUI.Section {
                TextField("Address", text: $form.email)
                    .textContentType(.username)
                    .autocorrectionDisabled()
                    #if os(iOS)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.emailAddress)
                    #endif
                if form.kind == .other {
                    TextField("Server, like imap.example.com", text: $form.host)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                        #endif
                    LabeledContent("Port") {
                        TextField("Port", text: $port)
                            .multilineTextAlignment(.trailing)
                            .labelsHidden()
                            #if os(iOS)
                            .keyboardType(.numberPad)
                            #endif
                    }
                    TextField("User name, if it is not the address", text: $form.user)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                }
                SecureField(form.kind == .icloud ? "App-specific password" : form.kind == .google ? "App password (16 letters)" : "Password", text: $form.password)
                    .textContentType(.password)
                switch form.kind {
                case .google:
                    VStack(alignment: .leading, spacing: 4) {
                        Text(AccountTexts.googleHowTo).font(.footnote).foregroundStyle(.secondary)
                        Link("Open Google's page", destination: URL(string: "https://myaccount.google.com/apppasswords")!).font(.footnote)
                    }
                case .icloud:
                    VStack(alignment: .leading, spacing: 4) {
                        Text(AccountTexts.icloudHowTo).font(.footnote).foregroundStyle(.secondary)
                        Link("Open account.apple.com", destination: URL(string: "https://account.apple.com")!).font(.footnote)
                    }
                    PageLink { OwnKeyGuideView(service: "icloud", stepsOnly: true) } label: { Label("Show me how", systemImage: "list.number") }
                case .other:
                    Text("Your provider's help pages give its server and port, and where to make an app password. The hub connects with TLS only (most often port 993), and only to servers on the internet, never one on your own network.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            } header: {
                Text("Sign in")
            }
            .themedRow()

            SwiftUI.Section {
                feature("Mail", note: AccountTexts.inboxNote, .inbox)
                feature("Receipts and renewals", note: AccountTexts.receiptsNote, .receipts)
                if form.kind == .icloud { feature("Calendars", note: AccountTexts.calendarsNote, .calendars) }
                Button(busy ? "Checking" : "Add account") { add() }
                    .buttonStyle(.themedProminent)
                    .disabled(busy || !ready)
                if let message { Text(message).font(.footnote).foregroundStyle(.dangerText) }
            } header: {
                Text("What it brings in")
            } footer: {
                Text(AccountTexts.addFooter)
            }
            .themedRow()
        }
        .formStyle(.grouped)
        .themedScreen()
        .navigationTitle("Add account")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            if inSheet { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        .onAppear {
            if let prefill, form.email.isEmpty { form.kind = .google; form.email = prefill }
        }
    }

    private var ready: Bool {
        var f = form
        f.port = Int(port) ?? 993
        return f.ready && engine.client != nil
    }

    private func feature(_ title: String, note: String, _ f: AccountFeature) -> some View {
        Toggle(isOn: wants(f)) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                Text(note).font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func add() {
        guard let client = engine.client else { return }
        var f = form
        f.port = Int(port) ?? 993
        busy = true
        message = nil
        Task {
            do {
                let key = try await client.addAccount(f, isOn: { model.modules.isOnListed($0) }, switchOn: { try await model.setModules($0) })
                form.password = ""
                await model.refreshModules()
                busy = false
                await onAdded(key)
                if !inSheet { dismiss() }
            } catch {
                message = (error as? HubError)?.errorDescription ?? error.localizedDescription
                busy = false
            }
        }
    }
}
