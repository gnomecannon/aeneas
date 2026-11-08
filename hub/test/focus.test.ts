import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub } from "./helpers.js";
import { focusTick, openActivity } from "../src/focus.js";
import type { NotifyEvent } from "../src/bus.js";

test("focus: the check-in fires once after the threshold and again only after the next interval", () => {
  const t = makeHub();
  try {
    const events: NotifyEvent[] = [];
    t.hub.bus.on("notify", (e) => events.push(e));
    const t0 = new Date("2026-10-21T14:00:00.000Z");
    const at = (h: number) => new Date(t0.getTime() + h * 3600_000);
    assert.equal(focusTick(t.hub, at(5)), null, "nothing running");

    const log = t.hub.store.create("log", { type: "activity", value: "coding", at: t0.toISOString() });
    t.hub.store.create("log", { type: "weight", value: 160, at: at(1).toISOString() });
    assert.equal(openActivity(t.hub)!.id, log.id);
    assert.equal(focusTick(t.hub, at(2.9)), null);
    assert.equal(focusTick(t.hub, at(3)), log.id);
    assert.deepEqual(t.hub.store.get(log.id)!.fields.checkins, [at(3).toISOString()]);
    assert.deepEqual(events, [{ id: log.id, kind: "activity", title: "On coding for 3 h", at: at(3).toISOString(), log_id: log.id }]);
    // Not again until 3 h after the last check-in.
    assert.equal(focusTick(t.hub, at(3.1)), null);
    assert.equal(focusTick(t.hub, at(5.9)), null);
    assert.equal(focusTick(t.hub, at(6)), log.id);
    assert.equal(t.hub.store.get(log.id)!.fields.checkins.length, 2);
    assert.equal(events[1].title, "On coding for 6 h");
    assert.equal(events.length, 2);

    // Stop: the end log for the same value closes it.
    t.hub.store.create("log", { type: "activity", value: "coding", at: at(6.5).toISOString(), note: "end" });
    assert.equal(openActivity(t.hub), null);
    assert.equal(focusTick(t.hub, at(10)), null);
    assert.equal(events.length, 2);

    // A new activity starts the clock over; the configured threshold is honoured (1.5 h here) and fractional hours print with one decimal.
    const next = t.hub.store.create("log", { type: "activity", value: "guitar", at: at(11).toISOString() });
    assert.equal(focusTick(t.hub, at(12.4), 1.5), null);
    assert.equal(focusTick(t.hub, at(12.5), 1.5), next.id);
    assert.equal(events[2].title, "On guitar for 1.5 h");
    // An end log for a different value does not close it.
    t.hub.store.create("log", { type: "activity", value: "coding", at: at(13).toISOString(), note: "end" });
    assert.equal(openActivity(t.hub)!.id, next.id);
  } finally { t.cleanup(); }
});

test("focus: an activity left running past the limit ends at its first check-in and stops asking", () => {
  const t = makeHub();
  try {
    const events: NotifyEvent[] = [];
    t.hub.bus.on("notify", (e) => events.push(e));
    const t0 = new Date("2026-10-28T14:00:00.000Z");
    const at = (h: number) => new Date(t0.getTime() + h * 3600_000);
    t.hub.store.create("log", { type: "activity", value: "soldering", at: t0.toISOString() });
    assert.ok(focusTick(t.hub, at(9), 3, 12), "still asking before the limit");
    assert.equal(focusTick(t.hub, at(101), 3, 12), null);
    assert.equal(openActivity(t.hub), null);
    const end = t.hub.store.list({ kind: "log" }).find((l) => l.fields.note === "end")!;
    assert.equal(end.fields.value, "soldering");
    assert.equal(end.fields.at, at(3).toISOString());
    assert.equal(focusTick(t.hub, at(104), 3, 12), null);
    assert.equal(events.length, 1);
    // 0 keeps it open for good.
    t.hub.store.create("log", { type: "activity", value: "travel", at: at(200).toISOString() });
    assert.ok(focusTick(t.hub, at(260), 3, 0));
    assert.ok(openActivity(t.hub));
  } finally { t.cleanup(); }
});

test("focus: a future-dated or malformed activity log never fires", () => {
  const t = makeHub({ focusCheckHours: 2 });
  try {
    const now = new Date("2026-10-21T14:00:00.000Z");
    t.hub.store.create("log", { type: "activity", value: "nap", at: new Date(now.getTime() + 3600_000).toISOString() });
    assert.equal(focusTick(t.hub, now), null);
    assert.equal(t.hub.cfg.focusCheckHours, 2);
    const old = t.hub.store.create("log", { type: "activity", value: "reading", at: new Date(now.getTime() - 5 * 3600_000).toISOString() });
    // The future one is newer, so it is the open activity and it has not started yet.
    assert.equal(openActivity(t.hub)!.fields.value, "nap");
    assert.equal(focusTick(t.hub, now), null);
    t.hub.store.patch(old.id, { at: new Date(now.getTime() + 7200_000).toISOString() });
    assert.equal(focusTick(t.hub, new Date(now.getTime() + 4 * 3600_000)), old.id, "2 h after the newest start with the configured threshold");
  } finally { t.cleanup(); }
});
