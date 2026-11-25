import SwiftUI
import Combine
import EACore

/// Today: the day as a status board (`TodayBoardView`): what is on now, what needs you, the schedule, things to do,
/// today so far and what is coming. Swiping left and right moves to the next and previous day, as in a calendar app:
/// another day shows its plan (timeline, renewals to make, never a charge on autopay, free slots that take a task
/// with one tap), and Today brings it back.
struct TodayView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var engine: SyncEngine
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.dynamicTypeSize) private var typeSize
    #endif
    /// Days from today being shown; 0 is today.
    @State private var dayOffset = 0
    @State private var otherDay: PlannerDay?
    @State private var otherFromHub = false
    @State private var today: PlannerToday?
    @State private var fromHub = false
    @State private var scheduling: FreeSlot?
    @State private var reloadTask: Task<Void, Never>?

    /// The day as the title: "Wednesday, November 25", and on an iPhone "Wednesday, Nov 25", since the large title
    /// does not shrink and the long month was cut to "Wednesday, Novembe..." there; at the accessibility text sizes
    /// "Wed, Nov 25", where even that was cut to "Wednesday,...".
    private var title: String {
        #if os(iOS)
        if sizeClass == .compact {
            let weekday: Date.FormatStyle.Symbol.Weekday = typeSize.isAccessibilitySize ? .abbreviated : .wide
            return shownDate.formatted(.dateTime.weekday(weekday).day().month(.abbreviated))
        }
        #endif
        return shownDate.formatted(.dateTime.weekday(.wide).day().month(.wide))
    }

    var body: some View {
        ScrollViewReader { proxy in
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                StatusBanner()
                SampleBanner()
                #if os(iOS)
                WorkCalendarBanner()
                #endif
                if dayOffset != 0 {
                    otherDayView
                } else if let t = today {
                    TodayBoardView(today: t, fromHub: fromHub, onSchedule: { scheduling = $0 })
                } else {
                    ProgressView().frame(maxWidth: .infinity).padding()
                }
            }
            .padding()
        }
        .task(id: today != nil) {
            #if DEBUG
            // `-EAScrollTo timeline` (DebugHooks): that card at the top, for screenshots: tech, needs, timeline (the
            // Schedule), todo, sofar or coming.
            guard today != nil, let card = UserDefaults.standard.string(forKey: "EAScrollTo"), ["tech", "needs", "timeline", "todo", "sofar", "coming"].contains(card) else { return }
            try? await Task.sleep(nanoseconds: 800_000_000)
            proxy.scrollTo(card, anchor: .top)
            #endif
        }
        }
        .navigationTitle(title)
        .toolbar {
            if dayOffset != 0 {
                ToolbarItem(placement: .navigation) { Button("Today") { show(0) } }
            }
            #if os(macOS)
            ToolbarItemGroup(placement: .primaryAction) {
                Button { show(dayOffset - 1) } label: { Label("Previous day", systemImage: "chevron.left") }
                Button { show(dayOffset + 1) } label: { Label("Next day", systemImage: "chevron.right") }
            }
            #endif
            ToolbarItem(placement: .primaryAction) {
                NavigationLink(value: Section.week) { Label("Week", systemImage: "calendar") }
            }
        }
        #if os(iOS)
        // Left for the next day, right for the previous one. A drag that starts at the screen's edge is left to the system.
        .simultaneousGesture(DragGesture(minimumDistance: 30).onEnded { v in
            let dx = v.translation.width, dy = v.translation.height
            guard abs(dx) > 60, abs(dx) > abs(dy) * 1.5, v.startLocation.x > 30 else { return }
            show(dayOffset + (dx < 0 ? 1 : -1))
        })
        #endif
        .sheet(item: $scheduling) { slot in SchedulePicker(slot: slot, next: today?.next ?? engine.upNext) { await reload() } }
        .task { await reload() }
        .refreshable { await engine.sync(); await reload() }
        // Only changes to what Today shows reload it. Reacting to every change looped: a reload saves what it
        // fetched, which was itself a change.
        .onReceive(engine.$entities.map(Self.signature).removeDuplicates()) { _ in scheduleReload() }
    }

    /// What Today depends on: tasks, reminders, renewals, events and plan rules, by id and last update.
    static func signature(_ all: [String: Entity]) -> Int {
        let kinds: Set<Kind> = [.task, .reminder, .watch, .event, .plan_rule]
        // Summed, so the dictionary's order does not matter.
        var sum = 0
        for e in all.values where kinds.contains(e.kind) {
            var h = Hasher()
            h.combine(e.id); h.combine(e.updated_at); h.combine(e.deleted_at)
            sum &+= h.finalize()
        }
        return sum
    }

    private func reload() async {
        let r = await engine.loadToday()
        today = r.today
        fromHub = r.fromHub
        if dayOffset != 0 { await loadOtherDay() }
    }

    private var shownDate: Date {
        Calendar.current.date(byAdding: .day, value: dayOffset, to: Calendar.current.startOfDay(for: Date())) ?? Date()
    }

    private func show(_ offset: Int) {
        withAnimation(.easeInOut(duration: 0.2)) { dayOffset = offset }
        otherDay = nil
        Task { await loadOtherDay() }
    }

    /// Another day's plan, from the week it falls in.
    private func loadOtherDay() async {
        guard dayOffset != 0 else { otherDay = nil; return }
        let d = shownDate
        let r = await engine.loadWeek(start: LocalPlanner.monday(of: d))
        guard LocalPlanner.dateString(d) == LocalPlanner.dateString(shownDate) else { return }
        otherDay = r.week.days.first { $0.date == LocalPlanner.dateString(d) }
        otherFromHub = r.fromHub
    }

    @ViewBuilder private var otherDayView: some View {
        if let d = otherDay {
            TimelineList(blocks: d.blocks, commitments: d.commitments, events: d.events, reminders: d.reminders, freeSlots: d.free_slots, day: shownDate, onSchedule: { scheduling = $0 })
            let due = model.isOn(.renewals) ? TodayBoard.toRenew(d.watches_due) : []
            if !due.isEmpty {
                Text("Renewals due").font(.headline).foregroundStyle(.secondary)
                ForEach(due) { Text(StyleGuard.dashes($0.str("title"))) }
            }
            if !otherFromHub { Text("Planned on this device.").font(.caption).foregroundStyle(.secondary) }
        } else {
            ProgressView().frame(maxWidth: .infinity).padding()
        }
    }

    /// Local edits arrive one patch at a time; coalesce them into one reload.
    private func scheduleReload() {
        reloadTask?.cancel()
        reloadTask = Task {
            try? await Task.sleep(nanoseconds: 300_000_000)
            if !Task.isCancelled { await reload() }
        }
    }
}

