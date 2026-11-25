import WidgetKit
import SwiftUI
import AppIntents
import EACore
#if canImport(ActivityKit) && os(iOS)
import ActivityKit
#endif

/// One moment of the Now and next widget: the Next line at `date` (CONTRACT.md, Planner, The Next line).
struct NowEntry: TimelineEntry {
    var date: Date
    var line: TodayBoard.LineWords
    /// Under a task you started: what is on now or next.
    var then: TodayBoard.LineWords?
    var unprocessed: Int
    var activity: String? = nil
    var activityStart: Date? = nil
}

/// The line at each minute of the next hour, worked out here from the plan the app wrote (`SharedConfig.nextLinePlan`),
/// so the minutes left count down without the app; the app reloads the widget when the plan changes.
struct NowProvider: TimelineProvider {
    private func entry(_ plan: NextLinePlan?, at date: Date) -> NowEntry {
        let c = SharedConfig.shared
        let plan = plan ?? NextLinePlan(day: "", started: nil, spans: [])
        return NowEntry(date: date, line: plan.words(at: date), then: plan.then(at: date), unprocessed: c.unprocessedCount,
                        activity: c.currentActivity, activityStart: c.currentActivityStart)
    }
    func placeholder(in context: Context) -> NowEntry {
        let now = Date()
        return NowEntry(date: now, line: TodayBoard.LineWords(label: .next, lead: "Next: ", title: "Dentist", when: "at \(TodayBoard.deviceClock(now.addingTimeInterval(2760)))", aside: "in 46 min"),
                        then: nil, unprocessed: 2)
    }
    func getSnapshot(in context: Context, completion: @escaping (NowEntry) -> Void) {
        completion(context.isPreview ? placeholder(in: context) : entry(SharedConfig.shared.nextLinePlan, at: Date()))
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<NowEntry>) -> Void) {
        let plan = SharedConfig.shared.nextLinePlan
        let moments = NextLinePlan.moments(from: Date())
        completion(Timeline(entries: moments.map { entry(plan, at: $0) }, policy: .after(moments.last ?? Date().addingTimeInterval(3600))))
    }
}

/// The widget's Done button: marks the task you started done on the hub straight from the widget (the app picks it up
/// on its next sync) and clears it from the widget at once. It is only on the widget while a task is started.
struct WidgetDoneIntent: AppIntent {
    static let title: LocalizedStringResource = "Mark Started Task Done"
    static let isDiscoverable = false

    func perform() async throws -> some IntentResult {
        let c = SharedConfig.shared
        // The device's own key, read from the Keychain the app shares with its widgets.
        guard let id = c.nowTaskId, !c.deviceId.isEmpty else { return .result() }
        // Widgets cannot reach a Direct link hub themselves (no iroh here); any other hub needs a client.
        let client = HubClient.make(config: c)
        guard client != nil || DirectHub.isDirect(c.hubURL) else { return .result() }
        // Kept until the hub has it: a hub out of reach or a send cut short used to lose the tap, and the task came
        // back not done. The app's next sync sends what is still waiting.
        let done = WidgetDone(taskId: id, at: ISO.now(), timing: c.nowTaskTiming ?? "")
        c.addPendingWidgetDone(done)
        if let client, (try? await client.push(deviceId: c.deviceId, patches: [done.patch()])) != nil { c.removePendingWidgetDones([done]) }
        c.nowTaskId = nil
        c.nowTaskTitle = nil
        if var plan = c.nextLinePlan, plan.started?.id == id {
            plan.started = nil
            c.nextLinePlan = plan
        }
        WidgetCenter.shared.reloadAllTimelines()
        return .result()
    }
}

struct NowWidgetView: View {
    @Environment(\.widgetFamily) private var family
    var entry: NowEntry

    private var line: TodayBoard.LineWords { entry.line }

