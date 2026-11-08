import { describe, expect, it } from "vitest";
import {
  MAX_TILES,
  addTile,
  chartGeometry,
  dayPoints,
  describeChange,
  describePeriod,
  formatNumber,
  formatValue,
  moveTile,
  pickerGroups,
  readCachedBoard,
  removeTile,
  shortDay,
  tilesOf,
  timePoints,
  type MetricInfo,
  type Tile,
} from "./dashboard";

const series = (over: Record<string, unknown> = {}) => ({ change: 2, change_pct: 10, unit: "lb", days: 30, period: "average" as const, previous: 20, current: 22, ...over });

describe("formatting", () => {
  it("drops trailing zeros, groups thousands and keeps units readable", () => {
    expect(formatNumber(241.5)).toBe("241.5");
    expect(formatNumber(8214)).toBe("8,214");
    expect(formatNumber(7.25)).toBe("7.25");
    expect(formatNumber(12.345)).toBe("12.3");
    expect(formatValue(92.5, "%")).toBe("92.5%");
    expect(formatValue(3, "")).toBe("3");
    expect(formatValue(8214, "steps")).toBe("8,214 steps");
    expect(formatValue(3064.5, "steps")).toBe("3,065 steps");
    expect(formatValue(1.5, "cups")).toBe("1.5 cups");
    expect(formatValue(null, "lb")).toBe("no data");
    expect(formatValue(1, "tasks")).toBe("1 task");
    expect(formatValue(1, "lbs")).toBe("1 lb");
    expect(formatValue(2, "tasks")).toBe("2 tasks");
    expect(formatValue(1, "C")).toBe("1 C");
  });
  it("says the change in plain words, with no dashes", () => {
    expect(describeChange(series())).toEqual({ text: "Up 2 lb (10%) from the 30 days before", direction: "up" });
    expect(describeChange(series({ change: -1.5, change_pct: -6.8, days: 7 })).text).toBe("Down 1.5 lb (6.8%) from the 7 days before");
    expect(describeChange(series({ change: 0, change_pct: 0 })).direction).toBe("flat");
    expect(describeChange(series({ change: null, previous: null, days: 365 })).text).toBe("Nothing to compare with the 1 year before");
    expect(describeChange(series({ unit: "%", change: -25, change_pct: -25 })).text).toBe("Down 25 points from the 30 days before");
    for (const s of [series(), series({ change: -3 })]) expect(describeChange(s).text).not.toMatch(/[–—]/);
  });
  it("names the period's number as a total or an average", () => {
    expect(describePeriod({ current: 42, unit: "tasks", period: "total" })).toBe("Total 42 tasks");
    expect(describePeriod({ current: 161.33, unit: "lb", period: "average" })).toBe("Average 161.3 lb");
    expect(describePeriod({ current: null, unit: "lb", period: "average" })).toBe("");
  });
  it("reads a day key as a local date", () => {
    expect(shortDay("2026-10-03")).toBe("Oct 3");
    expect(shortDay("bad")).toBe("bad");
  });
});

describe("tile edits", () => {
  const t = (metric: string): Tile => ({ metric, range: 30, chart: "line" });
  it("moves a tile one place and refuses to move past either end", () => {
    const tiles = [t("a"), t("b"), t("c")];
    expect(moveTile(tiles, 1, -1).map((x) => x.metric)).toEqual(["b", "a", "c"]);
    expect(moveTile(tiles, 1, 1).map((x) => x.metric)).toEqual(["a", "c", "b"]);
    expect(moveTile(tiles, 0, -1)).toBe(tiles);
    expect(moveTile(tiles, 2, 1)).toBe(tiles);
    expect(tiles.map((x) => x.metric)).toEqual(["a", "b", "c"]);
  });
  it("removes by index and adds with the metric's suggested chart, up to the limit", () => {
    expect(removeTile([t("a"), t("b")], 0).map((x) => x.metric)).toEqual(["b"]);
    expect(addTile([t("a")], { id: "tasks:done", chart: "bar" }, 7)).toEqual([t("a"), { metric: "tasks:done", range: 7, chart: "bar" }]);
    const full = Array.from({ length: MAX_TILES }, (_, i) => t(`m${i}`));
    expect(addTile(full, { id: "x", chart: "bar" })).toBe(full);
  });
  it("strips series before saving", () => {
    expect(tilesOf([{ metric: "a", range: 7, chart: "bar", series: null } as never])).toEqual([{ metric: "a", range: 7, chart: "bar" }]);
  });
  it("groups the picker in the hub's order and marks what is on the board", () => {
    const m = (id: string, group: string): MetricInfo => ({ id, label: id, unit: "", group, agg: "mean", chart: "line", count: 1, last_at: null });
    const g = pickerGroups([m("log:weight", "Body"), m("tasks:done", "Plan"), m("log:mood", "Body")], ["log:mood"]);
    expect(g.map((x) => x.group)).toEqual(["Body", "Plan"]);
    expect(g[0].metrics.map((x) => [x.id, x.shown])).toEqual([["log:weight", false], ["log:mood", true]]);
  });
  it("reads a cached board and ignores anything broken", () => {
    expect(readCachedBoard(JSON.stringify({ tiles: [], saved: true }))).toEqual({ tiles: [], saved: true });
    expect(readCachedBoard("{nope")).toBeNull();
    expect(readCachedBoard(JSON.stringify({ tiles: "x" }))).toBeNull();
    expect(readCachedBoard(null)).toBeNull();
  });
});