/// The task being done (or the first one in Next) as a compact card on Today: Done, Skip, and Start block when it is
/// not running. Nothing when no task is doing or next: Today's To do lists the open tasks itself. `inCard` is the
/// card inside To do, a little tighter.
struct NowCard: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var engine: SyncEngine
    var inCard = false
    /// Today's To do passes the lists chosen for it: the task shown is the one being done, or the next one, among those.
    var match: TaskListMatch? = nil

    var body: some View {
        if let task = match.map({ m in engine.nowTask(where: { m.contains($0) }) }) ?? engine.nowTask {
            let f = task.decoded(TaskFields.self)
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text(f?.status == .doing ? "Doing" : "Now").font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                    Spacer()
                    if let b = f?.block, let end = ISO.date(b.end) {
                        TimelineView(.periodic(from: .now, by: 60)) { ctx in
                            Text(end > ctx.date ? "Block ends \(end.shortTime)" : "Block ended \(end.shortTime)").font(.subheadline).foregroundStyle(.secondary)
                        }
                    }
                }
                Button { model.section = .now } label: {
                    Text(StyleGuard.dashes(task.str("title")))
                        .font(.title2.weight(.bold))
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.plain)
                // With their symbols where they fit on one line each; words alone on a narrow card, where "Start 3 h"
                // with its symbol broke in two; one above the other where even the words do not fit side by side (the
                // largest text sizes), where the row of three was wider than the card and pushed all of Today past
                // the screen's edge, so it scrolled sideways.
                ViewThatFits(in: .horizontal) {
                    buttons(task, starts: f?.status != .doing, symbols: true)
                    buttons(task, starts: f?.status != .doing, symbols: false)
                    buttons(task, starts: f?.status != .doing, symbols: false, stacked: true)
                }
                .controlSize(inCard ? .regular : .large)
            }
            .padding(inCard ? 12 : 16)
            .background(Color.secondary.opacity(inCard ? 0.10 : 0.08), in: RoundedRectangle(cornerRadius: inCard ? 12 : 16))
        }
    }

    /// Done, Skip and, for a task not started, Start 3 h: three buttons of one width, each on one line. Stacked, they
    /// are one under the other, each the card's width, and their words may wrap.
    private func buttons(_ task: Entity, starts: Bool, symbols: Bool, stacked: Bool = false) -> some View {
        func label(_ title: String, _ symbol: String) -> some View {
            Group {
                if symbols { Label(title, systemImage: symbol) } else { Text(title) }
            }
            .lineLimit(stacked ? nil : 1)
            .fixedSize(horizontal: !stacked, vertical: true)
            .frame(maxWidth: .infinity)
        }
        let layout = stacked ? AnyLayout(VStackLayout(spacing: 8)) : AnyLayout(HStackLayout(spacing: 8))
        return layout {
            Button { Task { await engine.markDone(task.id) } } label: { label("Done", "checkmark") }
                .buttonStyle(.themedProminent)
            Button { Task { await engine.skip(task.id) } } label: { label("Skip", "forward") }
                .buttonStyle(.bordered)
            if starts {
                Button { Task { await engine.startBlock(task.id, hours: 3) } } label: { label("Start 3 h", "timer") }
                    .buttonStyle(.bordered)
            }
        }
    }
}

