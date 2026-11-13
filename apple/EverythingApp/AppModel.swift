import SwiftUI
import Combine
import EACore
import EATailnet
import os.log
#if canImport(UIKit)
import UIKit
#endif

enum Section: String, CaseIterable, Identifiable, Hashable, Codable {
    // Tabs
    case today, assistant, capture, library, search
    // Plan
    case inbox, tasks, reminders, week, renewals, dashboard, planRules, now
    // Notes
    case notes, memory, people
    // Homelab
    case ops, hosts, journal, snippets
    // Making
    case projects, wiki, procedures, music, quiz, images
    // Body and home
    case health, logs, pet, food, sensors
    // Life admin
    case lists, career, games, films, calc
    case settings
    var id: String { rawValue }
    var title: String {
        switch self {
        case .today: return "Today"
        case .assistant: return "Assistant"
        case .capture: return "Capture"
        case .library: return "Library"
        case .search: return "Search"
        case .inbox: return "Unsorted Info"
        case .tasks: return "Tasks"
        case .reminders: return "Reminders"
        case .week: return "Week"
        case .renewals: return "Renewals"
        case .dashboard: return "Dashboard"
        case .planRules: return "Plan rules"
        case .now: return "Now"
        case .notes: return "Notes"
        case .memory: return "Memory"
        case .people: return "People"
        case .ops: return "Ops"
        case .hosts: return "Machines"
        case .journal: return "Change journal"
        case .snippets: return "Snippets"
        case .projects: return "Projects"
        case .wiki: return "Wiki"
        case .procedures: return "Procedures"
        case .music: return "Music"
        case .quiz: return "Recall quiz"
        case .images: return "Image Gallery"
        case .logs: return "Logs"
        case .health: return "Health"
        case .pet: return PetView.pet
        case .food: return "Food"
        case .sensors: return "Sensors"
        case .lists: return "Lists"
        case .career: return "Job applications"
        case .games: return "Games"
        case .films: return "Films"
        case .calc: return "Calculators"
        case .settings: return "Settings"
        }
    }
    var symbol: String {
        switch self {
        case .today: return "sun.max"
        case .assistant: return "bubble.left.and.text.bubble.right"
        case .capture: return "square.and.pencil"
        case .library: return "square.grid.2x2"
        case .search: return "magnifyingglass"
        case .inbox: return "tray"
        case .tasks: return "checklist"
        case .reminders: return "bell"
        case .week: return "calendar"
        case .renewals: return "arrow.triangle.2.circlepath"
        case .dashboard: return "chart.xyaxis.line"
        case .planRules: return "calendar.badge.clock"
        case .now: return "circle.inset.filled"
        case .notes: return "doc.text"
        case .memory: return "brain"
        case .people: return "person.2"
        case .ops: return "server.rack"
        case .hosts: return "desktopcomputer"
        case .journal: return "list.bullet.clipboard"
        case .snippets: return "chevron.left.forwardslash.chevron.right"
        case .projects: return "hammer"
        case .wiki: return "books.vertical"
        case .procedures: return "list.number"
        case .music: return "music.note"
        case .quiz: return "questionmark.bubble"
        case .images: return "photo.on.rectangle"
        case .logs: return "heart.text.square"
        case .health: return "heart"
        case .pet: return "pawprint"
        case .food: return "fork.knife"
        case .sensors: return "thermometer.medium"
        case .lists: return "checkmark.square"
        case .career: return "briefcase"
        case .games: return "gamecontroller"
        case .films: return "film"
        case .calc: return "function"
        case .settings: return "gearshape"
        }
    }
    /// The tab a section belongs to on the iPhone. Everything that is not a tab lives in Library.
    var tab: Section {
        switch self {
        case .today, .now, .week: return .today
        case .assistant, .memory: return .assistant
        case .capture: return .capture
        case .search: return .search
        default: return .library
        }
    }
    /// Library: every screen that is not a tab, grouped by area of life, the same on every device.
    static let areas: [LibraryArea] = [
        LibraryArea(title: "Plan", sections: [.inbox, .tasks, .week, .renewals, .dashboard]),
        LibraryArea(title: "Notes", sections: [.notes, .memory, .people]),
        LibraryArea(title: "Homelab", sections: [.ops, .hosts, .journal, .snippets]),
        LibraryArea(title: "Making", sections: [.projects, .wiki, .images, .procedures, .music, .quiz]),
        LibraryArea(title: "Body and home", sections: [.health, .logs, .pet, .food, .sensors]),
        LibraryArea(title: "Life admin", sections: [.lists, .games, .films, .calc]),
    ]
    /// iPad and Mac: the tabs first, then the Library areas as sidebar groups.
    static let primary: [Section] = [.today, .assistant, .capture, .search]

