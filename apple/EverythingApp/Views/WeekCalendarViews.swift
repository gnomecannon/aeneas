import SwiftUI
import EACore

/// Monday-first weekday names, short ("Mon") or one letter ("M"), from the device's calendar.
private func weekdayNames(short: Bool) -> [String] {
    let cal = Calendar.current
    let names = short ? cal.shortWeekdaySymbols : cal.veryShortWeekdaySymbols
    guard names.count == 7 else { return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] }
    return Array(names[1...]) + [names[0]]
}

/// Month: the weeks that hold the month's days, each day with its events: short titles in their calendar's color on a
/// wide window (as many as the row has room for, so the Mac's larger window shows more), dots on a phone. A day opens
/// in Day.
struct MonthGridView: View {
    var anchor: Date
    var events: [Entity]
    var wide: Bool
    var calendars: [CalendarColorEntry]
    var onOpenDay: (Date) -> Void

    var body: some View {
        let cal = Calendar.current
        let c = cal.dateComponents([.year, .month], from: anchor)
        let weeks = CalendarViews.monthGrid(year: c.year ?? 2026, month: c.month ?? 1)
        let first = weeks.first.flatMap { LocalPlanner.date($0[0].date) } ?? anchor
        let end = weeks.last.flatMap { LocalPlanner.date($0[6].date) }.flatMap { cal.date(byAdding: .day, value: 1, to: $0) } ?? anchor
        let byDay = CalendarViews.eventsByDay(events, from: first, to: end)
        let today = LocalPlanner.dateString(Date())
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                ForEach(Array(weekdayNames(short: wide).enumerated()), id: \.offset) { _, name in
                    Text(name).font(.caption).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: wide ? .trailing : .center)
                        .padding(.horizontal, 8)
                }
            }
            .padding(.vertical, 4)
            .accessibilityHidden(true)
            Divider()
            GeometryReader { geo in
                let rowHeight = geo.size.height / CGFloat(max(1, weeks.count))
                VStack(spacing: 0) {
                    ForEach(weeks, id: \.self) { week in
                        HStack(spacing: 0) {
                            ForEach(week) { d in cell(d, byDay[d.date] ?? [], rowHeight: rowHeight, today: today) }
                        }
                        .frame(height: rowHeight)
                        .overlay(alignment: .bottom) { Divider() }
                    }
                }
            }
        }
        .padding(.horizontal, wide ? 8 : 0)
    }

    private func cell(_ d: CalendarViews.GridDay, _ list: [Entity], rowHeight: CGFloat, today: String) -> some View {
        let date = LocalPlanner.date(d.date) ?? anchor
        let isToday = d.date == today
        // Titles: as many lines as the row holds under the number, one of them kept for "N more" when some are left.
        let lines = wide ? max(0, Int((rowHeight - 36) / 17)) : 3
        let shown = Array(list.prefix(list.count > lines ? max(0, lines - (wide ? 1 : 0)) : lines))
        let words = list.isEmpty ? "no events" : "\(list.count) \(list.count == 1 ? "event" : "events")"
        return Button { onOpenDay(date) } label: {
            VStack(alignment: wide ? .leading : .center, spacing: 2) {
                Text("\(d.number)")
                    .font(wide ? .callout : .body).monospacedDigit()
                    .fontWeight(isToday ? .semibold : .regular)
                    .foregroundStyle(isToday ? AnyShapeStyle(.onAccent) : AnyShapeStyle(.primary))
                    .frame(width: 28, height: 28)
                    .background { if isToday { Circle().fill(.tint) } }
                    .frame(maxWidth: .infinity, alignment: wide ? .trailing : .center)
                if wide {
                    ForEach(shown) { e in title(e) }
                    if list.count > shown.count {
                        Text("\(list.count - shown.count) more").font(.caption2).foregroundStyle(.secondary).padding(.leading, 4)
                    }
                } else {
                    HStack(spacing: 3) {
                        ForEach(shown) { e in Circle().fill(EventColor.style(e, calendars: calendars)).frame(width: 6, height: 6) }
                    }
                    .frame(height: 6)
                }
                Spacer(minLength: 0)
            }
            .padding(.vertical, 4)
            .padding(.horizontal, wide ? 4 : 0)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .opacity(d.inMonth ? 1 : 0.45)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .overlay(alignment: .leading) {
            if wide { Rectangle().fill(Color.secondary.opacity(0.2)).frame(width: 0.5) }
        }
        .accessibilityLabel("\(date.formatted(.dateTime.weekday(.wide).day().month(.wide))), \(words)")
        .accessibilityHint("Opens the day")
    }

    private func title(_ e: Entity) -> some View {
        let color = EventColor.style(e, calendars: calendars)
        let allDay = e.bool("all_day") == true
        return HStack(spacing: 4) {
            if !allDay, let s = e.date("start") {
                Text(s.formatted(.dateTime.hour().minute())).foregroundStyle(.secondary).monospacedDigit()
            }
            Text(StyleGuard.dashes(e.str("title")))
        }
        .font(.caption2)
        .lineLimit(1)
        .padding(.leading, 6).padding(.trailing, 2).padding(.vertical, 1)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(allDay ? AnyShapeStyle(color.opacity(0.22)) : AnyShapeStyle(Color.clear), in: RoundedRectangle(cornerRadius: 3))
        .overlay(alignment: .leading) { UnevenRoundedRectangle(topLeadingRadius: 3, bottomLeadingRadius: 3).fill(color).frame(width: 3) }
    }
}

