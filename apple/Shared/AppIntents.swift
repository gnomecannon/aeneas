import AppIntents
import UserNotifications
import EACore

// App Intents shared by the iPhone/iPad/Mac app and the Watch app, for Siri, Shortcuts,
// the Action Button and the Watch. Each target defines `AppModel.shared` with `engine`.

struct CaptureIntent: AppIntent {
    static let title: LocalizedStringResource = "Capture"
    static let description = IntentDescription("Capture text into Aeneas")
    static let openAppWhenRun = false

    @Parameter(title: "Text", requestValueDialog: "What do you want to capture?")
    var text: String

    init() {}
    init(text: String) { self.text = text }

    static var parameterSummary: some ParameterSummary { Summary("Capture \(\.$text)") }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let model = AppModel.shared
        await model.ensureStarted()
        let e = await model.engine.capture(text, source: .shortcut)
        return .result(dialog: e == nil ? "Nothing captured" : (model.engine.status == .online ? "Captured" : "Captured, will sync"))
    }
}

/// "Ask Aeneas": Siri takes the question by voice and speaks the answer. On the Watch it joins the day's
/// conversation on the voice page. An answer slower than Siri waits for comes as a notification instead.
struct AskIntent: AppIntent {
    static let title: LocalizedStringResource = "Ask"
    static let description = IntentDescription("Ask the assistant and hear the answer")
    static let openAppWhenRun = false

    @Parameter(title: "Question", requestValueDialog: "What do you want to ask?")
    var question: String

    init() {}
    init(question: String) { self.question = question }

    static var parameterSummary: some ParameterSummary { Summary("Ask \(\.$question)") }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let model = AppModel.shared
        // Siri waits about 10 s for the answer, and a cold start (a full sync first) can take most of that, so the
        // question goes out at once and the start runs alongside it.
        Task { await model.ensureStarted() }
        #if os(watchOS)
        WatchLink.shared.activate()
        let said = await model.ask.answerForSiri(question, engine: model.engine)
        #else
        let said = await SiriAsk.answer(question, engine: model.engine)
        #endif
        return .result(dialog: IntentDialog(stringLiteral: said))
    }
}

/// An assistant answer that took longer than Siri waits, delivered as a notification. A tap on the iPhone or Mac opens
/// its chat in the Assistant.
enum AnswerNotice {
    static func post(question: String, answer: String, session: String?) {
        let c = UNMutableNotificationContent()
        c.title = StyleGuard.dashes(question)
        c.body = Speakable.text(StyleGuard.dashes(answer))
        c.sound = .default
        c.userInfo = ["kind": "assistant_answer", "session": session ?? ""]
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "answer-\(UUID().uuidString)", content: c, trigger: nil))
    }

    /// Siri promised a notification, so a failure after that is one too, rather than silence.
    static func postFailure(question: String, reason: String, session: String?) {
        let why = reason.trimmingCharacters(in: CharacterSet(charactersIn: ". "))
        post(question: question, answer: "No answer came back: \(why). Ask again or open the app.", session: session)
    }
}

#if !os(watchOS)
/// Siri on the iPhone, iPad or Mac: one Siri conversation per day on the hub, so follow-ups keep their context.
@MainActor
enum SiriAsk {
    static let wait: TimeInterval = 10

    static func answer(_ question: String, engine: SyncEngine) async -> String {
        guard let c = engine.readyClient() else { return "Aeneas is not connected to the hub." }
        let d = UserDefaults.standard
        let today = ISO.localDay()
        if d.string(forKey: "siri.askDay") != today || (d.string(forKey: "siri.askSession") ?? "").isEmpty {
            d.set("siri-\(today)-\(UUID().uuidString.prefix(8).lowercased())", forKey: "siri.askSession")
            d.set(today, forKey: "siri.askDay")
        }
        let req = ChatRequest(session_id: d.string(forKey: "siri.askSession") ?? "", message: question)
        return await SiriAnswer.run(question, session: req.session_id, wait: wait) {
            do {
                // A reply slower than the request's limit, or held up while iOS suspended the app, is still finished
                // by the hub: past 45 s it is also read from the chat there, whichever comes first.
                switch try await c.chatOrLate(req, approveOn: "the app") {
                case .reply(let r): return .init(reply: r.pending_action != nil ? r.reply + "\n\nApprove or decline this in the app." : r.reply)
                case .late(let t): return .init(reply: t.a)
                }
            } catch {
                return .init(failure: (error as? HubError)?.errorDescription ?? error.localizedDescription)
            }
        }
    }
}
#endif

/// Siri asking the assistant: an answer in time is spoken; once Siri stops waiting, the answer is posted as a
/// notification when it comes. The app holds background time meanwhile, or iOS and watchOS would suspend it
/// before a slow answer arrived. Both ends run on the main actor, so exactly one of them delivers the answer.
@MainActor
final class SiriAnswer {
    struct Outcome { var reply: String?; var failure: String? }