describe("chart geometry", () => {
  const pts = dayPoints([
    { day: "2026-10-01", value: 10 },
    { day: "2026-10-02", value: null },
    { day: "2026-10-03", value: 20 },
    { day: "2026-10-04", value: 30 },
  ]);
  it("spaces days evenly from left to right", () => {
    expect(pts.map((p) => p.x)).toEqual([0, 1 / 3, 2 / 3, 1]);
    expect(dayPoints([{ day: "2026-10-01", value: 1 }])[0].x).toBe(0.5);
  });
  it("runs the line across empty days and dots each reading while they are few", () => {
    const g = chartGeometry(pts, { kind: "line", width: 100, height: 50, pad: 0 });
    expect(g.path.match(/M/g)?.length).toBe(1);
    expect(g.path.match(/L/g)?.length).toBe(2);
    expect(g.path.startsWith("M0.0,")).toBe(true);
    expect(g.dots.length).toBe(3);
    expect(g.empty).toBe(false);
    // Higher values sit higher (smaller y).
    expect(g.dots[2].cy).toBeLessThan(g.dots[0].cy);
    const dense = chartGeometry(dayPoints(Array.from({ length: 100 }, (_, i) => ({ day: `d${i}`, value: i === 50 ? null : i }))), { kind: "line", width: 100, height: 50 });
    expect(dense.dots.length).toBe(0);
  });
  it("starts bars at zero, skips empty days and keeps a zero day flat", () => {
    const g = chartGeometry(dayPoints([{ day: "a", value: 0 }, { day: "b", value: null }, { day: "c", value: 4 }]), { kind: "bar", width: 90, height: 40, pad: 0 });
    expect(g.min).toBe(0);
    expect(g.max).toBe(4);
    expect(g.bars.length).toBe(2);
    expect(g.bars[0].h).toBe(0);
    expect(g.bars[1].h).toBe(40);
    expect(g.bars[1].y).toBe(0);
    expect(g.baseline).toBe(40);
  });
  it("widens the range to show thresholds, and says when there is nothing to draw", () => {
    const g = chartGeometry(dayPoints([{ day: "a", value: 20 }, { day: "b", value: 22 }]), { kind: "line", width: 100, height: 50, bounds: [15, 30] });
    expect(g.min).toBeLessThan(15);
    expect(g.max).toBeGreaterThan(30);
    expect(g.bounds.map((b) => b.value)).toEqual([15, 30]);
    expect(chartGeometry(dayPoints([{ day: "a", value: null }]), { kind: "line", width: 10, height: 10 }).empty).toBe(true);
    const flat = chartGeometry(dayPoints([{ day: "a", value: 5 }, { day: "b", value: 5 }]), { kind: "line", width: 10, height: 10 });
    expect(flat.max).toBeGreaterThan(flat.min);
  });
  it("places timed readings by time and drops ones outside the window", () => {
    const start = Date.parse("2026-10-29T00:00:00Z");
    const end = Date.parse("2026-10-29T10:00:00Z");
    const tp = timePoints(
      [
        { at: "2026-10-29T05:00:00Z", value: 2 },
        { at: "2026-10-28T23:00:00Z", value: 1 },
        { at: "2026-10-29T00:00:00Z", value: 3 },
      ],
      start,
      end,
    );
    expect(tp.map((p) => [p.x, p.value])).toEqual([[0, 3], [0.5, 2]]);
  });
});
