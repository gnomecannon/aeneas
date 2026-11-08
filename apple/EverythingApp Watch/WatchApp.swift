import SwiftUI
import AVFoundation
import EACore
import UserNotifications

@main
struct EverythingAppWatchApp: App {
    @StateObject private var model = AppModel.shared
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            WatchRootView()
                .environmentObject(model)
                .environmentObject(model.engine)
                .task { await model.start() }
                .onOpenURL { model.handle(url: $0) }
        }
        .onChange(of: scenePhase) { _, p in if p == .active { Task { await model.start() } } }
    }
}

/// The voice page (Ask, Capture, Hum) is first; reminders and the rest are mostly left to Apple's own apps.
enum WatchPage: Hashable { case voice, now, today, log, activity, weight }

/// Watch model. The Watch has no hub URL or token: every hub call is relayed through the
/// iPhone over WatchConnectivity, and the Watch keeps its own SQLite outbox while the phone
/// is out of reach. There is nothing to configure on the wrist.
@MainActor
final class AppModel: ObservableObject {
    static let shared = AppModel()
    let engine: SyncEngine
    @Published var page: WatchPage = .voice
    /// Set by the Ask and Capture complications: the voice page starts listening.
    @Published var listen: VoiceAction?
    /// Today's conversation is pushed over the voice page. Kept here so a complication can close it: the voice page
    /// under it, which starts the dictation, is out of sight until it does.
    @Published var conversationOpen = false
    @Published var started = false
    @Published var phoneReachable = false
    /// Activity check-in from the hub (found on the polled log's `checkins`) or the local 3 h notification.
    @Published var activityCheckin: ActivityCheckin?
    /// Module switches, fetched through the iPhone and kept in the Watch's own app group for when it is out of reach.
    @Published private(set) var modules: [ModuleInfo] = SharedConfig.shared.modules ?? []
    /// What the modules that are on need from the Watch (notifications, the microphone for hums), offered once after
    /// its first setup or when a module is switched on. Asked only after Continue.
    @Published var permissionOffer: [PermissionNeed]?
    /// The pet's name from the hub's profile (empty: none named yet), kept for when the iPhone is out of reach.
    @Published private(set) var petName: String = UserDefaults.standard.string(forKey: "ea.petName") ?? ""
    /// The hub said this Watch was removed (Settings, Devices on the iPhone).
    @Published var removed = false
    /// The first module fetch after launch only remembers the switches; later ones offer what a switched on module needs.
    private var modulesFetchedThisLaunch = false
    /// Hums recorded here and how far each has got.
    let hum = WatchHumModel()
    /// Today's conversation with the assistant.
    let ask = WatchAskModel()

    private init() {
        engine = SyncEngine(config: .shared, platform: .watch)
        engine.makeClient = { HubClient(transport: WatchRelayTransport()) }
        engine.pollInterval = 60
        engine.onNotify = { id, title, friction in
            Task { await ReminderScheduler.shared.notifyNow(reminderId: id, title: title, friction: friction) }
        }
        engine.onActivityCheckin = { [weak self] c in self?.activityCheckin = c }
        engine.onDeviceRemoved = { [weak self] in self?.removed = true }
        UNUserNotificationCenter.current().delegate = WatchNotificationHandler.shared
        WatchLink.shared.onStateChanged = { [weak self] in
            guard let self = self else { return }
            let reachable = WatchLink.shared.isReachable
            let becameReachable = reachable && !self.phoneReachable
            self.phoneReachable = reachable
            if becameReachable, self.started { Task { await self.engine.sync(); await self.refreshModules() } }
        }
        WatchLink.shared.onHumDelivered = { [weak self] id in self?.hum.delivered(id) }
        WatchLink.shared.onHumResult = { [weak self] r in self?.hum.apply(r) }
    }

    func start() async {
        // The Watch's copy stays out of the iPhone's iCloud Backup.
        BackupExclusion.apply(config: engine.config)
        if started {
            // A hum whose transfer failed goes again; one WatchConnectivity is still carrying is left to it.
            WatchLink.shared.sendQueuedHums()
            // Not awaited: Siri's question waits behind start, and Siri gives it only 10 s.
            Task { await ask.catchUp(engine: engine) }
            await engine.sync(); await refreshModules()
            return
        }
        started = true
        ReminderScheduler.shared.registerCategories()
        WatchLink.shared.activate()
        phoneReachable = WatchLink.shared.isReachable
        // A Watch that never registered is being set up now: once its modules are known it offers what they need.
        if engine.config.deviceId.isEmpty { engine.config.permissionOfferPending = true }
        await engine.start()
        await refreshModules()
        Task { await ask.catchUp(engine: engine) }
        #if DEBUG
        // Simulator checks without a hand on the screen: the notification question would cover the app, and
        // `-listen ask|capture` does what the complications do (the Watch simulator cannot open links).
        let args = ProcessInfo.processInfo.arguments
        if let i = args.firstIndex(of: "-listen"), i + 1 < args.count { listen = args[i + 1] == "ask" ? .ask : .capture }
        // `-page now|today|log|activity|weight`: open on that page (App Store screenshots without swiping).
        if let i = args.firstIndex(of: "-page"), i + 1 < args.count, let u = URL(string: "everythingapp://" + args[i + 1]) { handle(url: u) }
        // `-ask "question"`: what the Ask tile sends once dictation ends (the simulator has no dictation).
        if let i = args.firstIndex(of: "-ask"), i + 1 < args.count {
            let q = args[i + 1]
            conversationOpen = true
            Task { await ask.ask(q, engine: engine) }
        }
        #endif
        // No permission is asked at launch (release rule 2).
    }

