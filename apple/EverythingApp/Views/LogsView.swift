import SwiftUI
import Charts
import EACore

/// One-tap logging, the newest reading of each type (typed here or from Apple Health) and 30-day sparklines.
struct LogsView: View {
    @EnvironmentObject var engine: SyncEngine
    @State private var weight = ""
    @State private var systolic = ""
    @State private var diastolic = ""
    @State private var customMed = ""
    @State private var customActivity = ""
    @State private var flash: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                StatusBanner()
                if let f = flash { Text(f).font(.subheadline).foregroundStyle(.secondary) }

                block("Weight") {
                    HStack {
                        TextField("162", text: $weight).numericKeyboard().textFieldStyle(.roundedBorder).font(.title2).frame(maxWidth: 160)
                        Text("lb").foregroundStyle(.secondary)
                        Button("Log") {
                            guard let v = Double(weight.replacingOccurrences(of: ",", with: ".")) else { return }
                            Task { _ = await engine.log(type: .weight, value: .number(v), unit: "lb"); weight = ""; flash = "Weight \(v) logged" }
                        }
                        .buttonStyle(.borderedProminent).controlSize(.large).disabled(Double(weight) == nil)
                    }
                    // Each weight in its own unit; the chart has every reading in lb.
                    latest(.weight, unit: nil)
                    Sparkline(points: numericPoints(.weight))
                }

                block("Meds") {
                    FlowLayout {
                        ForEach(engine.recentValues(type: .med), id: \.self) { m in
                            Chip(text: m) { Task { _ = await engine.log(type: .med, value: .string(m)); flash = "Took \(m)" } }
                        }
                        HStack(spacing: 6) {
                            TextField("Other med", text: $customMed).textFieldStyle(.roundedBorder).frame(width: 140)
                            Button("Log") { let m = customMed; Task { _ = await engine.log(type: .med, value: .string(m)); customMed = ""; flash = "Took \(m)" } }.disabled(customMed.isEmpty)
                        }
                    }
                    countSummary(.med)
                }

                block("Steps") {
                    let steps = dailyTotals(.steps, days: 14)
                    if let today = steps.last(where: { Calendar.current.isDateInToday($0.0) }) {
                        Text("\(Int(today.1).formatted()) today").font(.title2.weight(.semibold))
                    }
                    latest(.steps, unit: "steps")
                    Sparkline(points: steps, emptyText: "No steps yet. They come from Apple Health (Settings, Connections).")
                }

                block("Blood pressure") {
                    HStack {
                        TextField("120", text: $systolic).numericKeyboard().textFieldStyle(.roundedBorder).font(.title2).frame(width: 90)
                        Text("/").font(.title2)
                        TextField("80", text: $diastolic).numericKeyboard().textFieldStyle(.roundedBorder).font(.title2).frame(width: 90)
                        Button("Log") {
                            let v = "\(systolic)/\(diastolic)"
                            Task { _ = await engine.log(type: .bp, value: .string(v)); systolic = ""; diastolic = ""; flash = "BP \(v) logged" }
                        }
                        .buttonStyle(.borderedProminent).controlSize(.large).disabled(Int(systolic) == nil || Int(diastolic) == nil)
                    }
                    latest(.bp, unit: "mmHg")
                    Sparkline(points: engine.logs(type: .bp, days: window).compactMap { e in
                        guard let d = e.date("at"), let s = e.fields["value"]?.stringValue?.split(separator: "/").first, let v = Double(s) else { return nil }
                        return (d, v)
                    })
                }

                block("Caffeine") {
                    HStack {
                        BigButton(title: "+1", symbol: "cup.and.saucer") { Task { _ = await engine.log(type: .caffeine, value: 1); flash = "Caffeine +1" } }
                            .frame(maxWidth: 200)
                        Text("Today: \(todayCount(.caffeine))").font(.title3).foregroundStyle(.secondary)
                    }
                    Sparkline(points: dailyTotals(.caffeine, days: window))
                }

                block("Mood") {
                    HStack(spacing: 8) {
                        ForEach([-2, -1, 0, 1, 2], id: \.self) { m in
                            Button {
                                Task { _ = await engine.log(type: .mood, value: .number(Double(m))); flash = "Mood \(Self.moodWord(m)) logged" }
                            } label: {
                                Text(m > 0 ? "+\(m)" : "\(m)").font(.title3.weight(.semibold)).frame(maxWidth: .infinity, minHeight: 50)
                            }
                            .buttonStyle(.bordered)
                            .accessibilityLabel("Mood \(Self.moodWord(m))")
                        }
                    }
                    latest(.mood, unit: nil)
                    Sparkline(points: numericPoints(.mood), domain: -2...2)
                }

