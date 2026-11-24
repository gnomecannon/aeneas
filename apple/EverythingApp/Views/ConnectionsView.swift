import SwiftUI
import AuthenticationServices
import EACore

/// Settings, Connections, grouped as on every device (gnomecannon/aeneas#10, #25): Internet Accounts first (iCloud,
/// Google and other mail accounts, each with Mail, Calendars, Reminders, Read only and Receipts and renewals), then the
/// services by kind (Steam and Letterboxd, Confluence, Apple Health, the password manager, the calendar feed), then App
/// keys, the hub's own registrations those services need. Linked data lands in Renewals, Pet, Games, Wiki, Films and
/// Logs on its own, where the assistant reads it too.
struct ConnectionsSettingsView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var engine: SyncEngine
    @Environment(\.webAuthenticationSession) private var webAuth
    @StateObject private var store = ConnectionsStore()
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
    #if os(iOS)
    @State private var healthOn = false
    #endif

    var body: some View {
        Form {
            if engine.client == nil {
                Text("Set up the hub connection first.").foregroundStyle(.secondary)
            } else if let c = store.c {
                // Every account, with what it brings in; Apple Reminders' switch is on the iCloud account.
                InternetAccountsSection(store: store, note: message["accounts"], reload: { await load() })
                // The services, by kind. Each feeds one module; while that module is off its link is hidden and the
                // hub pauses its sync.
                if model.isOn(.games) { steam(c.steam) }
                if model.isOn(.films) { letterboxd(c.letterboxd) }
                if model.isOn(.wiki), let a = c.atlassian { confluence(a) }
                if model.isOn(.health) { health(c.health) }
                if model.isOn(.homelab), let pm = c.password_manager { PasswordManagerSection(view: pm, reload: { await load() }) }
                calendarFeed
                // The app keys those services need, each made once, with what it is and why it is asked for.
                AppKeysSection(store: store, reload: { await load() })
            } else if let loadError = store.loadError {
                Text(loadError).foregroundStyle(.dangerText)
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
                if let e = s.last_error { Text(e).font(.footnote).foregroundStyle(.dangerText) }
                Button(busy == "steam" ? "Reading" : "Read now") { run("steam") { let r = try await $0.syncSteam(); return "\(r.games ?? 0) games: \(r.created) new, \(r.updated) changed." } }
                    .disabled(busy != nil)
                Button("Unlink", role: .destructive) { run("steam") { try await $0.disconnectSteam(); return "Unlinked. The games stay." } }
                    .disabled(busy != nil)
            } else if s.hub_key == true {
                Button { signInWithSteam() } label: { Label(busy == "steam" ? "Waiting for Steam" : "Sign in with Steam", systemImage: "person.badge.key") }
                    .disabled(busy != nil)
            } else {
                Text("Signing in needs the hub's own Steam key first, added once under App keys at the end of this page.").foregroundStyle(.secondary)
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
                Text("The key takes about 2 minutes. After that, sign in with Steam here.")
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

    /// Sign-in that came back through everythingapp://google instead of the browser sheet.
    private func takeGoogleReturn() {
        guard let r = model.googleReturn else { return }
        model.googleReturn = nil
        message["accounts"] = (r.ok, r.text)
        Task { await load() }
    }

    @ViewBuilder private func confluence(_ a: Connections.Atlassian) -> some View {
        SwiftUI.Section {
            if a.needsReconnect {
                // Atlassian ended the sign-in: Reconnect is the same sign-in and keeps the spaces and pages. Unlink and
                // linking again was the only way, and Unlink drops both (gnomecannon/aeneas#24).
                LabeledContent("Site", value: a.site_name ?? a.site_url ?? "")
                LabeledContent("Pages", value: "\(a.pages ?? 0)")
                LabeledContent("Last sync", value: when(a.last_sync))
                Text(a.last_error ?? "Atlassian ended the sign-in.").font(.footnote).foregroundStyle(.dangerText)
                Button { signInWithAtlassian() } label: { Label(busy == "atlassian" ? "Waiting for Atlassian" : "Reconnect", systemImage: "arrow.clockwise") }
                    .disabled(busy != nil)
                unlinkAtlassian
            } else if a.connected {
                LabeledContent("Site", value: a.site_name ?? a.site_url ?? "")
                LabeledContent("Pages", value: "\(a.pages ?? 0)")
                LabeledContent("Last sync", value: when(a.last_sync))
                if let e = a.last_error, !e.isEmpty { Text(e).font(.footnote).foregroundStyle(.dangerText) }
                spacePicker
                Button(busy == "atlassian" ? "Syncing" : "Sync now") { run("atlassian") { Self.counts(try await $0.syncConfluence()) } }
                    .disabled(busy != nil)
                unlinkAtlassian
            } else if a.app == true {
                Button { signInWithAtlassian() } label: { Label(busy == "atlassian" ? "Waiting for Atlassian" : "Sign in with Atlassian", systemImage: "person.badge.key") }
                    .disabled(busy != nil)
            } else {
                Text("Signing in needs the hub's own Atlassian app first, added once under App keys at the end of this page.").foregroundStyle(.secondary)
            }
            note("atlassian")
        } header: {
            Text("Confluence")
        } footer: {
            if a.needsReconnect {
                Text("Reconnect opens Atlassian's page: sign in with the account that reads \(a.site_name ?? "this site"). The pages already in the wiki stay.")
            } else if a.connected {
                Text("The chosen spaces are read again every hour and show under Library, Wiki, next to the repo docs.")
            } else if a.app == true {
                Text("Sign in on Atlassian's own page. The hub asks only to read spaces, pages and attachments; your Atlassian password never reaches it. Atlassian sends you back only to an https hub address.")
            } else {
                Text("The Atlassian app takes about 10 minutes, allowed only to read Confluence. After that, sign in with Atlassian here.")
            }
        }
        .themedRow()
    }

    /// Unlink, after asking: the sign-in and the mirrored pages go.
    private var unlinkAtlassian: some View {
        Button("Unlink", role: .destructive) { confirmUnlinkAtlassian = true }
            .disabled(busy != nil)
            .confirmationDialog("Unlink Confluence?", isPresented: $confirmUnlinkAtlassian, titleVisibility: .visible) {
                Button("Unlink", role: .destructive) {
                    run("atlassian") { try await $0.disconnectAtlassian(); spaces = nil; return "Unlinked. The Confluence pages left the wiki." }
                }
            } message: {
                Text("The hub forgets the sign-in and takes the mirrored Confluence pages out of the wiki. Confluence itself is not touched.")
            }
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
                if let e = l.last_error { Text(e).font(.footnote).foregroundStyle(.dangerText) }
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
            if model.config.sampleMode {
                // As with Contacts, Calendar and Reminders: no sample reading goes into the person's own Health.
                Text(HealthImporter.sampleOff).font(.subheadline).foregroundStyle(.secondary)
            } else {
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
        if let m = message[key] { Text(m.text).font(.footnote).foregroundStyle(m.ok ? AnyShapeStyle(.secondary) : AnyShapeStyle(.dangerText)) }
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
        await store.load(client, calendarsOn: model.isOn(.calendars))
        let c = store.c
        if calendarKey.isEmpty, let k = try? await client.feedKeys() { calendarKey = k.calendar.key }
        // An ended sign-in cannot list the spaces: they load once Reconnect lands.
        if c?.atlassian?.connected == true, c?.atlassian?.needsReconnect != true, spaces == nil {
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
