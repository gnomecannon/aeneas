import WidgetKit
import SwiftUI
import AppIntents
import EACore
#if canImport(ActivityKit) && os(iOS)
import ActivityKit
#endif

struct NowEntry: TimelineEntry {
    var date: Date
    var title: String?
    var status: String?
    var blockEnd: Date?
    var unprocessed: Int
    var nextBlockTitle: String? = nil
    var nextBlockStart: Date? = nil
    var activity: String? = nil
    var activityStart: Date? = nil
}

struct NowProvider: TimelineProvider {
    private func snapshot() -> NowEntry {
        let c = SharedConfig.shared
        let nextStart = c.nextBlockStart.flatMap { $0 > Date() && Calendar.current.isDateInToday($0) ? $0 : nil }
        return NowEntry(date: Date(), title: c.nowTaskTitle, status: c.nowTaskStatus, blockEnd: c.nowBlockEnd, unprocessed: c.unprocessedCount,
                        nextBlockTitle: nextStart == nil ? nil : c.nextBlockTitle, nextBlockStart: nextStart,
                        activity: c.currentActivity, activityStart: c.currentActivityStart)
    }
    func placeholder(in context: Context) -> NowEntry {
        NowEntry(date: Date(), title: "Order filament", status: "next", blockEnd: nil, unprocessed: 2, nextBlockTitle: "Fix the NAS", nextBlockStart: Date().addingTimeInterval(7200))
    }
    func getSnapshot(in context: Context, completion: @escaping (NowEntry) -> Void) { completion(context.isPreview ? placeholder(in: context) : snapshot()) }
    func getTimeline(in context: Context, completion: @escaping (Timeline<NowEntry>) -> Void) {
        completion(Timeline(entries: [snapshot()], policy: .after(Date().addingTimeInterval(1800))))
    }
}

/// The widget's Done button: marks the Now task done on the hub straight from the widget (the app picks it up on its
/// next sync) and clears the widget at once.
struct WidgetDoneIntent: AppIntent {
    static let title: LocalizedStringResource = "Mark Now Done"
    static let isDiscoverable = false

    func perform() async throws -> some IntentResult {
        let c = SharedConfig.shared
        // The device's own key, read from the Keychain the app shares with its widgets.
        guard let id = c.nowTaskId, !c.deviceId.isEmpty, let client = HubClient.make(config: c) else { return .result() }
        let now = ISO.now()
        _ = try? await client.push(deviceId: c.deviceId, patches: [Patch(id: id, kind: .task, ts: now, fields: ["status": .string("done"), "done_at": .string(now)])])
        c.nowTaskId = nil
        c.nowTaskTitle = nil
        c.nowTaskStatus = nil
        c.nowBlockEnd = nil
        WidgetCenter.shared.reloadAllTimelines()
        return .result()
    }
}

struct NowWidgetView: View {
    @Environment(\.widgetFamily) private var family
    var entry: NowEntry

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
            else { Text(entry.title.map { "Now: \(StyleGuard.dashes($0))" } ?? "Nothing is next").lockScreenPrivate() }
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
                    Text(entry.status == "doing" ? "Doing" : "Now").font(.caption2).foregroundStyle(.secondary)
                    Text(entry.title.map { StyleGuard.dashes($0) } ?? "Nothing is next").font(.headline).lineLimit(2).lockScreenPrivate()
                    if let end = entry.blockEnd, end > entry.date { Text("until \(end.formatted(date: .omitted, time: .shortened))").font(.caption2) }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .widgetURL(URL(string: "everythingapp://now"))
        #endif
        default:
            nowBlock.widgetURL(URL(string: entry.title == nil ? "everythingapp://capture" : "everythingapp://now"))
        }
    }

    private var nowBlock: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(entry.status == "doing" ? "Doing" : "Now").font(.caption).foregroundStyle(.secondary)
                Spacer(minLength: 0)
                if entry.title != nil {
                    Button(intent: WidgetDoneIntent()) { Image(systemName: "checkmark.circle") }
                        .buttonStyle(.plain)
                        .font(.title3)
                        .foregroundStyle(.tint)
                        .accessibilityLabel("Mark done")
                }
            }
            Text(entry.title.map { StyleGuard.dashes($0) } ?? "Nothing is next")
                .font(.headline)
                .lineLimit(3)
                .minimumScaleFactor(0.8)
                .lockScreenPrivate()
            Spacer(minLength: 0)
            if let a = entry.activity, let s = entry.activityStart {
                HStack(spacing: 4) {
                    Image(systemName: "timer").font(.caption2)
                    Text(a).font(.caption2).lineLimit(1).lockScreenPrivate()
                    Text(s, style: .timer).font(.caption2).monospacedDigit()
                }
                .foregroundStyle(.secondary)
            } else if let end = entry.blockEnd, end > entry.date {
                Text("Block ends \(end.formatted(date: .omitted, time: .shortened))").font(.caption2).foregroundStyle(.secondary)
            }
            if family == .systemMedium, let t = entry.nextBlockTitle, let s = entry.nextBlockStart, s > entry.date {
                HStack(spacing: 4) {
                    Image(systemName: "calendar").font(.caption2)
                    Text("Next \(s.formatted(date: .omitted, time: .shortened)): \(StyleGuard.dashes(t))").font(.caption2).lineLimit(1).lockScreenPrivate()
                }
                .foregroundStyle(.secondary)
            } else if family == .systemSmall, entry.unprocessed > 0, entry.activity == nil {
                Text("\(entry.unprocessed) to sort").font(.caption2).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

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
        .configurationDisplayName("Now")
        .description("The task you are on with a Done button, a running activity, and a capture shortcut. Lock Screen sizes too.")
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

/// The Live Activity: a running activity counting up, or the focus block counting down to its end.
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
            .widgetURL(URL(string: "everythingapp://now"))
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
            .widgetURL(URL(string: "everythingapp://now"))
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
