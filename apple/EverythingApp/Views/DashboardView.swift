import SwiftUI
import Charts
import EACore

/// The general dashboard: a grid of tiles, each one metric over 7, 30, 90 or 365 days with its newest value and the
/// change against the period before. The tiles are one setting on the hub, so every device shows the same board; the
/// last board seen is kept here for when the hub is out of reach.
struct DashboardView: View {
    @EnvironmentObject var engine: SyncEngine
    @State private var board: DashboardBoard? = DashboardCache.load()
    @State private var live = false
    @State private var note: String?
    @State private var problem: String?
    @State private var picking = false

    private var tiles: [DashboardBoardTile] { board?.tiles ?? [] }
    private var canEdit: Bool { engine.client != nil && live }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if let note { Text(note).font(.callout).foregroundStyle(.secondary) }
                if let problem { Text(problem).font(.callout).foregroundStyle(.red) }
                if board != nil && tiles.isEmpty {
                    Text("No tiles yet. Add one to chart weight, sleep, tasks done, a sensor or anything else the hub keeps.")
                        .foregroundStyle(.secondary)
                }
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 300), spacing: 12, alignment: .top)], spacing: 12) {
                    ForEach(Array(tiles.enumerated()), id: \.offset) { i, item in
                        DashboardTileCard(
                            item: item,
                            first: i == 0,
                            last: i == tiles.count - 1,
                            canEdit: canEdit,
                            onRange: { r in var t = board?.plainTiles ?? []; t[i].range = r; Task { await save(t, fetch: i) } },
                            onChart: { c in var t = board?.plainTiles ?? []; t[i].chart = c; Task { await save(t) } },
                            onMove: { by in Task { await save(DashboardTiles.move(board?.plainTiles ?? [], from: i, by: by), moved: (i, by)) } },
                            onRemove: { Task { await save(DashboardTiles.remove(board?.plainTiles ?? [], at: i), removed: i) } }
                        )
                    }
                }
            }
            .padding()
        }
        .navigationTitle("Dashboard")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { picking = true } label: { Label("Add tile", systemImage: "plus") }
                    .disabled(!canEdit || tiles.count >= DashboardTiles.maxTiles)
            }
        }
        .sheet(isPresented: $picking) {
            MetricPicker(shown: tiles.map(\.tile.metric)) { m in
                picking = false
                let t = DashboardTiles.add(board?.plainTiles ?? [], metric: m)
                Task { await save(t, fetch: t.count - 1) }
            }
        }
        .refreshable { await load() }
        .task { await load() }
        .onChange(of: engine.lastSync) { Task { await load() } }
    }

    private func load() async {
        guard let c = engine.client else {
            live = false
            note = "The dashboard is drawn by the hub. Connect one in Settings."
            return
        }
        do {
            let b = try await c.dashboardBoard()
            board = b
            live = true
            note = nil
            DashboardCache.save(b)
        } catch HubError.http(let status, _) where status == 404 {
            live = false
            note = "The dashboard is not available on this hub yet."
        } catch {
            live = false
            note = board == nil
                ? "The dashboard is drawn by the hub, which is out of reach right now. It fills in when the hub is back."
                : "The hub is out of reach, so this is the board as this device last saw it. Changes wait until the hub is back."
        }
    }

    /// Show the change at once (keeping each tile's series), then save the whole board. `fetch` is a tile whose
    /// series must be read again: a new tile, or one whose range changed.
    private func save(_ next: [DashboardTile], fetch: Int? = nil, moved: (Int, Int)? = nil, removed: Int? = nil) async {
        var old = board?.tiles ?? []
        if case let (i, by)? = moved { old = DashboardTiles.move(old, from: i, by: by) }
        if let i = removed { old = DashboardTiles.remove(old, at: i) }
        let shown = next.enumerated().map { i, t in
            DashboardBoardTile(tile: t, series: i < old.count && old[i].tile.metric == t.metric ? old[i].series : nil)
        }
        board = DashboardBoard(tiles: shown, saved: true)
        problem = nil
        guard let c = engine.client else { problem = "Changes need the hub."; return }
        do {
            _ = try await c.setDashboardTiles(next)
            if let i = fetch, next.indices.contains(i) {
                let s = try await c.dashboardSeries(metric: next[i].metric, days: next[i].range)
                if var b = board, b.tiles.indices.contains(i), b.tiles[i].tile == next[i] {
                    b.tiles[i].series = s
                    board = b
                }
            }
            if let b = board { DashboardCache.save(b) }
        } catch {
            problem = "Not saved: \(StyleGuard.dashes(error.localizedDescription))"
            await load()
        }
    }
}

/// The last board seen, for showing while the hub is out of reach.
enum DashboardCache {
    private static let key = "dashboard.board"
    static func load() -> DashboardBoard? {
        guard let d = UserDefaults.standard.data(forKey: key) else { return nil }
        return try? JSONCoding.decode(DashboardBoard.self, from: d)
    }
    static func save(_ b: DashboardBoard) {
        if let d = try? JSONCoding.data(b) { UserDefaults.standard.set(d, forKey: key) }
    }
}

struct DashboardTileCard: View {
    let item: DashboardBoardTile
    let first: Bool
    let last: Bool
    let canEdit: Bool
    let onRange: (Int) -> Void
    let onChart: (DashboardChart) -> Void
    let onMove: (Int) -> Void
    let onRemove: () -> Void

