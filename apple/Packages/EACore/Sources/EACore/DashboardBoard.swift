import Foundation

// The general dashboard (contract section 3, Dashboard): tiles of any metric over 7, 30, 90 or 365 days.
// The tile choice is one setting on the hub (`/prefs/dashboard`), so every device shows the same board.
// Decoding is lossy throughout: a tile or point the app does not understand is dropped, never fatal.

public enum DashboardChart: String, Codable, CaseIterable, Sendable { case line, bar }

/// Decodes each element on its own and keeps the ones that parse.
struct LossyList<T: Decodable>: Decodable {
    var items: [T]
    private struct Item: Decodable {
        var value: T?
        init(from decoder: Decoder) throws { value = try? T(from: decoder) }
    }
    init(from decoder: Decoder) throws { items = (try? [Item](from: decoder))?.compactMap(\.value) ?? [] }
}

public struct MetricSeriesPoint: Codable, Equatable, Hashable, Sendable {
    /// Local calendar day on the hub, `YYYY-MM-DD`.
    public var day: String
    /// Null on a day with no reading (counts and sums are 0 instead).
    public var value: Double?

    public init(day: String, value: Double?) { self.day = day; self.value = value }
    public var date: Date? { DashboardText.date(day) }
}

public struct MetricLatest: Codable, Equatable, Sendable {
    public var day: String
    public var value: Double
    public var at: String?
    public init(day: String, value: Double, at: String? = nil) { self.day = day; self.value = value; self.at = at }
}

/// One metric as a series of local days, with its newest value and the change against the period before.
public struct MetricSeries: Codable, Equatable, Sendable {
    public var metric: String
    public var label: String
    public var unit: String
    public var group: String
    public var agg: String
    public var chart: DashboardChart
    public var days: Int
    public var from: String
    public var to: String
    public var points: [MetricSeriesPoint]
    public var latest: MetricLatest?
    /// `total` for counts and sums, `average` for everything else.
    public var period: String
    public var current: Double?
    public var previous: Double?
    public var change: Double?
    public var change_pct: Double?

    public init(metric: String, label: String, unit: String = "", group: String = "", agg: String = "mean", chart: DashboardChart = .line, days: Int, from: String = "", to: String = "", points: [MetricSeriesPoint] = [], latest: MetricLatest? = nil, period: String = "average", current: Double? = nil, previous: Double? = nil, change: Double? = nil, change_pct: Double? = nil) {
        self.metric = metric; self.label = label; self.unit = unit; self.group = group; self.agg = agg; self.chart = chart; self.days = days
        self.from = from; self.to = to; self.points = points; self.latest = latest; self.period = period
        self.current = current; self.previous = previous; self.change = change; self.change_pct = change_pct
    }

    enum CodingKeys: String, CodingKey { case metric, label, unit, group, agg, chart, days, from, to, points, latest, period, current, previous, change, change_pct }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        metric = try c.decode(String.self, forKey: .metric)
        label = (try? c.decodeIfPresent(String.self, forKey: .label)) ?? metric
        unit = (try? c.decodeIfPresent(String.self, forKey: .unit)) ?? ""
        group = (try? c.decodeIfPresent(String.self, forKey: .group)) ?? ""
        agg = (try? c.decodeIfPresent(String.self, forKey: .agg)) ?? "mean"
        chart = (try? c.decodeIfPresent(DashboardChart.self, forKey: .chart)) ?? .line
        points = (try? c.decodeIfPresent(LossyList<MetricSeriesPoint>.self, forKey: .points))?.items ?? []
        days = (try? c.decodeIfPresent(Int.self, forKey: .days)) ?? points.count
        from = (try? c.decodeIfPresent(String.self, forKey: .from)) ?? points.first?.day ?? ""
        to = (try? c.decodeIfPresent(String.self, forKey: .to)) ?? points.last?.day ?? ""
        latest = (try? c.decodeIfPresent(MetricLatest.self, forKey: .latest))
        period = (try? c.decodeIfPresent(String.self, forKey: .period)) ?? "average"
        current = (try? c.decodeIfPresent(Double.self, forKey: .current))
        previous = (try? c.decodeIfPresent(Double.self, forKey: .previous))
        change = (try? c.decodeIfPresent(Double.self, forKey: .change))
        change_pct = (try? c.decodeIfPresent(Double.self, forKey: .change_pct))
    }
}

/// One tile of the board: which metric, over how many days, drawn how.
public struct DashboardTile: Codable, Equatable, Hashable, Sendable {
    public var metric: String
    public var range: Int
    public var chart: DashboardChart

    public init(metric: String, range: Int = 30, chart: DashboardChart = .line) { self.metric = metric; self.range = range; self.chart = chart }
}

