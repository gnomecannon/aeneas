import SwiftUI
import Combine
import EACore

/// Today: digest lines, the Now card, a time-ordered timeline with a current-time marker,
/// renewals due soon, and free slots that take a task with one tap. Swiping left and right moves to the next and
/// previous day, as in a calendar app: another day shows its plan (timeline, renewals due, free slots), and Today
/// brings it back.
struct TodayView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var engine: SyncEngine
    /// Days from today being shown; 0 is today.
    @State private var dayOffset = 0
    @State private var otherDay: PlannerDay?
    @State private var otherFromHub = false
    @State private var today: PlannerToday?
    @State private var fromHub = false
    @State private var scheduling: FreeSlot?
    @State private var reloadTask: Task<Void, Never>?

    var body: some View {
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
                    digest(t)
                    NowCard()
                    peopleSection(t)
                    // Meds are Health logs, follow-ups are job applications, renewals their own module: each shows only while on.
                    if model.isOn(.health) { medsSection(TodayExtras.regularMeds(engine.logs(type: .med, days: 9))) }
                    if model.isOn(.jobs) { followUpsSection(TodayExtras.followUpsDue(engine.list(.application))) }
                    TimelineList(blocks: t.blocks, commitments: t.commitments, events: engine.localDay(Date()).events, reminders: t.reminders_due, freeSlots: t.free_slots, day: Date(), onSchedule: { scheduling = $0 })
                    if model.isOn(.renewals) { watchesSection(t.watches_due_soon) }
                    diarySection()
                    if !fromHub {
                        Text("Planned on this device. The hub's plan replaces it when it is reachable.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                } else {
                    ProgressView().frame(maxWidth: .infinity).padding()
                }
            }
            .padding()
        }
        .navigationTitle(shownDate.formatted(.dateTime.weekday(.wide).day().month(.wide)))
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
            if !d.watches_due.isEmpty, model.isOn(.renewals) {
                Text("Renewals due").font(.headline).foregroundStyle(.secondary)
                ForEach(d.watches_due) { Text(StyleGuard.dashes($0.str("title"))) }
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

    /// The digest without its "Now" sentence, bare date and People line: the Now card, the title and the People
    /// section already show those (the People line is for the morning notification).
    static func digestBody(_ digest: String) -> [String] {
        digest.split(separator: "\n").map(String.init)
            .map { $0.replacingOccurrences(of: #"\s*(Now: [^.]*(\.|$)|Nothing queued\.?)"#, with: "", options: .regularExpression).trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !$0.hasPrefix("People:") && $0.range(of: #"^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2}\.?$"#, options: .regularExpression) == nil }
    }

    @ViewBuilder
    private func digest(_ t: PlannerToday) -> some View {
        let lines = Self.digestBody(StyleGuard.dashes(t.digest))
        if !lines.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                    Text(line).font(.body).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .background(Color.accentColor.opacity(0.10), in: RoundedRectangle(cornerRadius: 14))
        }
    }

    /// People today: who today's plans name, with what the owner told the app about them, then birthdays,
    /// anniversaries and other dates from their cards in the next two weeks. Each opens the person.
    @ViewBuilder
    private func peopleSection(_ t: PlannerToday) -> some View {
        let people = engine.list(.person)
        let plans = TodayExtras.plansToday(events: engine.localDay(Date()).events, reminders: t.reminders_due,
                                           tasks: engine.list(.task).filter { $0.str("status") == "doing" || !$0.str("due").isEmpty })
        let seeing = people.isEmpty ? [] : TodayExtras.peopleInPlans(people: people, facts: engine.list(.fact), plans: plans)
        let dates = TodayExtras.datesSoon(people)
        if !seeing.isEmpty || !dates.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Text("People").font(.headline).foregroundStyle(.secondary)
                ForEach(seeing) { p in
                    Button { model.open(itemId: p.id) } label: {
                        VStack(alignment: .leading, spacing: 3) {
                            HStack(alignment: .firstTextBaseline, spacing: 6) {
                                Text(p.name).font(.body.bold())
                                Text(StyleGuard.dashes(p.plans.map { $0.title + ($0.at.map { ", " + $0.formatted(date: .omitted, time: .shortened) } ?? "") }.joined(separator: "; ")))
                                    .font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                            }
                            ForEach(p.notes, id: \.self) { n in
                                Text(StyleGuard.dashes(n)).font(.subheadline).lineLimit(2)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(12)
                        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
                    }
                    .buttonStyle(.plain)
                }
                if !dates.isEmpty {
                    FlowLayout(spacing: 8) {
                        ForEach(Array(dates.prefix(5).enumerated()), id: \.offset) { _, d in
                            Button { model.open(itemId: d.id) } label: {
                                Label(TodayExtras.phrase(d), systemImage: d.label == "birthday" ? (d.days == 0 ? "gift.fill" : "gift") : d.label == "anniversary" ? "heart" : "calendar")
                            }
                            .buttonStyle(.bordered)
                        }
                    }
                }
            }
        }
    }

    /// Meds taken on two or more days this past week: one tap logs one as taken now; taken ones show the time.
    @ViewBuilder
    private func medsSection(_ meds: [TodayExtras.Med]) -> some View {
        if !meds.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("Meds").font(.headline).foregroundStyle(.secondary)
                FlowLayout(spacing: 8) {
                    ForEach(meds, id: \.name) { m in
                        if let at = m.takenAt {
                            Label("\(m.name) \(at.formatted(date: .omitted, time: .shortened))", systemImage: "checkmark.circle.fill")
                                .font(.subheadline).foregroundStyle(.secondary)
                                .padding(.horizontal, 10).padding(.vertical, 6)
                                .background(Color.secondary.opacity(0.08), in: Capsule())
                        } else {
                            Button {
                                Task { _ = await engine.log(type: .med, value: .string(m.name)) }
                            } label: { Label("Took \(m.name)", systemImage: "pills") }
                            .buttonStyle(.bordered)
                        }
                    }
                }
            }
        }
    }

    /// Job applications with a next step due today or earlier.
    @ViewBuilder
    private func followUpsSection(_ apps: [Entity]) -> some View {
        if !apps.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("Follow up").font(.headline).foregroundStyle(.secondary)
                    Spacer()
                    Button("All") { model.section = .career }.buttonStyle(.borderless)
                }
                ForEach(apps.prefix(3)) { a in
                    Button { model.open(itemId: a.id) } label: {
                        HStack {
                            Text(StyleGuard.dashes(a.str("company") + (a.str("next_step").isEmpty ? "" : ": " + a.str("next_step")))).lineLimit(1)
                            Spacer()
                            if let d = a.date("next_at") {
                                Text(d < Date() && !Calendar.current.isDateInToday(d) ? "late" : d.formatted(date: .omitted, time: .shortened))
                                    .font(.subheadline).foregroundStyle(d < Date() ? .red : .secondary)
                            }
                        }
                        .padding(10)
                        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    /// Today's diary note (every capture, timestamped) and its lines, oldest first.
    /// Before 4 AM it is still the day before, as on the hub: late night captures go to that day's note.
    static func diary(_ notes: [Entity], now: Date = Date()) -> (note: Entity, lines: [(time: String, text: String)])? {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        let day = Calendar.current.component(.hour, from: now) < 4 ? Calendar.current.date(byAdding: .day, value: -1, to: now) ?? now : now
        let path = "Diary/\(f.string(from: day)).md".lowercased()
        guard let n = notes.first(where: { $0.str("path").lowercased() == path && !$0.isDeleted }) else { return nil }
        let lines = n.str("body").split(separator: "\n").compactMap { raw -> (String, String)? in
            let l = raw.trimmingCharacters(in: .whitespaces)
            guard l.hasPrefix("- "), l.count > 8 else { return nil }
            let rest = l.dropFirst(2)
            let time = String(rest.prefix(5))
            guard time.range(of: #"^\d{2}:\d{2}$"#, options: .regularExpression) != nil else { return nil }
            return (time, String(rest.dropFirst(6)))
        }
        return (n, lines)
    }

    /// "Today so far": what the owner captured today, the latest few, with the whole day one tap away.
    @ViewBuilder
    private func diarySection() -> some View {
        if let d = Self.diary(engine.list(.note)), !d.lines.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("Today so far").font(.headline).foregroundStyle(.secondary)
                    Spacer()
                    Button(d.lines.count > 6 ? "All \(d.lines.count)" : "Open") { model.open(itemId: d.note.id) }.buttonStyle(.borderless)
                }
                ForEach(Array(d.lines.suffix(6).enumerated()), id: \.offset) { _, l in
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Text(Self.clock(l.time)).font(.subheadline.monospacedDigit()).foregroundStyle(.secondary)
                        Text(StyleGuard.dashes(l.text)).lineLimit(2)
                    }
                }
            }
            .padding(12)
            .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
        }
    }

    /// "17:05" in the device's clock style.
    static func clock(_ hhmm: String) -> String {
        let p = hhmm.split(separator: ":").compactMap { Int($0) }
        guard p.count == 2, let d = Calendar.current.date(bySettingHour: p[0], minute: p[1], second: 0, of: Date()) else { return hhmm }
        return d.formatted(date: .omitted, time: .shortened)
    }

    @ViewBuilder
    private func watchesSection(_ watches: [Entity]) -> some View {
        if !watches.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("Renewals due soon").font(.headline).foregroundStyle(.secondary)
                    Spacer()
                    Button("All") { model.section = .renewals }.buttonStyle(.borderless)
                }
                ForEach(watches.prefix(5)) { w in
                    HStack {
                        Text(StyleGuard.dashes(w.str("title"))).lineLimit(1)
                        Spacer()
                        // Autopay renews by itself: shown, not urgent.
                        if w.bool("autopay") == true {
                            Text("Autopay, \(daysLeftLabel(w.date("due")))").font(.subheadline).foregroundStyle(.secondary)
                        } else {
                            Text(daysLeftLabel(w.date("due"))).font(.subheadline).foregroundStyle(daysLeftColor(w.date("due")))
                        }
                    }
                    .padding(10)
                    .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
                }
            }
        }
    }
}

