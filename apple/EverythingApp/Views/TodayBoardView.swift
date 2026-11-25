import SwiftUI
import EACore

/// Today as a status board, in the order its owner asked every report to take: at the top the Next line (the task you
/// started, else what is on now and how long it has left); then Tech's light as one folded line and what needs you (actions only, numbered, each with its
/// buttons), the schedule (what is left), things to do, today so far (what is done and was said), and what is coming
/// that needs nothing from you. One column on an iPhone, up to five across a wide window. The rules are EACore's
/// `TodayBoard` and `Tech`, the same as the web app's. That is the default: Theme, Today (`today` in the feel setting,
/// one for every device) hides parts and puts the cards in another order, which fills the columns; Edit Today at the
/// bottom opens it.
///
/// The day is drawn once, as the Schedule card's list: a strip of it across the top said the same again
/// (gnomecannon/aeneas#15). Capturing is the Capture tab's, one press away on every screen; a box for it here said
/// that again (gnomecannon/aeneas#21). A charge on autopay pays itself, so Today does not list it (#14).
///
/// The theme's accent is only on what can be pressed to act.
struct TodayBoardView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var engine: SyncEngine
    /// Tech's board, for what needs a look: the same list and light as the Overview's, so the two never disagree.
    @ObservedObject private var feed = OpsBoardFeed.shared
    /// What Today shows and in what order (Theme, Today).
    @ObservedObject private var feel = FeelController.shared
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var typeSize

    var today: PlannerToday
    var fromHub: Bool
    var onSchedule: (FreeSlot) -> Void

    /// The screen's own width: it decides how many columns there are.
    @State private var width: CGFloat = 0
    @State private var acking: Entity?
    /// Tech's card is folded each time Today opens: the screen's own state, never saved.
    @State private var techOpen = false

    private var setting: TodaySetting { feel.settings.shownToday }

    /// The cards the setting shows, in its order; Tech only while it has something to show.
    private var cards: [TodayPart] { setting.cards.filter { $0 != .tech || showsTech } }

    /// How wide one column of cards is at the width the screen has now.
    private var columnWidth: CGFloat {
        let n = CGFloat(max(1, TodayBoard.columns(width: Double(width), cards: cards).count))
        return (width - 16 * (n - 1)) / n
    }

    /// How many open tasks To do lists, and how many lines Today so far shows, before a link to the rest.
    private static let todoShown = 6
    private static let soFarShown = 10

    /// The largest text sizes: what sits side by side in a row (a time and its words, a task and Start) goes one
    /// under the other, so the words keep the card's width.
    private var large: Bool { typeSize.isAccessibilitySize }

    /// A time or a label beside its words, or over them at the largest text sizes.
    private func lineLayout<Content: View>(spacing: CGFloat, @ViewBuilder _ content: () -> Content) -> some View {
        let layout = large ? AnyLayout(VStackLayout(alignment: .leading, spacing: 2)) : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: spacing))
        return layout { content() }
    }

    var body: some View {
        // Every half minute: "46 min left" counts down and a reminder whose time has come joins Needs you.
        TimelineView(.periodic(from: .now, by: 30)) { ctx in
            board(now: ctx.date)
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .sheet(item: $acking) { inc in AckSheet(incident: inc) }
        // Tech folds again when Today is left (another tab, a page opened over it), so Today always opens with it
        // folded: the iPhone keeps a tab's screen, and its state, while another tab shows.
        .onDisappear { techOpen = false }
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
        let columns = TodayBoard.columns(width: Double(width), cards: cards)
        VStack(alignment: .leading, spacing: 16) {
            if setting.showsTop { head(spans, now: now) }
            if columns.isEmpty {
                // Every card hidden: said in one line, with the way back.
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(TodayText.none).foregroundStyle(.secondary)
                    editLink
                }
            } else {
                HStack(alignment: .top, spacing: 16) {
                    ForEach(Array(columns.enumerated()), id: \.offset) { _, column in
                        VStack(alignment: .leading, spacing: 16) {
                            ForEach(column, id: \.self) { section($0, events: events, spans: spans, now: now) }
                        }
                        // As tall as its cards: offered the tallest column's height, the Schedule's rows grew to fill it.
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .topLeading)
                    }
                }
            }
            if !fromHub {
                Text("Planned on this device. The hub's plan replaces it when it is reachable.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if !columns.isEmpty { editLink.font(.subheadline) }
        }
    }

    /// Theme, Today, opened over Today.
    private var editLink: some View {
        PageLink { TodayPartsSettingsView() } label: { Text(TodayText.edit) }
            .buttonStyle(.borderless)
    }

    @ViewBuilder
    private func section(_ s: TodayPart, events: [Entity], spans: [TodayBoard.Span], now: Date) -> some View {
        switch s {
        // Each card has a name the screen can be scrolled to (`-EAScrollTo`, TodayView).
        case .now: EmptyView()
        // Tech is one line until pressed, at the top of the card after it (`TodayBoard.slots`).
        case .tech: techCard.id("tech")
        case .needs: needsCard(now: now).id("needs")
        case .schedule: scheduleCard(events: events, spans: spans, now: now).id("timeline")
        case .todo: todoCard().id("todo")
        case .sofar: soFarCard(now: now).id("sofar")
        case .coming: comingCard(now: now).id("coming")
        }
    }

    /// One card of the board: its name, a count beside it, and what it holds.
    private func card<Content: View>(_ title: String, count: String? = nil, waiting: Bool = false, @ViewBuilder content: () -> Content) -> some View {
        box {
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
    }

    /// The box every card is drawn in.
    private func box<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) { content() }
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

    // MARK: the top: the Next line and free time

    private func head(_ spans: [TodayBoard.Span], now: Date) -> some View {
        // The task you started leads it (never the first task in Next), whatever list it is in.
        let line = TodayBoard.nowLine(spans, now: now, started: engine.startedTask.map(TodayBoard.StartedTask.init))
        return VStack(alignment: .leading, spacing: 4) {
            nowLine(TodayBoard.lineWords(line, free: nil))
            if let free = TodayBoard.freeLine(spans, now: now) {
                Text(free).font(.subheadline).foregroundStyle(.secondary)
            }
        }
    }

    /// The largest words on the screen: the Next line (CONTRACT.md, Planner), the same words as the widgets, the Watch
    /// and the menu bar: the task you started, else what is under way, else what is next, else that the day is clear.
    private func nowLine(_ w: TodayBoard.LineWords) -> some View {
        var words = Text(w.lead) + Text(StyleGuard.dashes(w.title)).fontWeight(w.label == .today ? .regular : .bold)
        if !w.when.isEmpty { words = words + Text(" " + w.when) }
        if !w.aside.isEmpty { words = words + Text("   " + w.aside).foregroundStyle(.secondary) }
        return words
            .font(width >= 680 ? .system(size: 26, weight: .medium) : .title3.weight(.medium))
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityLabel(StyleGuard.dashes(w.text))
            .accessibilityAddTraits(.isHeader)
    }

    // MARK: Tech

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

    /// Tech shows with Machines on, once there is a check or a thing to show.
    private var showsTech: Bool { model.isOn(.homelab) && !(things.isEmpty && monitors.isEmpty) }

    /// Tech in one line: a dot in the light's color (green, yellow, red or gray), "Tech" and what the light says,
    /// folded each time Today opens. A press on the line opens it: what needs a look, each with Propose a fix,
    /// Acknowledge and Open as Needs you had them, then the acknowledged ones, then Open Tech and what is watched.
    private var techCard: some View {
        let things = self.things, monitors = self.monitors, sensors = self.sensors, looks = self.looks
        let light = Tech.light(looks: looks, things: things, monitors: monitors, sensors: sensors)
        let watched = Tech.watched(things: things, monitors: monitors, sensors: sensors)
        return box {
            Button { techOpen.toggle() } label: {
                // Plain colors: inside a button the hierarchical .primary and .secondary would take the tint.
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: "circle.fill").font(.system(size: 10)).foregroundStyle(light.tone.status.fill(else: .gray))
                    // What the light says goes under "Tech" at the largest text sizes, where beside it it had a sliver.
                    lineLayout(spacing: 8) {
                        Text("Tech").font(.headline).foregroundStyle(Color.primary)
                        Text(light.label).font(.subheadline.weight(.semibold)).foregroundStyle(light.tone.status.text(else: .secondary))
                            .multilineTextAlignment(.leading)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Color.secondary)
                        .rotationEffect(.degrees(techOpen ? 90 : 0))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(light.detail)
            .accessibilityLabel("Tech, \(light.label)")
            .accessibilityValue(techOpen ? "Open" : "Folded")
            .accessibilityHint(techOpen ? "Folds it to one line" : "Shows what needs a look")
            .accessibilityAddTraits(.isHeader)
            if techOpen {
                // Tech.needsALook lists the ones not yet acknowledged first.
                ForEach(looks) { look in
                    Divider()
                    techRow(look)
                }
                Divider()
                lineLayout(spacing: 12) {
                    Button("Open Tech") { model.section = .ops }.buttonStyle(.borderless).font(.subheadline)
                    if !watched.isEmpty { Text(watched).font(.caption).foregroundStyle(.secondary) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    /// One thing that needs a look: a dot in its color (red when down, yellow for a reading, gray once acknowledged),
    /// what it is, and the buttons that settle it here. An acknowledged one says when, and its note.
    private func techRow(_ look: TechLook) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: "circle.fill").font(.system(size: 8)).foregroundStyle(look.tone.status.fill(else: .gray))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(StyleGuard.dashes(look.title))
                    .font(look.acknowledged ? Font.body : Font.body.weight(.semibold))
                    .foregroundStyle(look.acknowledged ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
                    .fixedSize(horizontal: false, vertical: true)
                if let d = look.detail, !d.isEmpty {
                    Text(StyleGuard.dashes(d)).font(.caption).foregroundStyle(.secondary).lineLimit(3)
                }
                if look.acknowledged, let inc = look.incident, let at = inc.string("acknowledged_at") {
                    Text(MonitorText.acked(at, note: inc.string("ack_note"))).font(.caption).foregroundStyle(.secondary)
                }
                FlowLayout(spacing: 8) { techActions(look) }
                    .controlSize(.small)
                    .padding(.top, 2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(look.acknowledged ? "\(look.title), acknowledged" : look.title)
    }

    /// The buttons Needs you had for a look: Propose a fix and Acknowledge while it is not acknowledged, and Open.
    @ViewBuilder
    private func techActions(_ look: TechLook) -> some View {
        if !look.acknowledged {
            if look.monitorId != nil || look.sensor != nil { ProposeFixButton(monitorId: look.monitorId, sensor: look.sensor) }
            if let inc = look.incident { Button("Acknowledge") { acking = inc }.buttonStyle(.themedProminent) }
        }
        if look.thing.isEmpty {
            Button("Open") { model.section = .ops }.buttonStyle(.borderless)
        } else {
            PageLink("Open") { HostDetailView(host: look.thing) }.buttonStyle(.borderless)
        }
    }

    // MARK: needs you

    private func needs(now: Date) -> [TodayBoard.Need] {
        let tasks = engine.list(.task)
        return TodayBoard.needsYou(
            reminders: Mail.dueReminders(tasks, now: now), tasks: tasks,
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
                    lineLayout(spacing: 8) {
                        Text("All day").font(.caption).foregroundStyle(.secondary)
                        Text(StyleGuard.dashes(e.str("title"))).multilineTextAlignment(.leading)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            ForEach(dayRules) { c in
                lineLayout(spacing: 8) {
                    Text("All day").font(.caption).foregroundStyle(.secondary)
                    Text(StyleGuard.dashes(c.title)).multilineTextAlignment(.leading)
                    Text(c.type.rawValue.capitalized).font(.caption).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
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
                            lineLayout(spacing: 6) {
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
        // The tasks of the lists chosen for To do (Theme, Today, Lists in To do), or of every list.
        let match = setting.todoMatch(engine.sources?.lists ?? [])
        let tasks = engine.list(.task)
        let open = TodayBoard.openTasks(match.map { m in tasks.filter { m.contains($0) } } ?? tasks)
        // The task you started, among To do's lists, with its buttons; never the first task in Next.
        let current = match.map { m in engine.startedTask(where: { m.contains($0) }) } ?? engine.startedTask
        let rest = open.filter { $0.id != current?.id }
        return card("To do", count: open.isEmpty ? nil : "\(open.count) open") {
            if let current { StartedCard(task: current, inCard: true) }
            ForEach(rest.prefix(Self.todoShown)) { task in todoRow(task) }
            if open.isEmpty {
                if setting.todoLists?.isEmpty == true {
                    Text(TodayText.noneChosen).font(.subheadline).foregroundStyle(.secondary)
                    editLink.font(.subheadline)
                } else {
                    clear("No open tasks.")
                }
            }
            if rest.count > Self.todoShown {
                Button("All \(open.count) in Tasks") { model.section = .tasks }.buttonStyle(.borderless).font(.subheadline)
            }
        }
    }

    /// An open task: one press finishes it, one makes it the task being done, and its words open it. At the largest
    /// text sizes Start goes under the words, which beside it kept a few letters a line.
    private func todoRow(_ task: Entity) -> some View {
        let title = StyleGuard.dashes(task.str("title"))
        let open = Button { model.open(itemId: task.id) } label: {
            VStack(alignment: .leading, spacing: 1) {
                Text(title).multilineTextAlignment(.leading).lineLimit(large ? 4 : 2)
                if !task.str("due").isEmpty {
                    Text("Due \(TaskDue.label(task.str("due")))").font(.caption).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        let start = Button("Start") { Task { await engine.startTask(task.id) } }
            .buttonStyle(.borderless)
            .help("Make this the thing you are doing now")
            .accessibilityLabel("Start \(title)")
        return HStack(alignment: .firstTextBaseline, spacing: 8) {
            Button { Task { await engine.markDone(task.id) } } label: {
                Image(systemName: "circle").font(.title3).foregroundStyle(.secondary)
                    .frame(minWidth: 28, minHeight: 28)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Done")
            .accessibilityLabel("Done: \(title)")
            if large {
                VStack(alignment: .leading, spacing: 4) { open; start }
            } else {
                open
                start
            }
        }
    }

    // MARK: today so far

    private func soFarCard(now: Date) -> some View {
        let diary = TodayBoard.diary(engine.list(.note), now: now)
        let rows = TodayBoard.soFar(diary: diary?.lines ?? [], tasks: engine.list(.task), logs: engine.logs, now: now)
        let numbers = model.isOn(.health) ? TodayBoard.todayNumbers(engine.logs, now: now) : []
        return card("Today so far", count: rows.isEmpty ? nil : "\(rows.count)") {
            if !numbers.isEmpty {
                // Wider columns at the largest text sizes: three of 104 points broke "Weight" and "158.4 lb" in two.
                LazyVGrid(columns: [GridItem(.adaptive(minimum: large ? 240 : 104), spacing: 10, alignment: .topLeading)], alignment: .leading, spacing: 8) {
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
                    lineLayout(spacing: 10) {
                        // "Yesterday" above the time for a line from before midnight, so the column keeps its width.
                        VStack(alignment: .leading, spacing: 0) {
                            if let day = r.day { Text(day) }
                            Text(r.clock)
                        }
                        .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                        .frame(minWidth: 58, alignment: .leading)
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(r.time)
                        Text(StyleGuard.dashes(r.text)).font(.subheadline).lineLimit(large ? 6 : 3)
                            .foregroundStyle(r.kind == .capture ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
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
        lineLayout(spacing: 10) {
            Text(when).font(.caption.monospacedDigit()).foregroundStyle(.secondary).frame(minWidth: 58, alignment: .leading)
            Text(StyleGuard.dashes(what)).font(.subheadline).lineLimit(large ? 4 : 2).multilineTextAlignment(.leading)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }
}
