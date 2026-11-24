import Foundation
#if canImport(WidgetKit)
import WidgetKit
#endif

/// Offline-first coordinator: in-memory entity cache backed by SyncStore, outbox flush,
/// `/sync/changes` pull, `/live` SSE listener with backoff, and reminder replanning.
@MainActor
public final class SyncEngine: ObservableObject {
    public enum Status: Equatable, Sendable { case unconfigured, offline, connecting, online }

    /// Every entity by id. Screens read it through `list(_:)`, which is indexed by kind and rebuilt only after a change.
    @Published public private(set) var entities: [String: Entity] = [:] { didSet { byKind = nil } }
    var byKind: [Kind: [Entity]]?
    private var lastSnapshotKey = ""
    @Published public internal(set) var status: Status = .unconfigured
    @Published public internal(set) var lastError: String?
    @Published public private(set) var outboxCount: Int = 0
    @Published public private(set) var lastSync: Date?
    @Published public private(set) var cursor: Int = 0
    /// Edits the hub refused, newest last. The hub's copy replaced them; this keeps what was changed so it is not lost silently.
    @Published public private(set) var rejectedEdits: [RejectedEdit] = SyncEngine.loadRejected()
    /// The hub said this device's key was removed. Its key is gone; it shows a plain screen until paired again.
    @Published public private(set) var deviceRemoved = false
    /// Whose hub this device is paired with (name and color), kept from the last time the hub said.
    @Published public private(set) var hubIdentity: HubIdentity? = SyncEngine.loadHubIdentity()
    /// The alert switches from the hub (Settings, Notifications), in its order, starting from the app group's copy.
    /// Empty from a hub that has none (before 2026-11-20): every kind is then on and Settings lists no switches.
    @Published public private(set) var alerts: [AlertInfo] = []
    /// Which Apple Reminders lists, calendars and Contacts come in (SyncEngine+Sources.swift), from the app group's copy
    /// until the hub answers. Nil from a hub before 1.0.18, or before it first answered: every list then syncs.
    @Published public internal(set) var sources: SourcesSetting?
    /// The rule for which tasks show, made from `sources` when first needed.
    var visibility: TaskVisibility?
    /// Called when the sources setting changed (a read, or the live stream), after it is taken in.
    public var onSources: ((SourcesSetting?) -> Void)?
    /// Called once when the hub says this device was removed.
    public var onDeviceRemoved: (() -> Void)?
    private var retryTask: Task<Void, Never>?
    private var exchanging = false

    public let config: SharedConfig
    public let store: SyncStore
    public let platform: Platform
    public private(set) var client: HubClient?

    /// Called for `notify` events of kind `reminder` from `/live`: the reminder the hub says is due, and the time it
    /// fired for.
    public var onNotify: ((_ reminderId: String, _ title: String, _ friction: Friction, _ at: Date?) -> Void)?
    /// Called for other `notify` events (a monitor down, a sensor out of range, the recall quiz): plain alerts with
    /// no reminder buttons, since Done and Snooze mean nothing for them. The whole event, so a monitor's alert can
    /// name the monitor, its state and error, and offer Acknowledge for its incident.
    public var onAlert: ((_ alert: NotifyEvent) -> Void)?
    /// Called for `notify` events of kind `activity` (from `/live`, or found on a pulled log's
    /// `checkins` when the client polls): the activity name, hours so far and the log id.
    public var onActivityCheckin: ((_ checkin: ActivityCheckin) -> Void)?
    /// Called for `notify` events of kind `digest`: the first line of the day's digest.
    public var onDigest: ((_ title: String) -> Void)?
    /// Called for `modules` events from `/live`: a switch changed on some device; the whole list as it is now. The
    /// alert switches the same event carries are taken in here first (`applyAlerts`).
    public var onModules: ((_ modules: [ModuleInfo]) -> Void)?
    /// Called when what the Watch complications would show changed (the iPhone sends it on to the Watch).
    public var onComplicationSnapshot: ((ComplicationSnapshot) -> Void)?
    private var lastComplications: ComplicationSnapshot?
    /// Called when this device creates something or finishes something (a task done, a reminder acknowledged,
    /// a procedure step done). Never for changes pulled from the hub. The app answers with shapes and a chord.
    public var onMoment: ((_ moment: FeelMoment, _ kind: Kind) -> Void)?
    /// Above zero while a background import runs, so its writes do not celebrate.
    private var quietDepth = 0
    /// Latest hub check-in already surfaced per activity log id, so a poll does not repeat it.
    private var seenCheckins: [String: String] = [:]
    /// Set false on platforms that should not schedule local notifications.
    public var schedulesNotifications = true
    /// Override how the client is built (the Watch relays through the iPhone and needs no hub URL).
    public var makeClient: (() -> HubClient?)?
    /// Poll interval used when the client cannot stream `/live` (the Watch).
    public var pollInterval: TimeInterval = 60

    /// How the iPhone, iPad and Mac reach the hub (RouteChooser.swift): the address they were paired with and, when the
    /// hub has one, its home network.
    public let routes = RouteChooser()
    /// The route requests take now. Nil on the Watch, in sample mode and before a hub is set up.
    @Published public private(set) var route: HubRoute?
    /// Settings: "Home network", "Direct link" or "Tailscale" while the hub answers.
    public var routeLabel: String? { status == .online ? route?.label : nil }
    /// False after a new connection until the hub's id was asked (`/link/routes`): nothing is sent before.
    private var routesChecked = false
    /// The hub at this address said another id than the one this device was paired with.
    private var otherHubAtAddress = false
    /// Tests: whether the hub's id is asked before syncing. By default only the app's own client (no `makeClient`) does.
    var checksHubRoutes: Bool?
    static let otherHubMessage = "This address now leads to another hub, so nothing was sent to it. Pair this device again with a code from your hub."

    private var liveTask: Task<Void, Never>?
    private var syncTask: Task<Void, Never>?
    private var registrationTask: Task<Void, Never>?
    private var started = false

    public init(config: SharedConfig = .shared, platform: Platform, store: SyncStore? = nil) {
        self.config = config
        self.platform = platform
        if let s = store {
            self.store = s
        } else {
            self.store = (try? SyncStore(url: config.storeURL)) ?? (try! SyncStore.inMemory())
        }
        deviceRemoved = platform != .watch && config.deviceRemoved
        alerts = config.alerts ?? []
        sources = config.sources
        routes.onChange = { [weak self] r in Task { @MainActor in self?.routeChanged(r) } }
        routes.onFound = { [weak self] address, moves in Task { @MainActor in self?.homeFound(address, movesAddress: moves) } }
    }

    public var isConfigured: Bool { client != nil }

    /// The local copy was filled from the hub at least once since it was last emptied (store meta `pulled`).
    public private(set) var pulledOnce = false
    /// Paired with the person's own hub: not sample mode, not removed, with a way to reach it. What copies into this
    /// device's own stores (Health, Reminders, Calendar, Contacts) runs only then, so no sample data reaches them and
    /// nothing is taken from them because this device's copy was emptied.
    public var pairedWithHub: Bool { client != nil && !deviceRemoved && !config.sampleMode }
    /// Paired, and the local copy holds the hub's items: filled from the hub at least once since it was last emptied
    /// (a removal, another hub). An emptied copy reads as having no people and no tasks, and a copy run against it
    /// took every card and every Apple item for a new one.
    public var hasHubCopy: Bool { pairedWithHub && pulledOnce }
    /// The hub answered the last sync (or the live stream since).
    public var hubInReach: Bool { status == .online }
    public var statusLabel: String {
        switch status {
        case .unconfigured: return "Not set up"
        case .offline: return outboxCount > 0 ? "Offline, \(outboxCount) queued" : "Offline"
        case .connecting: return "Connecting"
        case .online: return "Online"
        }
    }

