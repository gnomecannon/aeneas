import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub } from "./helpers.js";
import { parseMedications, nextWeekdayAt } from "../src/health.js";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const ago = (ms: number, now = new Date()) => new Date(now.getTime() - ms).toISOString();
/** Noon on the calendar day before: on the day clocks fall back, 24 hours ago is still today. */
const yesterdayNoon = (now: Date) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12).toISOString();

test("health: the summary reads weight deltas, bp, caffeine and meds today, mood, sleep and activity hours from logs", async () => {
  const t = makeHub();
  try {
    const now = new Date();
    const log = (fields: Record<string, unknown>) => t.hub.store.create("log", fields);
    log({ type: "weight", value: 130, unit: "lb", at: ago(40 * DAY, now) });
    log({ type: "weight", value: 125, unit: "lb", at: ago(10 * DAY, now) });
    log({ type: "weight", value: 120, unit: "lb", at: yesterdayNoon(now) });
    log({ type: "bp", value: "118/76", at: ago(2 * DAY, now) });
    log({ type: "bp", value: "122/80", at: now.toISOString() });
    log({ type: "caffeine", value: 80, unit: "mg", at: now.toISOString() });
    log({ type: "caffeine", value: 120, unit: "mg", at: now.toISOString() });
    log({ type: "caffeine", value: 200, unit: "mg", at: ago(2 * DAY, now) });
    log({ type: "med", value: "Claritin", at: now.toISOString() });
    log({ type: "med", value: "Allegra", at: ago(2 * DAY, now) });
    log({ type: "mood", value: 1, at: ago(2 * DAY, now) });
    log({ type: "mood", value: -1, at: ago(9 * DAY, now) });
    log({ type: "sleep", value: 7.5, unit: "h", at: yesterdayNoon(now) });
    log({ type: "activity", value: "guitar", at: ago(3 * HOUR, now) });
    log({ type: "activity", value: "guitar", at: ago(1 * HOUR, now), note: "end" });
    log({ type: "activity", value: "old", at: ago(10 * DAY, now) });
    log({ type: "activity", value: "old", at: ago(10 * DAY - HOUR, now), note: "end" });
    t.hub.store.create("fact", { category: "health", key: "medications", value: "cetirizine (Claritin), fexofenadine (Allegra), fluticasone spray each morning, B12 weekly since 2026-01-15. Latex allergy." });

    const res = await t.api("/health/summary");
    assert.equal(res.status, 200);
    const s = await res.json() as any;
    assert.equal(s.weight.latest, 120);
    assert.equal(s.weight.delta_7d, -5, "against the newest weight at or before 7 days ago");
    assert.equal(s.weight.delta_30d, -10);
    assert.deepEqual(s.weight.series.map((p: any) => p.value), [125, 120], "30 day series, oldest first");
    assert.equal(s.bp.latest, "122/80");
    assert.equal(s.caffeine_today, 2.1, "cups: 200 mg at 95 mg a cup");
    assert.equal(s.weight.unit, "lb");
    assert.deepEqual(s.meds_today, ["Claritin"]);
    assert.deepEqual(s.meds_expected, ["Claritin", "Allegra", "fluticasone", "B12"]);
    assert.deepEqual(s.mood.series_7d.map((p: any) => p.value), [1]);
    assert.deepEqual(s.sleep.series_7d.map((p: any) => p.value), [450], "minutes, as Apple Health sends them");
    assert.equal(s.activity_hours_7d, 2);
    assert.equal(s.next_injection, null);

    const wide = await (await t.api("/health/summary?days=60")).json() as any;
    assert.equal(wide.weight.series.length, 3);
    assert.equal((await t.api("/health/summary?days=0")).status, 400);

    // Proof rows count the health logs of the day.
    const proof = await (await t.api("/metrics/proof?days=1")).json() as any;
    assert.equal(proof.rows[0].health_logs, 4, "two caffeine logs, one med and one bp log today; activity logs do not count");
    assert.equal(proof.totals.health_logs, 4);
  } finally { t.cleanup(); }
});

test("health: meds_expected parsing takes the brand in parentheses, else the first word, and dedupes", () => {
  assert.deepEqual(parseMedications(null), []);
  assert.deepEqual(parseMedications("cetirizine (Claritin), fexofenadine (Allegra), fluticasone spray, B12 weekly. Advil once."), ["Claritin", "Allegra", "fluticasone", "B12"]);
  assert.deepEqual(parseMedications("Claritin, claritin, Allegra"), ["Claritin", "Allegra"]);
  assert.deepEqual(parseMedications(" , ,"), []);
});

test("health: injection-day creates one weekly reminder and later calls move it instead of adding another", async () => {
  const t = makeHub();
  try {
    const res = await t.api("/health/injection-day", { method: "POST", json: { name: "B12", weekday: "fri", time: "18:30" } });
    assert.equal(res.status, 201);
    const r = await res.json() as any;
    assert.equal(r.fields.title, "Injection: B12");
    assert.equal(r.fields.repeat, "every 1 weeks on fri");
    assert.equal(r.fields.friction, "reason");
    const at = new Date(r.fields.remind_at);
    assert.ok(at > new Date(), "planned in the future");
    assert.equal(at.getDay(), 5);
    assert.equal(at.getHours(), 18);
    assert.equal(at.getMinutes(), 30);

    const again = await t.api("/health/injection-day", { method: "POST", json: { name: "B12", weekday: "Friday", time: "18:30" } });
    assert.equal(again.status, 200);
    assert.equal(t.hub.store.list({ kind: "task" }).length, 1);

    t.hub.store.patch(r.id, { status: "done" });
    const moved = await (await t.api("/health/injection-day", { method: "POST", json: { name: "B12", weekday: "sat", time: "09:00" } })).json() as any;
    assert.equal(moved.id, r.id);
    assert.equal(new Date(moved.fields.remind_at).getDay(), 6);
    assert.equal(moved.fields.repeat, "every 1 weeks on sat");
    assert.equal(moved.fields.status, "scheduled", "a moved plan fires again");
    assert.equal(t.hub.store.list({ kind: "task" }).length, 1);

    const s = await (await t.api("/health/summary")).json() as any;
    assert.deepEqual(s.next_injection, { name: "B12", at: moved.fields.remind_at });

    assert.equal((await t.api("/health/injection-day", { method: "POST", json: { name: "", weekday: "sat", time: "09:00" } })).status, 422);
    assert.equal((await t.api("/health/injection-day", { method: "POST", json: { name: "X", weekday: "someday", time: "09:00" } })).status, 422);
    assert.equal((await t.api("/health/injection-day", { method: "POST", json: { name: "X", weekday: "mon", time: "9am" } })).status, 422);

    const base = new Date(2026, 9, 21, 12, 0); // a Wednesday
    assert.equal(nextWeekdayAt("wed", "13:00", base).getTime(), new Date(2026, 9, 21, 13, 0).getTime(), "later today counts");
    assert.equal(nextWeekdayAt("wed", "11:00", base).getTime(), new Date(2026, 9, 28, 11, 0).getTime(), "earlier today means next week");
  } finally { t.cleanup(); }
});
