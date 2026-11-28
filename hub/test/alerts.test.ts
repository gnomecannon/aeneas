import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { deviceKey, makeHub, type TestHub } from "./helpers.js";
import { ALERT_KINDS, AlertStore, alertGoesOut, type AlertView } from "../src/alerts.js";
import { reminderTick } from "../src/reminders.js";
import { refuseToolCall } from "../src/ai/api-guard.js";
import { aeneasAlerts, inAppleReminders, type AppleReminderAlerts } from "@everythingapp/shared";

// Each kind of alert switched on or off on its own (alerts.ts): one setting for every device, held back at the hub.

const alerts = async (t: ReturnType<typeof makeHub>) => ((await (await t.api("/modules")).json()) as { alerts: AlertView[] }).alerts;
const put = (t: ReturnType<typeof makeHub>, body: unknown) => t.api("/modules/alerts", { method: "PUT", body: JSON.stringify(body) });

test("alerts: every kind is on to start with, and each is switched off and on by itself", async () => {
  const t = makeHub();
  try {
    assert.deepEqual((await alerts(t)).map((a) => [a.id, a.on]), ALERT_KINDS.map((k) => [k.id, true]));
    assert.deepEqual(ALERT_KINDS.map((k) => k.id).sort(), ["activity", "connection", "digest", "disk", "mail", "monitor", "quiz", "reminder", "sensor"]);
    const res = await put(t, { mail: false, quiz: false });
    assert.equal(res.status, 200);
    const now = ((await res.json()) as { alerts: AlertView[] }).alerts;
    assert.deepEqual(now.filter((a) => !a.on).map((a) => a.id).sort(), ["mail", "quiz"]);
    assert.equal(t.hub.alerts.on("reminder"), true);
    assert.equal(t.hub.alerts.on("mail"), false);
    await put(t, { mail: true });
    assert.deepEqual((await alerts(t)).filter((a) => !a.on).map((a) => a.id), ["quiz"]);
    // Kept in its own file, which is one of the settings files a backup carries.
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(t.hub.cfg.dataDir, "alerts.json"), "utf8")), { quiz: false });
    // A kind the hub does not list (a newer hub's, an older file) is on.
    assert.equal(t.hub.alerts.on("something-new"), true);
  } finally { t.cleanup(); }
});

test("alerts: an unknown kind or a value that is not true or false is refused and nothing is saved", async () => {
  const t = makeHub();
  try {
    assert.equal((await put(t, { mail: false, nonsense: false })).status, 422);
    assert.equal((await put(t, { mail: "no" })).status, 422);
    assert.ok((await alerts(t)).every((a) => a.on));
  } finally { t.cleanup(); }
});

test("alerts: a switched-off kind is held back from the live stream; the others and the hub's own listeners still get theirs", async () => {
  const t = makeHub();
  try {
    await put(t, { mail: false });
    const heard: string[] = [];
    const off = t.hub.bus.on("notify", (e) => { heard.push(e.kind); });
    const res = await t.api("/live");
    const reader = res.body!.getReader();
    const text = new TextDecoder();
    let got = "";
    // One read waits at a time: a read given up on would swallow the next event.
    let pending: Promise<{ done: boolean; value?: Uint8Array }> | null = null;
    const readFor = async (ms: number) => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        pending ??= reader.read();
        const next = await Promise.race([pending, new Promise<null>((r) => setTimeout(() => r(null), Math.max(1, until - Date.now())))]);
        if (!next) break;
        pending = null;
        if (next.done) break;
        got += text.decode(next.value);
      }
    };
    await readFor(150);
    t.hub.bus.emit("notify", { id: "mail:1", kind: "mail", title: "Alex: Gutters", at: new Date().toISOString() });
    t.hub.bus.emit("notify", { id: "disk:1", kind: "disk", title: "The hub's disk is almost full", at: new Date().toISOString() });
    await readFor(400);
    await reader.cancel();
    off();
    assert.ok(got.includes("almost full"), "the disk alert reached the device");
    assert.ok(!got.includes("Gutters"), "the mail alert did not");
    assert.deepEqual(heard, ["mail", "disk"], "the hub's own listeners hear both");
  } finally { t.cleanup(); }
});

// Tasks also in Apple Reminders alert from Aeneas and from Apple's Reminders app; each can be switched off.

const modulesBody = async (t: TestHub) => (await (await t.api("/modules")).json()) as { alerts: AlertView[]; apple_reminder_alerts: AppleReminderAlerts };

