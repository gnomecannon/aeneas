import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeBackend, fastestFirst, type Backend, type Residency } from "../src/ai/backends.js";

const at = (host: string, r: Residency): Backend => ({ ...fakeBackend(), host, residency: async () => r });

test("routing: the backend holding the whole model on its GPU answers first; ties keep the configured order", async () => {
  const cloud: Backend = { ...fakeBackend(), name: "anthropic", host: "cloud" };
  const order = async (...b: Backend[]) => (await fastestFirst(b)).map((x) => x.host);
  // Core fit: core stays first even when desk-pc is warm too.
  assert.deepEqual(await order(at("core", "gpu"), at("desk-pc", "gpu")), ["core", "desk-pc"]);
  assert.deepEqual(await order(at("core", "cold"), at("desk-pc", "cold")), ["core", "desk-pc"]);
  // A game on core spills the model to the CPU: desk-pc goes first, warm or not.
  assert.deepEqual(await order(at("core", "partial"), at("desk-pc", "gpu")), ["desk-pc", "core"]);
  assert.deepEqual(await order(at("core", "partial"), at("desk-pc", "cold")), ["desk-pc", "core"]);
  // A sleeping desk-pc is never preferred, and spilled on both keeps core.
  assert.deepEqual(await order(at("core", "partial"), at("desk-pc", "down")), ["core", "desk-pc"]);
  assert.deepEqual(await order(at("core", "partial"), at("desk-pc", "partial")), ["core", "desk-pc"]);
  // The cloud keeps its place in the chain.
  assert.deepEqual(await order(cloud, at("core", "partial"), at("desk-pc", "gpu")), ["cloud", "desk-pc", "core"]);
});

test("ops_status: the model gets every monitor with backup detail and incident notes, small enough to never be cut", async () => {
  const { opsForModel, renderResult } = await import("../src/ai/tools.js");
  const mon = (i: number, extra: Record<string, unknown> = {}) => ({ id: `m${i}`, kind: "monitor", created_at: "x", updated_at: "x", fields: { name: `host${i} ping`, type: "ping", host: `host${i}`, target: "10.0.0.1", interval_s: 120, timeout_s: 5, fails_before_down: 3, enabled: true, state: "up", last_check: "2026-10-29T21:00:00.000Z", last_ok: "2026-10-29T21:00:00.000Z", last_latency_ms: 4, consecutive_fails: 0, ...extra } });
  const d = {
    monitors: [...Array.from({ length: 40 }, (_, i) => mon(i)), mon(99, { name: "Laptop backup", type: "backup", host: "laptop", state: "down", last_detail: "last good backup 2026-10-28 08:07 UTC (33 h ago)", last_error: "backup failed: Found 44 fatal error(s)" })],
    incidents_open: [{ fields: { name: "core ping (LAN)", opened_at: "2026-10-26T22:44:08.975Z", last_error: "ping exit 1", checks_failed: 1155, acknowledged_at: "2026-10-28T19:28:53.828Z", ack_note: "moved back to wifi" } }],
    incidents_7d: 2, uptime_24h: [{ name: "a", pct: 100 }, { name: "Laptop backup", pct: 40 }], watches_due_30d: [], journal_recent: [],
  };
  const text = renderResult(opsForModel(d));
  assert.ok(!text.includes("[cut"), `fits: ${text.length} chars`);
  // Backup detail times come in local time with the offset, like every other time the model reads.
  assert.match(text, /"name":"Laptop backup","type":"backup","state":"down","detail":"last good backup 2026-10-28T\d\d:07[+-]\d\d:\d\d \(33 h ago\)","error":"backup failed: Found 44 fatal error\(s\)"/);
  assert.match(text, /"monitor":"core ping \(LAN\)".*"owner_note":"moved back to wifi"/);
  assert.match(text, /"uptime_below_100_today":\[\{"name":"Laptop backup","pct":40\}\]/);
  const backups = opsForModel(d, "backup") as { monitors: unknown[] };
  assert.equal(backups.monitors.length, 1);
});

test("the clock names the next seven days, so Sunday lands on Sunday", async () => {
  const { comingDays, clockLine } = await import("../src/ai/prompt.js");
  const fri = new Date(2026, 9, 30, 0, 45);
  assert.equal(comingDays(fri), "Coming days: tomorrow Saturday 2026-10-31, Sunday 2026-11-01, Monday 2026-11-02, Tuesday 2026-11-03, Wednesday 2026-11-04, Thursday 2026-11-05, Friday 2026-11-06.");
  assert.match(clockLine(fri), /^Today is Friday 2026-10-30\. .*Past days: yesterday Thursday 2026-10-29, Wednesday 2026-10-28, .*Coming days: tomorrow Saturday 2026-10-31, Sunday 2026-11-01/);
});

test("after midnight the clock says the owner's day is still the one before until 4 AM", async () => {
  const { clockLine, lateNight } = await import("../src/ai/prompt.js");
  assert.equal(lateNight(new Date(2026, 10, 2, 9)), "");
  const line = clockLine(new Date(2026, 10, 2, 0, 30));
  assert.match(line, /"today" or "tonight" belong to Sunday 2026-11-01/);
  assert.match(line, /"tomorrow" means Monday 2026-11-02/);
});

test("the clock says which days this weekend is, today included on a weekend day", async () => {
  const { weekendLine } = await import("../src/ai/prompt.js");
  const tail = "next weekend is Saturday 2026-11-07 and Sunday 2026-11-08.";
  assert.equal(weekendLine(new Date(2026, 9, 28, 9)), `This weekend is Saturday 2026-10-31 and Sunday 2026-11-01; ${tail}`, "a Wednesday: the coming one");
  assert.equal(weekendLine(new Date(2026, 9, 31, 9)), `This weekend is Saturday 2026-10-31 and Sunday 2026-11-01; ${tail}`, "a Saturday");
  assert.equal(weekendLine(new Date(2026, 10, 1, 23)), `This weekend is Saturday 2026-10-31 and Sunday 2026-11-01; ${tail}`, "a Sunday: the one it is part of");
});