    private let question: String
    private let session: String?
    private var outcome: Outcome?
    private var gaveUp = false

    private init(question: String, session: String?) { self.question = question; self.session = session }

    static func run(_ question: String, session: String?, wait: TimeInterval, _ work: @escaping @MainActor () async -> Outcome) async -> String {
        let s = SiriAnswer(question: question, session: session)
        let job = Task { @MainActor in
            await KeepAwake.during("Answer a question asked through Siri") { @MainActor in s.finish(await work()) }
        }
        let inTime = await Deadline.answer(within: wait, otherwise: false) { await job.value; return true }
        return inTime ? s.spoken : s.stopWaiting()
    }

    private func finish(_ o: Outcome) {
        outcome = o
        guard gaveUp else { return }
        if let r = o.reply { AnswerNotice.post(question: question, answer: r, session: session) }
        else { AnswerNotice.postFailure(question: question, reason: o.failure ?? "unknown error", session: session) }
    }

    /// Siri's wait is over: the answer if it landed just now, else the promise of a notification.
    private func stopWaiting() -> String {
        if outcome != nil { return spoken }
        gaveUp = true
        return "Still thinking. The answer will come as a notification."
    }

    private var spoken: String {
        if let r = outcome?.reply { return Speakable.text(StyleGuard.dashes(r)) }
        return outcome?.failure ?? "I could not ask the assistant."
    }
}

struct LogWeightIntent: AppIntent {
    static let title: LocalizedStringResource = "Log Weight"
    static let description = IntentDescription("Log a weight in pounds")
    static let openAppWhenRun = false

    @Parameter(title: "Weight", requestValueDialog: "What is the weight in pounds?")
    var value: Double

    init() {}
    init(value: Double) { self.value = value }

    static var parameterSummary: some ParameterSummary { Summary("Log weight \(\.$value)") }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let model = AppModel.shared
        await model.ensureStarted()
        _ = await model.engine.log(type: .weight, value: .number(value), unit: "lb", source: .shortcut)
        return .result(dialog: "Logged \(value.formatted()) lb")
    }
}

struct MarkNowDoneIntent: AppIntent {
    static let title: LocalizedStringResource = "Mark Now Done"
    static let description = IntentDescription("Mark the current task done")
    static let openAppWhenRun = false

    init() {}

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let model = AppModel.shared
        await model.ensureStarted()
        guard let now = model.engine.nowTask else { return .result(dialog: "Nothing is next") }
        await model.engine.markDone(now.id)
        let next = model.engine.nowTask?.str("title")
        return .result(dialog: next.map { "Done. Next: \($0)" } ?? "Done. Nothing after this.")
    }
}

struct StartActivityIntent: AppIntent {
    static let title: LocalizedStringResource = "Start Activity"
    static let description = IntentDescription("Start tracking an activity, or end it if it is already running")
    static let openAppWhenRun = false

    @Parameter(title: "Activity", requestValueDialog: "Which activity?")
    var name: String

    init() {}
    init(name: String) { self.name = name }

    static var parameterSummary: some ParameterSummary { Summary("Start \(\.$name)") }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let model = AppModel.shared
        await model.ensureStarted()
        let wasCurrent = model.engine.currentActivity?.name.caseInsensitiveCompare(name) == .orderedSame
        await model.engine.toggleActivity(name)
        return .result(dialog: wasCurrent ? "Ended \(name)" : "Started \(name)")
    }
}

// MARK: logging

enum MoodLevel: Int, AppEnum {
    case veryLow = -2, low = -1, okay = 0, good = 1, veryGood = 2
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Mood"
    static let caseDisplayRepresentations: [MoodLevel: DisplayRepresentation] = [
        .veryLow: "Very low", .low: "Low", .okay: "Okay", .good: "Good", .veryGood: "Very good",
    ]
}

struct LogMoodIntent: AppIntent {
    static let title: LocalizedStringResource = "Log Mood"
    static let description = IntentDescription("Log how you feel, from very low to very good")
    static let openAppWhenRun = false

    @Parameter(title: "Mood", requestValueDialog: "How are you feeling?")
    var mood: MoodLevel

    init() {}

    static var parameterSummary: some ParameterSummary { Summary("Log mood \(\.$mood)") }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let model = AppModel.shared
        await model.ensureStarted()
        _ = await model.engine.log(type: .mood, value: .number(Double(mood.rawValue)), source: .shortcut)
        return .result(dialog: "Logged")
    }
}

struct LogCaffeineIntent: AppIntent {
    static let title: LocalizedStringResource = "Log Caffeine"
    static let description = IntentDescription("Log a cup of coffee or another caffeinated drink")
    static let openAppWhenRun = false