/// Year: twelve small months, today marked; one opens in Month.
struct YearGridView: View {
    var year: Int
    var compact: Bool
    var onOpenMonth: (Int) -> Void

    var body: some View {
        let months = CalendarViews.yearGrid(year: year)
        let today = LocalPlanner.dateString(Date())
        let thisMonth = String(today.prefix(7))
        ScrollView {
            // Top-aligned, so the months of a row start on one line whether they span five weeks or six.
            LazyVGrid(columns: compact ? Array(repeating: GridItem(.flexible(), spacing: 10, alignment: .topLeading), count: 3)
                                       : [GridItem(.adaptive(minimum: 200), spacing: 20, alignment: .topLeading)],
                      alignment: .leading, spacing: compact ? 18 : 24) {
                ForEach(months) { m in
                    let key = String(format: "%04d-%02d", year, m.month)
                    Button { onOpenMonth(m.month) } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(Calendar.current.monthSymbols[m.month - 1])
                                .font(compact ? .subheadline.weight(.semibold) : .headline)
                                .foregroundStyle(key == thisMonth ? AnyShapeStyle(.tint) : AnyShapeStyle(.primary))
                            miniMonth(m, today: today)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(Calendar.current.monthSymbols[m.month - 1]) \(String(year))")
                    .accessibilityHint("Opens the month")
                }
            }
            .padding()
        }
    }

    private func miniMonth(_ m: CalendarViews.MonthGrid, today: String) -> some View {
        let size: CGFloat = compact ? 9 : 11
        return VStack(spacing: compact ? 2 : 3) {
            if !compact {
                HStack(spacing: 0) {
                    ForEach(Array(weekdayNames(short: false).enumerated()), id: \.offset) { _, n in
                        Text(n).font(.system(size: size - 1)).foregroundStyle(.secondary).frame(maxWidth: .infinity)
                    }
                }
            }
            ForEach(m.weeks, id: \.self) { week in
                HStack(spacing: 0) {
                    ForEach(week) { d in
                        let isToday = d.inMonth && d.date == today
                        Text(d.inMonth ? "\(d.number)" : "")
                            .font(.system(size: size, weight: isToday ? .bold : .regular)).monospacedDigit()
                            .foregroundStyle(isToday ? AnyShapeStyle(.onAccent) : AnyShapeStyle(.primary))
                            .frame(maxWidth: .infinity)
                            .frame(height: size + (compact ? 4 : 6))
                            .background { if isToday { Circle().fill(.tint).frame(width: size + 7, height: size + 7) } }
                    }
                }
            }
        }
        .accessibilityHidden(true)
    }
}