    var body: some View {
        switch family {
        case .systemMedium:
            HStack(spacing: 12) {
                nowBlock
                Divider()
                Link(destination: URL(string: "everythingapp://capture")!) {
                    VStack(spacing: 6) {
                        Image(systemName: "square.and.pencil").font(.title)
                        Text("Capture").font(.caption.weight(.semibold))
                        if entry.unprocessed > 0 { Text("\(entry.unprocessed) unsorted").font(.caption2).foregroundStyle(.secondary) }
                    }
                    .frame(width: 90)
                }
            }
            .widgetURL(URL(string: "everythingapp://today"))
        #if os(iOS)
        case .accessoryInline:
            if let a = entry.activity { Text("\(a) since \(entry.activityStart?.formatted(date: .omitted, time: .shortened) ?? "")").lockScreenPrivate() }
            else { Text(StyleGuard.dashes(line.text)).lockScreenPrivate() }
        case .accessoryCircular:
            ZStack {
                AccessoryWidgetBackground()
                VStack(spacing: 0) {
                    Image(systemName: entry.unprocessed > 0 ? "tray.full" : "square.and.pencil").font(.title3)
                    if entry.unprocessed > 0 { Text("\(entry.unprocessed)").font(.caption2.weight(.semibold)) }
                }
            }
            .widgetURL(URL(string: entry.unprocessed > 0 ? "everythingapp://inbox" : "everythingapp://capture"))
        case .accessoryRectangular:
            VStack(alignment: .leading, spacing: 1) {
                if let a = entry.activity, let s = entry.activityStart {
                    Text(a).font(.headline).lineLimit(1).lockScreenPrivate()
                    Text(s, style: .timer).font(.caption).monospacedDigit()
                } else {
                    Text(line.label.rawValue).font(.caption2).foregroundStyle(.secondary)
                    Text(StyleGuard.dashes(line.title)).font(.headline).lineLimit(2).lockScreenPrivate()
                    if !line.detail.isEmpty { Text(line.detail).font(.caption2).lineLimit(1) }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .widgetURL(URL(string: "everythingapp://today"))
        #endif
        default:
            nowBlock.widgetURL(URL(string: "everythingapp://today"))
        }
    }

    private var nowBlock: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(line.label.rawValue).font(.caption).foregroundStyle(.secondary)
                Spacer(minLength: 0)
                // Done only on a task you started: nothing else on the line is a task to finish.
                if line.isStarted {
                    Button(intent: WidgetDoneIntent()) { Image(systemName: "checkmark.circle") }
                        .buttonStyle(.plain)
                        .font(.title3)
                        .foregroundStyle(.tint)
                        .accessibilityLabel("Mark done")
                }
            }
            Text(StyleGuard.dashes(line.title))
                .font(.headline)
                .lineLimit(3)
                .minimumScaleFactor(0.8)
                .lockScreenPrivate()
            if !line.detail.isEmpty {
                Text(line.detail).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 0)
            if let a = entry.activity, let s = entry.activityStart {
                HStack(spacing: 4) {
                    Image(systemName: "timer").font(.caption2)
                    Text(a).font(.caption2).lineLimit(1).lockScreenPrivate()
                    Text(s, style: .timer).font(.caption2).monospacedDigit()
                }
                .foregroundStyle(.secondary)
            } else if family == .systemMedium, let then = entry.then {
                // Under the task you started: what is on now or next.
                HStack(spacing: 4) {
                    Image(systemName: "calendar").font(.caption2)
                    Text(StyleGuard.dashes(then.text)).font(.caption2).lineLimit(1).lockScreenPrivate()
                }
                .foregroundStyle(.secondary)
            } else if family == .systemSmall, entry.unprocessed > 0 {
                Text("\(entry.unprocessed) to sort").font(.caption2).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

/// The Now and next widget. Its kind is the one the Now widget had, so a widget placed before 2026-11-25 shows the
/// line in its place.
struct NowWidget: Widget {
    private var families: [WidgetFamily] {
        #if os(iOS)
        [.systemSmall, .systemMedium, .accessoryInline, .accessoryCircular, .accessoryRectangular]
        #else
        [.systemSmall, .systemMedium]
        #endif
    }

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "com.gnomecannon.everythingapp.now", provider: NowProvider()) { entry in
            NowWidgetView(entry: entry).containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Now and next")
        .description("The task you started with a Done button, else what is on now or next today, a running activity, and a capture shortcut. Lock Screen sizes too.")
        .supportedFamilies(families)
    }
}

#if os(iOS)
/// Control Center, the Lock Screen and the Action Button: open Capture in one press.
struct CaptureControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "com.gnomecannon.everythingapp.capture") {
            ControlWidgetButton(action: OpenURLIntent(URL(string: "everythingapp://capture")!)) {
                Label("Capture", systemImage: "square.and.pencil")
            }
        }
        .displayName("Capture")
        .description("Open Aeneas ready to capture.")
    }
}

