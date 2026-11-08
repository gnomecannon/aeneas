import { describe, expect, it } from "vitest";
import { incidentSeconds, lastErrors, monitorFields, trafficLight, uptimePct, uptimeStrip, type CheckRow } from "./ops";

const m = (state?: string, enabled = true) => ({ fields: { state, enabled } });

describe("trafficLight", () => {
  it("is green with everything up", () => {
    const t = trafficLight([m("up"), m("up"), m("up")]);
    expect(t).toMatchObject({ up: 3, down: 0, unknown: 0, total: 3, tone: "ok", label: "All 3 up", detail: "" });
  });
  it("is red when anything is down and says the rest", () => {
    const t = trafficLight([m("up"), m("down"), m("down"), m(undefined)]);
    expect(t).toMatchObject({ up: 1, down: 2, unknown: 1, tone: "danger", label: "2 down", detail: "1 up, 1 unknown" });
  });
  it("is grey when nothing is down but something is unknown", () => {
    const t = trafficLight([m("up"), m("unknown")]);
    expect(t).toMatchObject({ tone: "muted", label: "1 unknown", detail: "1 up" });
  });
  it("ignores disabled monitors and handles none", () => {
    expect(trafficLight([m("down", false), m("up")]).label).toBe("All 1 up");
    expect(trafficLight([])).toMatchObject({ tone: "muted", label: "No monitors", total: 0 });
  });
});

const now = new Date("2026-10-23T12:00:00Z");
const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000).toISOString();

describe("uptimeStrip", () => {
  it("has one cell per check, in time order, when they fit", () => {
    const h: CheckRow[] = [
      { at: at(10), ok: true },
      { at: at(30), ok: false, error: "timeout" },
      { at: at(20), ok: true },
    ];
    const cells = uptimeStrip(h, { now, maxCells: 144 });
    expect(cells.map((c) => c.state)).toEqual(["fail", "ok", "ok"]);
    expect(cells[0].from).toBe(at(30));
    expect(cells.every((c) => c.checks === 1)).toBe(true);
  });
  it("drops checks outside the window", () => {
    const h: CheckRow[] = [
      { at: at(25 * 60), ok: false },
      { at: at(5), ok: true },
    ];
    expect(uptimeStrip(h, { now, hours: 24 }).map((c) => c.state)).toEqual(["ok"]);
  });
  it("buckets into equal time slices when there are more checks than cells, red when any check in the slice failed", () => {
    const h: CheckRow[] = [];
    for (let i = 0; i < 1440; i++) h.push({ at: at(i + 0.5), ok: true });
    h[700] = { at: at(700.5), ok: false, error: "refused" };
    const cells = uptimeStrip(h, { now, hours: 24, maxCells: 144 });
    expect(cells).toHaveLength(144);
    expect(cells.every((c) => c.checks === 10)).toBe(true);
    const red = cells.filter((c) => c.state === "fail");
    expect(red).toHaveLength(1);
    expect(red[0].fails).toBe(1);
    // 700.5 minutes ago is 739.5 minutes into the window, slice 73
    expect(cells.indexOf(red[0])).toBe(73);
  });
  it("marks empty slices as none", () => {
    const h: CheckRow[] = [];
    for (let i = 0; i < 20; i++) h.push({ at: at(i), ok: true });
    const cells = uptimeStrip(h, { now, hours: 24, maxCells: 4 });
    expect(cells.map((c) => c.state)).toEqual(["none", "none", "none", "ok"]);
  });
});

describe("uptimePct and errors", () => {
  it("rounds to one decimal and is null without checks", () => {
    expect(uptimePct([])).toBeNull();
    expect(uptimePct([{ at: at(1), ok: true }, { at: at(2), ok: true }, { at: at(3), ok: false }])).toBe(66.7);
  });
  it("lists the last distinct errors newest first", () => {
    const h: CheckRow[] = [
      { at: at(50), ok: false, error: "timeout" },
      { at: at(40), ok: false, error: "refused" },
      { at: at(30), ok: true },
      { at: at(20), ok: false, error: "refused" },
    ];
    expect(lastErrors(h).map((r) => r.error)).toEqual(["refused", "timeout"]);
  });
  it("measures incident durations", () => {
    expect(incidentSeconds({ opened_at: at(90), closed_at: at(30) })).toBe(3600);
    expect(incidentSeconds({ opened_at: at(10) }, now)).toBe(600);
  });
});

describe("monitorFields", () => {
  it("validates and converts the editor draft", () => {
    expect(monitorFields({ name: " hub ", host: "", type: "http", target: "http://x/health", expect: "ok", interval_s: "60", timeout_s: "5", fails_before_down: "3", enabled: true })).toEqual({
      name: "hub",
      host: null,
      type: "http",
      target: "http://x/health",
      expect: "ok",
      interval_s: 60,
      timeout_s: 5,
      fails_before_down: 3,
      enabled: true,
    });
    expect(() => monitorFields({ name: "", host: "", type: "ping", target: "x", expect: "", interval_s: "60", timeout_s: "5", fails_before_down: "3", enabled: true })).toThrow(/name/);
    expect(() => monitorFields({ name: "a", host: "", type: "ping", target: "x", expect: "", interval_s: "5", timeout_s: "5", fails_before_down: "3", enabled: true })).toThrow(/Interval/);
  });
});