    private var title: String { StyleGuard.dashes(item.series?.label ?? item.tile.metric) }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(title).font(.headline).lineLimit(2)
                Spacer()
                Menu {
                    Button { onMove(-1) } label: { Label("Move earlier", systemImage: "arrow.up") }.disabled(first)
                    Button { onMove(1) } label: { Label("Move later", systemImage: "arrow.down") }.disabled(last)
                    Picker("Chart", selection: Binding(get: { item.tile.chart }, set: { if $0 != item.tile.chart { onChart($0) } })) {
                        Label("Line", systemImage: "chart.xyaxis.line").tag(DashboardChart.line)
                        Label("Bars", systemImage: "chart.bar").tag(DashboardChart.bar)
                    }
                    Button(role: .destructive) { onRemove() } label: { Label("Remove", systemImage: "trash") }
                } label: {
                    Image(systemName: "ellipsis.circle").imageScale(.large)
                }
                .menuStyle(.button)
                .buttonStyle(.borderless)
                .disabled(!canEdit)
                .accessibilityLabel("Tile options for \(title)")
            }
            if let s = item.series {
                let change = DashboardText.change(s)
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(s.latest.map { DashboardText.value($0.value, unit: s.unit) } ?? "No data yet")
                        .font(.title2.weight(.semibold)).monospacedDigit()
                    if let d = DashboardText.latestDay(s) { Text(d).font(.caption).foregroundStyle(.secondary) }
                }
                Text(change.text).font(.caption).foregroundStyle(.secondary)
                MetricChart(series: s, kind: item.tile.chart)
                    .frame(height: 120)
                    // A range just switched shows the old series until the new one arrives.
                    .opacity(s.days == item.tile.range ? 1 : 0.45)
                Text(DashboardText.period(s)).font(.caption).foregroundStyle(.secondary)
            } else {
                Text("Loading").font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity, minHeight: 120)
            }
            Picker("Range", selection: Binding(get: { item.tile.range }, set: { if $0 != item.tile.range { onRange($0) } })) {
                ForEach(DashboardTiles.ranges, id: \.self) { Text(DashboardText.rangeShort($0)).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .disabled(!canEdit)
        }
        .padding(14)
        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 14))
        .accessibilityElement(children: .contain)
    }
}

/// One metric's days as a line or bars. The line runs from reading to reading across days with none.
struct MetricChart: View {
    let series: MetricSeries
    let kind: DashboardChart

    private struct P: Identifiable { var id: String; var date: Date; var value: Double }

    var body: some View {
        let pts = series.points.compactMap { p -> P? in
            guard let v = p.value, let d = p.date else { return nil }
            return P(id: p.day, date: d, value: v)
        }
        if pts.isEmpty {
            Text("No readings in this range.").font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            let label = StyleGuard.dashes(series.label)
            Chart(pts) { p in
                if kind == .bar {
                    BarMark(x: .value("Day", p.date, unit: .day), y: .value(label, p.value))
                } else {
                    LineMark(x: .value("Day", p.date, unit: .day), y: .value(label, p.value)).interpolationMethod(.monotone)
                    if pts.count <= 45 { PointMark(x: .value("Day", p.date, unit: .day), y: .value(label, p.value)).symbolSize(14) }
                }
            }
            .chartXScale(domain: chartDomain)
            .chartYScale(domain: .automatic(includesZero: kind == .bar))
            .accessibilityLabel("\(label), \(DashboardText.rangeLabel(series.days))")
        }
    }

    /// The whole range, so a sparse metric still sits where its days are.
    private var chartDomain: ClosedRange<Date> {
        let from = DashboardText.date(series.from) ?? Date().addingTimeInterval(-Double(series.days) * 86400)
        let to = (DashboardText.date(series.to) ?? Date()).addingTimeInterval(86400)
        return from...max(to, from.addingTimeInterval(86400))
    }
}

/// Every metric that has data, grouped as the hub groups them. One already on the board can be added again for another range.
struct MetricPicker: View {
    @EnvironmentObject var engine: SyncEngine
    @Environment(\.dismiss) private var dismiss
    let shown: [String]
    let onPick: (MetricInfo) -> Void
    @State private var metrics: [MetricInfo]?
    @State private var problem: String?

    var body: some View {
        NavigationStack {
            List {
                if let problem { Text(problem).foregroundStyle(.red) }
                if metrics == nil && problem == nil { ProgressView() }
                if let m = metrics, m.isEmpty {
                    Text("Nothing to chart yet. Log something, finish a task or connect a sensor and it shows up here.").foregroundStyle(.secondary)
                }
                ForEach(DashboardTiles.groups(metrics ?? []), id: \.group) { g in
                    SwiftUI.Section(g.group) {
                        ForEach(g.metrics) { m in
                            Button { onPick(m) } label: {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(StyleGuard.dashes(m.label)).foregroundStyle(.primary)
                                    Text((m.count == 1 ? "1 entry" : "\(m.count.formatted()) entries") + (shown.contains(m.id) ? ", on the board" : ""))
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Add a tile")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .task {
                guard let c = engine.client else { problem = "Adding a tile needs the hub."; return }
                do { metrics = try await c.dashboardMetrics() } catch { problem = StyleGuard.dashes(error.localizedDescription) }
            }
        }
        #if os(macOS)
        .frame(minWidth: 380, minHeight: 420)
        #endif
    }
}
