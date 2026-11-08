import SwiftUI
import EACore

/// The week: on iPhone a day-by-day list with a day switcher; on iPad and Mac a seven-column
/// grid for the day window with blackouts hatched, commitments grey, blocks as task cards,
/// and free cells with a plus that opens the picker.
struct WeekView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var engine: SyncEngine
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var sizeClass
    #endif
    @State private var weekStart = LocalPlanner.monday(of: Date())
    @State private var week: PlannerWeek?
    @State private var fromHub = false
    @State private var selectedDay = LocalPlanner.dateString(Date())
    @State private var scheduling: FreeSlot?
    @State private var reloadTask: Task<Void, Never>?

    private var isCompact: Bool {
        #if os(iOS)
        return sizeClass == .compact
        #else
        return false
        #endif
    }

    var body: some View {
        Group {
            if let w = week {
                if isCompact { dayList(w) } else { WeekGrid(week: w, onSchedule: { scheduling = $0 }) }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .navigationTitle(weekTitle)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button { shift(-7) } label: { Label("Previous", systemImage: "chevron.left") }
                Button("This week") { weekStart = LocalPlanner.monday(of: Date()); selectedDay = LocalPlanner.dateString(Date()); Task { await reload() } }
                Button { shift(7) } label: { Label("Next", systemImage: "chevron.right") }
            }
        }
        #if os(iOS)
        // Left for the next week, right for the previous one, as in a calendar app. A drag that starts at the screen's
        // edge is left to the system, so the edge swipe and the back button still go back to Today.
        .simultaneousGesture(DragGesture(minimumDistance: 30).onEnded { v in
            let dx = v.translation.width, dy = v.translation.height
            guard abs(dx) > 60, abs(dx) > abs(dy) * 1.5, v.startLocation.x > 30 else { return }
            shift(dx < 0 ? 7 : -7)
        })
        #endif
        .sheet(item: $scheduling) { slot in SchedulePicker(slot: slot, next: engine.upNext) { await reload() } }
        .task { await reload() }
        .refreshable { await engine.sync(); await reload() }
        .onReceive(engine.$entities) { _ in
            reloadTask?.cancel()
            reloadTask = Task { try? await Task.sleep(nanoseconds: 300_000_000); if !Task.isCancelled { await reload() } }
        }
    }

    private var weekTitle: String {
        let end = Calendar.current.date(byAdding: .day, value: 6, to: weekStart) ?? weekStart
        let sameMonth = Calendar.current.isDate(weekStart, equalTo: end, toGranularity: .month)
        return "\(weekStart.formatted(.dateTime.day().month(.abbreviated))) to \(sameMonth ? end.formatted(.dateTime.day()) : end.formatted(.dateTime.day().month(.abbreviated)))"
    }

    private func shift(_ days: Int) {
        weekStart = Calendar.current.date(byAdding: .day, value: days, to: weekStart) ?? weekStart
        if let d = LocalPlanner.date(selectedDay), let moved = Calendar.current.date(byAdding: .day, value: days, to: d) { selectedDay = LocalPlanner.dateString(moved) }
        Task { await reload() }
    }

    private func reload() async {
        let r = await engine.loadWeek(start: weekStart)
        week = r.week
        fromHub = r.fromHub
        if !r.week.days.contains(where: { $0.date == selectedDay }), let first = r.week.days.first { selectedDay = first.date }
    }

    // MARK: iPhone

    @ViewBuilder
    private func dayList(_ w: PlannerWeek) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                ForEach(w.days) { d in
                    let date = LocalPlanner.date(d.date) ?? Date()
                    let isToday = Calendar.current.isDateInToday(date)
                    Button { selectedDay = d.date } label: {
                        VStack(spacing: 2) {
                            Text(date.formatted(.dateTime.weekday(.abbreviated))).font(.caption2)
                            Text(date.formatted(.dateTime.day())).font(.headline)
                            Circle().fill(d.blocks.isEmpty ? Color.clear : Color.accentColor).frame(width: 5, height: 5)
                        }
                        .frame(maxWidth: .infinity, minHeight: 56)
                        .background(selectedDay == d.date ? Color.accentColor.opacity(0.25) : (isToday ? Color.secondary.opacity(0.12) : Color.clear), in: RoundedRectangle(cornerRadius: 10))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal)
            .padding(.vertical, 8)
            Divider()
            ScrollView {
                if let d = w.days.first(where: { $0.date == selectedDay }) {
                    VStack(alignment: .leading, spacing: 12) {
                        Text((LocalPlanner.date(d.date) ?? Date()).formatted(.dateTime.weekday(.wide).day().month(.wide))).font(.title3.weight(.semibold))
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
                            Text(StyleGuard.dashes(e.str("title"))).font(.caption2).lineLimit(1)
                                .padding(.horizontal, 4).padding(.vertical, 1)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(Color.purple.opacity(0.25), in: RoundedRectangle(cornerRadius: 4))
                                .padding(.horizontal, 2).padding(.top, 2)
                                .help(e.str("title"))
                                .accessibilityLabel("All day: " + e.str("title"))
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
                    .background(Calendar.current.isDateInToday(date) ? Color.accentColor.opacity(0.15) : Color.clear, in: RoundedRectangle(cornerRadius: 8))
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
            ForEach(hours, id: \.self) { h in
                Text(LocalPlanner.hhmm(h * 60)).font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                    .offset(y: y(forMinutes: h * 60) - 6)
            }
        }
        .frame(width: 52, height: gridHeight)
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
                            RoundedRectangle(cornerRadius: 6).fill(Color.green.opacity(0.10))
                                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.green.opacity(0.5), style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
                                .overlay(Text(c.title).font(.caption2).foregroundStyle(.green).padding(4), alignment: .bottomTrailing)
                        }
                    }
                    .frame(height: f.h)
                    .offset(y: f.y)
                    .help(c.title)
                }
            }
            ForEach(d.events) { e in
                if !(e.bool("all_day") ?? false), let f = frame(e.str("start"), e.str("end"), day: day) {
                    RoundedRectangle(cornerRadius: 6).fill(Color.purple.opacity(0.25))
                        .overlay(VStack(alignment: .leading, spacing: 2) {
                            if e.space == .work { SpaceChip(text: "Work", compact: true) }
                            Text(StyleGuard.dashes(e.str("title"))).font(.caption2)
                        }.padding(4), alignment: .topLeading)
                        .frame(height: f.h).offset(y: f.y)
                        .accessibilityLabel((e.space == .work ? "Work, " : "") + e.str("title"))
                }
            }
            ForEach(d.free_slots) { s in
                if let f = frame(s.start, s.end, day: day) {
                    Button { onSchedule(s) } label: {
                        RoundedRectangle(cornerRadius: 6)
                            .strokeBorder(Color.accentColor.opacity(0.5), style: StrokeStyle(lineWidth: 1, dash: [5, 4]))
                            .overlay(VStack(spacing: 2) {
                                Image(systemName: "plus.circle").font(.title3)
                                Text("\(s.hours.formatted()) h").font(.caption2)
                            }.foregroundStyle(Color.accentColor))
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
                    .background(Color.accentColor.opacity(b.status == .doing ? 0.45 : 0.25), in: RoundedRectangle(cornerRadius: 6))
                    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.accentColor, lineWidth: 1))
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
                        .foregroundStyle(.orange)
                        .padding(.horizontal, 5).padding(.vertical, 2)
                        .background(.thinMaterial, in: Capsule())
                        .frame(maxWidth: .infinity, alignment: .trailing)
                        .offset(y: y(for: at) - 9)
                        .help(r.str("title") + " " + at.shortTime)
                }
            }
            if Calendar.current.isDateInToday(day) {
                TimelineView(.periodic(from: .now, by: 60)) { ctx in
                    HStack(spacing: 0) {
                        Circle().fill(Color.red).frame(width: 8, height: 8)
                        Rectangle().fill(Color.red).frame(height: 2)
                    }
                    .offset(y: y(for: ctx.date) - 4)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .clipped()
        .background(Calendar.current.isDateInToday(day) ? Color.accentColor.opacity(0.05) : Color.clear)
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