/// Search results by the day they start: today and later first, then Earlier. A result opens the event.
struct WeekSearchResults: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject private var feel = FeelController.shared
    var query: String
    /// The events Week shows (calendars that are off left out), and all of them, to say how many more are hidden.
    var events: [Entity]
    var allEvents: [Entity]

    var body: some View {
        let today = Date()
        let r = CalendarViews.search(events, query: query, today: today)
        let off = allEvents.count == events.count ? 0 : CalendarViews.search(allEvents, query: query, today: today, limit: 0).total - r.total
        Group {
            if r.total == 0 && off == 0 {
                ContentUnavailableView.search(text: query.trimmingCharacters(in: .whitespaces))
            } else {
                List {
                    ForEach(r.upcoming) { g in section(g) }
                    ForEach(r.earlier) { g in section(g, earlier: g.id == r.earlier.first?.id) }
                    if r.total > r.shown || off > 0 || r.total == 0 {
                        SwiftUI.Section {
                            if r.total == 0 { Text("No events match in the calendars that are on.").foregroundStyle(.secondary) }
                            if r.total > r.shown { Text("\(r.total - r.shown) more. Add a word to narrow it down.").foregroundStyle(.secondary) }
                            if off > 0 { Text("\(off) more in calendars that are off.").foregroundStyle(.secondary) }
                        }
                        .font(.footnote)
                    }
                }
                #if os(iOS)
                .listStyle(.insetGrouped)
                #endif
            }
        }
    }

    private func label(_ date: String) -> String {
        guard let d = LocalPlanner.date(date) else { return date }
        let base = d.formatted(.dateTime.weekday(.wide).day().month(.wide))
        if Calendar.current.isDateInToday(d) { return "Today, \(base)" }
        return Calendar.current.isDate(d, equalTo: Date(), toGranularity: .year) ? base : "\(base), \(d.formatted(.dateTime.year()))"
    }

    /// One day's results; the first of the days before today says Earlier above its date.
    private func section(_ g: CalendarViews.DayGroup, earlier: Bool = false) -> some View {
        SwiftUI.Section {
            ForEach(g.events) { e in
                Button { model.open(itemId: e.id) } label: {
                    HStack(alignment: .top, spacing: 10) {
                        RoundedRectangle(cornerRadius: 2).fill(EventColor.style(e, calendars: feel.settings.calendars)).frame(width: 4)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(StyleGuard.dashes(e.str("title"))).foregroundStyle(.primary)
                            if !e.str("location").isEmpty {
                                Text(StyleGuard.dashes(e.str("location"))).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        Spacer(minLength: 8)
                        Text(e.bool("all_day") == true ? "All day" : (e.date("start")?.formatted(.dateTime.hour().minute()) ?? ""))
                            .font(.caption).foregroundStyle(.secondary).monospacedDigit()
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityHint("Opens the event")
            }
        } header: {
            VStack(alignment: .leading, spacing: 6) {
                if earlier {
                    Text("Earlier").font(.title3.weight(.semibold)).foregroundStyle(.primary).textCase(nil).padding(.top, 8)
                }
                Text(label(g.date))
            }
        }
    }
}

/// Which calendars Week shows: one choice for every device (`hidden_calendars`). As in Apple's Calendar, a filled
/// circle in the calendar's color is shown and an empty one is hidden.
struct WeekCalendarsView: View {
    @ObservedObject private var feel = FeelController.shared
    @Environment(\.dismiss) private var dismiss
    /// The calendars the events here are on.
    var eventKeys: Set<String>

    var body: some View {
        let hidden = feel.settings.hiddenCalendars
        let groups = HiddenCalendars.groups(calendars: feel.settings.calendars, eventKeys: eventKeys, hidden: hidden)
        List {
            if groups.isEmpty {
                Text("No calendars yet. Events brought in from Apple Calendar or iCloud show their calendars here.").foregroundStyle(.secondary)
            }
            ForEach(groups) { g in
                SwiftUI.Section(g.account) {
                    ForEach(g.calendars) { c in
                        let color = c.color.flatMap(FeelController.color).map { AnyShapeStyle($0) } ?? AnyShapeStyle(.tint)
                        Button { feel.setCalendar(c.key, shown: !c.shown) } label: {
                            HStack(spacing: 12) {
                                Image(systemName: c.shown ? "checkmark.circle.fill" : "circle")
                                    .font(.title3)
                                    .foregroundStyle(color)
                                Text(c.name).foregroundStyle(.primary)
                                Spacer()
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(c.name)
                        .accessibilityValue(c.shown ? "Shown" : "Hidden")
                        .accessibilityAddTraits(c.shown ? .isSelected : [])
                    }
                }
            }
            SwiftUI.Section {
            } footer: {
                Text("Unchecked calendars are hidden here in Week, on every device. Today and the assistant still see them.")
            }
        }
        .navigationTitle("Calendars")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            if !hidden.isEmpty {
                ToolbarItem(placement: .cancellationAction) { Button("Show All") { feel.setHiddenCalendars([]) } }
            }
            ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
        }
    }
}

#if DEBUG
/// Week's launch arguments for screenshots, Debug builds only:
///   -EAWeekView <day|week|month|year>  open on that view
///   -EAWeekDate <YYYY-MM-DD>            look at that day
///   -EAWeekSearch <words>               search for the words
///   -EAWeekCalendars YES                the Calendars list opens
///   -EAWeekSample YES                   (sample mode) a few events on three calendars with their colors, kept on this
///                                       device only, and Week planned on the device so they show in Day and Week too
///   -EAWeekHide <keys>                  those calendar keys hidden, comma separated
@MainActor
enum WeekDebug {
    static var localOnly: Bool { UserDefaults.standard.bool(forKey: "EAWeekSample") }

    static func apply(view: inout String, anchor: inout Date, query: inout String, calendars: inout Bool) {
        let d = UserDefaults.standard
        if let v = d.string(forKey: "EAWeekView"), CalendarViewKind(rawValue: v) != nil { view = v }
        if let s = d.string(forKey: "EAWeekDate"), let date = LocalPlanner.date(s) { anchor = date }
        if let q = d.string(forKey: "EAWeekSearch") { query = q }
        if d.bool(forKey: "EAWeekCalendars") { calendars = true }
    }

    /// The sample's calendars and a few events on them, written on this device only (sample mode keeps edits here).
    static func seed(_ engine: SyncEngine) async {
        let d = UserDefaults.standard
        guard d.bool(forKey: "EAWeekSample") else { return }
        let feel = FeelController.shared
        let cals = [
            CalendarColorEntry(key: "icloud:https://caldav.example/alex/home/", name: "Home", account: "alex@icloud.example", color: "#34C759"),
            CalendarColorEntry(key: "icloud:https://caldav.example/alex/family/", name: "Family", account: "alex@icloud.example", color: "#FF9500"),
            CalendarColorEntry(key: "apple:Exchange/Calendar", name: "Calendar", account: "Exchange", color: "#0A84FF"),
        ]
        feel.adoptCalendars(cals)
        if let hide = d.string(forKey: "EAWeekHide") {
            feel.setHiddenCalendars(hide.split(separator: ",").map(String.init))
        }
        let cal = Calendar.current
        let today = cal.startOfDay(for: Date())
        func at(_ day: Int, _ h: Int, _ m: Int = 0) -> String {
            ISO.string(cal.date(byAdding: .minute, value: h * 60 + m, to: cal.date(byAdding: .day, value: day, to: today)!)!)
        }
        func allDay(_ day: Int, _ days: Int = 1) -> (String, String) {
            let s = cal.date(byAdding: .day, value: day, to: today)!
            let e = cal.date(byAdding: .day, value: day + days, to: today)!
            return ("\(LocalPlanner.dateString(s))T00:00:00.000Z", "\(LocalPlanner.dateString(e))T00:00:00.000Z")
        }
        let home = cals[0].key, family = cals[1].key, work = cals[2].key
        var plans: [(String, String, String, String, Bool, String?)] = [
            ("Climbing with Jamie", at(0, 18), at(0, 20), home, false, "Boulder Barn"),
            ("Dentist cleaning", at(1, 15), at(1, 16), home, false, "Maple Street Dental"),
            ("Team standup", at(0, 9, 30), at(0, 9, 45), work, false, nil),
            ("Team standup", at(1, 9, 30), at(1, 9, 45), work, false, nil),
            ("Team standup", at(2, 9, 30), at(2, 9, 45), work, false, nil),
            ("Design review", at(2, 13), at(2, 14), work, false, "Room 4"),
            ("Dinner at Robin's", at(3, 19), at(3, 21), family, false, "Robin's place"),
            ("Farmers market", at(5, 10), at(5, 12), family, false, nil),
            ("Dentist follow-up", at(16, 11), at(16, 11, 30), home, false, "Maple Street Dental"),
            ("Book club", at(9, 19), at(9, 21), home, false, "Library"),
            ("Quarterly planning", at(12, 10), at(12, 12), work, false, nil),
            ("Dentist", at(-40, 15), at(-40, 16), home, false, "Maple Street Dental"),
        ]
        let trip = allDay(7, 3)
        plans.append(("Cabin trip", trip.0, trip.1, family, true, "Lake Alder"))
        let bday = allDay(4)
        plans.append(("Alex's birthday", bday.0, bday.1, family, true, nil))
        for (i, p) in plans.enumerated() {
            var f: [String: JSONValue] = ["title": .string(p.0), "start": .string(p.1), "end": .string(p.2), "all_day": .bool(p.4), "calendar_key": .string(p.3)]
            if let loc = p.5 { f["location"] = .string(loc) }
            _ = await engine.create(kind: .event, fields: f, id: StableID.uuid("week-sample-\(i)"))
        }
    }
}
#endif
