import SwiftUI
import AuthenticationServices
import EACore

/// Settings, Connections: Gmail (read-only, files receipts, renewals, orders and vet mail), Steam (key and profile),
/// Confluence (the wiki's handbook), Letterboxd (diary feed) and, on the iPhone, Apple Health. Linked data lands in
/// Renewals, Inventory, Pet, Games, Wiki, Films and Logs on its own, where the assistant reads it too.
struct ConnectionsSettingsView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var engine: SyncEngine
    @Environment(\.webAuthenticationSession) private var webAuth
    @State private var c: Connections?
    @State private var loadError: String?
    @State private var busy: String?
    @State private var message: [String: (ok: Bool, text: String)] = [:]
    @State private var spaces: [AtlassianSpace]?
    @State private var chosenSpaces: Set<String> = []
    @State private var confirmUnlinkAtlassian = false
    @State private var spacesFailed = false
    @State private var letterboxdUser = ""
    /// The calendar feed's own key (GET /feeds): it reads the feed and nothing else, so it can live in Calendar.
    @State private var calendarKey = ""
    @State private var confirmNewCalendarLink = false
    @State private var unlinkMail: String?
    #if os(iOS)
    @State private var healthOn = false
    #endif

    var body: some View {
        Form {
            if engine.client == nil {
                Text("Set up the hub connection first.").foregroundStyle(.secondary)
            } else if let c {
                if let g = c.google { gmail(g) }
                // Each link feeds one module; while that module is off its link is hidden and the hub pauses its sync.
                if model.isOn(.games) { steam(c.steam) }
                if model.isOn(.wiki), let a = c.atlassian { confluence(a) }
                if model.isOn(.films) { letterboxd(c.letterboxd) }
                if model.isOn(.health) { health(c.health) }
                if model.isOn(.homelab), let pm = c.password_manager { PasswordManagerSection(view: pm, reload: { await load() }) }
                if model.isOn(.appleReminders) { AppleRemindersSection() }
                calendarFeed
            } else if let loadError {
                Text(loadError).foregroundStyle(.red)
            } else {
                ProgressView()
            }
        }
        .formStyle(.grouped)
        .themedScreen()
        .navigationTitle("Connections")
        .task { await load() }
        .refreshable { spaces = nil; await load() }
        .onAppear { takeAtlassianReturn() }
        .onChange(of: model.atlassianReturn) { _, _ in takeAtlassianReturn() }
        .onAppear { takeGoogleReturn() }
        .onChange(of: model.googleReturn) { _, _ in takeGoogleReturn() }
        #if os(iOS)
        .onAppear { healthOn = model.config.healthImportEnabled }
        #endif
    }

    // MARK: sections

    @ViewBuilder private func steam(_ s: Connections.Steam) -> some View {
        SwiftUI.Section {
            if s.connected {
                LabeledContent("Profile", value: s.persona ?? s.steam_id ?? "")
                LabeledContent("Games", value: "\(s.games ?? 0)")
                LabeledContent("Last read", value: when(s.last_sync))
                if let e = s.last_error { Text(e).font(.footnote).foregroundStyle(.red) }
                Button(busy == "steam" ? "Reading" : "Read now") { run("steam") { let r = try await $0.syncSteam(); return "\(r.games ?? 0) games: \(r.created) new, \(r.updated) changed." } }
                    .disabled(busy != nil)
                Button("Unlink", role: .destructive) { run("steam") { try await $0.disconnectSteam(); return "Unlinked. The games stay." } }
                    .disabled(busy != nil)
            } else if s.hub_key == true {
                Button { signInWithSteam() } label: { Label(busy == "steam" ? "Waiting for Steam" : "Sign in with Steam", systemImage: "person.badge.key") }
                    .disabled(busy != nil)
            } else {
                NavigationLink { OwnKeyGuideView(service: "steam") { Task { await load() } } } label: { Label("Set it up with the guide", systemImage: "list.number") }
                Text("Advanced setup: this needs your own Steam key, made once by you on the service's own site; there is no server of ours in between.").font(.footnote).foregroundStyle(.secondary)
            }
            note("steam")
        } header: {
            Text("Steam")
        } footer: {
            if s.connected {
                Text("Playtime is read again every 6 hours.")
            } else if s.hub_key == true {
                Text("Sign in on Steam's own page. The app learns only which account is yours; your Steam password never reaches it. Your profile's Game details need to be public.")
            } else {
                Text("The guide takes about 2 minutes. After that, sign in with Steam.")
            }
        }
        .themedRow()
    }

    /// Steam's sign-in page in a secure browser sheet; the hub sends it back to everythingapp://steam.
    private func signInWithSteam() {
        guard let client = engine.client else { return }
        busy = "steam"
        message["steam"] = nil
        Task {
            defer { busy = nil }
            do {
                let url = try await client.steamSignInURL()
                let back = try await webAuth.authenticate(using: url, callbackURLScheme: "everythingapp")
                let q = URLComponents(url: back, resolvingAgainstBaseURL: false)?.queryItems ?? []
                if let err = q.first(where: { $0.name == "error" })?.value { message["steam"] = (false, err) }
                else { message["steam"] = (true, q.first(where: { $0.name == "message" })?.value ?? "Steam linked.") }
            } catch let e as ASWebAuthenticationSessionError where e.code == .canceledLogin {
                message["steam"] = (false, "Sign-in cancelled.")
            } catch {
                message["steam"] = (false, error.localizedDescription)
            }
            await load()
            await engine.sync()
        }
    }

    @ViewBuilder private func gmail(_ g: Connections.Google) -> some View {
        SwiftUI.Section {
            ForEach(g.accounts) { a in
                VStack(alignment: .leading, spacing: 3) {
                    Text(a.email).font(.body.weight(.semibold))
                    Text(a.summary).font(.footnote)
                    Text("Last checked \(when(a.last_sync))").font(.caption).foregroundStyle(.secondary)
                    if let e = a.last_error, !e.isEmpty { Text(e).font(.caption).foregroundStyle(.red) }
                    Button("Unlink", role: .destructive) { unlinkMail = a.email }
                        .disabled(busy != nil)
                        .font(.footnote)
                }
            }
            .confirmationDialog("Unlink \(unlinkMail ?? "")?", isPresented: Binding(get: { unlinkMail != nil }, set: { if !$0 { unlinkMail = nil } }), titleVisibility: .visible, presenting: unlinkMail) { email in
                Button("Unlink", role: .destructive) { run("google") { try await $0.disconnectGoogle(email: email); return "Unlinked \(email)." } }
            } message: { _ in
                Text("Google forgets the hub's sign-in. What was filed from this mailbox stays.")
            }
            if g.app {
                Button { signInWithGoogle() } label: { Label(busy == "google" ? "Waiting for Google" : g.accounts.isEmpty ? "Sign in with Google" : "Add another mailbox", systemImage: "envelope.badge.person.crop") }
                    .disabled(busy != nil)
                if !g.accounts.isEmpty {
                    Button(g.reading == true ? "Reading the waiting mail" : g.waiting > 0 ? "Read now (\(g.waiting) waiting)" : "Read now") { run("google-read") { _ = try await $0.readMailNow(); return "Reading the waiting mail now. It stops for any chat." } }
                        .disabled(busy != nil)
                    note("google-read")
                }
            } else {
                NavigationLink { OwnKeyGuideView(service: "google") { Task { await load() } } } label: { Label("Set it up with the guide", systemImage: "list.number") }
                Text("Advanced setup: this needs your own Google app, made once by you on the service's own site; there is no server of ours in between.").font(.footnote).foregroundStyle(.secondary)
            }
            note("google")
        } header: {
            Text("Gmail")
        } footer: {
            if g.app {
                Text("Receipts, renewal notices and vet mail fill in Renewals and \(PetView.pet). The hub checks for new mail every 15 minutes and reads it \(Self.readTimes(g.times)) when no game is using the GPU; Read now reads it right away.\(g.waiting_for_gpu.map { " Waiting: \($0)." } ?? "") Google lets the hub read mail only; it never sends, changes or deletes any, and the mail itself is never kept.")
            } else {
                Text("The guide takes about 10 to 15 minutes: your own Google app, allowed only to read mail. After that, sign in with Google.")
            }
        }
        .themedRow()
    }

    /// Google's account chooser in a secure browser sheet; the hub sends it back to everythingapp://google.
    private func signInWithGoogle() {
        guard let client = engine.client else { return }
        busy = "google"
        message["google"] = nil
        Task {
            defer { busy = nil }
            do {
                let url = try await client.googleSignInURL()
                let back = try await webAuth.authenticate(using: url, callbackURLScheme: "everythingapp")
                let q = URLComponents(url: back, resolvingAgainstBaseURL: false)?.queryItems ?? []
                if let err = q.first(where: { $0.name == "error" })?.value { message["google"] = (false, err) }
                else { message["google"] = (true, q.first(where: { $0.name == "message" })?.value ?? "Gmail linked.") }
            } catch let e as ASWebAuthenticationSessionError where e.code == .canceledLogin {
                message["google"] = (false, "Sign-in cancelled.")
            } catch {
                message["google"] = (false, error.localizedDescription)
            }
            await load()
        }
    }

    /// Sign-in that came back through everythingapp://google instead of the browser sheet.
    private func takeGoogleReturn() {
        guard let r = model.googleReturn else { return }
        model.googleReturn = nil
        message["google"] = (r.ok, r.text)
        Task { await load() }
    }

    @ViewBuilder private func confluence(_ a: Connections.Atlassian) -> some View {
        SwiftUI.Section {
            if a.connected {
                LabeledContent("Site", value: a.site_name ?? a.site_url ?? "")
                LabeledContent("Pages", value: "\(a.pages ?? 0)")
                LabeledContent("Last sync", value: when(a.last_sync))
                if let e = a.last_error, !e.isEmpty { Text(e).font(.footnote).foregroundStyle(.red) }
                spacePicker
                Button(busy == "atlassian" ? "Syncing" : "Sync now") { run("atlassian") { Self.counts(try await $0.syncConfluence()) } }
                    .disabled(busy != nil)
                Button("Unlink", role: .destructive) { confirmUnlinkAtlassian = true }
                    .disabled(busy != nil)
                    .confirmationDialog("Unlink Confluence?", isPresented: $confirmUnlinkAtlassian, titleVisibility: .visible) {
                        Button("Unlink", role: .destructive) {
                            run("atlassian") { try await $0.disconnectAtlassian(); spaces = nil; return "Unlinked. The Confluence pages left the wiki." }
                        }
                    } message: {
                        Text("The hub forgets the sign-in and takes the mirrored Confluence pages out of the wiki. Confluence itself is not touched.")
                    }
            } else if a.app == true {
                Button { signInWithAtlassian() } label: { Label(busy == "atlassian" ? "Waiting for Atlassian" : "Sign in with Atlassian", systemImage: "person.badge.key") }
                    .disabled(busy != nil)
            } else {
                NavigationLink { OwnKeyGuideView(service: "atlassian") { Task { await load() } } } label: { Label("Set it up with the guide", systemImage: "list.number") }
                Text("Advanced setup: this needs your own Atlassian app, made once by you on the service's own site; there is no server of ours in between.").font(.footnote).foregroundStyle(.secondary)
            }
            note("atlassian")
        } header: {
            Text("Confluence")
        } footer: {
            if a.connected {
                Text("The chosen spaces are read again every hour and show under Library, Wiki, next to the repo docs.")
            } else if a.app == true {
                Text("Sign in on Atlassian's own page. The hub asks only to read spaces, pages and attachments; your Atlassian password never reaches it. Atlassian sends you back only to an https hub address.")
            } else {
                Text("The guide takes about 10 minutes: your own Atlassian app, allowed only to read Confluence. After that, sign in with Atlassian.")
            }
        }
        .themedRow()
    }

    /// The spaces the account can read, ticked when mirrored. Save sends the ticked keys and the hub reads them.
    @ViewBuilder private var spacePicker: some View {
        if let spaces {
            Text("Spaces to mirror").font(.subheadline.weight(.semibold))
            if spaces.isEmpty, !spacesFailed { Text("This account can read no spaces.").font(.footnote).foregroundStyle(.secondary) }
            ForEach(spaces) { s in
                Button {
                    if chosenSpaces.contains(s.key) { chosenSpaces.remove(s.key) } else { chosenSpaces.insert(s.key) }
                } label: {
                    HStack {
                        Image(systemName: chosenSpaces.contains(s.key) ? "checkmark.square.fill" : "square")
                            .foregroundStyle(chosenSpaces.contains(s.key) ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
                        Text(s.name)
                        Spacer()
                        Text(s.key).font(.caption).foregroundStyle(.secondary)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(chosenSpaces.contains(s.key) ? .isSelected : [])
            }
            Button(busy == "atlassian" ? "Saving" : "Save spaces") {
                let keys = chosenSpaces.sorted()
                run("atlassian") { let r = try await $0.setAtlassianSpaces(keys); self.spaces = nil; return Self.counts(r) }
            }
            .disabled(busy != nil || chosenSpaces == Set(spaces.filter(\.mirrored).map(\.key)))
        } else {
            HStack { ProgressView().controlSize(.small); Text("Reading spaces").foregroundStyle(.secondary) }
        }
    }

    private static func counts(_ r: ConfluenceSyncCounts) -> String {
        "\(r.pages) pages from \(r.spaces) \(r.spaces == 1 ? "space" : "spaces"): \(r.updated) changed, \(r.removed) removed, \(r.images) pictures saved."
    }

    /// Where Atlassian sends the browser back: the hub's address as this app reaches it, which the Atlassian app must list.
    private var atlassianCallback: String? { callback("/connections/atlassian/return") }

    /// A sign-in return address on the hub as this app reaches it.
    private func callback(_ path: String) -> String? {
        guard let base = engine.client?.http?.baseURL, var c = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return nil }
        c.path = path
        c.query = nil
        return c.string
    }

    /// Atlassian's consent page in a secure browser sheet; the hub sends it back to everythingapp://atlassian.
    private func signInWithAtlassian() {
        guard let client = engine.client else { return }
        busy = "atlassian"
        message["atlassian"] = nil
        Task {
            defer { busy = nil }
            do {
                let url = try await client.atlassianSignInURL()
                let back = try await webAuth.authenticate(using: url, callbackURLScheme: "everythingapp")
                let q = URLComponents(url: back, resolvingAgainstBaseURL: false)?.queryItems ?? []
                if let err = q.first(where: { $0.name == "error" })?.value { message["atlassian"] = (false, err) }
                else { message["atlassian"] = (true, q.first(where: { $0.name == "message" })?.value ?? "Confluence linked.") }
            } catch let e as ASWebAuthenticationSessionError where e.code == .canceledLogin {
                message["atlassian"] = (false, "Sign-in cancelled.")
            } catch {
                message["atlassian"] = (false, error.localizedDescription)
            }
            spaces = nil
            await load()
        }
    }

    /// Sign-in that came back through everythingapp://atlassian instead of the browser sheet.
    private func takeAtlassianReturn() {
        guard let r = model.atlassianReturn else { return }
        model.atlassianReturn = nil
        message["atlassian"] = (r.ok, r.text)
        spaces = nil
        Task { await load() }
    }

    @ViewBuilder private func letterboxd(_ l: Connections.Letterboxd) -> some View {
        SwiftUI.Section {
            if l.connected, let user = l.username {
                LabeledContent("Films", value: "\(l.films ?? 0)")
                LabeledContent("Diary of", value: user)
                LabeledContent("Last read", value: when(l.last_sync))
                if let e = l.last_error { Text(e).font(.footnote).foregroundStyle(.red) }
                Button(busy == "letterboxd" ? "Reading" : "Read diary now") { run("letterboxd") { let r = try await $0.syncLetterboxd(); return "\(r.entries ?? 0) diary entries: \(r.created) new films, \(r.updated) changed." } }
                    .disabled(busy != nil)
                Button("Unlink", role: .destructive) { run("letterboxd") { try await $0.disconnectLetterboxd(); return "Unlinked. The films stay." } }
                    .disabled(busy != nil)
            } else {
                TextField("Letterboxd username", text: $letterboxdUser)
                    .autocorrectionDisabled()
                    #if os(iOS)
                    .textInputAutocapitalization(.never)
                    #endif
                Button(busy == "letterboxd" ? "Linking" : "Link diary") {
                    let u = letterboxdUser.trimmingCharacters(in: .whitespaces)
                    run("letterboxd") { let r = try await $0.connectLetterboxd(username: u); return "Linked. \(r.entries ?? 0) recent diary entries read." }
                }
                .disabled(busy != nil || letterboxdUser.isEmpty)
            }
            note("letterboxd")
        } header: {
            Text("Letterboxd")
        } footer: {
            Text("Everything you log on Letterboxd comes in by itself within the hour, starting from your 50 most recent diary entries.")
        }
        .themedRow()
    }

    @ViewBuilder private func health(_ h: Connections.Health) -> some View {
        SwiftUI.Section {
            #if os(iOS)
            Toggle("Sync with Apple Health", isOn: $healthOn)
                .onChange(of: healthOn) { _, v in
                    guard v != model.config.healthImportEnabled else { return }
                    model.config.healthImportEnabled = v
                    if v { sendHealth(ask: true) }
                }
            if healthOn {
                Button(busy == "health" ? "Sending" : "Send now") { sendHealth(ask: false) }
                    .disabled(busy != nil)
            }
            #endif
            LabeledContent("Readings from Health", value: "\(h.total)")
            LabeledContent("Last sent", value: when(h.last_import))
            note("health")
        } header: {
            Text("Apple Health")
        } footer: {
            #if os(iOS)
            Text("Both ways, each time you open the app: weight, blood pressure, sleep, steps, workouts, caffeine and mood come in from Health, and what you log in the app (weight, blood pressure, caffeine, mood, timed activities) goes into Health. Browse it all under Library, Health.")
            #else
            Text("Health lives on the iPhone: turn it on there, in Settings, Connections.")
            #endif
        }
        .themedRow()
    }

    /// The plan as a calendar subscription (task blocks, events, reminders, renewals); work items stay out.
    @ViewBuilder private var calendarFeed: some View {
        let cfg = engine.config
        if !cfg.hubURL.isEmpty, !calendarKey.isEmpty,
           var c = URLComponents(string: cfg.hubURL.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/calendar.ics") {
            let _ = c.queryItems = [URLQueryItem(name: "key", value: calendarKey)]
            let _ = c.scheme = "webcal"
            SwiftUI.Section {
                if let url = c.url { Link(destination: url) { Label("Subscribe in Calendar", systemImage: "calendar.badge.plus") } }
                Button("New link") { confirmNewCalendarLink = true }
                    .confirmationDialog("Make a new calendar link? Calendars subscribed with the old one stop updating until you subscribe again.", isPresented: $confirmNewCalendarLink, titleVisibility: .visible) {
                        Button("New link", role: .destructive) {
                            Task { if let k = try? await engine.client?.rotateFeedKey("calendar") { calendarKey = k.calendar.key } }
                        }
                    }
            } header: {
                Text("Calendar")
            } footer: {
                Text("Scheduled tasks, events, reminders and renewal dates in Calendar, kept up to date by itself. Work items stay out. The link's key only reads this calendar.")
            }
            .themedRow()
        }
    }

    @ViewBuilder private func note(_ key: String) -> some View {
        if let m = message[key] { Text(m.text).font(.footnote).foregroundStyle(m.ok ? Color.secondary : Color.red) }
    }

    /// "at 7 AM, noon, 5 PM, 10 PM".
    static func readTimes(_ times: [String]?) -> String {
        guard let times, !times.isEmpty else { return "at set times" }
        let shown = times.compactMap { t -> String? in
            let p = t.split(separator: ":").compactMap { Int($0) }
            guard p.count == 2 else { return nil }
            if p[0] == 12 && p[1] == 0 { return "noon" }
            return "\(p[0] % 12 == 0 ? 12 : p[0] % 12)\(p[1] > 0 ? String(format: ":%02d", p[1]) : "") \(p[0] < 12 ? "AM" : "PM")"
        }
        return "at " + shown.joined(separator: ", ")
    }

    // MARK: actions

    private func when(_ iso: String?) -> String {
        guard let iso, let d = ISO.date(iso) else { return "Never" }
        return d.shortDateTime
    }

    private func load() async {
        guard let client = engine.client else { return }
        do { c = try await client.connections(); loadError = nil } catch { loadError = error.localizedDescription }
        if calendarKey.isEmpty, let k = try? await client.feedKeys() { calendarKey = k.calendar.key }
        if c?.atlassian?.connected == true, spaces == nil {
            do {
                let s = try await client.atlassianSpaces()
                spaces = s
                chosenSpaces = Set(s.filter(\.mirrored).map(\.key))
                spacesFailed = false
            } catch {
                spaces = []
                spacesFailed = true
                message["atlassian"] = (false, "Could not read the spaces: \(error.localizedDescription)")
            }
        } else if c?.atlassian?.connected != true {
            spaces = nil
        }
    }

    private func run(_ key: String, _ f: @escaping (HubClient) async throws -> String) {
        guard let client = engine.client else { return }
        busy = key
        message[key] = nil
        Task {
            do { message[key] = (true, try await f(client)) } catch { message[key] = (false, error.localizedDescription) }
            await load()
            await engine.sync()
            busy = nil
        }
    }

    #if os(iOS)
    private func sendHealth(ask: Bool) {
        busy = "health"
        message["health"] = nil
        Task {
            let r = ask ? await HealthImporter.shared.requestAndImport(into: engine) : await HealthImporter.shared.importIfAuthorized(into: engine)
            message["health"] = (!r.hasPrefix("Could not") && !r.hasPrefix("Health permission"), r)
            await load()
            busy = nil
        }
    }
    #endif
}

/// Apple Reminders: every list, both ways, with this app's tasks. Work account lists go into the work space.
struct AppleRemindersSection: View {
    @ObservedObject private var sync = RemindersSync.shared

    var body: some View {
        SwiftUI.Section {
            Toggle("Sync with Apple Reminders", isOn: Binding(get: { sync.enabled }, set: { on in
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
                    if let e = sync.lastError { Text(e).font(.caption).foregroundStyle(.red) }
                    Button(sync.running ? "Syncing" : "Sync now") { Task { await sync.runNow(reason: "button") } }.disabled(sync.running)
                }
            }
        } header: {
            Text("Apple Reminders")
        } footer: {
            Text(sync.createsInApple
                 ? "Every list syncs both ways: titles, notes, due dates, alerts, repeats, done, and deletes. New tasks from the app go to your default list."
                 : "Every list syncs both ways: titles, notes, due dates, alerts, repeats, done, and deletes. New tasks from the app are added to Reminders by the iPhone.")
        }
    }
}