    /// The hub module a screen belongs to; nil for the core, which is always on.
    var module: AppModule? {
        switch self {
        case .renewals: return .renewals
        case .dashboard: return .dashboard
        case .ops, .hosts, .journal, .snippets: return .homelab
        case .projects, .procedures: return .projects
        case .music: return .music
        case .wiki: return .wiki
        case .images: return .images
        case .quiz: return .quiz
        case .health, .logs: return .health
        case .pet: return .pet
        case .food: return .food
        case .sensors: return .sensors
        case .games: return .games
        case .films: return .films
        case .calc: return .calc
        case .career: return .jobs
        default: return nil
        }
    }
}

struct SignInReturn: Equatable {
    var ok: Bool
    var text: String
}

struct LibraryArea: Identifiable, Hashable {
    let title: String
    let sections: [Section]
    var id: String { title }
}

@MainActor
final class AppModel: ObservableObject {
    static let shared = AppModel()

    let engine: SyncEngine
    let platform: Platform
    /// A screen whose module is off (a link, a search hit, a switch flipped on another device) falls back to Today.
    @Published var section: Section = .today { didSet { if !shows(section) { heldSection = section; section = .today } } }
    /// A screen asked for (a link, a notification, Spotlight) while the switches on this device said its module was
    /// off: shown once fresh switches say it is on, if Today is still showing.
    private var heldSection: Section?
    /// Module switches from the hub. Starts from the app group cache so nothing flickers in; empty means all on.
    @Published private(set) var modules: [ModuleInfo] = SharedConfig.shared.modules ?? []
    /// iPhone: Settings opens as a sheet from the gear, over whichever tab is showing.
    @Published var showingSettings = false
    /// A hub or local question about a long running activity, shown as a banner until answered.
    @Published var activityCheckin: ActivityCheckin?
    @Published var capturePrefill: String = ""
    @Published var captureRequested = false
    @Published var pendingSnoozeReminderId: String?
    @Published var started = false
    @Published var healthMessage: String?
    @Published var isConfigured = false
    /// The hub said this device was removed (Settings, Devices on another device): a plain screen asks to pair again.
    @Published var deviceRemoved = false
    /// What the modules that are on need from this device, offered once after pairing or when a module is switched on.
    @Published var permissionOffer: PermissionOffer?