    @Parameter(title: "Cups", default: 1, inclusiveRange: (0.5, 10))
    var cups: Double

    init() {}

    static var parameterSummary: some ParameterSummary { Summary("Log \(\.$cups) cups of caffeine") }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let model = AppModel.shared
        await model.ensureStarted()
        _ = await model.engine.log(type: .caffeine, value: .number(cups), source: .shortcut)
        let today = model.engine.logs(type: .caffeine, days: 1).filter { Calendar.current.isDateInToday($0.date("at") ?? .distantPast) }.reduce(0.0) { $0 + ($1.number("value") ?? 1) }
        return .result(dialog: "Logged. \(today.formatted()) today.")
    }
}

/// Meds taken lately, offered as choices.
struct RecentMedOptions: DynamicOptionsProvider {
    @MainActor
    func results() async throws -> [String] {
        let model = AppModel.shared
        await model.ensureStarted()
        return model.engine.recentValues(type: .med)
    }
}

struct LogMedIntent: AppIntent {
    static let title: LocalizedStringResource = "Log Medication"
    static let description = IntentDescription("Log a medication as taken")
    static let openAppWhenRun = false

    @Parameter(title: "Medication", requestValueDialog: "Which medication?", optionsProvider: RecentMedOptions())
    var name: String

    init() {}

    static var parameterSummary: some ParameterSummary { Summary("Took \(\.$name)") }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let model = AppModel.shared
        await model.ensureStarted()
        _ = await model.engine.log(type: .med, value: .string(name), source: .shortcut)
        return .result(dialog: "Logged \(name)")
    }
}

struct LogBloodPressureIntent: AppIntent {
    static let title: LocalizedStringResource = "Log Blood Pressure"
    static let description = IntentDescription("Log a blood pressure reading")
    static let openAppWhenRun = false

    @Parameter(title: "Systolic", inclusiveRange: (60, 260), requestValueDialog: "The top number?")
    var systolic: Int
    @Parameter(title: "Diastolic", inclusiveRange: (30, 180), requestValueDialog: "And the bottom number?")
    var diastolic: Int

    init() {}

    static var parameterSummary: some ParameterSummary { Summary("Log blood pressure \(\.$systolic) over \(\.$diastolic)") }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let model = AppModel.shared
        await model.ensureStarted()
        let v = "\(systolic)/\(diastolic)"
        _ = await model.engine.log(type: .bp, value: .string(v), unit: "mmHg", source: .shortcut)
        return .result(dialog: "Logged \(v)")
    }
}

// MARK: tasks

struct AddTaskIntent: AppIntent {
    static let title: LocalizedStringResource = "Add Task"
    static let description = IntentDescription("Add a task to Next")
    static let openAppWhenRun = false

    @Parameter(title: "Task", requestValueDialog: "What is the task?")
    var title: String

    init() {}

    static var parameterSummary: some ParameterSummary { Summary("Add task \(\.$title)") }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let model = AppModel.shared
        await model.ensureStarted()
        let e = await model.engine.createTask(title: title, status: .next)
        return .result(dialog: e == nil ? "Could not add it" : "Added")
    }
}

/// A personal task that is not done, for Shortcuts ("Complete task", "Find tasks").
struct TaskEntity: AppEntity {
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Task"
    static let defaultQuery = TaskQuery()
    var id: String
    var title: String
    var status: String
    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(title)", subtitle: "\(status.capitalized)") }

    init(_ e: EACore.Entity) {
        id = e.id
        title = StyleGuard.dashes(e.str("title"))
        status = e.str("status")
    }
}

struct TaskQuery: EntityStringQuery {
    @MainActor
    private func open() async -> [EACore.Entity] {
        let model = AppModel.shared
        await model.ensureStarted()
        return model.engine.list(.task, space: .personal).filter { $0.str("status") != "done" }
    }
    @MainActor
    func entities(for identifiers: [String]) async throws -> [TaskEntity] {
        await open().filter { identifiers.contains($0.id) }.map(TaskEntity.init)
    }
    @MainActor
    func entities(matching string: String) async throws -> [TaskEntity] {
        await open().filter { $0.str("title").localizedCaseInsensitiveContains(string) }.map(TaskEntity.init)
    }
    @MainActor
    func suggestedEntities() async throws -> [TaskEntity] {
        let order = ["doing", "next", "scheduled", "inbox", "parked"]
        return await open().sorted { (order.firstIndex(of: $0.str("status")) ?? 9) < (order.firstIndex(of: $1.str("status")) ?? 9) }.prefix(30).map(TaskEntity.init)
    }
}

struct CompleteTaskIntent: AppIntent {
    static let title: LocalizedStringResource = "Complete Task"
    static let description = IntentDescription("Mark a task done")
    static let openAppWhenRun = false

