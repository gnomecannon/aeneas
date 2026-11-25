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
    case inbox, tasks, reminders, week, mail, planRules
    // Notes
    case notes, reference, wiki, quiz
    // People
    case people, memory
    // Media
    case films, games, listening
    // Body and home
    case health, logs, dashboard, pet, food
    // Life admin
    case renewals, lists, calc
    // Making
    case projects, procedures, music, images
    // Tech
    case ops, hosts, sensors, journal, snippets
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
        case .notes: return "Notes"
        case .memory: return "Memory"
        case .people: return "People"
        case .reference: return "Reference"
        case .ops: return "Overview"
        case .hosts: return "Machines"
        case .journal: return "Change journal"
        case .snippets: return "Snippets"
        case .projects: return "Projects"
        case .wiki: return "Wiki"
        case .procedures: return "Procedures"
        case .music: return "Song ideas"
        case .quiz: return "Recall quiz"
        case .images: return "Image Gallery"
        case .logs: return "Logs"
        case .health: return "Health"
        case .pet: return PetView.pet
        case .food: return "Food"
        case .sensors: return "Sensors"
        case .mail: return "Mail"
        case .lists: return "Lists"
        case .games: return "Games"
        case .films: return "Films"
        // Apple Music listening (module apple_music). Song ideas, `music`, is the Making screen.
        case .listening: return "Music"
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
        case .notes: return "doc.text"
        case .memory: return "brain"
        case .people: return "person.2"
        case .reference: return "text.book.closed"
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
        case .mail: return "envelope"
        case .lists: return "checkmark.square"
        case .games: return "gamecontroller"
        case .films: return "film"
        case .listening: return "headphones"
        case .calc: return "function"
        case .settings: return "gearshape"
        }
    }
    /// The screen whose own stack shows this one on the iPhone while this one has no place in the bottom bar
    /// (`BarLayout.tab(for:)`): Week opens over Today, Memory over the Assistant, and the Overview's own pages
    /// over the Overview. Nil, or a home with no place either: it opens inside Library, like every other screen.
    var barHome: Section? {
        switch self {
        case .week: return .today
        case .memory: return .assistant
        case .hosts, .journal, .snippets: return .ops
        default: return nil
        }
    }
    /// Library: every screen that is not a tab, grouped by area of life, the same on every device (the web's `AREAS`
    /// and each module's `group` on the hub; CONTRACT.md, Modules). Since 2026-11-25 People and Media are areas of their
    /// own, Mail is in Plan, Renewals in Life admin, the Dashboard in Body and home, and the Wiki and Recall quiz in Notes.
    static let areas: [LibraryArea] = [
        LibraryArea(title: "Plan", sections: [.inbox, .tasks, .week, .mail]),
        LibraryArea(title: "Notes", sections: [.notes, .reference, .wiki, .quiz]),
        LibraryArea(title: "People", sections: [.people, .memory]),
        // What you watch, play and listen to. Music is the Apple Music taste this iPhone, iPad or Mac reads.
        LibraryArea(title: "Media", sections: [.films, .games, .listening]),
        LibraryArea(title: "Body and home", sections: [.health, .logs, .dashboard, .pet, .food]),
        LibraryArea(title: "Life admin", sections: [.renewals, .lists, .calc]),
        LibraryArea(title: "Making", sections: [.projects, .procedures, .music, .images]),
        // Since 2026-11-19 one screen: a card per machine, service and place, each opening its page (checks, readings,
        // fix notes, changes, snippets). Machine pages, the change journal and snippets stay sections for links,
        // notifications and Spotlight, reached from the Overview. With Machines off, the home sensors are Sensors.
        LibraryArea(title: "Tech", sections: [.ops, .sensors]),
    ]
    /// iPad and Mac: the tabs first, then the Library areas as sidebar groups.
    static let primary: [Section] = [.today, .assistant, .capture, .search]

    /// A module that, while on, takes this screen out of the Library: the Overview holds every reading when Machines
    /// is on, so Sensors is listed only while it is off.
    var hiddenWhileOn: AppModule? { self == .sensors ? .homelab : nil }

    /// The Library row a screen counts as: the machines list, the change journal and snippets are the Tech Overview's
    /// own pages (reached from it, or by a link), so the Tech area stays open on them.
    var libraryRow: Section {
        switch self {
        case .hosts, .journal, .snippets: return .ops
        default: return self
        }
    }

    /// The hub module a screen belongs to; nil for the core, which is always on.
    var module: AppModule? {
        switch self {
        case .renewals: return .renewals
        case .dashboard: return .dashboard
        case .reference: return .reference
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
        case .listening: return .appleMusic
        case .calc: return .calc
        case .mail: return .mailInbox
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
    /// Machines was just switched on in this app: Set up Machines shows (MachinesStartSheet), after the permission
    /// screen when there is one, until Done.
    @Published var machinesStart = false

    private init() {
        #if os(macOS)
        platform = .mac
        #else
        platform = UIDevice.current.userInterfaceIdiom == .pad ? .ipad : .iphone
        #endif
        engine = SyncEngine(config: .shared, platform: platform)
        if engine.config.sampleMode { Self.loadSample() }
        // Before any screen shows: one the app opens on reads its first answer through it (SyncEngine.connectEarly).
        engine.connectEarly()
        isConfigured = engine.config.isConfigured && !engine.deviceRemoved
        deviceRemoved = engine.deviceRemoved
        engine.onDeviceRemoved = { [weak self] in
            self?.isConfigured = false
            self?.deviceRemoved = true
            Task { await LocalCopy.wipeAppFiles() }
        }
        // Launch argument `-EASection week` opens that screen first (simulator screenshots, UI tests).
        if let s = UserDefaults.standard.string(forKey: "EASection"), let sec = Section(rawValue: s) { section = sec }
        engine.onNotify = { id, title, friction, at in
            Task { await ReminderScheduler.shared.notifyNow(reminderId: id, title: title, friction: friction, at: at) }
        }
        engine.onAlert = { alert in
            Task { await ReminderScheduler.shared.notifyAlert(alert) }
        }
        engine.onActivityCheckin = { [weak self] c in self?.activityCheckin = c }
        engine.onModules = { [weak self] list in self?.applyModules(list, offer: true) }
        // A Reminders list switched on or off: Spotlight follows the tasks that show.
        engine.onSources = { [weak self] _ in
            guard let self else { return }
            Task { await SpotlightIndexer.shared.update(self.engine) }
        }
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
        // The Watch complications follow what this iPhone shows, sent when it changes; never the sample month.
        if platform == .iphone {
            engine.onComplicationSnapshot = { [weak self] snapshot in
                guard let self, !self.config.sampleMode else { return }
                WatchLink.shared.sendComplications(snapshot)
            }
        }
        // A log made anywhere (this phone, the Mac, the assistant) reaches Health a few seconds after it syncs here;
        // never the sample month's, as with Contacts, Calendar and Reminders (exportNow checks it too).
        healthWrites = engine.$entities
            .debounce(for: .seconds(4), scheduler: RunLoop.main)
            .sink { [weak self] _ in
                guard let self, self.config.healthImportEnabled, self.isOn(.health), !self.config.sampleMode else { return }
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
            // Music: Apple Music read again when the profile is more than 12 hours old (on any device), without holding
            // up the rest.
            Task { await MusicTasteReader.shared.readIfDue(engine: engine) }
            #if os(iOS)
            await sendPendingShares()
            // Hums from the Watch that could not reach the hub before go now, and captures not written down yet.
            WatchHumRelay.shared.kick()
            WatchCaptureRelay.shared.kick()
            WatchSpeechSetup.shared.kick()
            await healthImportIfDue()
            #endif
            return
        }
        started = true
        #if os(macOS)
        // A helped person's Mac runs their helper's commands while they let it (HelperComputer).
        HelperComputer.shared.start(engine: engine, name: { [weak self] in self?.config.deviceName ?? "Mac" })
        // This Mac's readings go to the hub while the person lets them (ThisMacReport; off until ticked).
        ThisMacReport.shared.start(engine: engine)
        #endif
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
        // After the switches (Music is read only while the hub lists it as on), when the profile is old or missing.
        if isConfigured { Task { await MusicTasteReader.shared.readIfDue(engine: engine) } }
        #if os(iOS)
        await sendPendingShares()
        WatchHumRelay.shared.kick()
        WatchCaptureRelay.shared.kick()
        WatchSpeechSetup.shared.kick()
        #endif
    }

    /// A pairing link to another hub, waiting for the owner to say switch or keep (PairingPrompts asks).
    @Published var pendingSetup: PendingSetup?
    /// A pairing link for the hub this device already uses, waiting for Pair again or Cancel (PairingPrompts asks).
    @Published var pendingRepair: SetupLink?
    /// Another device's join code, opened from the Camera: Add it to your hub? (JoinRequestSheet).
    @Published var pendingJoin: JoinLink?
    /// How a pairing link went while Set up is not on screen, or which hub a phone's yes joined; shown in an alert.
    @Published var pairingNotice: PairingNotice?
    /// What went wrong with the last pairing link, shown on the setup screen.
    @Published var setupError: String?

    struct PairingNotice: Identifiable, Equatable {
        let id = UUID()
        var title: String
        var message: String?
    }

    struct PendingSetup: Identifiable, Equatable {
        let link: SetupLink
        let current: String
        /// The id of the hub this device uses now, when known: a link with another id is for another hub, whatever its address.
        var currentId: String? = nil
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
        // Moving to another hub (or from the sample month): the engine forgets the old hub's copy, and this app's own
        // files from it (chats, caches, Spotlight, the pet's name) go once the new hub took this device. The same hub
        // reached at another address (its id says so) keeps them.
        let otherHub = !config.hubURL.isEmpty && !SyncEngine.sameHub(config.hubURL, id: config.hubId, link.hub, id: link.hubId)
        do {
            switch link.credential {
            case .code(let code): try await engine.pair(hubURL: link.hub, code: code, deviceName: link.name, pin: link.pin, hubId: link.hubId)
            case .token(let token): try await engine.connect(hubURL: link.hub, token: token, deviceName: link.name, pin: link.pin, hubId: link.hubId)
            }
        } catch {
            Self.log.notice("pairing failed: \(String(describing: type(of: error)), privacy: .public)")
            if Tailnet.isTailnetHub(link.hub), let h = error as? HubError, case .transport = h { unreachedSetup = link }
            return Self.pairingMessage(error)
        }
        if otherHub { await LocalCopy.wipeAppFiles() }
        isConfigured = config.isConfigured
        deviceRemoved = false
        setupError = nil
        Self.log.notice("paired hub=\(URL(string: link.hub)?.host ?? "", privacy: .public) own key=\(self.config.hasDeviceKey)")
        if isConfigured { section = .today; await refreshProfile(); await refreshModules() }
        return nil
    }

    /// A setup link opened (the Camera, a message) or found in pasted text. Set up shows what went wrong itself; anywhere
    /// else every outcome shows in an alert, so a link never fails, or pairs again, without a word.
    func useSetupLink(_ link: SetupLink) {
        guard isConfigured else {
            if deviceRemoved { Task { await connectAndReport(link) } } else { Task { setupError = await connect(link) } }
            return
        }
        // An item open over the screen would keep the question from showing.
        openItemId = nil
        // The sample month is no hub: Set up says setting up a hub wipes it, so a link pairs at once, as on a device
        // that is not paired (asking whether to leave "sample://everythingapp" only confused).
        if config.sampleMode {
            Task { await connectAndReport(link) }
            return
        }
        // A link to another hub than this device's waits for a yes: a link in a note, a page or an email must not
        // move the device to someone else's hub unnoticed. Another hub id is another hub even at this address. So
        // does one to this hub that names another certificate than the one pinned now (taken at once, it replaced
        // the pin), or this hub at another address without the pinned certificate (the id alone proves nothing).
        if link.needsConfirmation(currentHub: config.hubURL, currentPin: config.hubPin, currentHubId: config.hubId) {
            pendingSetup = PendingSetup(link: link, current: config.hubURL, currentId: config.hubId)
            return
        }
        // The same hub, address and certificate: following it would only pair this device again.
        if link.pairsAgain(currentHub: config.hubURL, currentPin: config.hubPin, currentHubId: config.hubId) {
            pendingRepair = link
            return
        }
        Task { await connectAndReport(link) }
    }

    /// Pairs with `link` and says how it went in an alert.
    func connectAndReport(_ link: SetupLink) async {
        if let e = await connect(link) {
            pairingNotice = PairingNotice(title: "Pairing did not work", message: e)
            return
        }
        await notePaired()
    }

    /// "Paired with <hub>": the hub this device now uses, by the name it gives itself, else by its address. After a
    /// phone's yes this is how the new device says which hub it joined.
    func notePaired() async {
        pairingNotice = PairingNotice(title: "Paired with \(await pairedHubLabel())", message: nil)
    }

    /// The paired hub's own name, asked now (the one kept may be the previous hub's), else its address.
    private func pairedHubLabel() async -> String {
        if let c = engine.client, let h = try? await withDeadline(15, { try await c.health() }),
           let n = h.hub?.name?.trimmingCharacters(in: .whitespacesAndNewlines), !n.isEmpty {
            return "\(n)\u{2019}s hub"
        }
        return Self.hubPlace(config.hubURL)
    }

    /// The hub this device uses now, for a question: its name when it gave one, else its address.
    var currentHubLabel: String {
        if let n = engine.hubIdentity?.name?.trimmingCharacters(in: .whitespacesAndNewlines), !n.isEmpty { return "\(n)\u{2019}s hub" }
        return Self.hubPlace(config.hubURL)
    }

    /// A hub address in words: its host (and port), or for a Direct link hub the start of its key, as the web app shows it.
    static func hubPlace(_ hub: String) -> String {
        if let d = DirectHub.parse(hub) { return "the hub with Direct link key \(d.node.prefix(10))" }
        guard let u = HTTPTransport.hubURL(hub), let h = u.host else { return hub }
        return u.port.map { "\(h):\($0)" } ?? h
    }

    /// The phone's Add on another device's join code: its hub reaches that device over Direct link and hands it a
    /// pairing link. The words to show afterwards, and whether it worked.
    func join(_ link: JoinLink) async -> (text: String, ok: Bool) {
        guard isConfigured, !config.sampleMode, let c = engine.client else { return ("Pair this device with your hub first.", false) }
        do {
            // The hub may take about 100 seconds (HTTPTransport.timeout); this is only the last stop.
            switch try await withDeadline(115, { try await c.join(link) }) {
            case .added(let name): return ("Added \(name).", true)
            case .sent(let name): return ("Sent to \(name). It finishes pairing by itself.", true)
            }
        } catch {
            return (JoinAnswer.failureText(error, name: link.name), false)
        }
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
    /// device stays, with edits not sent yet, for when it is paired again. Nil when it worked; else what went wrong, and
    /// whether the hub could not be reached at all (then `forgetHub()` is offered).
    func removeThisDevice() async -> (message: String, unreachable: Bool)? {
        guard let c = engine.client else { return ("This device is not connected.", true) }
        let id = config.deviceId
        do { try await withDeadline(20) { try await c.removeDevice(id) } }
        catch { return ((error as? HubError)?.errorDescription ?? error.localizedDescription, Self.unreachable(error)) }
        forgetHub()
        return nil
    }

    /// The hub did not answer at all: no connection, a time limit, or a proxy in front of it saying it is not there.
    static func unreachable(_ e: Error) -> Bool {
        guard let h = e as? HubError else { return true }
        switch h {
        case .transport: return true
        case .http(let status, _): return [502, 503, 504].contains(status)
        default: return false
        }
    }

    /// This device stops using its hub without telling it: the half of Remove this device that happens here, for a
    /// device that cannot reach its hub. It goes back to Set up; what is on it stays, and the hub lists it until it is
    /// removed from another device.
    func forgetHub() {
        engine.signOut()
        isConfigured = false
    }

    // MARK: sample mode

    /// The demo hub's recorded month (SampleHub.json in the app), loaded once, only when sample mode is used. With it,
    /// the hub's meals tax table (SampleMealsTax.json), so the bill splitter's "Use my location" works with no hub.
    static func loadSample() {
        guard SampleTransport.shared == nil, let url = Bundle.main.url(forResource: "SampleHub", withExtension: "json"),
              let data = try? Data(contentsOf: url) else { return }
        let mealsTax = Bundle.main.url(forResource: "SampleMealsTax", withExtension: "json")
            .flatMap { try? Data(contentsOf: $0) }
            .flatMap { try? JSONDecoder().decode(MealsTaxTable.self, from: $0) }
        SampleTransport.shared = SampleTransport(data: data, mealsTax: mealsTax)
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
    func shows(_ s: Section) -> Bool {
        // Mail is off on a new hub, and a hub from before it has no Mail to answer: it shows only while the hub lists
        // it as on, never while the switches are not known yet. Sample mode has no mail to show (a recording never
        // keeps mail), so it has no Mail screen.
        if s == .mail {
            #if DEBUG
            // A made-up mailbox to measure the screen with (MailProbe, -EAMailFake): shown in sample mode too.
            if MailProbe.fakeCount > 0 { return true }
            #endif
            return !config.sampleMode && modules.isOnListed(.mailInbox)
        }
        // Music is off on a new hub, and a hub from before it has no Music to switch on or keep: shown only while the
        // hub lists it as on.
        if s == .listening { return modules.isOnListed(.appleMusic) }
        return s.module.map(isOn) ?? true
    }

    /// The Library with screens of switched off modules left out (and Sensors while Machines is on), and areas with
    /// nothing left dropped.
    var libraryAreas: [LibraryArea] {
        Section.areas.compactMap { a in
            let shown = a.sections.filter { shows($0) && !($0.hiddenWhileOn.map(isOn) ?? false) }
            return shown.isEmpty ? nil : LibraryArea(title: a.title, sections: shown)
        }
    }

    /// Fetch the switches, the alert switches with them (the engine holds those); offline keeps the cached ones. The
    /// sources setting too (which Reminders lists are on), read at launch and on return to the foreground.
    func refreshModules() async {
        guard let c = engine.client else { return }
        if let r = try? await c.modulesAndAlerts() {
            await engine.applyAlerts(r.alerts)
            await engine.applyAppleReminderAlerts(r.apple_reminder_alerts)
            applyModules(r.modules)
        }
        await engine.refreshSources()
    }

    /// Switch modules on or off for every device; the hub answers with the whole list. `offer`: a module switched on
    /// offers the permissions it needs; Settings, Accounts, From this iPhone asks for its own right where it is switched
    /// on, so it passes false.
    func setModules(_ changes: [String: Bool], offer: Bool = true) async throws {
        guard let c = engine.client else { throw HubError.notConfigured }
        let machinesWereOn = isOn(.homelab)
        applyModules(try await c.setModules(changes), offer: offer)
        // Machines switched on here (not on another device): its first steps, as the web offers them under the switch.
        if changes[AppModule.homelab.rawValue] == true, !machinesWereOn, isOn(.homelab) { machinesStart = true }
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
        // Music switched on where Apple Music is already allowed: read now if the profile is old or missing.
        if !before.isOnListed(.appleMusic), list.isOnListed(.appleMusic) { Task { await MusicTasteReader.shared.readIfDue(engine: engine) } }
    }

    func ensureStarted() async { if !started { await start() } }

    /// Things shared while the hub was out of reach wait in the app group; send them now, with the id the share sheet
    /// gave each, so one whose reply was lost is answered with the capture the hub already has.
    func sendPendingShares() async {
        for (file, req) in PendingShares.all() {
            if await engine.capture(req.text, attachments: req.attachments, source: req.source, id: req.id) != nil { PendingShares.remove(file) }
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
    /// Words for a new chat's box, started on another screen (Reference, Ask about this page). The Assistant starts a
    /// chat with them in the box and waits for the question; nothing is sent until the person sends it.
    @Published var assistantPrefill: String?

    func ask(_ prefill: String) {
        assistantPrefill = prefill
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
    private static let focusingKinds: Set<Kind> = [.note, .film]

    private func show(_ e: Entity) {
        if Self.focusingKinds.contains(e.kind) {
            focusItemId = e.id
            section = SearchView.section(for: e.kind)
        } else {
            openItemId = e.id
        }
    }

    func handle(url: URL) {
        // Only the kind of link: a setup link carries a pairing code (or an older hub's key) and a join link a secret,
        // which must never reach the system log.
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
            // everythingapp://setup?hub=<hub url>&code=<one-time code>&name=<device name>[&fp=<certificate SHA-256>]
            // [&hid=<hub id>], or an older link with &token= (traded for this device's own key at once).
            guard let link = SetupLink.parse(url) else {
                let message = "That setup link is not complete. Make a new pairing code on a device that is already paired."
                if !isConfigured, !deviceRemoved { setupError = message } else { pairingNotice = PairingNotice(title: "Pairing did not work", message: message) }
                return
            }
            useSetupLink(link)
        case "join":
            // everythingapp://join?node=&relay=&s=&name=&platform=: the code a Mac, iPad, Windows PC or Android tablet
            // shows while it is not paired, opened by this device's Camera. This device's hub does the pairing.
            guard isConfigured, !config.sampleMode else {
                pairingNotice = PairingNotice(title: "Pair this device with your hub first.", message: nil)
                return
            }
            guard let join = JoinLink.parse(url) else {
                pairingNotice = PairingNotice(title: "That code is not complete", message: "Point the Camera at the code on the other device again.")
                return
            }
            openItemId = nil
            pendingJoin = join
        #if DEBUG && os(macOS)
        case "debug":
            // everythingapp://debug/<command>: a Debug build does to its own window what a hand would (DebugHooksMac).
            DebugHooksMac.command(url)
        #endif
        case "now", "today":
            // The Now screen went on 2026-11-25 (Today's top line, the Next line, says it): an old link, or a widget
            // placed before then, opens Today.
            section = .today
            section = .today
        case "week":
            section = .week
        case "renewals":
            section = .renewals
        case "reminders":
            section = .tasks
        case "section":
            // everythingapp://section/<name>, e.g. everythingapp://section/films; section/now (gone) opens Today.
            if let name = url.pathComponents.dropFirst().first, let s = Section(rawValue: Self.goneSections[name] ?? name) { section = s }
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
            if let s = Section(rawValue: Self.goneSections[host] ?? host) { section = s }
        }
    }

    /// Screens that went on 2026-11-25, and the one an old link to each opens: Now opens Today (Today's top line, the
    /// Next line, says it), and Job applications (`career`, taken out with Job search) opens Lists, the screen it was in.
    static let goneSections: [String: String] = ["now": Section.today.rawValue, "career": Section.lists.rawValue]

    func healthImportIfDue() async {
        #if os(iOS)
        guard config.healthImportEnabled, isOn(.health), !config.sampleMode else { return }
        HealthImporter.shared.startObserving(engine)
        // Every return to the app sends what is new, at most every 15 minutes.
        if let last = config.lastHealthImport, Date().timeIntervalSince(last) < 900 { return }
        let result = await HealthImporter.shared.importIfAuthorized(into: engine)
        healthMessage = result
        #endif
    }
}