    private init() {
        #if os(macOS)
        platform = .mac
        #else
        platform = UIDevice.current.userInterfaceIdiom == .pad ? .ipad : .iphone
        #endif
        engine = SyncEngine(config: .shared, platform: platform)
        if engine.config.sampleMode { Self.loadSample() }
        isConfigured = engine.config.isConfigured && !engine.deviceRemoved
        deviceRemoved = engine.deviceRemoved
        engine.onDeviceRemoved = { [weak self] in
            self?.isConfigured = false
            self?.deviceRemoved = true
            Task { await LocalCopy.wipeAppFiles() }
        }
        // Launch argument `-EASection week` opens that screen first (simulator screenshots, UI tests).
        if let s = UserDefaults.standard.string(forKey: "EASection"), let sec = Section(rawValue: s) { section = sec }
        engine.onNotify = { id, title, friction in
            Task { await ReminderScheduler.shared.notifyNow(reminderId: id, title: title, friction: friction) }
        }
        engine.onAlert = { alert in
            Task { await ReminderScheduler.shared.notifyAlert(alert) }
        }
        engine.onActivityCheckin = { [weak self] c in self?.activityCheckin = c }
        engine.onModules = { [weak self] list in self?.applyModules(list, offer: true) }
        engine.onDigest = { title in
            Task { await ReminderScheduler.shared.notifyDigest(title: StyleGuard.dashes(title)) }
        }
        spotlight = engine.$entities
            .debounce(for: .seconds(8), scheduler: RunLoop.main)
            .sink { [weak self] _ in
                guard let self else { return }
                Task { await SpotlightIndexer.shared.update(self.engine) }
            }
        // A task or event changed here or synced from another device reaches Apple Reminders or Calendar a few seconds later.
        // Each copy runs only when what it reads changed: Ops brings in fresh monitors every 30 s, which none of them read.
        appleReminders = engine.$entities
            .debounce(for: .seconds(3), scheduler: RunLoop.main)
            .sink { [weak self] entities in
                guard let self else { return }
                let prints = Self.mirrorPrints(entities)
                let changed = Set(Self.mirrorKinds.filter { prints[$0] != self.lastMirrorPrints[$0] })
                self.lastMirrorPrints = prints
                if changed.contains(.task) { RemindersSync.shared.scheduleRun(after: 2) }
                if changed.contains(.event) { EventMirrorSync.shared.scheduleRun(after: 2) }
                if changed.contains(.person) { ContactsSync.shared.scheduleRun(after: 3) }
                #if os(iOS)
                // New generated images go to Photos when that switch is on, and only while Images is on.
                if PhotosOptions.saveGenerated, self.isOn(.images) { Task { await PhotosOptions.saveNew(engine: self.engine) } }
                #endif
            }
        #if canImport(ActivityKit) && os(iOS)
        // The Live Activity follows the running activity or focus block shortly after any change.
        liveActivity = engine.$entities
            .debounce(for: .seconds(2), scheduler: RunLoop.main)
            .sink { [weak self] _ in
                guard let self else { return }
                Task { await LiveActivityController.shared.update(self.engine) }
            }
        #endif
        #if os(iOS)
        // A log made anywhere (this phone, the Mac, the assistant) reaches Health a few seconds after it syncs here.
        healthWrites = engine.$entities
            .debounce(for: .seconds(4), scheduler: RunLoop.main)
            .sink { [weak self] _ in
                guard let self, self.config.healthImportEnabled, self.isOn(.health) else { return }
                Task { await HealthImporter.shared.exportNow(self.engine) }
            }
        #endif
    }
    private var spotlight: AnyCancellable?
    private var appleReminders: AnyCancellable?
    /// The kinds the Apple copies read: tasks (Reminders), events (Calendar), people (Contacts).
    private static let mirrorKinds: [Kind] = [.task, .event, .person]
    private var lastMirrorPrints: [Kind: Int] = [:]
    /// One hash per kind over every item of it, deleted ones too, the same in any order.
    private static func mirrorPrints(_ entities: [String: Entity]) -> [Kind: Int] {
        var out: [Kind: Int] = [:]
        for e in entities.values where mirrorKinds.contains(e.kind) { out[e.kind, default: 0] &+= e.hashValue }
        return out
    }
    private var liveActivity: AnyCancellable?
    #if os(iOS)
    private var healthWrites: AnyCancellable?
    #endif

    /// "Still on it": dismiss the banner. "Stop": close the activity with an `end` log.
    func answerCheckin(stop: Bool) async {
        let c = activityCheckin
        activityCheckin = nil
        if stop {
            if let cur = engine.currentActivity, c == nil || cur.logId == c?.logId || cur.name == c?.name { await engine.endActivity() }
            else if let name = c?.name, !name.isEmpty { _ = await engine.log(type: .activity, value: .string(name), unit: "min", note: "end") }
        }
    }

    var config: SharedConfig { engine.config }

    /// The Now widget's Done for a Direct link hub, which the widget could not send itself.
    func sendPendingWidgetDone() async {
        guard let p = config.pendingWidgetDone else { return }
        let parts = p.split(separator: "|", maxSplits: 1).map(String.init)
        guard parts.count == 2 else { config.pendingWidgetDone = nil; return }
        guard !config.deviceId.isEmpty, let client = HubClient.make(config: config) else { return }
        let done = Patch(id: parts[0], kind: .task, ts: parts[1], fields: ["status": .string("done"), "done_at": .string(parts[1])])
        if (try? await client.push(deviceId: config.deviceId, patches: [done])) != nil { config.pendingWidgetDone = nil }
    }