/** An Apple device paired with this hub that says it runs `version`. */
async function device(t: TestHub, name: string, platform: "iphone" | "ipad" | "mac", version: string): Promise<void> {
  const key = await deviceKey(t, name, platform);
  const r = await t.app.request("/devices/me/app", { method: "PUT", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ kind: platform === "mac" ? "macos" : platform === "ipad" ? "ipados" : "ios", version }) });
  assert.equal(r.status, 200);
}

test("alerts for tasks in Apple Reminders: both on to start with; each switched by itself, kept in the same file, and refused when wrong", async () => {
  const t = makeHub();
  try {
    assert.deepEqual((await modulesBody(t)).apple_reminder_alerts, { aeneas: true, apple: true, apple_alarms: true, waiting: [], needs: "1.0.19" });
    let res = await put(t, { apple_reminder_alerts: { aeneas: false } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { alerts: AlertView[]; apple_reminder_alerts: AppleReminderAlerts };
    assert.equal(body.apple_reminder_alerts.aeneas, false);
    assert.equal(body.apple_reminder_alerts.apple, true);
    assert.equal(body.alerts.length, ALERT_KINDS.length, "the kinds come with it, unchanged");
    assert.ok(body.alerts.every((a) => a.on));
    // A kind and the switches in one body.
    res = await put(t, { quiz: false, apple_reminder_alerts: { aeneas: true, apple: false } });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(t.hub.cfg.dataDir, "alerts.json"), "utf8")), { quiz: false, apple_reminder_alerts: { apple: false } });
    assert.deepEqual(t.hub.alerts.appleChoices(), { aeneas: true, apple: false });
    // No Apple device on the hub: nothing to wait for, so updated devices write no alarms from now on.
    assert.deepEqual((await modulesBody(t)).apple_reminder_alerts, { aeneas: true, apple: false, apple_alarms: false, waiting: [], needs: "1.0.19" });

    for (const bad of [
      { apple_reminder_alerts: true },
      { apple_reminder_alerts: [] },
      { apple_reminder_alerts: { aeneas: "no" } },
      { apple_reminder_alerts: { aeneas: false, sound: false } },
      { apple_reminder_alerts: { apple: true }, nonsense: false },
    ]) {
      assert.equal((await put(t, bad)).status, 422, JSON.stringify(bad));
    }
    assert.deepEqual(t.hub.alerts.appleChoices(), { aeneas: true, apple: false }, "a refused body changes nothing");
    // Read again from the file, as after a restart.
    assert.deepEqual(new AlertStore(path.join(t.hub.cfg.dataDir, "alerts.json")).appleChoices(), { aeneas: true, apple: false });
  } finally { t.cleanup(); }
});

test("alerts for tasks in Apple Reminders: Alert from Apple Reminders off waits while an iPhone, iPad or Mac runs an older app", async () => {
  const t = makeHub();
  try {
    await device(t, "Jamie's iPhone", "iphone", "1.0.19");
    await device(t, "Jamie's Mac", "mac", "1.0.18");
    await put(t, { apple_reminder_alerts: { apple: false } });
    let a = (await modulesBody(t)).apple_reminder_alerts;
    assert.equal(a.apple, false);
    assert.equal(a.apple_alarms, true, "an app before 1.0.19 would read an item with no alarm as one with no reminder time");
    assert.deepEqual(a.waiting.map((w) => [w.name, w.platform, w.version]), [["Jamie's Mac", "mac", "1.0.18"]]);
    // The Mac updates: the devices that are connected hear it at once.
    let told = 0;
    const off = t.hub.alerts.onChange(() => { told++; });
    const key = await deviceKey(t, "Jamie's Mac 2", "mac");
    assert.ok(told >= 1, "a device paired is news");
    told = 0;
    await t.app.request("/devices/me/app", { method: "PUT", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ kind: "macos", version: "1.0.19" }) });
    const mac = t.hub.devices.list().find((d) => d.name === "Jamie's Mac")!;
    const mres = await t.api(`/devices/${mac.id}`, { method: "DELETE" });
    assert.ok(mres.status < 300, `removing the old Mac answered ${mres.status}`);
    off();
    a = (await modulesBody(t)).apple_reminder_alerts;
    assert.deepEqual(a.waiting, []);
    assert.equal(a.apple_alarms, false);
    assert.ok(told >= 1, "the change was told");
    // On again: alarms at once, whatever runs where.
    await device(t, "Jamie's iPad", "ipad", "1.0.17");
    await put(t, { apple_reminder_alerts: { apple: true } });
    a = (await modulesBody(t)).apple_reminder_alerts;
    assert.equal(a.apple_alarms, true);
    assert.deepEqual(a.waiting, [], "nothing waits while it is on");
  } finally { t.cleanup(); }
});

