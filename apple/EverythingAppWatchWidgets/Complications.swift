import WidgetKit
import SwiftUI
import EACore

/// One moment of the Now and next complication: the Next line at `date` (CONTRACT.md, Planner, The Next line).
struct NowEntry: TimelineEntry {
    var date: Date
    var line: TodayBoard.LineWords
    var activity: String?
    var activityStart: Date?
}

/// The line at each minute of the next hour, from the plan the iPhone sends (`ComplicationSnapshot.line`) or the Watch
/// app writes on its own sync, so the minutes left count down on the wrist.
struct NowProvider: TimelineProvider {
    private func entry(_ plan: NextLinePlan?, at date: Date) -> NowEntry {
        let c = SharedConfig.shared
        let plan = plan ?? NextLinePlan(day: "", started: nil, spans: [])
        return NowEntry(date: date, line: plan.words(at: date), activity: c.currentActivity, activityStart: c.currentActivityStart)
    }
    func placeholder(in context: Context) -> NowEntry {
        NowEntry(date: Date(), line: TodayBoard.LineWords(label: .next, lead: "Next: ", title: "Dentist", when: "at \(TodayBoard.deviceClock(Date().addingTimeInterval(2760)))", aside: "in 46 min"),
                 activity: nil, activityStart: nil)
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

struct ComplicationView: View {
    @Environment(\.widgetFamily) private var family
    var entry: NowEntry

    private var text: String { StyleGuard.dashes(entry.line.text) }

    var body: some View {
        switch family {
        case .accessoryCorner:
            Image(systemName: "scope").font(.title3.weight(.semibold))
                .widgetLabel { Text(text).watchPrivate() }
                .widgetURL(URL(string: "everythingapp://now"))
        case .accessoryCircular:
            // Tap to start a capture by voice.
            ZStack {
                AccessoryWidgetBackground()
                Image(systemName: "mic.fill").font(.title2)
            }
            .widgetURL(URL(string: "everythingapp://capture"))
        case .accessoryInline:
            Text(entry.activity.map { "\($0): \(text)" } ?? text).watchPrivate()
                .widgetURL(URL(string: "everythingapp://now"))
        default:
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(entry.line.label.rawValue).font(.caption2).foregroundStyle(.secondary)
                    Text(StyleGuard.dashes(entry.line.title)).font(.headline).lineLimit(2).minimumScaleFactor(0.8).watchPrivate()
                    if let a = entry.activity {
                        Text(a).font(.caption2).foregroundStyle(.secondary).watchPrivate()
                    } else if !entry.line.detail.isEmpty {
                        Text(entry.line.detail).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
                Link(destination: URL(string: "everythingapp://capture")!) {
                    Image(systemName: "mic.fill").font(.title3)
                }
            }
            .widgetURL(URL(string: "everythingapp://now"))
        }
    }
}

/// The Now and next complication: the Next line. Its kind is the one the Now complication had, so one placed on a
/// face before 2026-11-25 shows the line in its place.
struct NowComplication: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "com.gnomecannon.everythingapp.watch.now", provider: NowProvider()) { entry in
            ComplicationView(entry: entry).containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Now and next")
        .description("The task you started, else what is on now or next today, and a tap to capture.")
        .supportedFamilies([.accessoryCircular, .accessoryCorner, .accessoryRectangular, .accessoryInline])
    }
}

struct NextUpEntry: TimelineEntry {
    var date: Date
    var title: String?
    var at: Date?
}

/// The next event or open reminder today, saved by the Watch app on every sync.
struct NextUpProvider: TimelineProvider {
    private func snapshot() -> NextUpEntry {
        let c = SharedConfig.shared
        return NextUpEntry(date: Date(), title: c.nextUpTitle, at: c.nextUpAt)
    }
    func placeholder(in context: Context) -> NextUpEntry { NextUpEntry(date: Date(), title: "Vet appointment", at: Date().addingTimeInterval(3600)) }
    func getSnapshot(in context: Context, completion: @escaping (NextUpEntry) -> Void) { completion(context.isPreview ? placeholder(in: context) : snapshot()) }
    func getTimeline(in context: Context, completion: @escaping (Timeline<NextUpEntry>) -> Void) {
        let e = snapshot()
        // Refresh just after it starts, so a passed event does not linger.
        let next = e.at.map { max($0.addingTimeInterval(60), Date().addingTimeInterval(300)) } ?? Date().addingTimeInterval(1800)
        completion(Timeline(entries: [e], policy: .after(min(next, Date().addingTimeInterval(1800)))))
    }
}

struct NextUpView: View {
    @Environment(\.widgetFamily) private var family
    var entry: NextUpEntry

    private var title: String { entry.title.map { StyleGuard.dashes($0) } ?? "Nothing else today" }