    func start() async {
        // Out of iCloud Backup unless the person chose otherwise (Settings, Privacy on this device).
        BackupExclusion.apply(config: engine.config)
        if started {
            // A start in the background before the first unlock could not read the key; this one can.
            if !isConfigured, !deviceRemoved, config.isConfigured { isConfigured = true }
            await engine.start()
            await refreshModules()
            await CalendarImporter.shared.runIfReady(reason: "foreground")
            await RemindersSync.shared.runIfReady(reason: "foreground")
            await EventMirrorSync.shared.runIfReady(reason: "foreground")
            await ContactsSync.shared.runNow(reason: "foreground")
            await sendPendingWidgetDone()
            #if os(iOS)
            await sendPendingShares()
            // Hums from the Watch that could not reach the hub before go now.
            WatchHumRelay.shared.kick()
            await healthImportIfDue()
            #endif
            return
        }
        started = true
        // Tailscale signed in or out inside Aeneas: the hub is reached another way now.
        TailnetSignIn.shared.onChange = { [weak self] in Task { @MainActor in await self?.tailnetChanged() } }
        ReminderScheduler.shared.registerCategories()
        await engine.start()
        isConfigured = config.isConfigured && !engine.deviceRemoved
        // The module switches and the pet's name first, without waiting, so a screen of a module switched on
        // elsewhere shows at once and a link to it does not open Today.
        if isConfigured { Task { await refreshProfile(); await refreshModules() } }
        #if os(iOS) && DEBUG
        await DebugHooks.applyLaunchArguments(self)
        #elseif os(macOS) && DEBUG
        await DebugHooksMac.applyLaunchArguments(self)
        #endif
        // Nothing here asks for a permission (release rule 2): each runs only with access already given and its
        // module on. Asking happens on the permission screen after pairing or a module switched on, or on the
        // feature's own screen when the person taps something that needs it.
        if isConfigured { await CalendarImporter.shared.autoStart(facts: engine.facts) }
        if isConfigured { await RemindersSync.shared.autoStart() }
        if isConfigured { await EventMirrorSync.shared.runIfReady(reason: "launch"); await ContactsSync.shared.runNow(reason: "launch") }
        await refreshProfile()
        // Before the Health import, which waits on whether Health is on.
        await refreshModules()
        await healthImportIfDue()
        #if os(iOS)
        await sendPendingShares()
        WatchHumRelay.shared.kick()
        #endif
    }

    /// A pairing link to another hub, waiting for the owner to say switch or keep (RootView asks).
    @Published var pendingSetup: PendingSetup?
    /// What went wrong with the last pairing link, shown on the setup screen.
    @Published var setupError: String?

    struct PendingSetup: Identifiable, Equatable {
        let link: SetupLink
        let current: String
        var hub: String { link.hub }
        var id: String { link.hub }
    }

    static func sameHub(_ a: String, _ b: String) -> Bool { SyncEngine.sameHub(a, b) }

    /// Pair with a one-time code (Setup, Shortcuts). Nil when it worked, else what went wrong, in plain words. A long
    /// value that is not a code is taken as an older hub's shared key and traded for this device's own key.
    func pair(hub: String, code: String, name: String?, pin: String? = nil) async -> String? {
        let raw = code.trimmingCharacters(in: .whitespacesAndNewlines)
        if PairingCode.isValid(raw) { return await connect(SetupLink(hub: hub, credential: .code(raw), name: name, pin: pin)) }
        if raw.count >= 16 { return await connect(SetupLink(hub: hub, credential: .token(raw), name: name, pin: pin)) }
        return "A pairing code has 8 letters and numbers, like ABCD-EFGH."
    }

    /// Tailscale inside Aeneas connected or signed out: the paired hub's connection is made again; a pairing that
    /// could not reach a Tailscale hub is tried again.
    func tailnetChanged() async {
        if isConfigured { await engine.rebuildClient(); return }
        if let link = unreachedSetup, case .connected = TailnetSignIn.shared.state { setupError = await connect(link) }
    }

