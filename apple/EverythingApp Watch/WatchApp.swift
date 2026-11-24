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
        // The iPhone's complication snapshot (or a hum's or capture's result) can wake the app in the background: the model's
        // handlers are set up, then everything waiting comes in.
        .backgroundTask(.watchConnectivity) {
            await MainActor.run { _ = AppModel.shared }
            await WatchLink.shared.receivePending()
        }
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
    /// Set by the Ask, Capture and Hum complications: the voice page starts listening or recording.
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
    /// Captures spoken here and how far each has got.
    let capture = WatchCaptureModel()
    /// Today's conversation with the assistant.
    let ask = WatchAskModel()

    private init() {
        engine = SyncEngine(config: .shared, platform: .watch)
        engine.makeClient = { HubClient(transport: WatchRelayTransport()) }
        engine.pollInterval = 60
        engine.onNotify = { id, title, friction, at in
            Task { await ReminderScheduler.shared.notifyNow(reminderId: id, title: title, friction: friction, at: at) }
        }
        engine.onActivityCheckin = { [weak self] c in self?.activityCheckin = c }
        engine.onDeviceRemoved = { [weak self] in self?.removed = true }
        UNUserNotificationCenter.current().delegate = WatchNotificationHandler.shared
        WatchLink.shared.onStateChanged = { [weak self] in
            guard let self = self else { return }
            let reachable = WatchLink.shared.isReachable
            let becameReachable = reachable && !self.phoneReachable
            self.phoneReachable = reachable
            // Activation may finish after launch: the iPhone hears which speech model this Watch wants once it can,
            // and the words it last sent are read.
            WatchSpeech.shared.linkChanged()
            if becameReachable, self.started { Task { await self.engine.sync(); await self.refreshModules() } }
        }
        WatchLink.shared.onHumDelivered = { [weak self] id in self?.hum.delivered(id) }
        WatchLink.shared.onHumResult = { [weak self] r in self?.hum.apply(r) }
        WatchLink.shared.onCaptureDelivered = { [weak self] id in self?.capture.delivered(id) }
        WatchLink.shared.onCaptureResult = { [weak self] r in self?.capture.apply(r) }
        // Writing speech down on the Watch: the words to expect, and the model the iPhone carries over.
        WatchLink.shared.onSpeechHints = { words in WatchSpeech.shared.setHints(words) }
        WatchLink.shared.onSpeechModelFile = { DispatchQueue.main.async { WatchSpeech.shared.fileArrived() } }
    }

    func start() async {
        // The Watch's copy stays out of the iPhone's iCloud Backup.
        BackupExclusion.apply(config: engine.config)
        if started {
            // A hum or capture whose transfer failed goes again; one WatchConnectivity is still carrying is left to it.
            WatchLink.shared.sendQueuedFiles()
            // Not awaited: Siri's question waits behind start, and Siri gives it only 10 s.
            Task { await ask.catchUp(engine: engine) }
            await engine.sync(); await refreshModules()
            return
        }
        started = true
        ReminderScheduler.shared.registerCategories()
        WatchLink.shared.activate()
        phoneReachable = WatchLink.shared.isReachable
        WatchSpeech.shared.start()
        #if DEBUG
        speechHooks()
        #endif
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
        // `-speak "text"`: read it aloud on the conversation page (the louder speaker and the crown volume control).
        if let i = args.firstIndex(of: "-speak"), i + 1 < args.count {
            let text = args[i + 1]
            conversationOpen = true
            Task { try? await Task.sleep(nanoseconds: 1_000_000_000); ask.speaker.speak(text, id: "debug") }
        }
        // `-page now|today|log|activity|weight`: open on that page (App Store screenshots without swiping).
        if let i = args.firstIndex(of: "-page"), i + 1 < args.count, let u = URL(string: "everythingapp://" + args[i + 1]) { handle(url: u) }
        // `-captureFor <seconds>`: a capture started by `-listen capture` ends by itself, as Done would end it.
        if let i = args.firstIndex(of: "-captureFor"), i + 1 < args.count, let n = Double(args[i + 1]) {
            Task {
                while !capture.recording { try? await Task.sleep(nanoseconds: 200_000_000) }
                try? await Task.sleep(nanoseconds: UInt64(n * 1_000_000_000))
                capture.stop()
            }
        }
        // `-captureSaved "words"`: a capture as the iPhone reports it once written down and saved.
        if let i = args.firstIndex(of: "-captureSaved"), i + 1 < args.count {
            let text = args[i + 1]
            Task { try? await Task.sleep(nanoseconds: 1_500_000_000); capture.debugSaved(text) }
        }
        // `-ask "question"`: what the Ask tile sends once dictation ends (the simulator has no dictation).
        if let i = args.firstIndex(of: "-ask"), i + 1 < args.count {
            let q = args[i + 1]
            conversationOpen = true
            Task { await ask.ask(q, engine: engine) }
        }
        #endif
        // No permission is asked at launch (release rule 2).
    }

    #if DEBUG
    /// Simulator and timing hooks for writing speech down on the Watch. They run before the first sync, which can wait
    /// a long time on a simulator whose paired iPhone is not running.
    private func speechHooks() {
        let args = ProcessInfo.processInfo.arguments
        let d = UserDefaults.standard
        // `-captureSample YES`: the bundled sample as if just recorded, through the Watch's own hearing when it can.
        if d.bool(forKey: "captureSample") {
            Task { try? await Task.sleep(nanoseconds: 1_000_000_000); await capture.debugSample() }
        }
        // `-captureLive YES`: a capture recorded from a bundled 6 second sample instead of the microphone, with the live
        // words showing while it plays, then the final pass as after Done.
        if d.bool(forKey: "captureLive") {
            Task { try? await Task.sleep(nanoseconds: 1_000_000_000); capture.debugLive() }
        }
        // `-captureFiled "Logs: weight 192.2 lb"` (after `-captureSample` or `-captureLive`, or alone): the newest capture saved and then
        // filed, as the iPhone would report it, after `-captureFiledAfter <seconds>` (2 when not given), so the
        // Watch's own words can show first. `-captureFiledText "<words>"`: the iPhone's words.
        if let i = args.firstIndex(of: "-captureFiled"), i + 1 < args.count {
            let filed = args[i + 1]
            let wait = args.firstIndex(of: "-captureFiledAfter").flatMap { $0 + 1 < args.count ? Double(args[$0 + 1]) : nil } ?? 2
            Task {
                try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
                if capture.recent.isEmpty { capture.debugSaved("I weigh 192.2 today.") }
                capture.debugFiled(filed, text: d.string(forKey: "captureFiledText"))
            }
        }
        // `-captureNow YES`: a capture starts at once through the microphone, as the Capture tile starts it, so the
        // recording panel can be seen in each state of the speech model (`-listen capture` waits for the first sync).
        if d.bool(forKey: "captureNow") {
            Task { try? await Task.sleep(nanoseconds: 1_000_000_000); await capture.record() }
        }
        // `-EAWatchHearingBench YES`: time the speech models on this Watch with the bundled sample (see WatchSpeech).
        if d.bool(forKey: "EAWatchHearingBench") { Task { await WatchSpeech.shared.bench() } }
    }
    #endif

    /// Unknown or never fetched means on, so nothing disappears while the iPhone is away.
    func isOn(_ m: AppModule) -> Bool { modules.isOn(m) }

    /// With Health off there is no health logging on the wrist, as on the iPhone, where activities, weight and the
    /// other logs live under Health. The Log page stays for the pet while Pet is on.
    func shows(_ p: WatchPage) -> Bool {
        switch p {
        case .log: return isOn(.health) || isOn(.pet)
        case .activity, .weight: return isOn(.health)
        case .voice, .now, .today: return true
        }
    }

    /// The Watch has no /live stream, so it asks on launch, on return and when the iPhone comes back in reach. The
    /// alert switches come in the same answer: the Watch has no page for them, but the reminder notifications and the
    /// activity check-in it plans itself obey them (the engine keeps them in the Watch's app group).
    func refreshModules() async {
        guard let c = engine.client, let r = try? await c.modulesAndAlerts() else { return }
        let list = r.modules
        if let p = try? await c.profile(), p.pet != petName {
            petName = p.pet
            UserDefaults.standard.set(p.pet, forKey: "ea.petName")
        }
        let before = modules
        if list != modules { modules = list }
        engine.config.modules = list
        if !shows(page) { page = .voice }
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
        await engine.applyAlerts(r.alerts)
        // Which Reminders lists are on: the Watch hides the tasks of a list that is off, as every device does.
        await engine.refreshSources()
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
        case "hum": page = .voice; conversationOpen = false; listen = .hum
        case "now": page = .now
        case "activity": page = .activity
        case "today": page = .today
        case "log": page = .log
        case "weight": page = .weight
        default: page = .voice
        }
        if !shows(page) { page = .voice }
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
        // Awaited: an app started for this action is suspended once the handler returns, and Done, Stop or a snooze
        // reason started in a task of its own was lost then.
        await Task { @MainActor in
            let model = AppModel.shared
            await model.ensureStarted()
            if let logId = info["activity_log_id"] as? String {
                let c = ActivityCheckin(logId: logId, name: info["activity_name"] as? String ?? "", hours: info["activity_hours"] as? Double ?? 3)
                switch action {
                case ActivityCheckin.stillAction: break
                case ActivityCheckin.stopAction: await model.answerCheckin(stop: true)
                default: model.activityCheckin = c; if model.shows(.activity) { model.page = .activity }
                }
            } else if let id = info["reminder_id"] as? String {
                if action == ReminderPlanner.ackAction { await model.engine.ack(id) }
                else if action == ReminderPlanner.snoozeAction { _ = await model.engine.snooze(id, minutes: 10, reason: nil) }
                // The reason is dictated or written on the wrist.
                else if action == ReminderPlanner.snoozeReasonAction { _ = await model.engine.snooze(id, minutes: 10, reason: typed) }
            }
            // An edit made here goes out through the iPhone before the handler returns, while it answers; otherwise it
            // waits in the queue for the next sync.
            if model.engine.status == .online, model.engine.outboxCount > 0 { await model.engine.sync() }
        }.value
    }
}
