import SwiftUI
import EACore

/// Today as a status board, in the order its owner asked every report to take: at the top what is on now and how long
/// it has left; then what needs you (actions only, numbered, each with its buttons), the schedule (what is left),
/// things to do, today so far (what is done and was said), and what is coming that needs nothing from you. One column
/// on an iPhone, up to five across a wide window. The rules are EACore's `TodayBoard`, the same as the web app's.
///
/// The day is drawn once, as the Schedule card's list: a strip of it across the top said the same again
/// (gnomecannon/aeneas#15). Capturing is the Capture tab's, one press away on every screen; a box for it here said
/// that again (gnomecannon/aeneas#21). A charge on autopay pays itself, so Today does not list it (#14).
///
/// The theme's accent is only on what can be pressed to act.
struct TodayBoardView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var engine: SyncEngine
    /// Tech's board, for what needs a look: the same list as the Overview's, so the two never disagree.
    @ObservedObject private var feed = OpsBoardFeed.shared
    @Environment(\.scenePhase) private var scenePhase

    var today: PlannerToday
    var fromHub: Bool
    var onSchedule: (FreeSlot) -> Void

    /// The screen's own width: it decides how many columns there are.
    @State private var width: CGFloat = 0
    @State private var acking: Entity?

    /// How wide one column of cards is at the width the screen has now.
    private var columnWidth: CGFloat {
        let n = CGFloat(TodayBoard.columns(width: Double(width)).count)
        return (width - 16 * (n - 1)) / n
    }

    /// How many open tasks To do lists, and how many lines Today so far shows, before a link to the rest.
    private static let todoShown = 6
    private static let soFarShown = 10

    var body: some View {
        // Every half minute: "46 min left" counts down and a reminder whose time has come joins Needs you.
        TimelineView(.periodic(from: .now, by: 30)) { ctx in
            board(now: ctx.date)
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .sheet(item: $acking) { inc in AckSheet(incident: inc) }
        // Tech's board once a minute while the screen can be seen; a window put away stops asking the hub.
        .task(id: scenePhase.refreshes) {
            guard scenePhase.refreshes, model.isOn(.homelab) else { return }
            while !Task.isCancelled {
                await feed.load(engine, maxAge: 55)
                try? await Task.sleep(for: .seconds(60))
            }
        }
    }

    // MARK: the board

    @ViewBuilder
    private func board(now: Date) -> some View {
        let events = engine.localDay(now).events
        let spans = TodayBoard.spans(blocks: today.blocks, commitments: today.commitments, events: events, reminders: today.reminders_due, freeSlots: today.free_slots)
        VStack(alignment: .leading, spacing: 16) {
            head(spans, now: now)
            HStack(alignment: .top, spacing: 16) {
                ForEach(Array(TodayBoard.columns(width: Double(width)).enumerated()), id: \.offset) { _, column in
                    VStack(alignment: .leading, spacing: 16) {
                        ForEach(column, id: \.self) { section($0, events: events, spans: spans, now: now) }
                    }
                    // As tall as its cards: offered the tallest column's height, the Schedule's rows grew to fill it.
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                }
            }
            if !fromHub {
                Text("Planned on this device. The hub's plan replaces it when it is reachable.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private func section(_ s: TodayBoard.Section, events: [Entity], spans: [TodayBoard.Span], now: Date) -> some View {
        switch s {
        // Each card has a name the screen can be scrolled to (`-EAScrollTo`, TodayView).
        case .needs: needsCard(now: now).id("needs")
        case .schedule: scheduleCard(events: events, spans: spans, now: now).id("timeline")
        case .todo: todoCard().id("todo")
        case .sofar: soFarCard(now: now).id("sofar")
        case .coming: comingCard(now: now).id("coming")
        }
    }

    /// One card of the board: its name, a count beside it, and what it holds.
    private func card<Content: View>(_ title: String, count: String? = nil, waiting: Bool = false, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(title).font(.headline)
                if let count {
                    Text(count)
                        .font(.caption.weight(.semibold)).monospacedDigit()
                        .foregroundStyle(waiting ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
                        .padding(.horizontal, 7).padding(.vertical, 2)
                        .background(Color.secondary.opacity(waiting ? 0.3 : 0.12), in: Capsule())
                }
                Spacer(minLength: 0)
            }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
            content()
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 14))
    }

    /// A small heading inside a card.
    private func sub(_ title: String) -> some View {
        Text(title).font(.caption.weight(.semibold)).foregroundStyle(.secondary).textCase(.uppercase)
    }

    /// Nothing to do here, said with a mark that reads as fine.
    private func clear(_ words: String) -> some View {
        Label(words, systemImage: "checkmark.circle.fill")
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .symbolRenderingMode(.hierarchical)
    }

    // MARK: the top: now, free time, Tech

    @ViewBuilder
    private func head(_ spans: [TodayBoard.Span], now: Date) -> some View {
        let lines = VStack(alignment: .leading, spacing: 4) {
            nowLine(TodayBoard.nowLine(spans, now: now))
            if let free = TodayBoard.freeLine(spans, now: now) {
                Text(free).font(.subheadline).foregroundStyle(.secondary)
            }
        }
        if width >= 680 {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                lines
                Spacer(minLength: 8)
                techLight
            }
        } else {
            VStack(alignment: .leading, spacing: 8) {
                lines
                techLight
            }
        }
    }

    /// The largest words on the screen: what is under way, else what is next, else that the day is clear.
    private func nowLine(_ line: TodayBoard.NowLine) -> some View {
        let words: Text
        switch line {
        case .during(let title, let until, let left, _):
            words = Text(StyleGuard.dashes(title)).fontWeight(.bold) + Text(" until \(until.shortTime)") + Text("   \(left) left").foregroundStyle(.secondary)
        case .next(let title, let at, let wait, _):
            words = Text("Next: ") + Text(StyleGuard.dashes(title)).fontWeight(.bold) + Text(" at \(at.shortTime)") + Text("   in \(wait)").foregroundStyle(.secondary)
        case .clear:
            words = Text("Nothing else is scheduled today.")
        }
        return words
            .font(width >= 680 ? .system(size: 26, weight: .medium) : .title3.weight(.medium))
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityAddTraits(.isHeader)
    }

    private var monitors: [Entity] { engine.list(.monitor) }
    private var sensors: [Entity] { model.isOn(.sensors) ? engine.list(.sensor) : [] }
    private var things: [TechThing] {
        feed.board?.things ?? Tech.localThings(monitors: monitors, sensors: sensors, hosts: Homelab.localHosts(engine).map(\.host))
    }
    /// What Tech says needs a look, by the Overview's own rule.
    private var looks: [TechLook] {
        guard model.isOn(.homelab) else { return [] }
        let open = engine.list(.incident).filter { ($0.string("closed_at") ?? "").isEmpty }
        return Tech.needsALook(things: things, monitors: monitors, incidents: open, sensors: sensors, hubBackup: feed.board?.hub_backup ?? [])
    }

    /// Tech's light, small: green "All good" or what needs a look. It opens the Overview.
    @ViewBuilder
    private var techLight: some View {
        if model.isOn(.homelab), !(things.isEmpty && monitors.isEmpty) {
            let light = Tech.light(looks: looks, things: things, monitors: monitors, sensors: sensors)
            Button { model.section = .ops } label: {
                HStack(spacing: 6) {
                    Circle().fill(light.tone.status.fill(else: .gray)).frame(width: 9, height: 9)
                    Text("Tech: \(light.label)").font(.subheadline.weight(.medium))
                        .foregroundStyle(light.tone.status.text(else: .primary))
                }
                .padding(.horizontal, 10).padding(.vertical, 5)
                .background(Color.secondary.opacity(0.10), in: Capsule())
                .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .help(light.detail)
            .accessibilityHint("Opens the Tech Overview")
        }
    }

    // MARK: needs you

    private func needs(now: Date) -> [TodayBoard.Need] {
        let tasks = engine.list(.task)
        return TodayBoard.needsYou(
            reminders: Mail.dueReminders(tasks, now: now), tasks: tasks, looks: looks,
            watches: model.isOn(.renewals) ? today.watches_due_soon : [],
            followUps: model.isOn(.jobs) ? TodayExtras.followUpsDue(engine.list(.application), now: now) : [],
            meds: model.isOn(.health) ? TodayExtras.regularMeds(engine.logs(type: .med, days: 9), now: now) : [],
            unsorted: engine.unprocessedCaptures.count, now: now)
    }

    private func needsCard(now: Date) -> some View {
        let list = needs(now: now)
        return card("Needs you", count: list.isEmpty ? nil : "\(list.count)", waiting: true) {
            if list.isEmpty {
                clear("Nothing needs you right now.")
            } else {
                ForEach(Array(list.enumerated()), id: \.element.id) { i, need in
                    if i > 0 { Divider() }
                    needRow(i + 1, need)
                }
            }
        }
    }

    /// One thing that waits: its number in the order to take it, what it is, and the buttons that settle it here.
    private func needRow(_ number: Int, _ need: TodayBoard.Need) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text("\(number)")
                .font(.subheadline.weight(.semibold)).monospacedDigit()
                .foregroundStyle(.secondary)
                .frame(minWidth: 18, alignment: .trailing)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(StyleGuard.dashes(need.title)).font(.body.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
                if !need.detail.isEmpty {
                    Text(StyleGuard.dashes(need.detail)).font(.caption)
                        .foregroundStyle(need.late ? AnyShapeStyle(.dangerText) : AnyShapeStyle(.secondary))
                        .lineLimit(3)
                }
                FlowLayout(spacing: 8) { needActions(need) }
                    .controlSize(.small)
                    .padding(.top, 2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(number). \(need.title)")
    }

    @ViewBuilder
    private func needActions(_ need: TodayBoard.Need) -> some View {
        switch need {
        case .reminder(let r, _):
            Button("Done") { Task { await engine.ack(r.id) } }.buttonStyle(.themedProminent)
                .accessibilityLabel("Done: \(r.title)")
            // A reminder that asks why before it is put off is snoozed on its own page, where the reason is typed.
            if r.friction == "none" {
                Button("10 min") { Task { _ = await engine.snooze(r.id, minutes: 10, reason: nil) } }.buttonStyle(.bordered)
                    .accessibilityLabel("Snooze \(r.title) for 10 minutes")
                Button("1 h") { Task { _ = await engine.snooze(r.id, minutes: 60, reason: nil) } }.buttonStyle(.bordered)
                    .accessibilityLabel("Snooze \(r.title) for 1 hour")
            }
            Button("Open") { model.open(itemId: r.id) }.buttonStyle(.borderless)
        case .tech(let look):
            if look.monitorId != nil || look.sensor != nil { ProposeFixButton(monitorId: look.monitorId, sensor: look.sensor) }
            if let inc = look.incident { Button("Acknowledge") { acking = inc }.buttonStyle(.themedProminent) }
            if look.thing.isEmpty {
                Button("Open") { model.section = .ops }.buttonStyle(.borderless)
            } else {
                PageLink("Open") { HostDetailView(host: look.thing) }.buttonStyle(.borderless)
            }
        case .renewal(let w, _, _):
            Button("Renewed") { Task { await engine.renewWatch(w.id) } }.buttonStyle(.themedProminent)
                .accessibilityLabel("Mark \(w.str("title")) renewed")
            Button("Open") { model.open(itemId: w.id) }.buttonStyle(.borderless)
        case .followUp(let a, _, _):
            Button("Open") { model.open(itemId: a.id) }.buttonStyle(.bordered)
        case .med(let name):
            Button("Took \(name)") { Task { _ = await engine.log(type: .med, value: .string(name)) } }.buttonStyle(.themedProminent)
                .help("Log \(name) as taken now")
        case .unsorted:
            Button("Sort them") { model.section = .inbox }.buttonStyle(.bordered)
        }
    }

    // MARK: schedule

    private func scheduleCard(events: [Entity], spans: [TodayBoard.Span], now: Date) -> some View {
        let allDay = events.filter { $0.bool("all_day") == true }
        // A rule for the whole day (a custody week) is named with them: it has no time to stand at in the list.
        let dayRules = today.commitments.filter { TodayBoard.wholeDay($0) }
        let left = spans.filter { (($0.kind == .event && !$0.allDay) || $0.kind == .block || $0.kind == .reminder) && $0.end > now }.count
        let people = engine.list(.person)
        let plans = TodayExtras.plansToday(events: events, reminders: today.reminders_due,
                                           tasks: engine.list(.task).filter { $0.str("status") == "doing" || !$0.str("due").isEmpty }, now: now)
        let seeing = people.isEmpty ? [] : TodayExtras.peopleInPlans(people: people, facts: engine.list(.fact), plans: plans)
        return card("Schedule", count: left > 0 ? "\(left) left" : nil) {
            ForEach(allDay) { e in
                Button { model.open(itemId: e.id) } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("All day").font(.caption).foregroundStyle(.secondary)
                        Text(StyleGuard.dashes(e.str("title"))).multilineTextAlignment(.leading)
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            ForEach(dayRules) { c in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text("All day").font(.caption).foregroundStyle(.secondary)
                    Text(StyleGuard.dashes(c.title)).multilineTextAlignment(.leading)
                    Text(c.type.rawValue.capitalized).font(.caption).foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                }
                .accessibilityElement(children: .combine)
            }
            // All-day plans are named above: the list is what has a time. Free time that has ended is not offered (a
            // plan answered this morning, or the sample's, still lists it, with Schedule here on hours that are gone).
            TimelineList(blocks: today.blocks, commitments: today.commitments.filter { !TodayBoard.wholeDay($0) }, events: events.filter { $0.bool("all_day") != true },
                         reminders: today.reminders_due, freeSlots: today.free_slots.filter { (ISO.date($0.end) ?? .distantFuture) > now }, day: now,
                         timeWidth: columnWidth >= 380 ? 132 : 96, onSchedule: onSchedule)
            if !seeing.isEmpty {
                sub("People today").padding(.top, 4)
                ForEach(seeing) { p in
                    Button { model.open(itemId: p.id) } label: {
                        VStack(alignment: .leading, spacing: 3) {
                            HStack(alignment: .firstTextBaseline, spacing: 6) {
                                Text(p.name).font(.body.bold())
                                Text(StyleGuard.dashes(p.plans.map { $0.title + ($0.at.map { ", " + $0.shortTime } ?? "") }.joined(separator: "; ")))
                                    .font(.subheadline).foregroundStyle(.secondary).lineLimit(2).multilineTextAlignment(.leading)
                            }
                            ForEach(p.notes, id: \.self) { n in
                                Text(StyleGuard.dashes(n)).font(.subheadline).lineLimit(2).multilineTextAlignment(.leading)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    // MARK: to do

    private func todoCard() -> some View {
        let open = TodayBoard.openTasks(engine.list(.task))
        let current = engine.nowTask
        let rest = open.filter { $0.id != current?.id }
        return card("To do", count: open.isEmpty ? nil : "\(open.count) open") {
            // The task being done (or the first one in Next) with its buttons; nothing when there is none.
            if current != nil { NowCard(inCard: true) }
            ForEach(rest.prefix(Self.todoShown)) { task in todoRow(task) }
            if open.isEmpty { clear("No open tasks.") }
            if rest.count > Self.todoShown {
                Button("All \(open.count) in Tasks") { model.section = .tasks }.buttonStyle(.borderless).font(.subheadline)
            }
        }
    }

    /// An open task: one press finishes it, one makes it the task being done, and its words open it.
    private func todoRow(_ task: Entity) -> some View {
        let title = StyleGuard.dashes(task.str("title"))
        return HStack(alignment: .firstTextBaseline, spacing: 8) {
            Button { Task { await engine.markDone(task.id) } } label: {
                Image(systemName: "circle").font(.title3).foregroundStyle(.secondary)
                    .frame(minWidth: 28, minHeight: 28)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Done")
            .accessibilityLabel("Done: \(title)")
            Button { model.open(itemId: task.id) } label: {
                VStack(alignment: .leading, spacing: 1) {
                    Text(title).multilineTextAlignment(.leading).lineLimit(2)
                    if !task.str("due").isEmpty {
                        Text("Due \(TaskDue.label(task.str("due")))").font(.caption).foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            Button("Start") { Task { await engine.makeNow(task.id) } }
                .buttonStyle(.borderless)
                .help("Make this the thing you are doing now")
                .accessibilityLabel("Start \(title)")
        }
    }

    // MARK: today so far

    private func soFarCard(now: Date) -> some View {
        let diary = TodayBoard.diary(engine.list(.note), now: now)
        let rows = TodayBoard.soFar(diary: diary?.lines ?? [], tasks: engine.list(.task), logs: engine.logs, now: now)
        let numbers = model.isOn(.health) ? TodayBoard.todayNumbers(engine.logs, now: now) : []
        return card("Today so far", count: rows.isEmpty ? nil : "\(rows.count)") {
            if !numbers.isEmpty {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 104), spacing: 10, alignment: .topLeading)], alignment: .leading, spacing: 8) {
                    ForEach(numbers) { n in
                        VStack(alignment: .leading, spacing: 1) {
                            Text(n.label).font(.caption).foregroundStyle(.secondary)
                            Text(n.value).font(.body.weight(.semibold)).monospacedDigit()
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityElement(children: .combine)
                    }
                }
            }
            if rows.isEmpty {
                Text("Nothing recorded yet today.").font(.subheadline).foregroundStyle(.secondary)
            } else {
                ForEach(rows.suffix(Self.soFarShown)) { r in
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Text(r.time).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                            .frame(minWidth: 58, alignment: .leading)
                        Text(StyleGuard.dashes(r.text)).font(.subheadline).lineLimit(3)
                            .foregroundStyle(r.kind == .capture ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
                        Spacer(minLength: 0)
                    }
                }
            }
            if let diary, rows.count > Self.soFarShown || !diary.lines.isEmpty {
                Button(rows.count > Self.soFarShown ? "All \(rows.count): open today's diary" : "Open today's diary") { model.open(itemId: diary.note.id) }
                    .buttonStyle(.borderless).font(.subheadline)
            }
        }
    }

    // MARK: coming up

    private func comingCard(now: Date) -> some View {
        let tomorrowDay = Calendar.current.date(byAdding: .day, value: 1, to: now) ?? now
        let tomorrow = TodayBoard.tomorrowLines(engine.localDay(tomorrowDay, now: now).events, now: now)
        let dates = TodayExtras.datesSoon(engine.list(.person), now: now)
        return card("Coming up") {
            if !tomorrow.lines.isEmpty {
                sub("Tomorrow")
                ForEach(tomorrow.lines) { l in
                    Button { model.open(itemId: l.id) } label: { comingRow(when: l.time, what: l.title) }.buttonStyle(.plain)
                }
                if tomorrow.more > 0 {
                    Button("\(tomorrow.more) more") { model.section = .week }.buttonStyle(.borderless).font(.subheadline)
                }
            }
            if !dates.isEmpty {
                sub("Dates").padding(.top, tomorrow.lines.isEmpty ? 0 : 4)
                ForEach(Array(dates.prefix(5).enumerated()), id: \.offset) { _, d in
                    Button { model.open(itemId: d.id) } label: {
                        Text(TodayExtras.phrase(d)).font(.subheadline).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
            if tomorrow.lines.isEmpty && dates.isEmpty {
                Text("Nothing coming up in the next two weeks.").font(.subheadline).foregroundStyle(.secondary)
            }
        }
    }

    private func comingRow(when: String, what: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(when).font(.caption.monospacedDigit()).foregroundStyle(.secondary).frame(minWidth: 58, alignment: .leading)
            Text(StyleGuard.dashes(what)).font(.subheadline).lineLimit(2).multilineTextAlignment(.leading)
            Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
    }
}