    @Parameter(title: "Task", requestValueDialog: "Which task?")
    var task: TaskEntity

    init() {}

    static var parameterSummary: some ParameterSummary { Summary("Complete \(\.$task)") }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let model = AppModel.shared
        await model.ensureStarted()
        await model.engine.markDone(task.id)
        return .result(dialog: "Done: \(task.title)")
    }
}

#if !os(watchOS)
/// Pairs this device with a one-time code from a device that is already paired (Settings, Connection, Pair another
/// device). The code works once, for 10 minutes, so a Shortcut holds no lasting secret.
struct ConfigureHubIntent: AppIntent {
    static let title: LocalizedStringResource = "Configure Hub"
    static let description = IntentDescription("Pair this device with your hub using a one-time pairing code")
    static let openAppWhenRun = false

    @Parameter(title: "Hub URL") var hub: String
    @Parameter(title: "Pairing code") var code: String
    @Parameter(title: "Device name") var name: String?

    init() {}
    init(hub: String, code: String, name: String? = nil) { self.hub = hub; self.code = code; self.name = name }

    static var parameterSummary: some ParameterSummary { Summary("Pair with hub \(\.$hub)") }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let model = AppModel.shared
        let error = await model.pair(hub: hub, code: code, name: name)
        return .result(dialog: IntentDialog(stringLiteral: error ?? "Paired with your hub"))
    }
}

/// A screen of the app, for "Open a screen".
enum ScreenOption: String, AppEnum {
    case today, assistant, capture, tasks, reminders, week, notes, health, logs, games, films, lists, projects, ops
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Screen"
    static let caseDisplayRepresentations: [ScreenOption: DisplayRepresentation] = [
        .today: "Today", .assistant: "Assistant", .capture: "Capture", .tasks: "Tasks", .reminders: "Reminders", .week: "Week",
        .notes: "Notes", .health: "Health", .logs: "Logs", .games: "Games", .films: "Films", .lists: "Lists", .projects: "Projects", .ops: "Ops",
    ]
}

struct OpenScreenIntent: AppIntent {
    static let title: LocalizedStringResource = "Open Screen"
    static let description = IntentDescription("Open Aeneas on a screen")
    static let openAppWhenRun = true

    @Parameter(title: "Screen")
    var screen: ScreenOption

    init() {}

    static var parameterSummary: some ParameterSummary { Summary("Open \(\.$screen)") }

    @MainActor
    func perform() async throws -> some IntentResult {
        if let s = Section(rawValue: screen.rawValue) { AppModel.shared.section = s }
        return .result()
    }
}
#endif

/// Apple allows ten. Log Blood Pressure is left to the Shortcuts app (two numbers suit voice least), so Ask fits.
struct EverythingAppShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: AskIntent(), phrases: ["Ask \(.applicationName)", "Ask \(.applicationName) a question"], shortTitle: "Ask", systemImageName: "bubble.left.and.text.bubble.right")
        AppShortcut(intent: CaptureIntent(), phrases: ["Capture in \(.applicationName)", "New capture in \(.applicationName)"], shortTitle: "Capture", systemImageName: "square.and.pencil")
        AppShortcut(intent: LogWeightIntent(), phrases: ["Log weight in \(.applicationName)", "Log my weight in \(.applicationName)"], shortTitle: "Log weight", systemImageName: "scalemass")
        AppShortcut(intent: MarkNowDoneIntent(), phrases: ["Mark now done in \(.applicationName)", "Done in \(.applicationName)"], shortTitle: "Mark Now done", systemImageName: "checkmark.circle")
        AppShortcut(intent: StartActivityIntent(), phrases: ["Start activity in \(.applicationName)", "Track activity in \(.applicationName)"], shortTitle: "Start activity", systemImageName: "figure.walk")
        AppShortcut(intent: LogMoodIntent(), phrases: ["Log my mood in \(.applicationName)", "Log mood in \(.applicationName)"], shortTitle: "Log mood", systemImageName: "face.smiling")
        AppShortcut(intent: LogCaffeineIntent(), phrases: ["Log coffee in \(.applicationName)", "Log caffeine in \(.applicationName)"], shortTitle: "Log caffeine", systemImageName: "cup.and.saucer")
        AppShortcut(intent: LogMedIntent(), phrases: ["Log medication in \(.applicationName)", "I took my meds in \(.applicationName)"], shortTitle: "Log medication", systemImageName: "pills")
        AppShortcut(intent: AddTaskIntent(), phrases: ["Add a task in \(.applicationName)", "New task in \(.applicationName)"], shortTitle: "Add task", systemImageName: "plus.circle")
        AppShortcut(intent: CompleteTaskIntent(), phrases: ["Complete a task in \(.applicationName)", "Finish a task in \(.applicationName)"], shortTitle: "Complete task", systemImageName: "checkmark.circle.fill")
    }
}
