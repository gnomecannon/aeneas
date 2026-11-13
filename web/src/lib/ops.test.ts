import { describe, expect, it } from "vitest";
import { agoWords, hubLineText, incidentSeconds, isBackup, jobLine, lastErrors, monitorFields, trafficLight, uptimePct, uptimeStrip, type CheckRow } from "./ops";

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
  it("cuts the window by time, so a gap stays empty instead of looking like a full green day", () => {
    const h: CheckRow[] = [
      { at: at(10), ok: true },
      { at: at(30), ok: false, error: "timeout" },
      { at: at(20), ok: true },
    ];
    const cells = uptimeStrip(h, { now, maxCells: 144 });
    expect(cells).toHaveLength(144);
    expect(cells.filter((c) => c.state !== "none").map((c) => [cells.indexOf(c), c.state])).toEqual([[141, "fail"], [142, "ok"], [143, "ok"]]);
  });
  it("has a slice per interval when the monitor checks less often (a backup every 15 minutes)", () => {
    const h: CheckRow[] = [];
    for (let i = 0; i < 96; i++) h.push({ at: at(i * 15 + 7), ok: true });
    const cells = uptimeStrip(h, { now, intervalS: 900 });
    expect(cells).toHaveLength(96);
    expect(cells.every((c) => c.checks === 1)).toBe(true);
  });
  it("drops checks outside the window", () => {
    const h: CheckRow[] = [
      { at: at(25 * 60), ok: false },
      { at: at(5), ok: true },
    ];
    expect(uptimeStrip(h, { now, hours: 24 }).filter((c) => c.state !== "none").map((c) => c.state)).toEqual(["ok"]);
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

describe("backup job lines", () => {
  const now = new Date("2026-11-13T19:00:00Z");
  it("say how long ago in the hub's words", () => {
    expect(agoWords("2026-11-13T18:20:00Z", now)).toBe("40 min ago");
    expect(agoWords("2026-11-13T09:00:00Z", now)).toBe("10 h ago");
    expect(agoWords("2026-11-01T11:33:00Z", now)).toBe("12 days ago");
  });
  it("give each job a label, a tone and what to say", () => {
    expect(jobLine({ job: "backup", state: "ok", last_good: "2026-11-13T09:00:00Z", max_hours: 28 }, now)).toEqual({ label: "Backup", tone: "ok", text: "last good 10 h ago", at: "2026-11-13T09:00:00Z" });
    expect(jobLine({ job: "verify", state: "ok", running: true, last_good: "2026-11-12T09:18:00Z", max_hours: 200 }, now).text).toBe("running now; last good 34 h ago");
    expect(jobLine({ job: "verify", state: "stale", last_good: "2026-11-03T09:18:00Z", max_hours: 200 }, now)).toMatchObject({ label: "Verification", tone: "danger", text: "last good 10 days ago, over the 200 h limit" });
    expect(jobLine({ job: "backup", state: "failed", last_run: "2026-11-13T08:15:00Z", last_good: "2026-11-12T08:17:00Z", max_hours: 28 }, now)).toMatchObject({ tone: "danger", text: "failed 11 h ago; last good 35 h ago", at: "2026-11-13T08:15:00Z" });
    expect(jobLine({ job: "restore", state: "never", max_hours: 900 }, now)).toMatchObject({ label: "Restore test", tone: "danger", text: "no good run on record" });
    expect(jobLine({ job: "backup", state: "missing", max_hours: 28 }, now).text).toBe("not set up on this machine");
    // A machine away keeps its last read: fine then, past its limit now.
    expect(jobLine({ job: "backup", state: "ok", last_good: "2026-11-11T09:00:00Z", max_hours: 28 }, now)).toMatchObject({ tone: "danger", text: "last good 2 days ago, over the 28 h limit" });
  });
  it("say the hub's own backup lines", () => {
    expect(hubLineText({ label: "Nightly copy", ok: true, at: "2026-11-13T08:00:00Z", text: "30 kept, encrypted" }, now)).toBe("last 11 h ago; 30 kept, encrypted");
    expect(hubLineText({ label: "Live copy", ok: true, text: "running" }, now)).toBe("running");
    expect(hubLineText({ label: "Copy to storage", ok: false, at: null, text: "" }, now)).toBe("not fine");
  });
  it("tell backup machines from the other monitors", () => {
    expect(isBackup({ fields: { type: "backup" } })).toBe(true);
    expect(isBackup({ fields: { type: "ping" } })).toBe(false);
  });
});