    /// The last setup link that could not reach its hub: tried again once Tailscale is signed in inside Aeneas.
    @Published var unreachedSetup: SetupLink?

    /// Connect with a setup link or what was typed on the setup screen.
    func connect(_ link: SetupLink) async -> String? {
        await ensureStarted()
        guard HTTPTransport.hubURL(link.hub) != nil else { return "That hub address is not valid." }
        defer { if isConfigured { unreachedSetup = nil } }
        do {
            switch link.credential {
            case .code(let code): try await engine.pair(hubURL: link.hub, code: code, deviceName: link.name, pin: link.pin)
            case .token(let token): try await engine.connect(hubURL: link.hub, token: token, deviceName: link.name, pin: link.pin)
            }
        } catch {
            Self.log.notice("pairing failed: \(String(describing: type(of: error)), privacy: .public)")
            if Tailnet.isTailnetHub(link.hub), let h = error as? HubError, case .transport = h { unreachedSetup = link }
            return Self.pairingMessage(error)
        }
        isConfigured = config.isConfigured
        deviceRemoved = false
        setupError = nil
        Self.log.notice("paired hub=\(URL(string: link.hub)?.host ?? "", privacy: .public) own key=\(self.config.hasDeviceKey)")
        if isConfigured { section = .today; await refreshProfile(); await refreshModules() }
        return nil
    }

    static func pairingMessage(_ e: Error) -> String {
        guard let h = e as? HubError else { return e.localizedDescription }
        switch h {
        case .http(let status, let message) where status == 401:
            return message.isEmpty || message == "unauthorized" ? "The hub did not accept that. Make a new pairing code on a device that is already paired." : message
        case .http(let status, _) where status == 404:
            return "This hub is too old for pairing codes. Update it, or open the setup link its Welcome page shows."
        case .http(let status, _) where status == 429:
            return "Too many tries. Wait a minute, then make a new code."
        case .notConfigured: return "That hub address is not valid."
        case .transport(let m): return "Could not reach the hub: \(m)"
        default: return h.errorDescription ?? "Pairing did not work."
        }
    }

    /// Settings, Devices, Remove this device: the hub ends this device's key, and it signs out here. What is on the
    /// device stays, with edits not sent yet, for when it is paired again.
    func removeThisDevice() async -> String? {
        guard let c = engine.client else { return "This device is not connected." }
        let id = config.deviceId
        do { try await withDeadline(20) { try await c.removeDevice(id) } }
        catch { return (error as? HubError)?.errorDescription ?? error.localizedDescription }
        engine.signOut()
        isConfigured = false
        return nil
    }

    // MARK: sample mode

    /// The demo hub's recorded month (SampleHub.json in the app), loaded once, only when sample mode is used.
    static func loadSample() {
        guard SampleTransport.shared == nil, let url = Bundle.main.url(forResource: "SampleHub", withExtension: "json"),
              let data = try? Data(contentsOf: url) else { return }
        SampleTransport.shared = SampleTransport(data: data)
    }

    /// Setup's Try it with sample data: the app runs on a made-up month, with no hub and no network.
    func startSample() async {
        await ensureStarted()
        Self.loadSample()
        guard SampleTransport.shared != nil else { setupError = "The sample data is missing from this build."; return }
        await engine.startSample()
        isConfigured = config.isConfigured
        deviceRemoved = false
        setupError = nil
        section = .today
        await refreshProfile()
        await refreshModules()
    }

    /// Leave sample mode: the sample and every change made to it are wiped, and Setup shows again.
    func endSample() async {
        await engine.endSample()
        await LocalCopy.wipeAppFiles()
        isConfigured = false
        section = .today
    }

    /// The removed screen's Pair again: back to Setup with the hub address kept.
    func startPairingAgain() {
        engine.clearRemoved()
        deviceRemoved = false
    }