    /// Unknown or never fetched means on, so nothing disappears while the iPhone is away.
    func isOn(_ m: AppModule) -> Bool { modules.isOn(m) }

    /// The Watch has no /live stream, so it asks on launch, on return and when the iPhone comes back in reach.
    func refreshModules() async {
        guard let c = engine.client, let list = try? await c.modules() else { return }
        if let p = try? await c.profile(), p.pet != petName {
            petName = p.pet
            UserDefaults.standard.set(p.pet, forKey: "ea.petName")
        }
        let before = modules
        if list != modules { modules = list }
        engine.config.modules = list
        removed = engine.deviceRemoved
        let firstThisLaunch = !modulesFetchedThisLaunch
        modulesFetchedThisLaunch = true
        if engine.config.permissionOfferPending, !engine.config.deviceId.isEmpty {
            engine.config.permissionOfferPending = false
            await offerPermissions(for: PermissionPlan.withDeviceDefaults(list))
        } else if !firstThisLaunch {
            let on = PermissionPlan.switchedOn(before: before, after: list)
            if !on.isEmpty { await offerPermissions(for: on) }
        }
        if before.isOn(.notifications) != list.isOn(.notifications) { await engine.replanNotifications() }
    }

    private func offerPermissions(for list: [ModuleInfo]) async {
        var ask: [PermissionNeed] = []
        for n in PermissionPlan.needs(list, platform: .watch) where await Self.undecided(n.permission) { ask.append(n) }
        if !ask.isEmpty { permissionOffer = ask }
    }

    static func undecided(_ p: DevicePermission) async -> Bool {
        switch p {
        case .notifications: return await ReminderScheduler.shared.authorizationStatus() == .notDetermined
        case .microphone: return AVAudioApplication.shared.recordPermission == .undetermined
        default: return false
        }
    }

    /// Continue: each in turn.
    func grantOffered(_ needs: [PermissionNeed]) async {
        permissionOffer = nil
        for n in needs {
            switch n.permission {
            case .notifications: if await ReminderScheduler.shared.requestPermission() { await engine.replanNotifications() }
            case .microphone: _ = await HumRecorder.microphoneAllowed()
            default: break
            }
        }
    }

    func ensureStarted() async { if !started { await start() } }

    func answerCheckin(stop: Bool) async {
        activityCheckin = nil
        if stop { await engine.endActivity() }
    }

    func handle(url: URL) {
        guard url.scheme?.lowercased() == "everythingapp" else { return }
        switch (url.host ?? "").lowercased() {
        case "capture": page = .voice; conversationOpen = false; listen = .capture
        case "ask": page = .voice; conversationOpen = false; listen = .ask
        case "now": page = .now
        case "activity": page = .activity
        case "today": page = .today
        case "log": page = .log
        case "weight": page = .weight
        default: page = .voice
        }
    }
}


/// Notification taps and the Still on it / Stop actions on the wrist.
final class WatchNotificationHandler: NSObject, UNUserNotificationCenterDelegate {
    static let shared = WatchNotificationHandler()

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .list]
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        let action = response.actionIdentifier
        let typed = (response as? UNTextInputNotificationResponse)?.userText
        _ = await MainActor.run {
            Task { @MainActor in
                let model = AppModel.shared
                await model.ensureStarted()
                if let logId = info["activity_log_id"] as? String {
                    let c = ActivityCheckin(logId: logId, name: info["activity_name"] as? String ?? "", hours: info["activity_hours"] as? Double ?? 3)
                    switch action {
                    case ActivityCheckin.stillAction: break
                    case ActivityCheckin.stopAction: await model.answerCheckin(stop: true)
                    default: model.activityCheckin = c; model.page = .activity
                    }
                } else if let id = info["reminder_id"] as? String {
                    if action == ReminderPlanner.ackAction { await model.engine.ack(id) }
                    else if action == ReminderPlanner.snoozeAction { _ = await model.engine.snooze(id, minutes: 10, reason: nil) }
                    // The reason is dictated or written on the wrist.
                    else if action == ReminderPlanner.snoozeReasonAction { _ = await model.engine.snooze(id, minutes: 10, reason: typed) }
                }
            }
        }
    }
}
