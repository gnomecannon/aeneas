import SwiftUI
import Combine
import EACore

/// Week, laid out as Apple's Calendar does: Day, Week, Month and Year in a segmented control, back and forward arrows
/// and Today, a search field, and Calendars to hide a calendar's events (CONTRACT.md, Planner, Week screen). Week is
/// the plan as it was: on iPhone a day-by-day list with a day strip; on iPad and Mac a seven-column grid for the day
/// window with blackouts hatched, commitments grey, blocks as task cards, and free cells with a plus that opens the
/// picker. Day is one day of it. Month and Year read the events on the device.
struct WeekView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var engine: SyncEngine
    /// The hidden calendars and their colors, so a change made on another device redraws Week at once.
    @ObservedObject private var feel = FeelController.shared
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var sizeClass
    #endif
    /// The view chosen last, kept on this device.
    @AppStorage("ea.week.view") private var viewRaw = CalendarViewKind.week.rawValue
    /// The day looked at: the arrows move it, Today brings it back, and every view shows the period that holds it.
    @State private var anchor = Calendar.current.startOfDay(for: Date())
    @State private var week: PlannerWeek?
    @State private var fromHub = false
    @State private var scheduling: FreeSlot?
    @State private var reloadTask: Task<Void, Never>?
    @State private var query = ""
    @State private var showCalendars = false
    #if DEBUG
    @State private var debugApplied = false
    #endif

    private var isCompact: Bool {
        #if os(iOS)
        return sizeClass == .compact
        #else
        return false
        #endif
    }

    private var view: CalendarViewKind { CalendarViewKind(rawValue: viewRaw) ?? .week }
    private var viewBinding: Binding<CalendarViewKind> { Binding(get: { view }, set: { viewRaw = $0.rawValue }) }
    private var weekStart: Date { LocalPlanner.monday(of: anchor) }
    private var selectedDay: String { LocalPlanner.dateString(anchor) }
    private var hidden: [String] { feel.settings.hiddenCalendars }
    private var searching: Bool { !query.trimmingCharacters(in: .whitespaces).isEmpty }
    private var isToday: Bool { Calendar.current.isDateInToday(anchor) }

    /// The week without the events of calendars that are off.
    private var shownWeek: PlannerWeek? {
        guard var w = week else { return nil }
        if !hidden.isEmpty {
            for i in w.days.indices { w.days[i].events = w.days[i].events.filter { HiddenCalendars.shown($0, hidden: hidden) } }
        }
        return w
    }

    private var allEvents: [Entity] { engine.list(.event) }
    private var shownEvents: [Entity] { hidden.isEmpty ? allEvents : allEvents.filter { HiddenCalendars.shown($0, hidden: hidden) } }

    /// Every calendar the events here are on, for the Calendars list.
    private var eventKeys: Set<String> {
        var keys = Set(allEvents.map(HiddenCalendars.key))
        for d in week?.days ?? [] { for e in d.events { keys.insert(HiddenCalendars.key(e)) } }
        return keys
    }

    var body: some View {
        VStack(spacing: 0) {
            if isCompact, !searching {
                viewPicker.padding(.horizontal).padding(.top, 4).padding(.bottom, 8)
            }
            #if os(iOS)
            // On an iPad the bar holds Day, Week, Month and Year where the title goes, so the period ("November
            // 2026") heads the page, as in the iPad's Calendar. It was nowhere, so the arrows moved to a month unnamed.
            if !isCompact, !searching {
                Text(title).font(.title2.bold())
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal).padding(.top, 2).padding(.bottom, 6)
                    .accessibilityAddTraits(.isHeader)
            }
            #endif
            if searching {
                WeekSearchResults(query: query, events: shownEvents, allEvents: allEvents)
            } else {
                content
            }
        }
        .navigationTitle(searching ? "Search" : title)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar { toolbar }
        .searchable(text: $query, prompt: "Search events")
        #if os(iOS)
        // Left for the next period, right for the one before, as in a calendar app. A drag that starts at the screen's
        // edge is left to the system, so the edge swipe and the back button still go back to Today.
        .simultaneousGesture(DragGesture(minimumDistance: 30).onEnded { v in
            let dx = v.translation.width, dy = v.translation.height
            guard !searching, abs(dx) > 60, abs(dx) > abs(dy) * 1.5, v.startLocation.x > 30 else { return }
            shift(dx < 0 ? 1 : -1)
        })
        #endif
        .sheet(item: $scheduling) { slot in SchedulePicker(slot: slot, next: engine.upNext) { await reload() } }
        .sheet(isPresented: $showCalendars) {
            NavigationStack { WeekCalendarsView(eventKeys: eventKeys) }
                #if os(macOS)
                .frame(minWidth: 380, minHeight: 460)
                #endif
        }
        .task(id: LocalPlanner.dateString(weekStart)) { await reload() }
        .refreshable { await engine.sync(); await reload() }
        // Only changes to what the week shows reload it, as on Today. Every change fetched the week again, Ops's fresh
        // monitors every 30 s among them.
        .onReceive(engine.$entities.map(TodayView.signature).removeDuplicates()) { _ in
            reloadTask?.cancel()
            reloadTask = Task { try? await Task.sleep(nanoseconds: 300_000_000); if !Task.isCancelled { await reload() } }
        }
        #if DEBUG
        .onAppear {
            guard !debugApplied else { return }
            debugApplied = true
            WeekDebug.apply(view: &viewRaw, anchor: &anchor, query: &query, calendars: &showCalendars)
        }
        #endif
    }

    private var viewPicker: some View {
        Picker("View", selection: viewBinding) {
            ForEach(CalendarViewKind.allCases) { Text($0.title).tag($0) }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        if !isCompact {
            ToolbarItem(placement: .principal) { viewPicker.frame(width: 300) }
        }
        ToolbarItemGroup(placement: .primaryAction) {
            Button { shift(-1) } label: { Label("Previous \(view.period)", systemImage: "chevron.left") }
                .disabled(searching)
            Button("Today") { anchor = Calendar.current.startOfDay(for: Date()) }
                .disabled(searching || isToday)
            Button { shift(1) } label: { Label("Next \(view.period)", systemImage: "chevron.right") }
                .disabled(searching)
            Button { showCalendars = true } label: {
                Label(hidden.isEmpty ? "Calendars" : "Calendars, some off", systemImage: hidden.isEmpty ? "calendar" : "calendar.badge.minus")
            }
            .help("Choose which calendars Week shows")
        }
    }

    private var title: String {
        let d = anchor
        switch view {
        case .day:
            let sameYear = Calendar.current.isDate(d, equalTo: Date(), toGranularity: .year)
            return sameYear ? d.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated)) : d.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated).year())
        case .week:
            let end = Calendar.current.date(byAdding: .day, value: 6, to: weekStart) ?? weekStart
            let sameMonth = Calendar.current.isDate(weekStart, equalTo: end, toGranularity: .month)
            return "\(weekStart.formatted(.dateTime.day().month(.abbreviated))) to \(sameMonth ? end.formatted(.dateTime.day()) : end.formatted(.dateTime.day().month(.abbreviated)))"
        case .month:
            return d.formatted(.dateTime.month(.wide).year())
        case .year:
            return d.formatted(.dateTime.year())
        }
    }

    private func shift(_ n: Int) {
        anchor = CalendarViews.shift(view, anchor: anchor, by: n)
    }

    private func reload() async {
        #if DEBUG
        if WeekDebug.localOnly { week = engine.localWeek(start: weekStart); fromHub = false; return }
        #endif
        let r = await engine.loadWeek(start: weekStart)
        week = r.week
        fromHub = r.fromHub
    }

    // MARK: views

    @ViewBuilder
    private var content: some View {
        switch view {
        case .week, .day:
            if let w = shownWeek {
                if isCompact {
                    dayList(w, strip: view == .week)
                } else if view == .week {
                    WeekGrid(week: w, onSchedule: { scheduling = $0 })
                } else if let d = w.days.first(where: { $0.date == selectedDay }) {
                    WeekGrid(week: PlannerWeek(start: w.start, days: [d]), onSchedule: { scheduling = $0 })
                } else {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        case .month:
            MonthGridView(anchor: anchor, events: shownEvents, wide: !isCompact, calendars: feel.settings.calendars) { day in
                anchor = day
                viewRaw = CalendarViewKind.day.rawValue
            }
        case .year:
            YearGridView(year: Calendar.current.component(.year, from: anchor), compact: isCompact) { month in
                let cal = Calendar.current
                let year = cal.component(.year, from: anchor)
                let now = Date()
                if cal.component(.year, from: now) == year, cal.component(.month, from: now) == month {
                    anchor = cal.startOfDay(for: now)
                } else {
                    anchor = cal.date(from: DateComponents(year: year, month: month, day: 1)) ?? anchor
                }
                viewRaw = CalendarViewKind.month.rawValue
            }
        }
    }

    // MARK: iPhone

    @ViewBuilder
    private func dayList(_ w: PlannerWeek, strip: Bool) -> some View {
        VStack(spacing: 0) {
            if strip {
                HStack(spacing: 6) {
                    ForEach(w.days) { d in
                        let date = LocalPlanner.date(d.date) ?? Date()
                        let isToday = Calendar.current.isDateInToday(date)
                        Button { anchor = date } label: {
                            VStack(spacing: 2) {
                                Text(date.formatted(.dateTime.weekday(.abbreviated))).font(.caption2)
                                Text(date.formatted(.dateTime.day())).font(.headline)
                                Circle().fill(d.blocks.isEmpty ? AnyShapeStyle(Color.clear) : AnyShapeStyle(.tint)).frame(width: 5, height: 5)
                            }
                            .frame(maxWidth: .infinity, minHeight: 56)
                            .background(selectedDay == d.date ? AnyShapeStyle(.tint.opacity(0.25)) : AnyShapeStyle(isToday ? Color.secondary.opacity(0.12) : Color.clear), in: RoundedRectangle(cornerRadius: 10))
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(selectedDay == d.date ? .isSelected : [])
                    }
                }
                // Seven days across a phone: past this size "Mon" and "23" broke into pieces of a letter or a digit a
                // line. The day below, with its plans, takes the full size.
                .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
                .padding(.horizontal)
                .padding(.bottom, 8)
            }
            Divider()
            ScrollView {
                if let d = w.days.first(where: { $0.date == selectedDay }) {
                    VStack(alignment: .leading, spacing: 12) {
                        // Day says its date in the title already.
                        if strip {
                            Text((LocalPlanner.date(d.date) ?? Date()).formatted(.dateTime.weekday(.wide).day().month(.wide))).font(.title3.weight(.semibold))
                        }
                        TimelineList(blocks: d.blocks, commitments: d.commitments, events: d.events, reminders: d.reminders, freeSlots: d.free_slots, day: LocalPlanner.date(d.date) ?? Date(), onSchedule: { scheduling = $0 })
                        if !d.watches_due.isEmpty, model.isOn(.renewals) {
                            Text("Renewals due").font(.headline).foregroundStyle(.secondary)
                            ForEach(d.watches_due) { Text(StyleGuard.dashes($0.str("title"))) }
                        }
                        if !fromHub { Text("Planned on this device.").font(.caption).foregroundStyle(.secondary) }
                    }
                    .padding()
                }
            }
        }
    }
}

/// Seven columns for the day window. Hours run down the left.
struct WeekGrid: View {
    @EnvironmentObject var engine: SyncEngine
    /// Calendar colors, so a color chosen in Theme redraws the week at once.
    @ObservedObject private var feel = FeelController.shared
    var week: PlannerWeek
    var onSchedule: (FreeSlot) -> Void

    private let hourHeight: CGFloat = 48
    private var startMinutes: Int { LocalPlanner.minutes(LocalPlanner.dayStart) ?? 540 }
    private var endMinutes: Int { LocalPlanner.minutes(LocalPlanner.dayEnd) ?? 1380 }
    private var hours: [Int] { Array(stride(from: startMinutes / 60, through: endMinutes / 60, by: 1)) }
    private var gridHeight: CGFloat { CGFloat(endMinutes - startMinutes) / 60 * hourHeight }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 1) {
                Spacer().frame(width: 52, height: 1)
                ForEach(week.days) { d in
                    let date = LocalPlanner.date(d.date) ?? Date()
                    VStack(spacing: 0) {
                        Text(date.formatted(.dateTime.weekday(.abbreviated))).font(.caption).foregroundStyle(.secondary)
                        Text(date.formatted(.dateTime.day())).font(.headline)
                        // All-day plans mark the day here, as calendars show them, not as a block over the hours.
                        ForEach(d.events.filter { $0.bool("all_day") == true }) { e in
                            // Its calendar's color, else the accent: a tint under the words and a solid bar beside them.
                            let color = EventColor.style(e, calendars: feel.settings.calendars)
                            Text(StyleGuard.dashes(e.str("title"))).font(.caption2).lineLimit(1)
                                .padding(.leading, 7).padding(.trailing, 4).padding(.vertical, 1)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(color.opacity(0.22), in: RoundedRectangle(cornerRadius: 4))
                                .overlay(alignment: .leading) { UnevenRoundedRectangle(topLeadingRadius: 4, bottomLeadingRadius: 4).fill(color).frame(width: 3) }
                                .padding(.horizontal, 2).padding(.top, 2)
                                .help(e.str("title"))
                                .accessibilityLabel("All day: " + e.str("title"))
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
                    .background(Calendar.current.isDateInToday(date) ? AnyShapeStyle(.tint.opacity(0.15)) : AnyShapeStyle(Color.clear), in: RoundedRectangle(cornerRadius: 8))
                }
            }
            Divider()
            ScrollView {
                HStack(alignment: .top, spacing: 1) {
                    hourRuler
                    ForEach(week.days) { d in dayColumn(d) }
                }
                .frame(height: gridHeight)
                .padding(.top, 8)
                .padding(.bottom, 20)
            }
        }
        .padding(.horizontal, 8)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    private var hourRuler: some View {
        ZStack(alignment: .topTrailing) {
            Color.clear
            let labels = Self.rulerHours(hours)
            ForEach(Array(zip(hours, labels)), id: \.0) { h, label in
                Text(label).font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                    .offset(y: y(forMinutes: h * 60) - 6)
            }
        }
        .frame(width: 52, height: gridHeight)
    }

    /// The ruler's hours as the device writes times: "9 AM", or "09:00" where the clock is 24-hour. It said "09:00"
    /// everywhere, beside events and a Today that say "9:55 AM". One formatter for the whole ruler.
    static func rulerHours(_ hours: [Int], locale: Locale = .current) -> [String] {
        let twelve = DateFormatter.dateFormat(fromTemplate: "j", options: 0, locale: locale)?.contains("a") ?? false
        guard twelve else { return hours.map { LocalPlanner.hhmm($0 * 60) } }
        let symbols = DateFormatter()
        symbols.locale = locale
        let am = symbols.amSymbol ?? "AM", pm = symbols.pmSymbol ?? "PM"
        return hours.map { h in "\(h % 12 == 0 ? 12 : h % 12) \(h % 24 < 12 ? am : pm)" }
    }

    private func y(forMinutes m: Int) -> CGFloat { CGFloat(m - startMinutes) / 60 * hourHeight }

    private func y(for date: Date) -> CGFloat {
        let cal = Calendar.current
        let m = cal.component(.hour, from: date) * 60 + cal.component(.minute, from: date)
        return y(forMinutes: m)
    }

    private func frame(_ start: String, _ end: String, day: Date) -> (y: CGFloat, h: CGFloat)? {
        guard let s = ISO.date(start), let e = ISO.date(end) else { return nil }
        let dayStart = Calendar.current.startOfDay(for: day)
        let dayEnd = Calendar.current.date(byAdding: .day, value: 1, to: dayStart) ?? day
        let cs = max(s, dayStart), ce = min(e, dayEnd)
        var top = y(for: cs)
        var bottom = ce == dayEnd ? y(forMinutes: 1440) : y(for: ce)
        top = max(0, top); bottom = min(gridHeight, bottom)
        guard bottom > top else { return nil }
        return (top, bottom - top)
    }

    @ViewBuilder
    private func dayColumn(_ d: PlannerDay) -> some View {
        let day = LocalPlanner.date(d.date) ?? Date()
        ZStack(alignment: .top) {
            // Hour lines
            VStack(spacing: 0) {
                ForEach(hours.dropLast(), id: \.self) { _ in
                    Rectangle().fill(Color.secondary.opacity(0.15)).frame(height: 1)
                    Spacer(minLength: 0)
                }
            }
            ForEach(d.commitments) { c in
                if let f = frame(c.start, c.end, day: day) {
                    Group {
                        if c.type == .blackout {
                            Hatch().overlay(Text(c.title).font(.caption2).foregroundStyle(.secondary).padding(4), alignment: .topLeading)
                        } else if c.type == .commitment {
                            RoundedRectangle(cornerRadius: 6).fill(Color.gray.opacity(0.35))
                                .overlay(Text(c.title).font(.caption2).foregroundStyle(.primary).padding(4), alignment: .topLeading)
                        } else {
                            // A preferred time, as on the web: a dashed outline in the accent with quiet words. Green
                            // words were hard to read on a light theme.
                            RoundedRectangle(cornerRadius: 6).strokeBorder(.tint.opacity(0.6), style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
                                .overlay(Text(c.title).font(.caption2).foregroundStyle(.secondary).padding(4), alignment: .bottomTrailing)
                        }
                    }
                    .frame(height: f.h)
                    .offset(y: f.y)
                    .help(c.title)
                }
            }
            // Events that overlap stand side by side (CalendarViews.lanes); drawn full width, a later one covered the
            // one under it.
            let placed = d.events.compactMap { e -> PlacedEvent? in
                guard !(e.bool("all_day") ?? false), let f = frame(e.str("start"), e.str("end"), day: day) else { return nil }
                return PlacedEvent(event: e, y: f.y, h: f.h)
            }
            let lanes = CalendarViews.lanes(placed.map { (id: $0.id, start: Double($0.y), end: Double($0.y + $0.h)) })
            GeometryReader { geo in
                ForEach(placed) { p in
                    let e = p.event
                    let lane = lanes[p.id] ?? EventLane(lane: 0, lanes: 1)
                    let width = geo.size.width / CGFloat(max(1, lane.lanes))
                    // Its calendar's color, else the accent, as on the web: a light tint under the words (which keep
                    // the theme's text color), a thin border and a solid bar on the left.
                    let color = EventColor.style(e, calendars: feel.settings.calendars)
                    RoundedRectangle(cornerRadius: 6).fill(color.opacity(0.18))
                        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(color, lineWidth: 1))
                        .overlay(alignment: .leading) { UnevenRoundedRectangle(topLeadingRadius: 6, bottomLeadingRadius: 6).fill(color).frame(width: 3) }
                        .overlay(VStack(alignment: .leading, spacing: 2) {
                            if e.space == .work { SpaceChip(text: "Work", compact: true) }
                            Text(StyleGuard.dashes(e.str("title"))).font(.caption2)
                        }.padding(.vertical, 4).padding(.leading, 7).padding(.trailing, 4), alignment: .topLeading)
                        .frame(width: lane.lanes > 1 ? width - 1 : width, height: p.h)
                        .offset(x: CGFloat(lane.lane) * width, y: p.y)
                        .accessibilityLabel((e.space == .work ? "Work, " : "") + e.str("title"))
                }
            }
            ForEach(d.free_slots) { s in
                if let f = frame(s.start, s.end, day: day) {
                    Button { onSchedule(s) } label: {
                        RoundedRectangle(cornerRadius: 6)
                            .strokeBorder(.tint.opacity(0.5), style: StrokeStyle(lineWidth: 1, dash: [5, 4]))
                            .overlay(VStack(spacing: 2) {
                                Image(systemName: "plus.circle").font(.title3)
                                Text("\(s.hours.formatted()) h").font(.caption2)
                            }.foregroundStyle(.tint))
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .frame(height: f.h).offset(y: f.y)
                    .accessibilityLabel("Schedule here, \(s.hours.formatted()) hours")
                }
            }
            ForEach(d.blocks) { b in
                if let f = frame(b.start, b.end, day: day) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(StyleGuard.dashes(b.title)).font(.caption.weight(.semibold)).lineLimit(3)
                        Text(timeRange(b.start, b.end)).font(.caption2).foregroundStyle(.secondary)
                    }
                    .padding(6)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    .background(.tint.opacity(b.status == .doing ? 0.45 : 0.25), in: RoundedRectangle(cornerRadius: 6))
                    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(.tint, lineWidth: 1))
                    .frame(height: f.h).offset(y: f.y)
                    .contextMenu {
                        Button("Unschedule") { Task { await engine.unschedule(taskId: b.task_id) } }
                        Button("Make Now") { Task { await engine.makeNow(b.task_id) } }
                        Button("Done") { Task { await engine.markDone(b.task_id) } }
                    }
                }
            }
            ForEach(d.reminders) { r in
                if let at = r.alertDate {
                    HStack(spacing: 3) { Image(systemName: "bell.fill").font(.caption2); Text(r.str("title")).font(.caption2).lineLimit(1) }
                        .foregroundStyle(.warnText)
                        .padding(.horizontal, 5).padding(.vertical, 2)
                        .background(.thinMaterial, in: Capsule())
                        .frame(maxWidth: .infinity, alignment: .trailing)
                        // Held inside the grid: a reminder before the first hour was drawn above it and cut in half.
                        .offset(y: min(max(0, y(for: at) - 9), gridHeight - 18))
                        .help(r.str("title") + " " + at.shortTime)
                }
            }
            if Calendar.current.isDateInToday(day) {
                TimelineView(.periodic(from: .now, by: 60)) { ctx in
                    HStack(spacing: 0) {
                        Circle().fill(.danger).frame(width: 8, height: 8)
                        Rectangle().fill(.danger).frame(height: 2)
                    }
                    .offset(y: y(for: ctx.date) - 4)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .clipped()
        .background(Calendar.current.isDateInToday(day) ? AnyShapeStyle(.tint.opacity(0.05)) : AnyShapeStyle(Color.clear))
    }
}

/// Diagonal hatching for blackouts.
struct Hatch: View {
    var body: some View {
        Canvas { ctx, size in
            var path = Path()
            let step: CGFloat = 8
            var x: CGFloat = -size.height
            while x < size.width {
                path.move(to: CGPoint(x: x, y: size.height))
                path.addLine(to: CGPoint(x: x + size.height, y: 0))
                x += step
            }
            ctx.stroke(path, with: .color(.secondary.opacity(0.35)), lineWidth: 1)
        }
        .background(Color.secondary.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }
}

/// A timed event placed on a day column of the week grid: its top and height in points.
private struct PlacedEvent: Identifiable {
    let event: Entity
    let y: CGFloat
    let h: CGFloat
    var id: String { event.id }
}
