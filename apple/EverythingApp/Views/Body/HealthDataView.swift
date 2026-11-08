import SwiftUI
import Charts
import EACore

/// Health: everything tracked, typed here or synced with Apple Health. Each measure shows its newest reading; opening
/// one shows a chart over a chosen range and every entry, newest first.
struct HealthDataView: View {
    @EnvironmentObject var engine: SyncEngine

    var body: some View {
        List {
            SwiftUI.Section {
                ForEach(HealthMetric.allCases) { m in
                    NavigationLink { HealthMetricView(metric: m) } label: { row(m) }
                }
            } footer: {
                Text("Readings typed in the app and readings from Apple Health, kept the same both ways (Settings, Connections). Swipe an entry to delete it. To log something, use Logs.")
            }
        }
        .navigationTitle("Health")
        .refreshable { await engine.sync() }
    }

    @ViewBuilder private func row(_ m: HealthMetric) -> some View {
        let entries = m.entries(engine)
        HStack(spacing: 12) {
            Image(systemName: m.symbol).foregroundStyle(.tint).frame(width: 26)
            VStack(alignment: .leading, spacing: 2) {
                Text(m.title)
                if let last = entries.last {
                    Text("\(m.text(last)), \(last.at.formatted(date: .abbreviated, time: .omitted))").font(.caption).foregroundStyle(.secondary)
                } else {
                    Text("Nothing yet").font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
            Text("\(entries.count)").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
        }
    }
}

/// One measure: a point per reading (or per day for totals), with where it came from.
struct HealthPoint: Identifiable {
    var id: String
    var at: Date
    var value: Double
    var label: String?
    var fromHealth: Bool
    var note: String?
    /// The unit `value` is in, when the measure has more than one (weight: kg or lb).
    var unit: String? = nil
    /// The reading as it was logged, in its own unit, when that differs from `value`'s.
    var asLogged: String? = nil
}

/// Units as the hub reads them (hub/src/health.ts): weight is lb unless the log says kg, sleep is minutes unless the
/// log says hours, caffeine is cups unless the log says mg.
enum HealthUnits {
    static let lbPerKg = 2.20462
    static let cupMg = 95.0
    static func unit(_ e: Entity) -> String { e.str("unit").trimmingCharacters(in: .whitespaces).lowercased() }
    static func isKg(_ e: Entity) -> Bool { ["kg", "kgs", "kilo", "kilos", "kilogram", "kilograms"].contains(unit(e)) }
    static func inHours(_ e: Entity) -> Bool { ["h", "hr", "hrs", "hour", "hours"].contains(unit(e)) }
    static func isMg(_ e: Entity) -> Bool { ["mg", "milligram", "milligrams"].contains(unit(e)) }
    static func round1(_ v: Double) -> Double { (v * 10).rounded() / 10 }
    static func number(_ v: Double) -> String { v == v.rounded() ? "\(Int(v))" : String(format: "%.1f", v) }
}

enum HealthMetric: String, CaseIterable, Identifiable {
    case weight, bp, sleep, steps, workouts, caffeine, mood, meds
    var id: String { rawValue }

    var title: String {
        switch self {
        case .weight: return "Weight"
        case .bp: return "Blood pressure"
        case .sleep: return "Sleep"
        case .steps: return "Steps"
        case .workouts: return "Workouts and activities"
        case .caffeine: return "Caffeine"
        case .mood: return "Mood"
        case .meds: return "Medications"
        }
    }

    var symbol: String {
        switch self {
        case .weight: return "scalemass"
        case .bp: return "heart"
        case .sleep: return "bed.double"
        case .steps: return "figure.walk"
        case .workouts: return "figure.run"
        case .caffeine: return "cup.and.saucer"
        case .mood: return "face.smiling"
        case .meds: return "pills"
        }
    }

    /// The unit shown after a value, if any.
    var unit: String {
        switch self {
        case .weight: return "lb"
        case .bp: return "mmHg"
        case .sleep: return ""
        case .steps: return "steps"
        case .workouts: return "min"
        case .caffeine: return "cups"
        case .mood, .meds: return ""
        }
    }

    /// Daily totals rather than single readings (caffeine and steps add up over a day).
    var sumsByDay: Bool { self == .caffeine }

    func text(_ p: HealthPoint) -> String {
        switch self {
        case .bp: return p.label ?? ""
        // Every weight was shown as lb, so a reading logged in kg read as that many pounds. Each entry shows the unit
        // it was logged in; the chart and the summary use the newest reading's unit, as /health/summary does.
        case .weight: return p.asLogged ?? "\(HealthUnits.number(p.value)) \(p.unit ?? "lb")"
        case .sleep:
            let m = Int(p.value.rounded())
            return "\(m / 60) h \(m % 60) min"
        case .workouts: return "\(p.label ?? "Activity"), \(Int(p.value)) min"
        case .meds: return p.label ?? ""
        case .steps: return "\(Int(p.value).formatted()) steps"
        default:
            let v = p.value == p.value.rounded() ? "\(Int(p.value))" : String(format: "%.1f", p.value)
            return unit.isEmpty ? v : "\(v) \(unit)"
        }
    }

    @MainActor
    func entries(_ engine: SyncEngine) -> [HealthPoint] {
        let logs = engine.logs
        func of(_ t: String) -> [Entity] { logs.filter { $0.str("type") == t && $0.str("note") != "end" } }
        func point(_ e: Entity, value: Double, label: String? = nil) -> HealthPoint? {
            guard let at = e.date("at") else { return nil }
            return HealthPoint(id: e.id, at: at, value: value, label: label, fromHealth: e.str("note") == "Apple Health", note: e.str("note").isEmpty || e.str("note") == "Apple Health" ? nil : e.str("note"))
        }
        var out: [HealthPoint]
        switch self {
        case .steps, .mood:
            out = of(rawValue).compactMap { e in e.number("value").flatMap { point(e, value: $0) } }
        case .weight:
            let logs = of("weight").filter { $0.number("value") != nil && $0.date("at") != nil }
            let newest = logs.max { ($0.date("at") ?? .distantPast) < ($1.date("at") ?? .distantPast) }
            let common = newest.map(HealthUnits.isKg) == true ? "kg" : "lb"
            out = logs.compactMap { e in
                guard let v = e.number("value") else { return nil }
                let own = HealthUnits.isKg(e) ? "kg" : "lb"
                let inCommon = own == common ? v : HealthUnits.round1(own == "kg" ? v * HealthUnits.lbPerKg : v / HealthUnits.lbPerKg)
                var p = point(e, value: inCommon)
                p?.unit = common
                p?.asLogged = "\(HealthUnits.number(v)) \(own)"
                return p
            }
        case .sleep:
            // Sleep is minutes; a log in hours (7.5 h) showed as 0 h 7 min.
            out = of("sleep").compactMap { e in e.number("value").flatMap { point(e, value: HealthUnits.inHours(e) ? $0 * 60 : $0) } }
        case .caffeine:
            // Cups of 95 mg, as the hub counts them; a log in mg was added as that many cups.
            out = of("caffeine").compactMap { e in point(e, value: e.number("value").map { HealthUnits.isMg(e) ? $0 / HealthUnits.cupMg : $0 } ?? 1) }
        case .bp:
            out = of("bp").compactMap { e in
                let v = e.str("value")
                guard let s = v.split(separator: "/").first.flatMap({ Double($0.trimmingCharacters(in: .whitespaces)) }) else { return nil }
                return point(e, value: s, label: v)
            }
        case .meds:
            out = of("med").compactMap { point($0, value: 1, label: $0.str("value")) }
        case .workouts:
            let all = logs.filter { $0.str("type") == "activity" }
            let ends = all.filter { $0.str("note") == "end" }
            out = all.filter { $0.str("note") != "end" }.compactMap { e in
                guard let start = e.date("at") else { return nil }
                let end = ends.compactMap { x in x.str("value") == e.str("value") ? x.date("at") : nil }.filter { $0 >= start }.min()
                let mins = end.map { $0.timeIntervalSince(start) / 60 } ?? 0
                return point(e, value: mins.rounded(), label: e.str("value"))
            }
        }
        return out.sorted { $0.at < $1.at }
    }
}

struct HealthMetricView: View {
    @EnvironmentObject var engine: SyncEngine
    let metric: HealthMetric
    @State private var range: Range = .month

    enum Range: String, CaseIterable, Identifiable {
        case week = "Week", month = "Month", year = "Year", all = "All"
        var id: String { rawValue }
        var days: Int? { switch self { case .week: 7; case .month: 31; case .year: 366; case .all: nil } }
    }

    var body: some View {
        let all = metric.entries(engine)
        let cutoff = range.days.map { Date().addingTimeInterval(-Double($0) * 86400) } ?? .distantPast
        let shown = all.filter { $0.at >= cutoff }
        let chart = metric.sumsByDay ? dailyTotals(shown) : shown
        List {
            SwiftUI.Section {
                Picker("Range", selection: $range) { ForEach(Range.allCases) { Text($0.rawValue).tag($0) } }
                    .pickerStyle(.segmented)
                if chart.count >= 2, metric != .meds {
                    Chart(chart) { p in
                        if metric == .steps || metric == .caffeine || metric == .workouts {
                            BarMark(x: .value("Day", p.at, unit: .day), y: .value(metric.title, p.value))
                        } else {
                            LineMark(x: .value("Day", p.at), y: .value(metric.title, metric == .sleep ? p.value / 60 : p.value)).interpolationMethod(.monotone)
                            PointMark(x: .value("Day", p.at), y: .value(metric.title, metric == .sleep ? p.value / 60 : p.value)).symbolSize(18)
                        }
                    }
                    .chartYScale(domain: .automatic(includesZero: metric == .steps || metric == .caffeine || metric == .workouts))
                    .frame(height: 200)
                    summary(shown)
                } else {
                    Text(shown.isEmpty ? "Nothing in this range." : "\(shown.count) in this range.").foregroundStyle(.secondary)
                }
            }
            SwiftUI.Section("Entries, \(shown.count)") {
                ForEach(shown.reversed()) { p in
                    entryRow(p)
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) { Task { await engine.softDelete(p.id) } } label: { Label("Delete", systemImage: "trash") }
                        }
                }
            }
        }
        .navigationTitle(metric.title)
    }