                block("Activity") {
                    if let cur = engine.currentActivity {
                        TimelineView(.periodic(from: .now, by: 30)) { ctx in
                            HStack {
                                Text("\(cur.name), \(elapsedLabel(since: cur.start, now: ctx.date))").font(.title3)
                                Spacer()
                                Button("End") { Task { await engine.endActivity(); flash = "Ended \(cur.name)" } }.buttonStyle(.borderedProminent)
                            }
                        }
                    }
                    FlowLayout {
                        ForEach(engine.recentValues(type: .activity), id: \.self) { a in
                            Chip(text: a, selected: engine.currentActivity?.name == a) { Task { await engine.toggleActivity(a) } }
                        }
                        HStack(spacing: 6) {
                            TextField("New activity", text: $customActivity).textFieldStyle(.roundedBorder).frame(width: 150)
                            Button("Start") { let a = customActivity; Task { await engine.toggleActivity(a); customActivity = "" } }.disabled(customActivity.isEmpty)
                        }
                    }
                }

                let workouts = recentWorkouts()
                if !workouts.isEmpty {
                    block("Workouts from Health") {
                        ForEach(workouts, id: \.id) { w in
                            HStack {
                                Text(w.name)
                                Spacer()
                                Text(w.detail).foregroundStyle(.secondary)
                            }
                            .font(.callout)
                        }
                    }
                }

                block("Sleep") {
                    if let last = engine.logs(type: .sleep).last, let d = last.date("at") {
                        Text("\(LogUnits.valueText(last)), night of \(d.formatted(date: .abbreviated, time: .omitted))").font(.title3)
                    }
                    Sparkline(points: dailyTotals(.sleep, days: window).map { ($0.0, $0.1 / 60) }, emptyText: "No sleep in the last 30 days. It comes from Apple Health (Settings, Connections).")
                }