    var body: some View {
        switch family {
        case .accessoryInline:
            Text(entry.at.map { "\($0.formatted(date: .omitted, time: .shortened)) \(title)" } ?? title).watchPrivate()
        case .accessoryCorner:
            Image(systemName: "calendar").font(.title3.weight(.semibold))
                .widgetLabel { Text(entry.at.map { "\($0.formatted(date: .omitted, time: .shortened)) \(title)" } ?? title).watchPrivate() }
        case .accessoryCircular:
            ZStack {
                AccessoryWidgetBackground()
                if let at = entry.at {
                    VStack(spacing: 0) {
                        Image(systemName: "calendar").font(.caption2)
                        Text(at, style: .time).font(.system(size: 11, weight: .semibold)).minimumScaleFactor(0.6)
                    }
                } else {
                    Image(systemName: "calendar.badge.checkmark").font(.title3)
                }
            }
        default:
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.at.map { $0.formatted(date: .omitted, time: .shortened) } ?? "Today").font(.caption2).foregroundStyle(.secondary)
                Text(title).font(.headline).lineLimit(2).minimumScaleFactor(0.8).watchPrivate()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct NextUpComplication: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "com.gnomecannon.everythingapp.watch.nextup", provider: NextUpProvider()) { entry in
            NextUpView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
                .widgetURL(URL(string: "everythingapp://today"))
        }
        .configurationDisplayName("Next up")
        .description("Your next event or reminder today.")
        .supportedFamilies([.accessoryCircular, .accessoryCorner, .accessoryRectangular, .accessoryInline])
    }
}

/// A one-tap launcher on the watch face: opens the app straight into that action (Ask and Capture listen at once, Hum
/// starts recording). Round slots, corner slots (Infograph and other corner faces) and inline text.
struct LauncherView: View {
    @Environment(\.widgetFamily) private var family
    var title: String
    var icon: String
    /// Drawn instead of the symbol where a shape can go (Hum Song's note and drum, which SF Symbols lacks). Inline text
    /// takes only a symbol, so `icon` stays for it.
    var glyph: Bool = false

    @ViewBuilder private func symbol(_ size: CGFloat) -> some View {
        if glyph {
            HumSongGlyph().frame(width: size, height: size)
        } else {
            Image(systemName: icon)
        }
    }

    var body: some View {
        switch family {
        case .accessoryCorner:
            symbol(22).font(.title3.weight(.semibold))
                .widgetLabel(title)
        case .accessoryInline:
            Label(title, systemImage: icon)
        default:
            ZStack {
                AccessoryWidgetBackground()
                VStack(spacing: 1) {
                    symbol(20).font(.title3)
                    Text(title).font(.system(size: 10, weight: .semibold)).minimumScaleFactor(0.7).lineLimit(1)
                }
                .padding(.horizontal, 2)
            }
        }
    }
}

private struct LauncherEntry: TimelineEntry { var date: Date }

/// Nothing changes on a launcher: one entry, never refreshed.
private struct LauncherProvider: TimelineProvider {
    func placeholder(in context: Context) -> LauncherEntry { LauncherEntry(date: Date()) }
    func getSnapshot(in context: Context, completion: @escaping (LauncherEntry) -> Void) { completion(LauncherEntry(date: Date())) }
    func getTimeline(in context: Context, completion: @escaping (Timeline<LauncherEntry>) -> Void) {
        completion(Timeline(entries: [LauncherEntry(date: Date())], policy: .never))
    }
}

private func launcher(kind: String, title: String, icon: String, glyph: Bool = false, url: String, name: String, description: String) -> some WidgetConfiguration {
    StaticConfiguration(kind: kind, provider: LauncherProvider()) { _ in
        LauncherView(title: title, icon: icon, glyph: glyph)
            .containerBackground(.fill.tertiary, for: .widget)
            .widgetURL(URL(string: url))
    }
    .configurationDisplayName(name)
    .description(description)
    .supportedFamilies([.accessoryCircular, .accessoryCorner, .accessoryInline])
}

/// One tap to ask the assistant.
struct AskComplication: Widget {
    var body: some WidgetConfiguration {
        launcher(kind: "com.gnomecannon.everythingapp.watch.ask", title: "Ask", icon: "bubble.left.and.text.bubble.right",
                 url: "everythingapp://ask", name: "Ask", description: "Ask the assistant by voice.")
    }
}

/// One tap to capture a thought by voice.
struct CaptureComplication: Widget {
    var body: some WidgetConfiguration {
        launcher(kind: "com.gnomecannon.everythingapp.watch.capture", title: "Capture", icon: "mic.fill",
                 url: "everythingapp://capture", name: "Capture", description: "Say a thought, task or note and it is saved and sorted.")
    }
}

/// One tap to hum, sing, tap or beatbox (Song ideas): the hub hears it as a melody and as a rhythm.
struct HumComplication: Widget {
    var body: some WidgetConfiguration {
        launcher(kind: "com.gnomecannon.everythingapp.watch.hum", title: "Hum Song", icon: "music.note", glyph: true,
                 url: "everythingapp://hum", name: "Hum Song", description: "Hum, sing, tap or beatbox; it goes to Song ideas on your hub.")
    }
}

@main
struct EverythingAppWatchWidgets: WidgetBundle {
    var body: some Widget {
        NowComplication()
        NextUpComplication()
        AskComplication()
        CaptureComplication()
        HumComplication()
    }
}

extension View {
    /// Titles are the person's own words: redacted while the Watch is locked or dimmed (Always On) unless titles on the
    /// lock screen were turned on (`SharedConfig.lockScreenTitles`, off by default).
    func watchPrivate() -> some View { privacySensitive(!SharedConfig.shared.lockScreenTitles) }
}