test("alerts for tasks in Apple Reminders: Alert from Aeneas off holds back the hub's announcement of a linked task only", async () => {
  const t = makeHub();
  try {
    const at = "2026-10-21T09:00:00.000Z";
    const linked = t.hub.store.create("task", { title: "Water the plants", status: "scheduled", order: 1, remind_at: at, apple: { id: "ext-1", list: "L1", list_title: "Home" } });
    const waiting = t.hub.store.create("task", { title: "Buy stamps", status: "scheduled", order: 2, remind_at: at, apple: { id: "", list: "", list_title: "Home" } });
    const plain = t.hub.store.create("task", { title: "Call the vet", status: "scheduled", order: 3, remind_at: at });
    assert.equal(inAppleReminders(linked.fields), true);
    assert.equal(inAppleReminders(waiting.fields), false, "a task made inside a list has no Apple item yet");
    assert.equal(inAppleReminders(plain.fields), false);

    const ev = (id: string) => ({ id, kind: "reminder", title: "x", at });
    assert.ok([linked, waiting, plain].every((x) => alertGoesOut(t.hub, ev(x.id))), "both on: every reminder goes out, as before");
    await put(t, { apple_reminder_alerts: { aeneas: false } });
    assert.equal(alertGoesOut(t.hub, ev(linked.id)), false);
    assert.equal(alertGoesOut(t.hub, ev(waiting.id)), true);
    assert.equal(alertGoesOut(t.hub, ev(plain.id)), true);
    assert.equal(alertGoesOut(t.hub, { kind: "disk", id: linked.id }), true, "other kinds are not touched");
    assert.equal(aeneasAlerts(linked.fields, t.hub.alerts.appleChoices()), false);
    assert.equal(aeneasAlerts(linked.fields, null), true, "a hub without the setting alerts for all");

    // Through the live stream: the plain task's alert arrives, the linked one's does not. Both are marked fired, as a
    // kind switched off is, so switching it on again brings no burst of old alerts.
    const res = await t.api("/live");
    const reader = res.body!.getReader();
    const text = new TextDecoder();
    let got = "";
    let pending: Promise<{ done: boolean; value?: Uint8Array }> | null = null;
    const readFor = async (ms: number) => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        pending ??= reader.read();
        const next = await Promise.race([pending, new Promise<null>((r) => setTimeout(() => r(null), Math.max(1, until - Date.now())))]);
        if (!next) break;
        pending = null;
        if (next.done) break;
        got += text.decode(next.value);
      }
    };
    await readFor(150);
    const fired = reminderTick(t.hub.store, t.hub.bus, new Date("2026-10-21T09:00:30.000Z"));
    assert.deepEqual(fired.sort(), [linked.id, waiting.id, plain.id].sort());
    await readFor(400);
    await reader.cancel();
    assert.ok(got.includes(plain.id), "the plain task's alert reached the device");
    assert.ok(got.includes(waiting.id), "so did the one waiting for its Apple item");
    assert.ok(!got.includes(linked.id), "the linked task's did not");

    // Done and Snooze from Aeneas still work on the task itself.
    assert.equal((await t.api(`/reminders/${linked.id}/snooze`, { method: "POST", body: JSON.stringify({ until: "2026-10-21T10:00:00.000Z" }) })).status, 200);
    assert.equal((await t.api(`/reminders/${linked.id}/ack`, { method: "POST" })).status, 200);
    assert.equal(t.hub.store.get(linked.id)!.fields.status, "done");
  } finally { t.cleanup(); }
});

test("alerts for tasks in Apple Reminders: the modules event on the live stream carries the switches", async () => {
  const t = makeHub();
  try {
    const res = await t.api("/live");
    const reader = res.body!.getReader();
    const text = new TextDecoder();
    let got = "";
    const first = await reader.read();
    got += text.decode(first.value);
    await put(t, { apple_reminder_alerts: { aeneas: false } });
    const until = Date.now() + 1000;
    while (!got.includes("event: modules") && Date.now() < until) {
      const next = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), 300))]);
      if (!next || next.done) break;
      got += text.decode(next.value);
    }
    await reader.cancel();
    const line = got.split("\n").find((l) => l.startsWith("data:") && l.includes("apple_reminder_alerts"));
    assert.ok(line, "a modules event with the switches");
    assert.equal((JSON.parse(line!.slice(5)) as { apple_reminder_alerts: AppleReminderAlerts }).apple_reminder_alerts.aeneas, false);
  } finally { t.cleanup(); }
});

test("alerts: the assistant cannot switch them", () => {
  assert.ok(refuseToolCall("PUT", "/modules/alerts"), "refused");
  assert.equal(refuseToolCall("GET", "/modules"), null);
});
