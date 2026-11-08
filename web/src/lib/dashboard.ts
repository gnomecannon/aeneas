/**
 * The general dashboard: types for the hub's board, series and tile setting (contract section 3, Dashboard), and the
 * pure pieces the screen and the chart are built from. No React here, so it is all testable.
 */

export type Agg = "mean" | "last" | "sum" | "count" | "pct";
export type ChartKind = "line" | "bar";
export const RANGES = [7, 30, 90, 365] as const;
export type Range = (typeof RANGES)[number];

export interface SeriesPoint {
  day: string;
  value: number | null;
}

export interface Series {
  metric: string;
  label: string;
  unit: string;
  group: string;
  agg: Agg;
  chart: ChartKind;
  days: number;
  from: string;
  to: string;
  points: SeriesPoint[];
  latest: { day: string; value: number; at?: string } | null;
  period: "total" | "average";
  current: number | null;
  previous: number | null;
  change: number | null;
  change_pct: number | null;
}

export interface Tile {
  metric: string;
  range: Range;
  chart: ChartKind;
}

export interface BoardTile extends Tile {
  series: Series | null;
}

export interface Board {
  tiles: BoardTile[];
  saved: boolean;
}

export interface MetricInfo {
  id: string;
  label: string;
  unit: string;
  group: string;
  agg: Agg;
  chart: ChartKind;
  count: number;
  last_at: string | null;
}

export interface DashboardPrefs {
  tiles: Tile[];
  saved: boolean;
  options: { ranges: number[]; charts: string[]; max_tiles: number };
}

export const MAX_TILES = 24;

export function rangeLabel(days: number): string {
  if (days === 7) return "7 days";
  if (days === 30) return "30 days";
  if (days === 90) return "90 days";
  if (days === 365) return "1 year";
  return `${days} days`;
}

/** The short form on a range switch. */
export function rangeShort(days: number): string {
  return days === 365 ? "1y" : `${days}d`;
}

/** A number for people: no trailing zeros, thousands grouped, at most one decimal past 100 and two below. */
export function formatNumber(v: number): string {
  const abs = Math.abs(v);
  const digits = abs >= 100 ? (Number.isInteger(v) ? 0 : 1) : abs >= 10 ? 1 : 2;
  const r = Number(v.toFixed(digits));
  return r.toLocaleString("en-US", { maximumFractionDigits: digits });
}

/** Value and unit as one string: "161.5 lb", "92%", "8,214 steps", "1 task". */
export function formatValue(v: number | null | undefined, unit: string): string {
  if (v == null || !Number.isFinite(v)) return "no data";
  // Counted things past a hundred read as whole numbers: "3,065 steps", not "3,064.5 steps".
  const counted = /^[a-z]{2,}s$/.test(unit);
  const n = formatNumber(counted && Math.abs(v) >= 100 ? Math.round(v) : v);
  if (!unit) return n;
  if (unit === "%") return `${n}%`;
  // A counted word goes singular for exactly one: "1 task", "1 cup"; short units (lb, mmHg, C) stay as they are.
  const word = n === "1" && /^[a-z]{2,}s$/.test(unit) ? unit.slice(0, -1) : unit;
  return `${n} ${word}`;
}

/**
 * The change line: "Up 3 lb (1.2%) from the 30 days before", "Same as the 7 days before", or nothing to compare.
 * `direction` is only up or down; whether that is good is left to the person.
 */
export function describeChange(s: Pick<Series, "change" | "change_pct" | "unit" | "days" | "period" | "previous">): { text: string; direction: "up" | "down" | "flat" | "none" } {
  const before = `the ${rangeLabel(s.days)} before`;
  if (s.change == null || s.previous == null) return { text: `Nothing to compare with ${before}`, direction: "none" };
  if (Math.abs(s.change) < 1e-9) return { text: `Same as ${before}`, direction: "flat" };
  const dir = s.change > 0 ? "up" : "down";
  const amount = s.unit === "%" ? `${formatNumber(Math.abs(s.change))} points` : formatValue(Math.abs(s.change), s.unit);
  const pct = s.change_pct != null && s.unit !== "%" ? ` (${formatNumber(Math.abs(s.change_pct))}%)` : "";
  return { text: `${dir === "up" ? "Up" : "Down"} ${amount}${pct} from ${before}`, direction: dir };
}

/** "Total 42 tasks" or "Average 161.3 lb" for the period. */
export function describePeriod(s: Pick<Series, "current" | "unit" | "period">): string {
  if (s.current == null) return "";
  return `${s.period === "total" ? "Total" : "Average"} ${formatValue(s.current, s.unit)}`;
}

// ---------- tile list edits (pure, return new arrays) ----------

export function moveTile<T>(tiles: T[], index: number, by: -1 | 1): T[] {
  const to = index + by;
  if (index < 0 || index >= tiles.length || to < 0 || to >= tiles.length) return tiles;
  const next = tiles.slice();
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}

export function removeTile<T>(tiles: T[], index: number): T[] {
  return tiles.filter((_, i) => i !== index);
}

/** A new tile at the end, with the metric's suggested chart. Refused (unchanged) past the limit. */
export function addTile(tiles: Tile[], m: Pick<MetricInfo, "id" | "chart">, range: Range = 30): Tile[] {
  if (tiles.length >= MAX_TILES) return tiles;
  return [...tiles, { metric: m.id, range, chart: m.chart }];
}

/** Just the setting part, for PUT /prefs/dashboard. */
export function tilesOf(board: Pick<BoardTile, "metric" | "range" | "chart">[]): Tile[] {
  return board.map(({ metric, range, chart }) => ({ metric, range, chart }));
}