/// A tile with its series, as `GET /dashboard/board` returns it.
public struct DashboardBoardTile: Codable, Equatable, Sendable {
    public var tile: DashboardTile
    public var series: MetricSeries?

    public init(tile: DashboardTile, series: MetricSeries?) { self.tile = tile; self.series = series }

    enum CodingKeys: String, CodingKey { case metric, range, chart, series }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        tile = DashboardTile(
            metric: try c.decode(String.self, forKey: .metric),
            range: (try? c.decodeIfPresent(Int.self, forKey: .range)) ?? 30,
            chart: (try? c.decodeIfPresent(DashboardChart.self, forKey: .chart)) ?? .line
        )
        series = (try? c.decodeIfPresent(MetricSeries.self, forKey: .series))
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(tile.metric, forKey: .metric)
        try c.encode(tile.range, forKey: .range)
        try c.encode(tile.chart, forKey: .chart)
        try c.encodeIfPresent(series, forKey: .series)
    }
}

/// `GET /dashboard/board`: every tile with its series. Also what the app keeps for showing while the hub is out of reach.
public struct DashboardBoard: Codable, Equatable, Sendable {
    public var tiles: [DashboardBoardTile]
    public var saved: Bool

    public init(tiles: [DashboardBoardTile], saved: Bool) { self.tiles = tiles; self.saved = saved }

    enum CodingKeys: String, CodingKey { case tiles, saved }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        tiles = (try? c.decodeIfPresent(LossyList<DashboardBoardTile>.self, forKey: .tiles))?.items ?? []
        saved = (try? c.decodeIfPresent(Bool.self, forKey: .saved)) ?? false
    }

    public var plainTiles: [DashboardTile] { tiles.map(\.tile) }
}

/// A metric that has data, from `GET /dashboard/metrics`.
public struct MetricInfo: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var label: String
    public var unit: String
    public var group: String
    public var chart: DashboardChart
    public var count: Int
    public var last_at: String?

    public init(id: String, label: String, unit: String = "", group: String = "", chart: DashboardChart = .line, count: Int = 0, last_at: String? = nil) {
        self.id = id; self.label = label; self.unit = unit; self.group = group; self.chart = chart; self.count = count; self.last_at = last_at
    }

    enum CodingKeys: String, CodingKey { case id, label, unit, group, chart, count, last_at }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        label = (try? c.decodeIfPresent(String.self, forKey: .label)) ?? id
        unit = (try? c.decodeIfPresent(String.self, forKey: .unit)) ?? ""
        group = (try? c.decodeIfPresent(String.self, forKey: .group)) ?? "Other"
        chart = (try? c.decodeIfPresent(DashboardChart.self, forKey: .chart)) ?? .line
        count = Int((try? c.decodeIfPresent(Double.self, forKey: .count)) ?? 0)
        last_at = (try? c.decodeIfPresent(String.self, forKey: .last_at))
    }
}

/// `GET` and `PUT /prefs/dashboard`.
public struct DashboardPrefs: Decodable, Equatable, Sendable {
    public var tiles: [DashboardTile]
    public var saved: Bool

    enum CodingKeys: String, CodingKey { case tiles, saved }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        tiles = (try? c.decodeIfPresent(LossyList<DashboardTile>.self, forKey: .tiles))?.items ?? []
        saved = (try? c.decodeIfPresent(Bool.self, forKey: .saved)) ?? false
    }
}

extension HubClient {
    /// `GET /dashboard/board`: every tile with its series, in one read.
    public func dashboardBoard() async throws -> DashboardBoard { try await get("dashboard/board", as: DashboardBoard.self) }

    /// `GET /dashboard/metrics`: the metrics that have data, for the add picker.
    public func dashboardMetrics() async throws -> [MetricInfo] {
        struct R: Decodable { var metrics: LossyList<MetricInfo>? }
        return try await get("dashboard/metrics", as: R.self).metrics?.items ?? []
    }

    /// `GET /dashboard/series?metric=&days=`.
    public func dashboardSeries(metric: String, days: Int) async throws -> MetricSeries {
        try await get("dashboard/series", query: ["metric": metric, "days": String(days)], as: MetricSeries.self)
    }

    /// `PUT /prefs/dashboard`: replaces the whole board, in order.
    public func setDashboardTiles(_ tiles: [DashboardTile]) async throws -> DashboardPrefs {
        struct B: Encodable { var tiles: [DashboardTile] }
        return try await post("prefs/dashboard", B(tiles: tiles), as: DashboardPrefs.self, method: "PUT")
    }
}

/// Pure tile edits. Each returns a new list; a move past either end or an add past the limit changes nothing.
public enum DashboardTiles {
    public static let ranges = [7, 30, 90, 365]
    public static let maxTiles = 24