    // MARK: lifecycle

    public func start() async {
        guard !started else {
            // A start before the first unlock (a background wake) could not read the key; the next one can.
            if client == nil, config.isConfigured { connectClient(); if client != nil { startLive() } }
            // Waking: the network may be another one now. Home and the other route are tried again, and the hub's
            // id is asked again before anything is sent.
            routesChecked = false
            routes.refresh()
            await sync()
            Task { await self.exchangeLegacyTokenIfNeeded() }
            return
        }
        started = true
        await reloadFromStore()
        connectClient()
        status = client == nil ? .unconfigured : .offline
        if client != nil {
            startLive()
            await sync()
            Task { await self.refreshHubIdentity() }
        }
        // An install paired before devices had keys trades the shared key for its own, without holding up the start.
        Task { await self.exchangeLegacyTokenIfNeeded() }
        await afterChange()
        // Edits waiting to send are retried every minute even when nothing else triggers a sync.
        retryTask?.cancel()
        retryTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 60_000_000_000)
                guard let self = self, !Task.isCancelled else { return }
                if self.outboxCount > 0 && self.client != nil { await self.sync() }
            }
        }
    }

    private static let hubIdentityKey = "ea.hubIdentity"
    private static func loadHubIdentity() -> HubIdentity? {
        guard let d = UserDefaults.standard.data(forKey: hubIdentityKey) else { return nil }
        return try? JSONDecoder().decode(HubIdentity.self, from: d)
    }

    /// Ask the hub its name and color (several people's hubs can share one machine). Kept as it was when it cannot be reached.
    public func refreshHubIdentity() async {
        // The Watch relays through the iPhone, which shows it; nothing to show on the wrist.
        guard makeClient == nil, let c = client else { return }
        guard let h = try? await withDeadline(15, { try await c.health() }), h.version != nil else { return }
        let next = h.hub.flatMap { ($0.name ?? "").isEmpty && ($0.color ?? "").isEmpty ? nil : $0 }
        guard next != hubIdentity else { return }
        hubIdentity = next
        if let next, let d = try? JSONEncoder().encode(next) { UserDefaults.standard.set(d, forKey: Self.hubIdentityKey) }
        else { UserDefaults.standard.removeObject(forKey: Self.hubIdentityKey) }
    }

    /// A client at once, before `start()` has finished its first sync: Siri's question cannot wait for a cold start.
    public func readyClient() -> HubClient? { client ?? buildClient() }

    private func buildClient() -> HubClient? {
        if let make = makeClient { return make() }
        if deviceRemoved { return nil }
        // The iPhone, iPad and Mac: the address they were paired with, and the hub's home network when it has one.
        if usesRoutes, let c = HubClient.routed(config: config, routes: routes) { return c }
        return HubClient.make(config: config)
    }

    /// The app's own client picks its route (not the Watch, which relays through the iPhone, nor sample mode).
    private var usesRoutes: Bool { makeClient == nil && platform != .watch && !config.sampleMode }
    private var checksRoutes: Bool { checksHubRoutes ?? usesRoutes }

    /// A new connection to the hub: the hub's id is asked again before anything is sent over it.
    private func connectClient() {
        client = buildClient()
        routesChecked = false
        route = usesRoutes && client != nil ? routes.current : nil
        if usesRoutes, client != nil { routes.watchNetwork() }
    }

    /// The route in use changed (a race, a network change, Bonjour). The live stream moves to it, the hub's id is asked
    /// again over it, and a sync runs. The copy stays: it is the same hub.
    private func routeChanged(_ r: HubRoute?) {
        guard usesRoutes, client != nil, route != r else { return }
        route = r
        guard started else { return }
        routesChecked = false
        startLive()
        Task { await self.sync() }
    }

    /// Bonjour found the hub at a new home address, and the hub there showed the pinned certificate. When the address it
    /// was paired with is itself a home address (Home Wi-Fi only), that address follows, so widgets, the share sheet
    /// and the Watch use it too. The copy stays: it is the same hub.
    private func homeFound(_ address: String, movesAddress: Bool) {
        guard movesAddress, usesRoutes, !deviceRemoved, client != nil, !Self.sameHub(config.hubURL, address) else { return }
        config.hubURL = address
        connectClient()
        lastError = nil
        startLive()
        Task { await self.sync() }
    }

    /// The hub's routes as kept now: a change of home addresses starts a race.
    private func reconfigureRoutes() {
        guard usesRoutes else { return }
        if routes.configure(address: config.hubURL, pin: config.hubPin, routes: config.linkRoutes) { routes.refresh() }
        route = routes.current
    }

    /// On a new connection, before anything is sent: is this still the hub this device was paired with? `/link/routes`
    /// says its id (kept the first time) and its home route (kept every time). False when the id is another one. An
    /// older hub (404) has neither; when no answer comes, the sync goes ahead as before and the next one asks again.
    private func checkHubRoutes(_ c: HubClient) async throws -> Bool {
        let answer: LinkRoutes
        do {
            answer = try await withDeadline(10) { try await c.linkRoutes() }
        } catch let h as HubError {
            if h.isDeviceRemoved { throw h }
            if case .http(let status, _) = h, status == 404, client === c {
                routesChecked = true
                otherHubAtAddress = false
                if config.linkRoutes != nil { config.linkRoutes = nil; reconfigureRoutes() }
            }
            return true
        } catch {
            return true
        }
        guard client === c else { return true }
        let said = HubID.normalize(answer.hub_id)
        if let have = config.hubId, let said, have != said {
            otherHubAtAddress = true
            return false
        }
        otherHubAtAddress = false
        if config.hubId == nil, let said { config.hubId = said }
        if config.linkRoutes != answer {
            config.linkRoutes = answer
            reconfigureRoutes()
        }
        routesChecked = true
        return true
    }

    public func stop() {
        liveTask?.cancel()
        liveTask = nil
        liveWatch?.cancel()
        liveWatch = nil
        retryTask?.cancel()
        retryTask = nil
    }

    private func reloadFromStore() async {
        let list = (try? await store.all(kind: nil, includeDeleted: true)) ?? []
        var map: [String: Entity] = [:]
        for e in list { map[e.id] = e }
        entities = map
        cursor = (try? await store.cursor) ?? 0
        outboxCount = (try? await store.outboxCount()) ?? 0
        // A copy filled by a build from before the `pulled` mark counts once it has pulled anything.
        if (try? await store.meta("pulled")) == "1" { pulledOnce = true }
        else if cursor > 0 { pulledOnce = true; try? await store.setMeta("pulled", "1") }
        else { pulledOnce = false }
        // An older build skipped items it could not read (a kind it did not know yet) and moved past them. After an
        // update, read everything once more from the start; each item is merged, so nothing is doubled.
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""
        if !build.isEmpty, (try? await store.meta("synced_build")) != build {
            try? await store.setCursor(0)
            try? await store.setMeta("synced_build", build)
            cursor = 0
        }
    }

    /// Settings, Reset local cache: throw away this device's copy and read everything again from the hub. Wiping
    /// the store alone left the cursor in memory, so the next pull started where it was and downloaded nothing, the
    /// queued edits vanished without a word, and the next edit made a partial row. This resets the cursor and what
    /// is in memory, so the next sync pulls from zero. Edits still waiting to send are kept, with their rows: they
    /// exist nowhere else, and the next sync sends them before it pulls.
    public func resetLocalCache() async {
        stop()
        try? await store.resetKeepingOutbox()
        try? await store.setCursor(0)
        pulledOnce = false
        let list = (try? await store.all(kind: nil, includeDeleted: true)) ?? []
        var map: [String: Entity] = [:]
        for e in list { map[e.id] = e }
        entities = map
        cursor = 0
        outboxCount = (try? await store.outboxCount()) ?? 0
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""
        if !build.isEmpty { try? await store.setMeta("synced_build", build) }
        updateSnapshot()
    }

    /// Check that a hub address answers (`/health` needs no key).
    public func testAddress(_ hubURL: String) async throws -> HealthResponse {
        guard let c = HubClient.make(urlString: hubURL, token: "") else { throw HubError.notConfigured }
        return try await withDeadline(15) { try await c.health() }
    }

    /// The same address (case, spaces and a trailing slash aside).
    nonisolated public static func sameHub(_ a: String, _ b: String) -> Bool {
        func n(_ s: String) -> String { s.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/")).lowercased() }
        return n(a) == n(b)
    }

    /// One hub or two. By the hub's own id when both sides know it, so the same hub reached at another address (home
    /// network, Direct link, Tailscale) is the same hub, and another id is another hub even at the same address. By
    /// address when either id is not known (an older hub, a link without `hid`).
    nonisolated public static func sameHub(_ a: String, id aId: String?, _ b: String, id bId: String?) -> Bool {
        if let x = HubID.normalize(aId), let y = HubID.normalize(bId) { return x == y }
        return sameHub(a, b)
    }

    /// Pair with a one-time code: the hub answers with this device's own key, kept in the Keychain. On the same hub
    /// (by its id, else by address) the device keeps its id (a device removed and paired again comes back as itself).
    public func pair(hubURL: String, code: String, deviceName: String?, pin: String? = nil, hubId: String? = nil) async throws {
        await endSample()
        let hub = hubURL.trimmingCharacters(in: .whitespacesAndNewlines)
        let pin = HubPin.forHub(hub, pin: pin)
        guard let anon = pairingClient?(hub, "") ?? HubClient.make(urlString: hub, token: "", pin: pin) else { throw HubError.notConfigured }
        let name = Self.cleanName(deviceName) ?? config.deviceName
        let keepId = Self.sameHub(config.hubURL, id: config.hubId, hub, id: hubId) && !config.deviceId.isEmpty ? config.deviceId : nil
        let platform = self.platform
        // This device's own key goes only where it went before: the address it was paired with, under the certificate
        // pinned now, never the link's address. A link naming another certificate (asked about first, AppModel.handle)
        // does not take the old key to whoever answers with that one; the old entry is then left for Settings, Devices.
        let oldAddress = config.hubURL
        let keyPin = config.hubPin
        let oldKey = keepId == nil || pin != keyPin ? "" : config.deviceKey
        let r = try await withDeadline(20) { try await anon.claim(code: code, name: name, platform: platform, deviceId: keepId) }
        // Paired again while the old key still worked: the hub gave a new id, so the old entry (and its key) is removed
        // rather than left behind with a key that works. The Watch's key went with it; a new one is claimed when the
        // Watch next asks.
        if let old = keepId, r.device_id != old, !oldKey.isEmpty,
           let oc = pairingClient?(oldAddress, oldKey) ?? HubClient.make(urlString: oldAddress, token: oldKey, pin: keyPin) {
            _ = try? await withDeadline(10) { try await oc.removeDevice(old) }
            config.clearWatchKey()
            config.watchRemoved = false
        }
        guard config.storeDeviceKey(r.key) else { throw KeychainRefused() }
        await adopt(hub: hub, legacyToken: nil, deviceId: r.device_id, name: r.name.flatMap(Self.cleanName) ?? name, pin: pin, hubId: hubId)
        config.permissionOfferPending = true
    }

    /// An older setup link that carries the hub's shared key: it is traded for this device's own key at once and not
    /// kept. Only a hub too old to trade it, or one out of reach, leaves the shared key in use until it can.
    public func connect(hubURL: String, token: String, deviceName: String?, pin: String? = nil, hubId: String? = nil) async throws {
        await endSample()
        let hub = hubURL.trimmingCharacters(in: .whitespacesAndNewlines)
        let token = token.trimmingCharacters(in: .whitespacesAndNewlines)
        let pin = HubPin.forHub(hub, pin: pin)
        guard let c = pairingClient?(hub, token) ?? HubClient.make(urlString: hub, token: token, pin: pin) else { throw HubError.notConfigured }
        let name = Self.cleanName(deviceName) ?? config.deviceName
        let same = Self.sameHub(config.hubURL, id: config.hubId, hub, id: hubId)
        let keepId = same && !config.deviceId.isEmpty ? config.deviceId : nil
        let platform = self.platform
        do {
            let r = try await withDeadline(20) { try await c.exchange(name: name, platform: platform, deviceId: keepId) }
            guard config.storeDeviceKey(r.key) else { throw KeychainRefused() }
            await adopt(hub: hub, legacyToken: nil, deviceId: r.device_id, name: r.name.flatMap(Self.cleanName) ?? name, pin: pin, hubId: hubId)
        } catch {
            switch CredentialMigration.outcome(error) {
            case .refused: throw error
            case .traded: return
            case .keepToken(let wait):
                // A device with its own key for this hub keeps it: a link whose trade did not go through (out of
                // reach, or a certificate that did not match its pin) is no reason to drop it for the link's
                // shared key. Nothing changes, and the link's error is shown.
                if same, config.hasDeviceKey { throw error }
                config.clearDeviceKey()
                config.exchangeRetryAfter = Date().addingTimeInterval(wait)
                await adopt(hub: hub, legacyToken: token, deviceId: keepId, name: name, pin: pin, hubId: hubId)
            }
        }
        config.permissionOfferPending = true
    }

    /// Tests: the client used to pair (hub address and key given).
    public var pairingClient: ((String, String) -> HubClient?)?

    /// Save the hub (the key is already in the Keychain, or `legacyToken` is the shared key), forget the old hub's copy
    /// when the hub changed, register this device and sync. The same hub at another address (another route to it, by
    /// its id) keeps its copy.
    private func adopt(hub: String, legacyToken: String?, deviceId: String?, name: String, pin: String?, hubId: String?) async {
        let changedHub = !Self.sameHub(config.hubURL, id: config.hubId, hub, id: hubId)
        let movedAddress = !Self.sameHub(config.hubURL, hub)
        if changedHub { await forgetHubCopy() }
        config.hubURL = hub
        config.legacyToken = legacyToken ?? ""
        // The pin belongs to an address: a new address keeps none from the old one.
        if changedHub || movedAddress || pin != nil { config.hubPin = pin }
        if changedHub {
            config.hubId = hubId
            // The old hub's home addresses are not this hub's.
            config.linkRoutes = nil
        } else if let id = HubID.normalize(hubId) {
            config.hubId = id
        }
        otherHubAtAddress = false
        config.deviceName = name
        config.deviceRemoved = false
        deviceRemoved = false
        if changedHub {
            // The old hub's module switches are not this hub's: until it answers, nothing of the person's is copied.
            config.modules = nil
            // Nor are its alert switches: until this hub sends its own, every kind is on.
            forgetAlerts()
            // The Watch's key belongs to the old hub.
            config.clearWatchKey()
            config.watchDeviceId = ""
            config.watchRemoved = false
        }
        config.deviceId = deviceId ?? (changedHub ? "" : config.deviceId)
        stop()
        connectClient()
        status = client == nil ? .unconfigured : .offline
        started = true
        if client != nil {
            await ensureRegistered()
            startLive()
            await sync()
            if changedHub { Task { await self.refreshHubIdentity() } }
        }
    }

    /// Another hub's items mean nothing on this one. Its local copy stayed beside the new hub's, and the edits queued
    /// for it (a capture made offline) went to the new hub. The copy and its queue go, with what this device recorded
    /// about its links to Apple Reminders, Calendar and Contacts (by the old hub's ids), the edits the old hub refused
    /// and its name. Reconnecting to the same hub keeps all of it.
    private func forgetHubCopy() async {
        // Edits made here for the old hub exist nowhere else: they go to it first when it answers within a few
        // seconds (this device's id and the client are still the old hub's here). What it does not take is dropped
        // with the copy, never sent to the new hub, nor to another hub now at the old hub's address.
        if let old = client, outboxCount > 0, !otherHubAtAddress {
            if let t = syncTask { await t.value }
            let have = checksRoutes ? config.hubId : nil
            _ = try? await withDeadline(10) {
                if let have, let said = HubID.normalize((try? await old.linkRoutes())?.hub_id), said != have { return }
                try await self.flush(old)
            }
        }
        // Nothing more goes to or comes from the old hub, and a sync with it still running ends before its copy goes.
        stop()
        client = nil
        if let t = syncTask { await t.value }
        try? await store.reset()
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""
        if !build.isEmpty { try? await store.setMeta("synced_build", build) }
        entities = [:]
        cursor = 0
        outboxCount = 0
        pulledOnce = false
        AppleLinkRecords.forget()
        adoptSources(nil)
        config.clearSnapshot()
        forgetAlerts()
        clearRejected()
        hubIdentity = nil
        UserDefaults.standard.removeObject(forKey: Self.hubIdentityKey)
    }

    // MARK: sample mode

    /// The address sample mode stands in for: not a URL any transport can reach.
    public static let sampleHubURL = "sample://everythingapp"

    /// Try the app on the made-up month (SampleHub.swift): no hub, no network, nothing of the person's.
    public func startSample() async {
        guard SampleTransport.shared != nil, !config.isConfigured || config.sampleMode else { return }
        stop()
        try? await store.reset()
        try? await store.setCursor(0)
        entities = [:]
        cursor = 0
        pulledOnce = false
        config.sampleMode = true
        config.hubURL = Self.sampleHubURL
        // Whatever hub was set up before is not the sample's: its id and routes go with its address.
        config.hubId = nil
        config.linkRoutes = nil
        config.deviceId = "sample-device"
        deviceRemoved = false
        connectClient()
        status = .offline
        started = true
        await sync()
    }

    /// Sample mode off: the made-up month and every edit made to it are wiped, and the device is not set up. The
    /// alerts planned from its reminders go too: with no sync after this, they kept firing for up to 30 days.
    public func endSample() async {
        guard config.sampleMode else { return }
        stop()
        client = nil
        try? await store.reset()
        try? await store.setCursor(0)
        entities = [:]
        cursor = 0
        pulledOnce = false
        config.sampleMode = false
        config.hubURL = ""
        config.hubId = nil
        config.linkRoutes = nil
        config.deviceId = ""
        config.clearSnapshot()
        forgetAlerts()
        route = nil
        status = .unconfigured
        await takeOffPlannedAlerts()
    }

    /// A new name for this device, sent with its own key (which registers only this device).
    public func rename(_ name: String) async {
        guard let n = Self.cleanName(name), n != config.deviceName else { return }
        config.deviceName = n
        guard let c = client else { return }
        let platform = self.platform
        _ = try? await withDeadline(20) { try await c.register(name: n, platform: platform) }
    }

    /// After Remove this device: forget the key and stop. The local copy stays, with any edits not sent yet.
    public func signOut() {
        stop()
        config.clearDeviceKey()
        // The Watch's key is the iPhone's to hold: a signed-out iPhone keeps no key that still opens the hub.
        config.clearWatchKey()
        config.legacyToken = ""
        client = nil
        route = nil
        status = .unconfigured
    }

    static func cleanName(_ s: String?) -> String? {
        guard let t = s?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty else { return nil }
        return String(t.prefix(60))
    }

    // MARK: trading the shared key

    /// Tests: the client the trade is made with, given the shared key.
    public var exchangeClient: ((String) -> HubClient?)?

    /// An install from before device keys holds the hub's shared key: trade it for this device's own, keeping the device
    /// id so sync carries on, then delete the shared key. Offline, or a hub too old to trade (404), keeps using the
    /// shared key quietly and tries again later. The iPhone also trades for its Watch, which keeps its id too.
    public func exchangeLegacyTokenIfNeeded(now: Date = Date()) async {
        guard platform != .watch, !exchanging else { return }
        switch CredentialMigration.next(hubURL: config.hubURL, hasKey: config.hasDeviceKey, legacyToken: config.legacyToken, retryAfter: config.exchangeRetryAfter, now: now) {
        case .nothing: return
        case .clearLeftoverToken:
            config.legacyToken = ""
            return
        case .exchange: break
        }
        exchanging = true
        defer { exchanging = false }
        let token = config.legacyToken
        guard let c = exchangeClient?(token) ?? HubClient.make(urlString: config.hubURL, token: token, pin: config.hubPin) else { return }
        let name = config.deviceName
        let platform = self.platform
        let myId = config.deviceId.isEmpty ? nil : config.deviceId
        do {
            let r = try await withDeadline(20) { try await c.exchange(name: name, platform: platform, deviceId: myId) }
            // The Watch, while the shared key still opens the door. A Watch left out gets a key later through the
            // iPhone's own (`WatchKeys`).
            if platform == .iphone, config.watchKey.isEmpty, let w = pairedWatchDevice() {
                let phoneId = r.device_id
                if let wr = try? await withDeadline(20, { try await c.exchange(name: w.name, platform: .watch, deviceId: w.id, parentId: phoneId) }), config.storeWatchKey(wr.key) {
                    config.watchDeviceId = wr.device_id
                }
            }
            guard config.storeDeviceKey(r.key) else {
                // The Keychain would not keep it: stay on the shared key, which still works, and try again later.
                config.exchangeRetryAfter = now.addingTimeInterval(3600)
                return
            }
            if config.deviceId != r.device_id { config.deviceId = r.device_id }
            config.legacyToken = ""
            config.exchangeRetryAfter = nil
            stop()
            connectClient()
            if client != nil { startLive() }
        } catch {
            if case .keepToken(let wait) = CredentialMigration.outcome(error) { config.exchangeRetryAfter = now.addingTimeInterval(wait) }
            else { config.exchangeRetryAfter = now.addingTimeInterval(3600) }
        }
    }

    /// The Watch this iPhone relays for: the id its requests named, else the newest Watch row.
    private func pairedWatchDevice() -> (id: String, name: String)? {
        let rows = list(.device).filter { $0.str("platform") == Platform.watch.rawValue }
        if !config.watchDeviceId.isEmpty, let e = rows.first(where: { $0.id == config.watchDeviceId }) { return (e.id, e.str("name")) }
        guard let e = rows.max(by: { ($0.string("last_seen") ?? $0.updated_at) < ($1.string("last_seen") ?? $1.updated_at) }) else { return nil }
        return (e.id, e.str("name").isEmpty ? config.deviceName + " Watch" : e.str("name"))
    }

    /// A removal answer is being checked against the key held now (handleDeviceRemoved).
    private var checkingRemoval = false

    /// The hub said a key of this device's is gone. Before anything is wiped, the key held NOW is asked once: pairing
    /// again with the same hub replaces the key and removes the old entry, and a request still in flight with the old
    /// key then hears "removed" about a key this device no longer uses (a second scan of a pairing code wiped the
    /// fresh pairing and the local copy). Only a "removed" for the current key, or no key at all, signs out.
    private func handleDeviceRemoved() {
        guard !deviceRemoved, !checkingRemoval else { return }
        guard platform != .watch, let current = client else { confirmDeviceRemoved(); return }
        checkingRemoval = true
        Task { @MainActor in
            defer { self.checkingRemoval = false }
            if await Self.removalConfirmed(by: current), self.client === current { self.confirmDeviceRemoved() }
        }
    }

    /// True only when the hub says this client's key is removed. Any other answer, or no answer, is not a removal:
    /// the next request asks again.
    nonisolated static func removalConfirmed(by c: HubClient) async -> Bool {
        do { _ = try await withDeadline(10) { try await c.entity("removal-check") }; return false }
        catch let h as HubError { return h.isDeviceRemoved }
        catch { return false }
    }

    /// The hub said this device's key is gone: forget it and stop. The Watch has no key; it only says so.
    private func confirmDeviceRemoved() {
        guard !deviceRemoved else { return }
        deviceRemoved = true
        lastError = HubError.deviceRemoved.errorDescription
        guard platform != .watch else { onDeviceRemoved?(); return }
        config.deviceRemoved = true
        // Signed out (no client, `pairedWithHub` false) before the copy is emptied: the copies into this device's own
        // stores stop first, so nothing reads the empty copy as the person deleting everything (the Health export
        // took out every sample it had written).
        signOut()
        // Nothing of the hub's stays on a removed device: the local copy, its unsent edits and the widget snapshot go
        // with the key, and so do the refused edits (what was changed in which item) and the hub's name. The app
        // removes its own files and settings (chats, caches, Spotlight, the wiki's page list) in `onDeviceRemoved`.
        let store = self.store
        Task { try? await store.reset() }
        entities = [:]
        pulledOnce = false
        config.clearSnapshot()
        forgetAlerts()
        clearRejected()
        hubIdentity = nil
        UserDefaults.standard.removeObject(forKey: Self.hubIdentityKey)
        // The alerts planned from its reminders go with them: syncing stops here, so no later replan took them off,
        // and alerts with task titles kept firing for up to 30 days.
        Task { await self.takeOffPlannedAlerts() }
        onDeviceRemoved?()
    }

    /// The Watch: requests go through again (it was paired again), so it stops saying it was removed.
    public func clearRemoved() {
        deviceRemoved = false
        config.deviceRemoved = false
    }

    /// The hub client this app's version was last told to, so it is told once per connection.
    private var reportedTo: ObjectIdentifier?

    /// Tells the hub which app and version this is (Settings, Devices; the assistant's update_apps), once per connection.
    private func reportApp(_ c: HubClient) async {
        let id = ObjectIdentifier(c)
        guard reportedTo != id, let app = AppReport.current(platform: platform) else { return }
        reportedTo = id
        _ = try? await withDeadline(20) { try await c.reportApp(app) }
    }

    /// Register once per device. Concurrent callers wait for the same in-flight registration,
    /// and a stored device id is reused on later launches.
    private func ensureRegistered() async {
        if !config.deviceId.isEmpty { return }
        if let t = registrationTask { await t.value; return }
        guard let c = client else { return }
        let task = Task { [weak self] in
            guard let self = self else { return }
            do {
                // A register whose reply was lost (Watch relay timeout, app killed) would create a
                // duplicate row on retry, so reuse an existing row for this device first.
                if let existing = try? await Self.existingDeviceId(client: c, platform: self.platform, name: self.config.deviceName) {
                    if self.config.deviceId.isEmpty { self.config.deviceId = existing }
                    return
                }
                let id = try await c.register(name: self.config.deviceName, platform: self.platform)
                if self.config.deviceId.isEmpty { self.config.deviceId = id }
            } catch {
                self.note(error)
            }
        }
        registrationTask = task
        await task.value
        registrationTask = nil
    }

    /// Newest non-deleted `device` row for this platform. The phone matches on its name too; the
    /// Watch does not know the name the phone registers it under, so it matches on platform alone.
    static func existingDeviceId(client: HubClient, platform: Platform, name: String) async throws -> String? {
        let devices = try await client.entities(kind: .device)
        let matches = devices.filter { d in
            guard !d.isDeleted, d.str("platform") == platform.rawValue else { return false }
            return platform == .watch || d.str("name") == name
        }
        return matches.max { ($0.string("last_seen") ?? $0.updated_at) < ($1.string("last_seen") ?? $1.updated_at) }?.id
    }

    // MARK: sync

    /// Flush the outbox, then pull changes until `more` is false. Safe to call often.
    public func sync() async {
        if let t = syncTask { await t.value; return }
        let task = Task { [weak self] in
            guard let self = self else { return }
            // An edit made while this sync runs, after its push, joins this sync instead of waiting for the next poll
            // (or, if the app is suspended first, the next launch). A few rounds at most, so nothing keeps it going.
            var rounds = 0
            repeat {
                rounds += 1
                await self.performSync()
            } while self.status == .online && self.outboxCount > 0 && rounds < 4
            // Cleared here, with no wait after the last check, so a sync asked for from now on starts its own run.
            self.syncTask = nil
        }
        syncTask = task
        await task.value
    }

    private func performSync() async {
        guard let c = client else { status = .unconfigured; return }
        if status != .online { status = .connecting }
        do {
            // A new connection: is it still the hub this device was paired with? Nothing goes out before that is known,
            // and nothing goes to another hub at all.
            if checksRoutes, !routesChecked {
                let ours = try await checkHubRoutes(c)
                if !ours {
                    status = .offline
                    lastError = Self.otherHubMessage
                    return
                }
            }
            await ensureRegistered()
            await reportApp(c)
            await takeWidgetDones()
            // A push that fails (one bad edit, a hub hiccup) must not stop changes from coming in.
            var pushError: Error?
            do { try await flush(c) } catch { pushError = error }
            try await pull(c)
            if let pushError { throw pushError }
            status = .online
            lastError = nil
            // The Watch's removal ends once the iPhone relays for it again (it was paired again).
            if platform == .watch, deviceRemoved { clearRemoved() }
            lastSync = Date()
            surfacePolledCheckins()
        } catch {
            note(error)
            status = client == nil ? .unconfigured : .offline
        }
        await afterChange()
    }

    /// Done taps on the Now widget the hub has not taken (`SharedConfig.pendingWidgetDones`): each becomes a queued
    /// edit stamped with the time of the tap, sent with the rest of the queue until the hub takes it, and the task
    /// shows done here at once instead of coming back. A task this device does not hold yet waits for a later sync.
    func takeWidgetDones() async {
        let waiting = config.pendingWidgetDones
        guard !waiting.isEmpty else { return }
        var taken: [WidgetDone] = []
        for d in waiting where entities[d.taskId]?.kind == .task {
            guard let e = try? await store.applyLocal(d.patch(task: entities[d.taskId])) else { continue }
            entities[e.id] = e
            taken.append(d)
        }
        guard !taken.isEmpty else { return }
        config.removePendingWidgetDones(taken)
        outboxCount = (try? await store.outboxCount()) ?? 0
    }

    /// Builds the hub connection again (the way to the hub changed, such as Tailscale signed in inside Aeneas) and syncs.
    /// A Home Wi-Fi hub that moved to another address is found again by the route chooser (Bonjour, `homeFound`).
    public func rebuildClient() async {
        guard started, !deviceRemoved, makeClient == nil else { return }
        connectClient()
        status = client == nil ? .unconfigured : .offline
        routes.refresh()
        startLive()
        await sync()
    }

    /// The hub refuses request bodies over 2 MB: pushes are cut to about 1.5 MB of patches each.
    static let pushBytes = 1_500_000
    /// A Watch relay message holds about 60 KB in all (the body goes as base64 in an envelope): the Watch pushes
    /// 40 KB of patches at a time, or a long queue would never fit and never drain.
    static let watchPushBytes = 40_000
    private var pushLimit: Int { platform == .watch ? Self.watchPushBytes : Self.pushBytes }

    private func flush(_ c: HubClient) async throws {
        var limit = 500
        /// Items sent again whole in this flush (see below): once each.
        var resent: Set<String> = []
        while true {
            let queued = try await store.outbox(limit: limit)
            if queued.isEmpty { break }
            if config.deviceId.isEmpty { throw HubError.transport("Device not registered") }
            var items: [SyncStore.OutboxItem] = []
            var bytes = 0
            for q in queued {
                let n = (try? JSONCoding.data(q.patch).count) ?? 0
                if !items.isEmpty && bytes + n > pushLimit { break }
                items.append(q)
                bytes += n
            }
            let resp: PushResponse
            do {
                resp = try await c.push(deviceId: config.deviceId, patches: items.map(\.patch))
            } catch let e as HubError where e.isTooLarge {
                // Too big even so: halve the batch, and a single patch the hub will never take is set aside as refused.
                if items.count > 1 { limit = max(1, items.count / 2); continue }
                let it = items[0]
                logRejected(it.patch.id, reason: platform == .watch ? "too large to send from the Watch" : "too large to send (over 2 MB)", patches: [it.patch])
                try await store.removeOutbox(rowids: [it.rowid])
                outboxCount = (try? await store.outboxCount()) ?? 0
                continue
            }
            limit = 500
            try await store.removeOutbox(rowids: items.map(\.rowid))
            for r in resp.rejected {
                // An edit of an item the hub does not have (it was restored from a copy older than the item): the item
                // goes again whole with create, stamped with when it was made so it keeps its day, then the refused
                // edits with their own stamps. It was deleted here, losing what had just been changed. Once each: a
                // create the hub also refuses is a refusal like any other.
                if r.reason.hasPrefix("entity not found"), let local = entities[r.id], !local.isDeleted, !resent.contains(r.id) {
                    resent.insert(r.id)
                    _ = try? await store.applyLocal(Patch(id: local.id, kind: local.kind, space: local.space, ts: local.created_at, fields: local.fields, create: true))
                    for p in items.map(\.patch) where p.id == r.id { _ = try? await store.applyLocal(p) }
                    continue
                }
                logRejected(r.id, reason: r.reason, patches: items.map(\.patch).filter { $0.id == r.id })
                // Conflict: drop our queued patches for it and reload the hub copy.
                try? await store.removeOutbox(entityId: r.id)
                do {
                    let fresh = try await c.entity(r.id)
                    try? await store.replace(fresh)
                    entities[r.id] = fresh
                } catch HubError.http(let status, _) where status == 404 {
                    // A create the hub refused: it has no copy, so this device should not keep one either. A work item
                    // is kept: a hub restored without its work key cannot read it, and this may be the last copy.
                    if entities[r.id]?.space != .work {
                        try? await store.remove(r.id)
                        entities[r.id] = nil
                    }
                } catch {}
                lastError = "Rejected \(r.id.prefix(8)): \(r.reason)"
            }
            outboxCount = (try? await store.outboxCount()) ?? 0
        }
    }

    private func pull(_ c: HubClient) async throws {
        var since = cursor
        var loops = 0
        // Set when the hub answered from the beginning (it was restored from an older copy): every entity it has.
        var seen: Set<String>? = nil
        var complete = false
        while loops < 200 {
            loops += 1
            let page = try await c.changes(since: since, deviceId: config.deviceId)
            if page.reset { since = 0; seen = [] }
            for ch in page.changes { seen?.insert(ch.entity.id) }
            // One store transaction and one screen update per page, and only for entities that actually changed:
            // a big import (a Steam library) used to redraw every screen once per entity.
            let stored = try await store.upsertManyFromHub(page.changes.map(\.entity))
            var next = entities
            var changed = false
            for e in stored where next[e.id] != e {
                next[e.id] = e
                changed = true
            }
            if changed { entities = next }
            for ch in page.changes { since = max(since, ch.seq) }
            since = max(since, page.seq)
            // During a reset the cursor is kept only once the whole feed is in: cut short, the next pull starts over.
            if seen == nil {
                try await store.setCursor(since)
                cursor = since
            }
            if !page.more { complete = true; break }
        }
        // What this device holds that the restored hub does not, and no edit of ours is waiting to send, is gone.
        if let seen {
            let removed = try await store.removeStale(keeping: seen)
            if !removed.isEmpty {
                var next = entities
                for id in removed { next.removeValue(forKey: id) }
                entities = next
            }
            try await store.setCursor(since)
            cursor = since
        }
        // The whole feed is in: the copy holds the hub's items now (`hasHubCopy`). Not when this hub was left meanwhile.
        if complete, !pulledOnce, client === c {
            try? await store.setMeta("pulled", "1")
            pulledOnce = true
        }
    }

    private func note(_ error: Error) {
        if let h = error as? HubError, h.isDeviceRemoved {
            handleDeviceRemoved()
        } else if let h = error as? HubError {
            lastError = h.isAuth ? "The hub did not accept this device's key" : h.errorDescription
        } else {
            lastError = error.localizedDescription
        }
    }

    /// True when the last failure was the Watch relay finding no phone.
    public var phoneUnreachable: Bool { lastError == HubError.phoneUnreachable.errorDescription && status != .online }

    // MARK: live

    /// When the live stream last said anything, or last started.
    private var lastLiveEvent = Date()
    private var liveWatch: Task<Void, Never>?

    /// Stream `/live` when the transport supports it; otherwise poll `/sync/changes`.
    private func startLive() {
        liveTask?.cancel()
        liveWatch?.cancel()
        liveWatch = nil
        guard let c = client else { return }
        guard c.supportsStreaming else { startPolling(); return }
        lastLiveEvent = Date()
        liveTask = Task { [weak self] in
            var backoff: Double = 1
            while !Task.isCancelled {
                do {
                    self?.lastLiveEvent = Date()
                    for try await ev in c.live(deviceId: self?.config.deviceId) {
                        if Task.isCancelled { break }
                        backoff = 1
                        guard let self = self else { return }
                        self.lastLiveEvent = Date()
                        switch ev {
                        case .change:
                            await self.sync()
                        case .notify(let n):
                            self.handleNotify(n)
                        case .modules(let list, let alerts):
                            await self.applyAlerts(alerts)
                            self.onModules?(list)
                        case .sources(let s):
                            self.adoptSources(s)
                        case .ping:
                            if self.status != .online { self.status = .online }
                        case .unknown: break
                        }
                    }
                } catch {
                    if let self = self, self.status == .online { self.status = .offline }
                }
                if Task.isCancelled { break }
                try? await Task.sleep(nanoseconds: UInt64(backoff * 1_000_000_000))
                backoff = min(backoff * 2, 30)
                if let self = self, !Task.isCancelled { await self.sync() }
            }
        }
        // The hub pings every 25 s. A stream silent for 70 s is gone even when its connection never said so (the
        // internet went down at home): the routes are raced again and the stream starts over. Not while a sync runs:
        // the stream waits for it before it reads the next event.
        liveWatch = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 20_000_000_000)
                guard let self, !Task.isCancelled else { return }
                if self.syncTask == nil, Date().timeIntervalSince(self.lastLiveEvent) > 70 {
                    self.routes.refresh()
                    self.startLive()
                    return
                }
            }
        }
    }

    private func handleNotify(_ n: NotifyEvent) {
        switch n.kind {
        case "activity":
            let logId = n.log_id ?? n.id ?? ""
            seenCheckins[logId] = ISO.now()
            let cur = currentActivity
            let name = (cur?.logId == logId ? cur?.name : nil) ?? Self.activityName(fromTitle: n.title) ?? cur?.name ?? ""
            let hours = cur.map { Date().timeIntervalSince($0.start) / 3600 } ?? Self.hours(fromTitle: n.title) ?? 0
            // The hub sends none while Activity check-ins is off (Settings, Notifications). One that was already on
            // its way when the switch was flipped is held back here.
            guard config.alertOn(.activity) else { return }
            onActivityCheckin?(ActivityCheckin(logId: logId, name: name, hours: hours, title: n.title))
        case "digest":
            onDigest?(n.title)
        case "reminder":
            if let id = n.id { onNotify?(id, n.title, n.friction ?? .none, ISO.date(n.at)) }
        default:
            onAlert?(n)
        }
    }

    /// "On <value> for <h> h" is the hub's title; recover the value when the log is not local yet.
    nonisolated static func activityName(fromTitle t: String) -> String? {
        guard t.hasPrefix("On "), let r = t.range(of: " for ", options: .backwards) else { return nil }
        let name = String(t[t.index(t.startIndex, offsetBy: 3)..<r.lowerBound])
        return name.isEmpty ? nil : name
    }

    nonisolated static func hours(fromTitle t: String) -> Double? {
        guard let r = t.range(of: " for ", options: .backwards) else { return nil }
        let tail = t[r.upperBound...].split(separator: " ").first.map(String.init) ?? ""
        return Double(tail)
    }

    /// After a pull: a new hub check-in on the running activity surfaces like a live event.
    private func surfacePolledCheckins() {
        guard onActivityCheckin != nil, let cur = currentActivity, let e = entities[cur.logId] else { return }
        let checkins = e.stringArray("checkins")
        guard let latest = checkins.max() else { return }
        if let seen = seenCheckins[cur.logId], !ISO.isAfter(latest, seen) { return }
        seenCheckins[cur.logId] = latest
        // The hub still writes the check-in on the log while Activity check-ins is off (Settings, Notifications); it
        // only sends no alert. Found by a pull, it is this device's own to hold back.
        guard config.alertOn(.activity) else { return }
        // Only check-ins from the last ten minutes are worth a banner.
        guard let at = ISO.date(latest), Date().timeIntervalSince(at) < 600 else { return }
        let hours = Date().timeIntervalSince(cur.start) / 3600
        onActivityCheckin?(ActivityCheckin(logId: cur.logId, name: cur.name, hours: hours, title: "On \(cur.name) for \(Int(hours.rounded(.down))) h"))
    }

    private func startPolling() {
        let interval = pollInterval
        liveTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
                if Task.isCancelled { break }
                await self?.sync()
            }
        }
    }

    // MARK: local edits

    /// Apply a patch locally now, queue it, and try to flush.
    @discardableResult
    public func apply(_ patch: Patch) async -> Entity? {
        let before = entities[patch.id]
        guard let e = try? await store.applyLocal(patch) else { return nil }
        entities[e.id] = e
        if let m = FeelMoment.detect(before: before, after: e, created: patch.create == true) { moment(m, kind: e.kind) }
        outboxCount = (try? await store.outboxCount()) ?? 0
        await afterChange()
        Task { await self.sync() }
        return e
    }

    /// Apply many local patches with one notification replan, one widget refresh and one sync.
    public func applyBatch(_ patches: [Patch]) async {
        for p in patches {
            if let e = try? await store.applyLocal(p) { entities[e.id] = e }
        }
        outboxCount = (try? await store.outboxCount()) ?? 0
        await afterChange()
        Task { await self.sync() }
    }

    @discardableResult
    public func create(kind: Kind, space: Space = .personal, fields: [String: JSONValue], id: String? = nil) async -> Entity? {
        await apply(Patch(id: id ?? UUID().uuidString.lowercased(), kind: kind, space: space, ts: ISO.now(), fields: fields, create: true))
    }

    @discardableResult
    public func update(_ id: String, fields: [String: JSONValue]) async -> Entity? {
        guard let e = entities[id] else { return nil }
        // A field written twice in one millisecond would lose the second write to a tie, so the stamp is always
        // later than the newest one on the fields it touches.
        var ts = Date()
        for k in fields.keys {
            // Half a millisecond of margin, since the formatter truncates to whole milliseconds.
            if let last = ISO.date(e.field_ts[k]), ISO.string(last) >= ISO.string(ts) { ts = last.addingTimeInterval(0.0015) }
        }
        // No space: the hub keeps the item where it is. Naming the space this copy last saw moved an item back that had
        // been moved to the other space on another device meanwhile (moveToSpace does the moving).
        return await apply(Patch(id: id, kind: e.kind, ts: ISO.string(ts), fields: fields))
    }

    /// Move an item to the other space (a task between Personal and Work), keeping its id and fields.
    public func moveToSpace(_ id: String, _ space: Space, fields: [String: JSONValue] = [:]) async {
        guard let e = entities[id], e.space != space else { return }
        var ts = Date()
        if let last = ISO.date(e.field_ts["space"]), ISO.string(last) >= ISO.string(ts) { ts = last.addingTimeInterval(0.0015) }
        _ = await apply(Patch(id: id, kind: e.kind, space: space, ts: ISO.string(ts), fields: fields))
    }

    public func softDelete(_ id: String) async {
        _ = await update(id, fields: ["deleted_at": .string(ISO.now())])
    }

    /// Put an entity the hub returned from a convenience route into the cache.
    /// A finish the hub route made (a procedure step, say) still counts as this device's; a new entity does not,
    /// since screens also absorb what they load. Hub routes that create call `moment(.create, kind:)` themselves.
    public func absorb(_ e: Entity) async {
        let before = entities[e.id]
        if let stored = try? await store.upsertFromHub(e) {
            // Unchanged: no publish. Screens absorb what they load, and a publish makes them load again.
            guard stored != before else { return }
            entities[stored.id] = stored
            if before != nil, let m = FeelMoment.detect(before: before, after: stored, created: false) { moment(m, kind: stored.kind) }
        }
    }

    /// Many hub copies at once (every monitor on the ops board): one store transaction and at most one publish, and
    /// copies that change nothing are neither written nor published. One at a time, each was a write and a publish
    /// that redrew every screen.
    public func absorb(_ list: [Entity]) async {
        guard !list.isEmpty, let stored = try? await store.upsertManyFromHub(list) else { return }
        var next = entities
        var changed = false
        var finished: [(FeelMoment, Kind)] = []
        for e in stored where next[e.id] != e {
            if let before = next[e.id], let m = FeelMoment.detect(before: before, after: e, created: false) { finished.append((m, e.kind)) }
            next[e.id] = e
            changed = true
        }
        guard changed else { return }
        entities = next
        for (m, kind) in finished { moment(m, kind: kind) }
    }

    /// Report a create or finish to `onMoment`, unless a background import is running.
    public func moment(_ m: FeelMoment, kind: Kind) {
        if quietDepth == 0 { onMoment?(m, kind) }
    }

    /// Writes between these two calls do not celebrate (Health import and other background work).
    public func beginQuiet() { quietDepth += 1 }
    public func endQuiet() { quietDepth = max(0, quietDepth - 1) }

    // MARK: queries

    /// The live items of a kind. A task in an Apple Reminders list that is switched off is left out (`TaskVisibility`),
    /// so every screen, alert, widget and the Watch hide it; the Reminders sync reads `entities` and keeps it whole.
    public func list(_ kind: Kind, space: Space? = nil) -> [Entity] {
        if byKind == nil {
            let shows = visibility ?? TaskVisibility(sources)
            visibility = shows
            var m: [Kind: [Entity]] = [:]
            for e in entities.values where !e.isDeleted && shows.shows(e) { m[e.kind, default: []].append(e) }
            byKind = m
        }
        let all = byKind?[kind] ?? []
        return space == nil ? all : all.filter { $0.space == space }
    }

    public func get(_ id: String) -> Entity? { entities[id] }

    // MARK: after change hooks

    func afterChange() async {
        updateSnapshot()
        if schedulesNotifications { await replanNotifications() }
    }

    /// The notifications the reminders on this device should have now: the task reminders, as every replan uses.
    /// The first notification grant on the iPhone and the Watch used to replan from the old `reminder` kind, which
    /// nothing writes any more, and so took every task reminder off until the next sync.
    public func notificationPlan(now: Date = Date()) -> [PlannedNotification] {
        ReminderPlanner.plan(reminders: reminders, now: now)
    }

    /// Replace the pending reminder notifications with `notificationPlan`.
    /// With Reminder alerts off (Settings, Modules) or Reminders off (Settings, Notifications) nothing is scheduled
    /// and what was planned is taken off. The check-in planned for a running activity obeys its switch the same way.
    public func replanNotifications() async {
        let list = config.notifies(.reminder) ? reminders : []
        if let onReplan { onReplan(list); return }
        #if canImport(UserNotifications)
        await ReminderScheduler.shared.replan(reminders: list)
        await ReminderScheduler.shared.replanActivityCheckin()
        #endif
    }

    // MARK: alert switches

    /// The kinds this device plans notifications for by itself, ahead of time: a change to one of their switches
    /// means a replan. Every other kind is shown, or not, when its event comes.
    private static let plannedKinds: [AlertKind] = [.reminder, .activity]

    /// The alert switches as the hub has them now (`GET /modules`, `PUT /modules/alerts`, or a `modules` event on
    /// `/live`); nil from a hub that has none, where every kind is on. Kept in the app group, so the notifications
    /// this device plans itself obey them with no network. Reminders switched off takes this device's planned
    /// reminder notifications off, as Reminder alerts off in Modules does, and on brings them back.
    public func applyAlerts(_ list: [AlertInfo]?) async {
        let before = alerts
        let now = list ?? []
        if now != alerts { alerts = now }
        config.alerts = list
        if schedulesNotifications, Self.plannedKinds.contains(where: { before.isOn($0) != now.isOn($0) }) { await replanNotifications() }
    }

    /// Switch kinds of alert on or off for every device; the hub answers with the whole list.
    public func setAlerts(_ changes: [String: Bool]) async throws {
        guard let c = client else { throw HubError.notConfigured }
        await applyAlerts(try await c.setAlerts(changes))
    }

    /// The switches belonged to a hub this device left (another hub, removed, the sample ended).
    private func forgetAlerts() {
        config.alerts = nil
        if !alerts.isEmpty { alerts = [] }
    }

    /// Tests: stands in for the notification center, given the reminders a replan plans from.
    var onReplan: (([Entity]) -> Void)?

    /// The hub's items left this device (it was removed, or the sample ended): the alerts planned from them go too.
    /// Activity check-ins name an activity, so they go as well.
    private func takeOffPlannedAlerts() async {
        guard schedulesNotifications else { return }
        await replanNotifications()
        #if canImport(UserNotifications)
        if onReplan == nil { await ReminderScheduler.shared.cancelActivityCheckins() }
        #endif
    }

    /// Background refresh (iPhone): the hub's changes come in first, so the copies to Apple's stores compare against
    /// them (an event made in the app that this device had not pulled yet came back from Apple Calendar as a second
    /// one); then the copies run; then what they changed goes to the hub.
    public func refreshing(_ copies: () async -> Void) async {
        await sync()
        await copies()
        await sync()
    }

    public func updateSnapshot() {
        let now = nowTask
        config.nowTaskId = now?.id
        config.nowTaskTitle = now?.str("title")
        config.nowTaskStatus = now?.str("status")
        config.nowTaskTiming = now.map { WidgetDone.timing(of: $0) }
        config.nowBlockEnd = now.flatMap { $0.decoded(TaskFields.self)?.block }.flatMap { ISO.date($0.end) }
        let nb = nextBlockToday(excluding: now?.id)
        config.nextBlockTitle = nb?.title
        config.nextBlockStart = nb.flatMap { ISO.date($0.start) }
        config.unprocessedCount = unprocessedCaptures.count
        let up = nextUp()
        config.nextUpTitle = up?.title
        config.nextUpAt = up?.at
        let act = currentActivity
        config.currentActivity = act?.name
        config.currentActivityStart = act?.start
        config.snapshotUpdated = Date()
        // Widgets show only these values; reloading them on every change (each synced game, say) wasted the main thread.
        let key = [now?.id, now?.str("title"), now?.str("status"), nb?.title, up?.title, up?.at.map { "\($0)" }, act?.name, "\(unprocessedCaptures.count)", config.nowBlockEnd.map { "\($0)" }, config.nextBlockStart.map { "\($0)" }].map { $0 ?? "" }.joined(separator: "|")
        if key != lastSnapshotKey {
            lastSnapshotKey = key
            #if canImport(WidgetKit)
            WidgetCenter.shared.reloadAllTimelines()
            #endif
        }
        if let send = onComplicationSnapshot {
            let complications = ComplicationSnapshot(config: config)
            if complications != lastComplications {
                lastComplications = complications
                send(complications)
            }
        }
    }
}