/** Metrics for the add picker, grouped in the hub's order, already shown ones marked. */
export function pickerGroups(metrics: MetricInfo[], shown: string[]): { group: string; metrics: (MetricInfo & { shown: boolean })[] }[] {
  const out: { group: string; metrics: (MetricInfo & { shown: boolean })[] }[] = [];
  for (const m of metrics) {
    let g = out.find((x) => x.group === m.group);
    if (!g) out.push((g = { group: m.group, metrics: [] }));
    g.metrics.push({ ...m, shown: shown.includes(m.id) });
  }
  return out;
}

// ---------- chart geometry ----------

/** A point to draw: `x` from 0 (left) to 1 (right); null values leave a gap. */
export interface ChartPoint {
  x: number;
  value: number | null;
  label: string;
}

/** Day series: evenly spaced, oldest left. */
export function dayPoints(points: SeriesPoint[]): ChartPoint[] {
  const n = points.length;
  return points.map((p, i) => ({ x: n <= 1 ? 0.5 : i / (n - 1), value: p.value, label: p.day }));
}

/** Raw timed readings (a sensor's last 24 hours) placed by time between `start` and `end`. */
export function timePoints(points: { at: string; value: number }[], start: number, end: number): ChartPoint[] {
  const span = end - start || 1;
  return points
    .map((p) => ({ t: new Date(p.at).getTime(), value: p.value, label: p.at }))
    .filter((p) => Number.isFinite(p.t) && p.t >= start && p.t <= end && Number.isFinite(p.value))
    .sort((a, b) => a.t - b.t)
    .map((p) => ({ x: (p.t - start) / span, value: p.value, label: p.label }));
}

export interface Geometry {
  min: number;
  max: number;
  /** Line: through every reading, oldest first. */
  path: string;
  /** Line: a dot per reading while they are few enough to see one by one. */
  dots: { cx: number; cy: number; value: number; label: string }[];
  bars: { x: number; y: number; w: number; h: number; value: number; label: string }[];
  /** y of the zero line for bars, of the floor for lines. */
  baseline: number;
  /** y for each dashed bound (a sensor's min and max). */
  bounds: { value: number; y: number }[];
  empty: boolean;
}

/**
 * Where everything goes in a `width` by `height` box. Bars start at zero; lines fit their data with a little
 * headroom. Bounds widen the range so a threshold is always on screen.
 */
export function chartGeometry(points: ChartPoint[], opts: { kind: ChartKind; width: number; height: number; pad?: number; bounds?: number[]; denseAt?: number }): Geometry {
  const { kind, width: w, height: h } = opts;
  const pad = opts.pad ?? 4;
  const vals = points.map((p) => p.value).filter((v): v is number => v != null && Number.isFinite(v));
  const boundVals = (opts.bounds ?? []).filter((v) => Number.isFinite(v));
  const empty = vals.length === 0;
  let min = Math.min(...vals, ...boundVals);
  let max = Math.max(...vals, ...boundVals);
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = 0;
    max = 1;
  }
  if (kind === "bar") {
    min = Math.min(0, min);
    max = Math.max(0, max);
  } else if (max === min) {
    const d = Math.abs(max) * 0.05 || 1;
    min -= d;
    max += d;
  } else {
    const head = (max - min) * 0.08;
    min -= head;
    max += head;
  }
  if (max === min) max = min + 1;
  const innerW = w - 2 * pad;
  const innerH = h - 2 * pad;
  const y = (v: number) => pad + (1 - (v - min) / (max - min)) * innerH;
  const baseline = kind === "bar" ? y(0) : h - pad;
  const bounds = boundVals.map((value) => ({ value, y: y(value) }));

  if (kind === "bar") {
    const n = Math.max(points.length, 1);
    const slot = innerW / n;
    const bw = Math.max(1, slot * (n > 60 ? 0.9 : 0.7));
    const bars = points.flatMap((p, i) => {
      if (p.value == null || !Number.isFinite(p.value)) return [];
      const top = Math.min(y(p.value), baseline);
      const height = Math.abs(baseline - y(p.value));
      return [{ x: pad + i * slot + (slot - bw) / 2, y: top, w: bw, h: Math.max(height, p.value === 0 ? 0 : 1), value: p.value, label: p.label }];
    });
    return { min, max, path: "", dots: [], bars, baseline, bounds, empty };
  }

  // Measurements are often sparse (weight every few days): the line runs from reading to reading across empty days.
  const xOf = (p: ChartPoint) => pad + p.x * innerW;
  const real = points.filter((p): p is ChartPoint & { value: number } => p.value != null && Number.isFinite(p.value));
  const path = real.map((p, i) => `${i ? "L" : "M"}${xOf(p).toFixed(1)},${y(p.value).toFixed(1)}`).join("");
  const dense = real.length > (opts.denseAt ?? 45);
  const dots = (dense ? [] : real).map((p) => ({ cx: xOf(p), cy: y(p.value), value: p.value, label: p.label }));
  return { min, max, path, dots, bars: [], baseline, bounds, empty };
}

/** "Oct 3" for a day key, read as a local date (no time zone shift). */
export function shortDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return day;
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** The board as last seen, for showing while the hub is out of reach. Never throws. */
export function readCachedBoard(raw: string | null): Board | null {
  if (!raw) return null;
  try {
    const b = JSON.parse(raw) as Board;
    return Array.isArray(b?.tiles) ? b : null;
  } catch {
    return null;
  }
}