/// Control Center: open Logs to log weight, mood, caffeine or meds.
struct LogControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "com.gnomecannon.everythingapp.log") {
            ControlWidgetButton(action: OpenURLIntent(URL(string: "everythingapp://section/logs")!)) {
                Label("Log", systemImage: "heart.text.square")
            }
        }
        .displayName("Log")
        .description("Open Logs to log weight, mood, caffeine or meds.")
    }
}

/// The Live Activity: a running activity counting up, or the focus block of the task you started counting down to its end.
struct EALiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: EAActivityAttributes.self) { ctx in
            HStack(spacing: 12) {
                Image(systemName: ctx.attributes.kind == "block" ? "target" : "timer").font(.title2).foregroundStyle(.tint)
                VStack(alignment: .leading, spacing: 2) {
                    Text(ctx.attributes.kind == "block" ? "Focus block" : "Activity").font(.caption).foregroundStyle(.secondary)
                    Text(StyleGuard.dashes(ctx.state.title)).font(.headline).lineLimit(1).lockScreenPrivate()
                }
                Spacer()
                clock(ctx.state).font(.title3.monospacedDigit()).multilineTextAlignment(.trailing)
            }
            .padding()
            .widgetURL(URL(string: "everythingapp://today"))
        } dynamicIsland: { ctx in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Image(systemName: ctx.attributes.kind == "block" ? "target" : "timer").foregroundStyle(.tint)
                }
                DynamicIslandExpandedRegion(.center) { Text(StyleGuard.dashes(ctx.state.title)).font(.headline).lineLimit(1).lockScreenPrivate() }
                DynamicIslandExpandedRegion(.trailing) { clock(ctx.state).monospacedDigit().frame(maxWidth: 70) }
            } compactLeading: {
                Image(systemName: ctx.attributes.kind == "block" ? "target" : "timer").foregroundStyle(.tint)
            } compactTrailing: {
                clock(ctx.state).monospacedDigit().frame(maxWidth: 52)
            } minimal: {
                Image(systemName: ctx.attributes.kind == "block" ? "target" : "timer").foregroundStyle(.tint)
            }
            .widgetURL(URL(string: "everythingapp://today"))
        }
    }

    @ViewBuilder private func clock(_ s: EAActivityAttributes.ContentState) -> some View {
        if let end = s.end, end > Date() {
            Text(timerInterval: Date()...end, countsDown: true)
        } else {
            Text(s.start, style: .timer)
        }
    }
}
#endif

@main
struct EverythingAppWidgets: WidgetBundle {
    var body: some Widget {
        NowWidget()
        #if os(iOS)
        CaptureControl()
        LogControl()
        EALiveActivity()
        #endif
    }
}

extension View {
    /// Titles are the person's own words: redacted while the device is locked (lock screen, StandBy) unless they turned
    /// on Settings, Privacy on this device, Show titles on the lock screen.
    func lockScreenPrivate() -> some View { privacySensitive(!SharedConfig.shared.lockScreenTitles) }
}
