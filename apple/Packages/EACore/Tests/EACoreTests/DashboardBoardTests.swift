import XCTest
@testable import EACore

final class DashboardBoardTests: XCTestCase {
    private func series(change: Double? = 2, pct: Double? = 10, unit: String = "lb", days: Int = 30, previous: Double? = 20, current: Double? = 22, period: String = "average") -> MetricSeries {
        MetricSeries(metric: "log:weight", label: "Weight", unit: unit, days: days, to: "2026-10-29", period: period, current: current, previous: previous, change: change, change_pct: pct)
    }

    func testDecodesTheBoardLossily() throws {
        let json = """
        {"saved": true, "tiles": [
          {"metric": "log:weight", "range": 30, "chart": "line", "series": {"metric": "log:weight", "label": "Weight", "unit": "lb", "group": "Body", "agg": "mean", "chart": "line", "days": 30,
            "from": "2026-09-30", "to": "2026-10-29", "points": [{"day": "2026-10-28", "value": null}, {"day": "2026-10-29", "value": 241.5}, {"bad": 1}],
            "latest": {"day": "2026-10-29", "value": 241.5, "at": "2026-10-29T11:00:00.000Z"}, "period": "average", "current": 242, "previous": 245, "change": -3, "change_pct": -1.22, "future_field": [1, 2]}},
          {"range": 7},
          {"metric": "tasks:done", "range": 7, "chart": "pie", "series": "garbage"}
        ]}
        """
        let b = try JSONCoding.decode(DashboardBoard.self, from: json)
        XCTAssertTrue(b.saved)
        XCTAssertEqual(b.tiles.count, 2, "a tile without a metric is dropped")
        XCTAssertEqual(b.tiles[0].series?.points.count, 2)
        XCTAssertNil(b.tiles[0].series?.points[0].value)
        XCTAssertEqual(b.tiles[0].series?.latest?.value, 241.5)
        XCTAssertEqual(b.tiles[1].tile, DashboardTile(metric: "tasks:done", range: 7, chart: .line), "an unknown chart falls back to line")
        XCTAssertNil(b.tiles[1].series)

        // The cached copy comes back the same.
        let again = try JSONCoding.decode(DashboardBoard.self, from: try JSONCoding.data(b))
        XCTAssertEqual(again, b)
        XCTAssertEqual(b.plainTiles.map(\.metric), ["log:weight", "tasks:done"])
    }

    func testDecodesMetricsAndPrefs() throws {
        let m = try JSONCoding.decode([MetricInfo].self, from: #"[{"id":"sensor:attic","label":"attic","unit":"C","group":"Home","chart":"line","count":12,"last_at":null}]"#)
        XCTAssertEqual(m.first?.count, 12)
        let p = try JSONCoding.decode(DashboardPrefs.self, from: #"{"tiles":[{"metric":"log:steps","range":30,"chart":"bar"},{"nope":true}],"saved":false,"options":{}}"#)
        XCTAssertEqual(p.tiles, [DashboardTile(metric: "log:steps", range: 30, chart: .bar)])
        XCTAssertFalse(p.saved)
    }

    func testTileEdits() {
        let t = ["a", "b", "c"].map { DashboardTile(metric: $0) }
        XCTAssertEqual(DashboardTiles.move(t, from: 1, by: -1).map(\.metric), ["b", "a", "c"])
        XCTAssertEqual(DashboardTiles.move(t, from: 2, by: 1), t)
        XCTAssertEqual(DashboardTiles.move(t, from: 0, by: -1), t)
        XCTAssertEqual(DashboardTiles.remove(t, at: 1).map(\.metric), ["a", "c"])
        XCTAssertEqual(DashboardTiles.remove(t, at: 9), t)
        let added = DashboardTiles.add(t, metric: MetricInfo(id: "tasks:done", label: "Tasks done", chart: .bar), range: 7)
        XCTAssertEqual(added.last, DashboardTile(metric: "tasks:done", range: 7, chart: .bar))
        let full = (0..<DashboardTiles.maxTiles).map { DashboardTile(metric: "m\($0)") }
        XCTAssertEqual(DashboardTiles.add(full, metric: MetricInfo(id: "x", label: "x")).count, DashboardTiles.maxTiles)
        let g = DashboardTiles.groups([MetricInfo(id: "w", label: "w", group: "Body"), MetricInfo(id: "t", label: "t", group: "Plan"), MetricInfo(id: "m", label: "m", group: "Body")])
        XCTAssertEqual(g.map(\.group), ["Body", "Plan"])
        XCTAssertEqual(g[0].metrics.map(\.id), ["w", "m"])
    }

    func testWordsMatchTheWebApp() {
        XCTAssertEqual(DashboardText.number(241.5), "241.5")
        XCTAssertEqual(DashboardText.number(8214), "8,214")
        XCTAssertEqual(DashboardText.number(7.25), "7.25")
        XCTAssertEqual(DashboardText.number(12.345), "12.3")
        XCTAssertEqual(DashboardText.value(92.5, unit: "%"), "92.5%")
        XCTAssertEqual(DashboardText.value(1, unit: "tasks"), "1 task")
        XCTAssertEqual(DashboardText.value(1, unit: "lbs"), "1 lb")
        XCTAssertEqual(DashboardText.value(2, unit: "tasks"), "2 tasks")
        XCTAssertEqual(DashboardText.value(3064.5, unit: "steps"), "3,065 steps")
        XCTAssertEqual(DashboardText.value(1.5, unit: "cups"), "1.5 cups")
        XCTAssertEqual(DashboardText.value(1, unit: "C"), "1 C")
        XCTAssertEqual(DashboardText.value(nil, unit: "lb"), "no data")
        XCTAssertEqual(DashboardText.change(series()).text, "Up 2 lb (10%) from the 30 days before")
        XCTAssertEqual(DashboardText.change(series(change: -1.5, pct: -6.8, days: 7)).text, "Down 1.5 lb (6.8%) from the 7 days before")
        XCTAssertEqual(DashboardText.change(series(change: 0, pct: 0)).direction, .flat)
        XCTAssertEqual(DashboardText.change(series(change: nil, days: 365, previous: nil)).text, "Nothing to compare with the 1 year before")
        XCTAssertEqual(DashboardText.change(series(change: -25, pct: -25, unit: "%")).text, "Down 25 points from the 30 days before")
        XCTAssertEqual(DashboardText.period(series(unit: "tasks", current: 42, period: "total")), "Total 42 tasks over 30 days")
        XCTAssertEqual(DashboardText.rangeShort(365), "1y")
        for s in [series(), series(change: -3)] {
            let t = DashboardText.change(s).text
            XCTAssertFalse(t.contains("\u{2014}") || t.contains("\u{2013}"))
        }
    }

    func testDayKeysAreLocalDates() {
        let d = DashboardText.date("2026-10-03")!
        let parts = Calendar.current.dateComponents([.year, .month, .day, .hour], from: d)
        XCTAssertEqual([parts.year, parts.month, parts.day, parts.hour], [2026, 10, 3, 0])
        var s = series()
        s.latest = MetricLatest(day: "2026-10-29", value: 1)
        XCTAssertEqual(DashboardText.latestDay(s), "today")
    }
}