/// One item on a day's timeline.
enum TimelineItem: Identifiable {
    case block(PlannerBlock)
    case commitment(PlannerCommitment)
    case event(Entity)
    case reminder(Entity, Date)
    case free(FreeSlot)
    case now(Date)

    var id: String {
        switch self {
        case .block(let b): return "b|" + b.id
        case .commitment(let c): return "c|" + c.id
        case .event(let e): return "e|" + e.id
        case .reminder(let r, _): return "r|" + r.id
        case .free(let f): return "f|" + f.id
        case .now: return "now"
        }
    }

    var start: Date {
        switch self {
        case .block(let b): return ISO.date(b.start) ?? .distantPast
        case .commitment(let c): return ISO.date(c.start) ?? .distantPast
        case .event(let e): return e.date("start") ?? .distantPast
        case .reminder(_, let d): return d
        case .free(let f): return ISO.date(f.start) ?? .distantPast
        case .now(let d): return d
        }
    }

    static func build(blocks: [PlannerBlock], commitments: [PlannerCommitment], events: [Entity] = [], reminders: [Entity], freeSlots: [FreeSlot], now: Date?) -> [TimelineItem] {
        var items: [TimelineItem] = blocks.map { .block($0) } + commitments.map { .commitment($0) } + events.map { .event($0) } + freeSlots.map { .free($0) }
        for r in reminders {
            guard let d = r.alertDate else { continue }
            items.append(.reminder(r, d))
        }
        if let n = now { items.append(.now(n)) }
        // The marker sorts after everything that started at or before now.
        return items.sorted { a, b in
            if a.start != b.start { return a.start < b.start }
            if case .now = a { return false }
            if case .now = b { return true }
            return a.id < b.id
        }
    }
}

/// A day's blocks, commitments, reminders and free slots in time order, with the current-time marker on today.
struct TimelineList: View {
    @EnvironmentObject var engine: SyncEngine
    /// Calendar colors, so a color chosen in Theme redraws the day at once.
    @ObservedObject private var feel = FeelController.shared
    var blocks: [PlannerBlock]
    var commitments: [PlannerCommitment]
    var events: [Entity] = []
    var reminders: [Entity]
    var freeSlots: [FreeSlot]
    var day: Date
    /// How wide the column of times is: 96 points fits a phone, where a time with both ends takes two lines; a wider
    /// list gives it 132, so every time is one line.
    var timeWidth: CGFloat = 96
    var onSchedule: (FreeSlot) -> Void
    @Environment(\.dynamicTypeSize) private var typeSize