    /// Offer what the modules that are on need, when any of it was never asked on this device.
    func offerPermissions(for list: [ModuleInfo]) async {
        var ask: [PermissionNeed] = []
        for n in PermissionPlan.needs(list, platform: platform) where await DevicePermissions.undecided(n.permission) { ask.append(n) }
        guard !ask.isEmpty else { return }
        permissionOffer = PermissionOffer(needs: ask)
    }

    /// Continue on the permission screen: each permission in turn, then what it unlocks starts.
    func grantOffered(_ offer: PermissionOffer) async {
        permissionOffer = nil
        for n in offer.needs { _ = await DevicePermissions.request(n.permission, engine: engine) }
        await engine.replanNotifications()
    }

    /// The pet's name (and the owner's) from the hub, kept for labels that show before the hub answers.
    func refreshProfile() async {
        guard let c = engine.client, let p = try? await c.profile() else { return }
        UserDefaults.standard.set(p.pet, forKey: PetView.nameKey)
        UserDefaults.standard.set(p.named == false ? "" : p.name, forKey: AdminGames.ownerKey)
    }

    // MARK: Modules

    func isOn(_ m: AppModule) -> Bool { modules.isOn(m) }
    /// Whether a screen shows: core screens always, module screens while their module is on.
    func shows(_ s: Section) -> Bool { s.module.map(isOn) ?? true }

    /// The Library with screens of switched off modules left out, and areas with nothing left dropped.
    var libraryAreas: [LibraryArea] {
        Section.areas.compactMap { a in
            let shown = a.sections.filter(shows)
            return shown.isEmpty ? nil : LibraryArea(title: a.title, sections: shown)
        }
    }

    /// Fetch the switches; offline keeps the cached ones.
    func refreshModules() async {
        guard let c = engine.client, let list = try? await c.modules() else { return }
        applyModules(list)
    }

    /// Switch modules on or off for every device; the hub answers with the whole list.
    func setModules(_ changes: [String: Bool]) async throws {
        guard let c = engine.client else { throw HubError.notConfigured }
        applyModules(try await c.setModules(changes), offer: true)
    }

    /// `offer`: the list came from a switch changed now (here in Settings, or another device over /live), so a
    /// module switched on offers what it needs. A fetch at launch never does. Right after pairing, the first list
    /// offers what every module that is on needs.
    func applyModules(_ list: [ModuleInfo], offer: Bool = false) {
        let before = modules
        if list != modules { modules = list }
        config.modules = list
        if !shows(section) { section = .today }
        if let held = heldSection { heldSection = nil; if section == .today, shows(held) { section = held } }
        if config.permissionOfferPending {
            config.permissionOfferPending = false
            Task { await offerPermissions(for: PermissionPlan.withDeviceDefaults(list)) }
        } else if offer {
            let switchedOn = PermissionPlan.switchedOn(before: before, after: list)
            if !switchedOn.isEmpty { Task { await offerPermissions(for: switchedOn) } }
        }
        // Reminder alerts switched off take this device's planned alerts off; on, they come back.
        if before.isOn(.notifications) != list.isOn(.notifications) { Task { await engine.replanNotifications() } }
    }

    func ensureStarted() async { if !started { await start() } }

    /// Things shared while the hub was out of reach wait in the app group; send them now.
    func sendPendingShares() async {
        for (file, req) in PendingShares.all() {
            if await engine.capture(req.text, attachments: req.attachments, source: req.source) != nil { PendingShares.remove(file) }
        }
    }

    private static let log = Logger(subsystem: SharedConfig.logSubsystem, category: "url")

    /// The item a link or Spotlight result asked for; screens that can show one item select it.
    @Published var focusItemId: String?
    /// A chat to open in the Assistant (a capture's filing chat, from Unsorted Info).
    @Published var openChatId: String?

    func openChat(_ id: String) {
        openChatId = id
        section = .assistant
    }
    /// An item shown on its own over the current screen (ItemView), for kinds whose screen has no selection.
    @Published var openItemId: String?
    /// A wiki page asked for by an everythingapp://wiki?id= link; the wiki opens it.
    @Published var wikiPageId: String?
    /// What came back from Sign in with Atlassian when it returned through the app's URL handler.
    @Published var atlassianReturn: SignInReturn?
    /// What came back from Sign in with Google when it returned through the app's URL handler.
    @Published var googleReturn: SignInReturn?