/// An edit the hub refused, kept so the change is visible instead of silently replaced.
public struct RejectedEdit: Codable, Identifiable, Sendable, Equatable {
    public var id: String { "\(entityId)|\(at)" }
    public var entityId: String
    public var kind: String
    public var title: String
    public var reason: String
    public var at: String
    public var fields: String
}

extension SyncEngine {
    private static let rejectedKey = "ea.rejectedEdits"

    static func loadRejected() -> [RejectedEdit] {
        guard let d = UserDefaults.standard.data(forKey: rejectedKey) else { return [] }
        return (try? JSONDecoder().decode([RejectedEdit].self, from: d)) ?? []
    }

    func logRejected(_ id: String, reason: String, patches: [Patch]) {
        let local = entities[id]
        var merged: [String: JSONValue] = [:]
        for p in patches { merged.merge(p.fields) { _, new in new } }
        let fields = (try? String(decoding: JSONEncoder().encode(merged), as: UTF8.self)) ?? ""
        let title = local.map { $0.str("title", $0.str("text", $0.str("name"))) } ?? ""
        rejectedEdits.append(RejectedEdit(entityId: id, kind: local?.kind.rawValue ?? patches.first?.kind.rawValue ?? "", title: title, reason: reason, at: ISO.now(), fields: fields))
        rejectedEdits = Array(rejectedEdits.suffix(50))
        if let d = try? JSONEncoder().encode(rejectedEdits) { UserDefaults.standard.set(d, forKey: Self.rejectedKey) }
    }

    public func clearRejected() {
        rejectedEdits = []
        UserDefaults.standard.removeObject(forKey: Self.rejectedKey)
    }
}

/// What this device keeps about its links to Apple Reminders, Calendar and Contacts, by the hub's ids (UserDefaults).
/// Another hub's ids mean nothing, so a change of hub forgets them (`SyncEngine.adopt`); a reconnect to the same hub
/// keeps them.
public enum AppleLinkRecords {
    public static let reminders = "ea.remindersSync.state"
    public static let calendar = "ea.eventMirror.state"
    public static let contacts = "ea.contacts.state"

    /// What this device last told the hub it sees, and whether it moved its own work calendar ticks (sources).
    public static let sourcesLists = "ea.sources.reported.lists"
    public static let sourcesCalendars = "ea.sources.reported.calendars"
    public static let workTicksMoved = "ea.sources.workTicksMoved"
    public static let contactsSeen = "ea.sources.contactsSeen"

    public static func forget(_ defaults: UserDefaults = .standard) {
        for k in [reminders, calendar, contacts, sourcesLists, sourcesCalendars, workTicksMoved, contactsSeen] { defaults.removeObject(forKey: k) }
    }
}