    /// One reading. Deleting it here also removes it from Apple Health when the app wrote it there.
    @ViewBuilder private func entryRow(_ p: HealthPoint) -> some View {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(metric.text(p))
                            if let n = p.note { Text(n).font(.caption).foregroundStyle(.secondary) }
                        }
                        Spacer()
                        if p.fromHealth { Image(systemName: "heart.fill").foregroundStyle(.pink).font(.caption).accessibilityLabel("From Apple Health") }
                        Text(p.at.formatted(date: .abbreviated, time: metric == .steps || metric == .sleep ? .omitted : .shortened))
                            .font(.callout).foregroundStyle(.secondary)
                    }
    }

    private func dailyTotals(_ pts: [HealthPoint]) -> [HealthPoint] {
        let cal = Calendar.current
        var sums: [Date: Double] = [:]
        for p in pts { sums[cal.startOfDay(for: p.at), default: 0] += p.value }
        return sums.keys.sorted().map { HealthPoint(id: "\($0)", at: $0, value: sums[$0]!, label: nil, fromHealth: false, note: nil) }
    }

    @ViewBuilder private func summary(_ pts: [HealthPoint]) -> some View {
        let vs = pts.map(\.value)
        if let lo = vs.min(), let hi = vs.max(), !vs.isEmpty {
            let avg = vs.reduce(0, +) / Double(vs.count)
            let f = { (v: Double) in metric.text(HealthPoint(id: "", at: .now, value: v, label: metric == .bp ? "\(Int(v))" : nil, fromHealth: false, note: nil, unit: pts.last?.unit)) }
            Text("Average \(f(avg)), low \(f(lo)), high \(f(hi))").font(.caption).foregroundStyle(.secondary)
        }
    }
}