    public static func move<T>(_ tiles: [T], from index: Int, by: Int) -> [T] {
        let to = index + by
        guard tiles.indices.contains(index), tiles.indices.contains(to) else { return tiles }
        var next = tiles
        next.swapAt(index, to)
        return next
    }

    public static func remove<T>(_ tiles: [T], at index: Int) -> [T] {
        guard tiles.indices.contains(index) else { return tiles }
        var next = tiles
        next.remove(at: index)
        return next
    }

    public static func add(_ tiles: [DashboardTile], metric: MetricInfo, range: Int = 30) -> [DashboardTile] {
        guard tiles.count < maxTiles else { return tiles }
        return tiles + [DashboardTile(metric: metric.id, range: range, chart: metric.chart)]
    }

    /// Metrics grouped in the hub's order (Body, Logs, Plan, Home, Homelab as they come).
    public static func groups(_ metrics: [MetricInfo]) -> [(group: String, metrics: [MetricInfo])] {
        var out: [(group: String, metrics: [MetricInfo])] = []
        for m in metrics {
            if let i = out.firstIndex(where: { $0.group == m.group }) { out[i].metrics.append(m) } else { out.append((m.group, [m])) }
        }
        return out
    }
}

/// The words on a tile, the same as the web app's.
public enum DashboardText {
    private static let dayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    /// A `YYYY-MM-DD` day key as local midnight.
    public static func date(_ day: String) -> Date? { dayFormatter.date(from: day) }

    public static func rangeLabel(_ days: Int) -> String {
        switch days {
        case 365: return "1 year"
        default: return "\(days) days"
        }
    }

    public static func rangeShort(_ days: Int) -> String { days == 365 ? "1y" : "\(days)d" }

    /// No trailing zeros, thousands grouped, one decimal from 10 up (none from 100 for whole numbers), two below.
    public static func number(_ v: Double) -> String {
        let a = abs(v)
        let digits = a >= 100 ? (v == v.rounded() ? 0 : 1) : a >= 10 ? 1 : 2
        let f = NumberFormatter()
        f.locale = Locale(identifier: "en_US")
        f.numberStyle = .decimal
        f.minimumFractionDigits = 0
        f.maximumFractionDigits = digits
        f.roundingMode = .halfUp
        return f.string(from: NSNumber(value: v)) ?? String(v)
    }

    /// "161.5 lb", "92%", "8,214 steps", "1 task".
    public static func value(_ v: Double?, unit: String) -> String {
        guard let v, v.isFinite else { return "no data" }
        let isWord = unit.count >= 3 && unit.hasSuffix("s") && unit.allSatisfy { $0.isLowercase && $0.isLetter }
        // Counted things past a hundred read as whole numbers: "3,065 steps", not "3,064.5 steps".
        let n = number(isWord && abs(v) >= 100 ? v.rounded() : v)
        if unit.isEmpty { return n }
        if unit == "%" { return "\(n)%" }
        return "\(n) \(n == "1" && isWord ? String(unit.dropLast()) : unit)"
    }

    public enum Direction: String, Sendable { case up, down, flat, none }

    /// "Up 2 lb (10%) from the 30 days before", "Same as the 7 days before", or nothing to compare.
    public static func change(_ s: MetricSeries) -> (text: String, direction: Direction) {
        let before = "the \(rangeLabel(s.days)) before"
        guard let change = s.change, s.previous != nil else { return ("Nothing to compare with \(before)", .none) }
        if abs(change) < 1e-9 { return ("Same as \(before)", .flat) }
        let up = change > 0
        let amount = s.unit == "%" ? "\(number(abs(change))) points" : value(abs(change), unit: s.unit)
        let pct = s.unit != "%" ? s.change_pct.map { " (\(number(abs($0)))%)" } ?? "" : ""
        return ("\(up ? "Up" : "Down") \(amount)\(pct) from \(before)", up ? .up : .down)
    }

    /// "Total 42 tasks over 30 days" or "Average 161.3 lb over 30 days".
    public static func period(_ s: MetricSeries) -> String {
        guard let cur = s.current else { return rangeLabel(s.days) }
        return "\(s.period == "total" ? "Total" : "Average") \(value(cur, unit: s.unit)) over \(rangeLabel(s.days))"
    }

    /// "today" or "Oct 3" for the latest value's day.
    public static func latestDay(_ s: MetricSeries) -> String? {
        guard let l = s.latest else { return nil }
        if l.day == s.to { return "today" }
        guard let d = date(l.day) else { return l.day }
        return d.formatted(.dateTime.month(.abbreviated).day())
    }
}