                block("Recent entries") {
                    ForEach(engine.logs.filter { $0.str("note") != "end" }.sorted { $0.str("at") > $1.str("at") }.prefix(15)) { e in
                        HStack(alignment: .firstTextBaseline) {
                            Text(e.str("type").capitalized).frame(width: 80, alignment: .leading).foregroundStyle(.secondary)
                            Text(Self.valueText(e))
                            Spacer()
                            if e.str("note") == "Apple Health" { Image(systemName: "heart.fill").foregroundStyle(.pink).font(.caption).accessibilityLabel("From Apple Health") }
                            Text(e.date("at")?.formatted(date: .abbreviated, time: .omitted) ?? "").foregroundStyle(.secondary)
                        }
                        .font(.callout)
                        .contentShape(Rectangle())
                        // Not a list row here, so no swipe: press and hold to delete, or swipe in All entries.
                        .contextMenu { Button(role: .destructive) { Task { await engine.softDelete(e.id) } } label: { Label("Delete", systemImage: "trash") } }
                    }
                    if engine.logs.isEmpty { Text("Nothing logged yet.").foregroundStyle(.secondary) }
                    else { NavigationLink("All entries") { AllLogsView() }.font(.callout) }
                }
            }
            .padding()
        }
        .navigationTitle("Logs")
        .toolbar { ToolbarItem(placement: .automatic) { CSVExportButton(kind: .log) } }
        .refreshable { await engine.sync() }
    }

    @ViewBuilder
    private func block<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.headline)
            content()
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 14))
    }

    static func moodWord(_ m: Int) -> String { ["very low", "low", "okay", "good", "very good"][max(0, min(4, m + 2))] }

    /// Days the sparklines cover.
    private let window = 30

    /// The newest reading of a type: value, day, and whether it came from Apple Health.
    @ViewBuilder
    private func latest(_ t: LogType, unit: String?) -> some View {
        if let e = engine.logs(type: t).last(where: { $0.str("note") != "end" }), let d = e.date("at") {
            let from = e.str("note") == "Apple Health" ? ", from Health" : ""
            Text("Latest \(Self.valueText(e))\(unit.map { " \($0)" } ?? "") on \(d.formatted(date: .abbreviated, time: .shortened))\(from)")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    /// Sleep in hours and minutes (an hours log is not read as minutes), a weight with its own unit.
    static func valueText(_ e: Entity) -> String { LogUnits.valueText(e) }

    private struct Workout { var id: String; var name: String; var detail: String }

    /// Workouts Health sent (an activity log with its "end" log), newest first.
    private func recentWorkouts() -> [Workout] {
        let acts = engine.logs(type: .activity, days: window)
        let ends = acts.filter { $0.str("note") == "end" }
        return acts.filter { $0.str("note") == "Apple Health" }.reversed().prefix(5).compactMap { a in
            guard let start = a.date("at") else { return nil }
            let end = ends.first { $0.str("value") == a.str("value") && ($0.date("at") ?? .distantPast) >= start }?.date("at")
            let mins = end.map { Int($0.timeIntervalSince(start) / 60) }
            return Workout(id: a.id, name: a.str("value"), detail: [mins.map { "\($0) min" }, start.formatted(date: .abbreviated, time: .omitted)].compactMap { $0 }.joined(separator: ", "))
        }
    }

    private func numericPoints(_ t: LogType) -> [(Date, Double)] {
        engine.logs(type: t, days: window).compactMap { e in
            // Weights in lb whatever each was logged in, so a kg reading is not drawn as lb.
            guard let d = e.date("at"), let v = t == .weight ? LogUnits.weightLb(e) : e.number("value") else { return nil }
            return (d, v)
        }
    }

    private func dailyTotals(_ t: LogType, days: Int) -> [(Date, Double)] {
        let cal = Calendar.current
        var totals: [Date: Double] = [:]
        for e in engine.logs(type: t, days: days) {
            guard let d = e.date("at") else { continue }
            totals[cal.startOfDay(for: d), default: 0] += (t == .sleep ? LogUnits.sleepMinutes(e) : e.number("value")) ?? 1
        }
        return totals.keys.sorted().map { ($0, totals[$0]!) }
    }

    private func todayCount(_ t: LogType) -> Int {
        engine.logs(type: t, days: 1).filter { Calendar.current.isDateInToday($0.date("at") ?? .distantPast) }.reduce(0) { $0 + Int($1.number("value") ?? 1) }
    }

    @ViewBuilder
    private func countSummary(_ t: LogType) -> some View {
        let n = engine.logs(type: t, days: 7).count
        Text("\(n) in the last 7 days").font(.caption).foregroundStyle(.secondary)
    }
}

struct Sparkline: View {
    var points: [(Date, Double)]
    var domain: ClosedRange<Double>? = nil
    var emptyText = "No data in the last 30 days"

    var body: some View {
        if points.count >= 2 {
            Chart {
                ForEach(Array(points.enumerated()), id: \.offset) { _, p in
                    LineMark(x: .value("Day", p.0), y: .value("Value", p.1)).interpolationMethod(.monotone)
                    PointMark(x: .value("Day", p.0), y: .value("Value", p.1))
                }
            }
            .chartXAxis(.hidden)
            .chartYAxis { AxisMarks(position: .leading, values: .automatic(desiredCount: 3)) }
            .chartYScale(domain: domain.map { ClosedRange(uncheckedBounds: ($0.lowerBound, $0.upperBound)) } ?? autoDomain)
            .frame(height: 70)
        } else {
            Text(points.isEmpty ? emptyText : "One entry in the last 30 days").font(.caption).foregroundStyle(.secondary)
        }
    }

    private var autoDomain: ClosedRange<Double> {
        let vs = points.map(\.1)
        let lo = vs.min() ?? 0, hi = vs.max() ?? 1
        let pad = max((hi - lo) * 0.2, 1)
        return (lo - pad)...(hi + pad)
    }
}

/// Every log, newest first and grouped by day, with swipe to delete.
struct AllLogsView: View {
    @EnvironmentObject var engine: SyncEngine

    private var days: [(day: String, logs: [Entity])] {
        let logs = engine.logs.filter { $0.str("note") != "end" }.sorted { $0.str("at") > $1.str("at") }
        var out: [(day: String, logs: [Entity])] = []
        for e in logs {
            let d = e.date("at")?.formatted(date: .complete, time: .omitted) ?? "Undated"
            if out.last?.day == d { out[out.count - 1].logs.append(e) } else { out.append((d, [e])) }
        }
        return out
    }

    var body: some View {
        List {
            ForEach(days, id: \.day) { d in
                SwiftUI.Section(d.day) {
                    ForEach(d.logs) { e in
                        HStack(alignment: .firstTextBaseline) {
                            Text(e.str("type").capitalized).frame(width: 80, alignment: .leading).foregroundStyle(.secondary)
                            Text(LogsView.valueText(e))
                            Spacer()
                            Text(e.date("at")?.formatted(date: .omitted, time: .shortened) ?? "").foregroundStyle(.secondary)
                        }
                        .deleteSwipe(e.id)
                    }
                }
            }
        }
        .overlay { if engine.logs.isEmpty { EmptyState(text: "Nothing logged yet") } }
        .navigationTitle("All entries")
    }
}