    /// At the largest text sizes the time goes over the words instead of in a column beside them: the column of 96
    /// points held only a few letters of each time, and squeezed the words beside it.
    private var stacked: Bool { typeSize.isAccessibilitySize }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { ctx in
            let isToday = Calendar.current.isDate(day, inSameDayAs: ctx.date)
            let items = TimelineItem.build(blocks: blocks, commitments: commitments, events: events, reminders: reminders, freeSlots: freeSlots, now: isToday ? ctx.date : nil)
            VStack(alignment: .leading, spacing: 8) {
                if items.filter({ if case .now = $0 { return false }; return true }).isEmpty {
                    Text("Nothing planned").font(.headline).foregroundStyle(.secondary).padding(.vertical, 8)
                }
                ForEach(items) { item in row(item, now: ctx.date) }
            }
        }
    }

    @ViewBuilder
    private func row(_ item: TimelineItem, now: Date) -> some View {
        switch item {
        case .now(let d):
            HStack(spacing: 8) {
                Circle().fill(.danger).frame(width: 10, height: 10)
                Rectangle().fill(.danger).frame(height: 2)
                Text(d.shortTime).font(.caption.weight(.semibold)).foregroundStyle(.dangerText)
            }
            .accessibilityLabel("Now, \(d.shortTime)")
        case .block(let b):
            let past = (ISO.date(b.end) ?? .distantFuture) < now
            // A block under way is marked as fine, as on the web; the others in the theme's accent.
            timelineRow(time: timeRange(b.start, b.end), title: b.title, subtitle: b.status == .doing ? "Doing" : "Block",
                        color: b.status == .doing ? AnyShapeStyle(.ok) : AnyShapeStyle(.tint), dim: past) {
                Button("Unschedule") { Task { await engine.unschedule(taskId: b.task_id) } }
                if b.status != .doing { Button("Make Now") { Task { await engine.makeNow(b.task_id) } } }
                Button("Done") { Task { await engine.markDone(b.task_id) } }
            }
        case .commitment(let c):
            // A rule for the whole day (a custody week) read "12:00 AM to 12:00 AM".
            timelineRow(time: TodayBoard.wholeDay(c) ? "All day" : timeRange(c.start, c.end), title: c.title, subtitle: c.type.rawValue.capitalized, color: AnyShapeStyle(c.type == .blackout ? Color.gray : (c.type == .preference ? Color.green : Color.secondary)), dim: (ISO.date(c.end) ?? .distantFuture) < now) { EmptyView() }
        case .event(let e):
            // In its calendar's color (Theme, Calendar colors), else the theme's accent: a tint under the words and a
            // solid bar, so the words read on any theme.
            timelineRow(time: (e.bool("all_day") ?? false) ? "All day" : timeRange(e.str("start"), e.str("end")), title: e.str("title"), subtitle: "Event",
                        color: EventColor.style(e, calendars: feel.settings.calendars), dim: (e.date("end") ?? .distantFuture) < now, chip: e.space == .work ? "Work" : nil) {
                // Work events come from the work calendar and go back on its next import.
                if e.space != .work || EventMirror.mirrors(e) { Button("Delete", role: .destructive) { Task { await engine.softDelete(e.id) } } }
            }
        case .reminder(let r, let d):
            timelineRow(time: d.shortTime, title: r.str("title"), subtitle: "Reminder", color: AnyShapeStyle(.warn), dim: d < now) {
                Button("Done") { Task { await engine.ack(r.id) } }
            }
        case .free(let f):
            let time = Text(timeRange(f.start, f.end)).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            let free = Text("Free, \(f.hours.formatted()) h").font(.body.weight(.medium))
            let schedule = Button { onSchedule(f) } label: { Label("Schedule here", systemImage: "plus") }
                .buttonStyle(.bordered)
            // On a narrow phone the button goes under the words: squeezed beside them, "Schedule" broke in two. Where
            // that is still too wide (the largest text sizes) the time, the words and the button each take a line and
            // the button's words wrap: held to one line, it was wider than the screen and Today and Week scrolled
            // sideways.
            ViewThatFits(in: .horizontal) {
                if !stacked {
                    HStack(spacing: 12) { time.frame(width: timeWidth, alignment: .leading); free; Spacer(); schedule.fixedSize() }
                    HStack(spacing: 12) {
                        time.frame(width: timeWidth, alignment: .leading)
                        VStack(alignment: .leading, spacing: 6) { free; schedule.fixedSize() }
                        Spacer(minLength: 0)
                    }
                }
                VStack(alignment: .leading, spacing: 6) { time; free; schedule }
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(10)
            .background(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.secondary.opacity(0.3), style: StrokeStyle(lineWidth: 1, dash: [5, 4])))
        }
    }

    @ViewBuilder
    private func timelineRow<M: View>(time: String, title: String, subtitle: String, color: AnyShapeStyle, dim: Bool, chip: String? = nil, @ViewBuilder menu: () -> M) -> some View {
        // Something already over is quieter: its color fades and its title takes the secondary color. The words are
        // not faded further: a whole row at 55% left its gray time and subtitle at about 2.5:1 on every theme.
        let timeText = Text(time).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
        HStack(spacing: 12) {
            if !stacked { timeText.frame(width: timeWidth, alignment: .leading) }
            RoundedRectangle(cornerRadius: 2).fill(color).frame(width: 4).opacity(dim ? 0.5 : 1)
            VStack(alignment: .leading, spacing: 2) {
                if stacked { timeText }
                Text(StyleGuard.dashes(title)).font(.body.weight(.medium)).lineLimit(stacked ? 4 : 2)
                    .foregroundStyle(dim ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
                HStack(spacing: 6) {
                    if let chip = chip { SpaceChip(text: chip) }
                    Text(subtitle).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
        }
        .padding(10)
        .background(color.opacity(dim ? 0.05 : 0.10), in: RoundedRectangle(cornerRadius: 10))
        .contextMenu { menu() }
    }
}

func timeRange(_ start: String, _ end: String) -> String {
    guard let s = ISO.date(start), let e = ISO.date(end) else { return "" }
    return "\(s.shortTime) to \(e.shortTime)"
}

func daysLeftLabel(_ due: Date?) -> String {
    guard let d = due else { return "" }
    let days = Calendar.current.dateComponents([.day], from: Calendar.current.startOfDay(for: Date()), to: Calendar.current.startOfDay(for: d)).day ?? 0
    if days == 0 { return "Due today" }
    if days < 0 { return "\(-days) day\(days == -1 ? "" : "s") overdue" }
    return "\(days) day\(days == 1 ? "" : "s") left"
}

/// Overdue is a problem, a week or less needs a look; as words in the theme's status colors.
func daysLeftColor(_ due: Date?) -> AnyShapeStyle {
    guard let d = due else { return AnyShapeStyle(.secondary) }
    let days = Calendar.current.dateComponents([.day], from: Calendar.current.startOfDay(for: Date()), to: Calendar.current.startOfDay(for: d)).day ?? 0
    if days < 0 { return AnyShapeStyle(.dangerText) }
    if days <= 7 { return AnyShapeStyle(.warnText) }
    return AnyShapeStyle(.secondary)
}

/// Pick a `next` task for a free slot. One tap schedules a 3 h block from the slot's start.
struct SchedulePicker: View {
    @EnvironmentObject var engine: SyncEngine
    @Environment(\.dismiss) private var dismiss
    var slot: FreeSlot
    var next: [Entity]
    var hours: Double = 3
    var afterSchedule: () async -> Void
    @State private var conflict: PlannerConflict?
    @State private var pendingTask: String?
    @State private var error: String?
    @State private var busy = false

    private var candidates: [Entity] {
        var out = next.filter { $0.str("status") == "next" || $0.str("status") == "inbox" }
        if out.isEmpty { out = engine.tasks(status: .next) + engine.tasks(status: .inbox) }
        if let n = engine.nowTask, n.str("status") == "next", !out.contains(where: { $0.id == n.id }) { out.insert(n, at: 0) }
        return out
    }

    var body: some View {
        NavigationStack {
            List {
                SwiftUI.Section {
                    Text("\(hours.formatted()) h from \(ISO.date(slot.start)?.formatted(date: .abbreviated, time: .shortened) ?? "")").foregroundStyle(.secondary)
                    if let e = error { Text(e).font(.caption).foregroundStyle(.dangerText) }
                }
                SwiftUI.Section("Next tasks") {
                    if candidates.isEmpty { Text("No tasks in Next").foregroundStyle(.secondary) }
                    ForEach(candidates) { t in
                        Button { schedule(t.id, force: false) } label: {
                            HStack {
                                Text(StyleGuard.dashes(t.str("title"))).font(.title3)
                                Spacer()
                                if busy && pendingTask == t.id { ProgressView() } else { Image(systemName: "plus.circle").foregroundStyle(.tint) }
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .disabled(busy)
                    }
                }
            }
            .navigationTitle("Schedule here")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .alert("Already taken", isPresented: Binding(get: { conflict != nil }, set: { if !$0 { conflict = nil } })) {
                Button("Schedule anyway") { if let id = pendingTask { schedule(id, force: true) } }
                Button("Cancel", role: .cancel) { conflict = nil }
            } message: {
                Text(conflict?.summary ?? "")
            }
        }
        #if os(macOS)
        .frame(minWidth: 420, minHeight: 360)
        #else
        .presentationDetents([.medium, .large])
        #endif
    }

    private func schedule(_ id: String, force: Bool) {
        guard let start = ISO.date(slot.start) else { return }
        pendingTask = id
        busy = true
        error = nil
        Task {
            do {
                _ = try await engine.schedule(taskId: id, start: start, hours: hours, force: force)
                await afterSchedule()
                dismiss()
            } catch let h as HubError {
                if let c = h.plannerConflict { conflict = c } else { error = h.errorDescription }
            } catch {
                self.error = error.localizedDescription
            }
            busy = false
        }
    }
}