    func open(itemId: String) {
        if let e = engine.get(itemId) {
            show(e)
            return
        }
        // Not on this device yet (a link from another device, or sync still catching up): fetch it from the hub.
        Task {
            guard let c = engine.client, let e = try? await c.entity(itemId) else { return }
            await engine.absorb(e)
            show(e)
        }
    }

    /// Screens that select a focused item themselves; any other item opens on its own over the current screen.
    private static let focusingKinds: Set<Kind> = [.note, .application, .film]

    private func show(_ e: Entity) {
        if Self.focusingKinds.contains(e.kind) {
            focusItemId = e.id
            section = SearchView.section(for: e.kind)
        } else {
            openItemId = e.id
        }
    }

    func handle(url: URL) {
        // Only the kind of link: a setup link carries a pairing code (or an older hub's key), which must never reach
        // the system log.
        Self.log.notice("open url: \(url.scheme ?? "", privacy: .public)://\(url.host ?? "", privacy: .public)")
        guard url.scheme?.lowercased() == "everythingapp" else { return }
        let host = (url.host ?? url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))).lowercased()
        switch host {
        case "capture":
            let text = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "text" }?.value ?? ""
            capturePrefill = text
            captureRequested = true
            section = .capture
        case "setup":
            // everythingapp://setup?hub=<hub url>&code=<one-time code>&name=<device name>[&fp=<certificate SHA-256>],
            // or an older link with &token= (traded for this device's own key at once).
            guard let link = SetupLink.parse(url) else {
                setupError = "That setup link is not complete. Make a new pairing code on a device that is already paired."
                return
            }
            // A link to another hub than this device's waits for a yes: a link in a note, a page or an email must not
            // move the device to someone else's hub unnoticed. A first setup, or the same hub, connects at once.
            if isConfigured, !Self.sameHub(config.hubURL, link.hub) {
                pendingSetup = PendingSetup(link: link, current: config.hubURL)
                return
            }
            Task { setupError = await connect(link) }
        case "now":
            section = .now
        case "today":
            section = .today
        case "week":
            section = .week
        case "renewals":
            section = .renewals
        case "reminders":
            section = .tasks
        case "section":
            // everythingapp://section/<name>, e.g. everythingapp://section/films
            if let name = url.pathComponents.dropFirst().first, let s = Section(rawValue: name) { section = s }
        case "item":
            // everythingapp://item/<id>: the screen that holds it (Spotlight, notifications, Shortcuts).
            if let id = url.pathComponents.dropFirst().first { open(itemId: id) }
        case "wiki":
            // everythingapp://wiki?id=<page id>: that page in the wiki.
            wikiPageId = WikiLink.pageId(url)
            section = .wiki
        case "atlassian":
            // everythingapp://atlassian?linked=1&message=… or ?error=…, when sign-in finished outside the app's browser sheet.
            let q = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            if let err = q.first(where: { $0.name == "error" })?.value { atlassianReturn = SignInReturn(ok: false, text: err) }
            else { atlassianReturn = SignInReturn(ok: true, text: q.first(where: { $0.name == "message" })?.value ?? "Confluence linked.") }
            section = .settings
        case "google":
            // everythingapp://google?linked=1&message=… or ?error=…, when sign-in finished outside the app's browser sheet.
            let q = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            if let err = q.first(where: { $0.name == "error" })?.value { googleReturn = SignInReturn(ok: false, text: err) }
            else { googleReturn = SignInReturn(ok: true, text: q.first(where: { $0.name == "message" })?.value ?? "Gmail linked.") }
            section = .settings
        default:
            if let s = Section(rawValue: host) { section = s }
        }
    }

    func healthImportIfDue() async {
        #if os(iOS)
        guard config.healthImportEnabled, isOn(.health) else { return }
        HealthImporter.shared.startObserving(engine)
        // Every return to the app sends what is new, at most every 15 minutes.
        if let last = config.lastHealthImport, Date().timeIntervalSince(last) < 900 { return }
        let result = await HealthImporter.shared.importIfAuthorized(into: engine)
        healthMessage = result
        #endif
    }
}