/// Compact Now card used on Today. Done, Skip, and Start block when it is not running.
struct NowCard: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var engine: SyncEngine

    var body: some View {
        if let task = engine.nowTask {
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
                HStack(spacing: 8) {
                    Button { Task { await engine.markDone(task.id) } } label: { Label("Done", systemImage: "checkmark").frame(maxWidth: .infinity) }
                        .buttonStyle(.borderedProminent)
                    Button { Task { await engine.skip(task.id) } } label: { Label("Skip", systemImage: "forward").frame(maxWidth: .infinity) }
                        .buttonStyle(.bordered)
                    if f?.status != .doing {
                        Button { Task { await engine.startBlock(task.id, hours: 3) } } label: { Label("Start 3 h", systemImage: "timer").frame(maxWidth: .infinity) }
                            .buttonStyle(.bordered)
                    }
                }
                .controlSize(.large)
            }
            .padding(16)
            .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 16))
        } else {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Nothing is next").font(.title3.weight(.semibold))
                    Text("Capture something, or move a task to Next.").font(.subheadline).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Capture") { model.section = .capture }.buttonStyle(.borderedProminent)
            }
            .padding(16)
            .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 16))
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
    var blocks: [PlannerBlock]
    var commitments: [PlannerCommitment]
    var events: [Entity] = []
    var reminders: [Entity]
    var freeSlots: [FreeSlot]
    var day: Date
    var onSchedule: (FreeSlot) -> Void

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
                Circle().fill(Color.red).frame(width: 10, height: 10)
                Rectangle().fill(Color.red).frame(height: 2)
                Text(d.shortTime).font(.caption.weight(.semibold)).foregroundStyle(.red)
            }
            .accessibilityLabel("Now, \(d.shortTime)")
        case .block(let b):
            let past = (ISO.date(b.end) ?? .distantFuture) < now
            timelineRow(time: timeRange(b.start, b.end), title: b.title, subtitle: b.status == .doing ? "Doing" : "Block", color: .accentColor, dim: past) {
                Button("Unschedule") { Task { await engine.unschedule(taskId: b.task_id) } }
                if b.status != .doing { Button("Make Now") { Task { await engine.makeNow(b.task_id) } } }
                Button("Done") { Task { await engine.markDone(b.task_id) } }
            }
        case .commitment(let c):
            timelineRow(time: timeRange(c.start, c.end), title: c.title, subtitle: c.type.rawValue.capitalized, color: c.type == .blackout ? .gray : (c.type == .preference ? .green : .secondary), dim: (ISO.date(c.end) ?? .distantFuture) < now) { EmptyView() }
        case .event(let e):
            timelineRow(time: (e.bool("all_day") ?? false) ? "All day" : timeRange(e.str("start"), e.str("end")), title: e.str("title"), subtitle: "Event", color: .purple, dim: (e.date("end") ?? .distantFuture) < now, chip: e.space == .work ? "Work" : nil) {
                // Work events come from the work calendar and go back on its next import.
                if e.space != .work || EventMirror.mirrors(e) { Button("Delete", role: .destructive) { Task { await engine.softDelete(e.id) } } }
            }
        case .reminder(let r, let d):
            timelineRow(time: d.shortTime, title: r.str("title"), subtitle: "Reminder", color: .orange, dim: d < now) {
                Button("Got it") { Task { await engine.ack(r.id) } }
            }
        case .free(let f):
            HStack(spacing: 12) {
                Text(timeRange(f.start, f.end)).font(.caption.monospacedDigit()).foregroundStyle(.secondary).frame(width: 96, alignment: .leading)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Free, \(f.hours.formatted()) h").font(.body.weight(.medium))
                }
                Spacer()
                Button { onSchedule(f) } label: { Label("Schedule here", systemImage: "plus") }
                    .buttonStyle(.bordered)
            }
            .padding(10)
            .background(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.secondary.opacity(0.3), style: StrokeStyle(lineWidth: 1, dash: [5, 4])))
        }
    }

    @ViewBuilder
    private func timelineRow<M: View>(time: String, title: String, subtitle: String, color: Color, dim: Bool, chip: String? = nil, @ViewBuilder menu: () -> M) -> some View {
        HStack(spacing: 12) {
            Text(time).font(.caption.monospacedDigit()).foregroundStyle(.secondary).frame(width: 96, alignment: .leading)
            RoundedRectangle(cornerRadius: 2).fill(color).frame(width: 4)
            VStack(alignment: .leading, spacing: 2) {
                Text(StyleGuard.dashes(title)).font(.body.weight(.medium)).lineLimit(2)
                HStack(spacing: 6) {
                    if let chip = chip { SpaceChip(text: chip) }
                    Text(subtitle).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
        }
        .padding(10)
        .background(color.opacity(0.10), in: RoundedRectangle(cornerRadius: 10))
        .opacity(dim ? 0.55 : 1)
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

func daysLeftColor(_ due: Date?) -> Color {
    guard let d = due else { return .secondary }
    let days = Calendar.current.dateComponents([.day], from: Calendar.current.startOfDay(for: Date()), to: Calendar.current.startOfDay(for: d)).day ?? 0
    if days < 0 { return .red }
    if days <= 7 { return .orange }
    return .secondary
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
                    if let e = error { Text(e).font(.caption).foregroundStyle(.red) }
                }
                SwiftUI.Section("Next tasks") {
                    if candidates.isEmpty { Text("No tasks in Next").foregroundStyle(.secondary) }
                    ForEach(candidates) { t in
                        Button { schedule(t.id, force: false) } label: {
                            HStack {
                                Text(StyleGuard.dashes(t.str("title"))).font(.title3)
                                Spacer()
                                if busy && pendingTask == t.id { ProgressView() } else { Image(systemName: "plus.circle").foregroundStyle(Color.accentColor) }
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
