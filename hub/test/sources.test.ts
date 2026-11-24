import { test } from "node:test";
import assert from "node:assert/strict";
import { taskFilter } from "@everythingapp/shared";
import { deviceKey, makeHub, TOKEN, type TestHub } from "./helpers.js";
import { reminderTick } from "../src/reminders.js";
import { runTool, type ToolContext } from "../src/ai/tools.js";
import { taskLists } from "../src/ai/lists.js";
import { defaultOn, versionAtLeast, type SourcesView } from "../src/sources.js";

/** A request with a device's own key. */
async function asDevice(t: TestHub, key: string, method: string, path: string, json?: unknown): Promise<Response> {
  return t.app.request(path, { method, headers: { authorization: `Bearer ${key}`, ...(json === undefined ? {} : { "content-type": "application/json" }) }, ...(json === undefined ? {} : { body: JSON.stringify(json) }) });
}

/** An iPhone paired with this hub that says it runs `version`. */
async function phone(t: TestHub, name: string, version: string, platform = "iphone"): Promise<string> {
  const key = await deviceKey(t, name, platform);
  const r = await asDevice(t, key, "PUT", "/devices/me/app", { kind: platform === "mac" ? "macos" : "ios", version });
  assert.equal(r.status, 200);
  return key;
}

const list = (key: string, title: string, account: string, kind: string, work = false, extra: Record<string, unknown> = {}) => ({ key, title, account, kind, work, ...extra });
const ICLOUD_SHOP = list("icloud:iCloud/Shopping", "Shopping", "iCloud", "icloud");
const ICLOUD_TODO = list("icloud:iCloud/To do", "To do", "iCloud", "icloud");
const SCHOOL = list("exchange:School/Homework", "Homework", "School", "exchange", true);
const GOOGLE = list("caldav:Google/Errands", "Errands", "Google", "caldav");
const LOCAL = list("local:On My iPhone/Packing", "Packing", "On My iPhone", "local");

/** A task an iPhone brought in from Apple Reminders. */
function linked(t: TestHub, title: string, apple: Record<string, unknown>, more: Record<string, unknown> = {}, space: "personal" | "work" = "personal") {
  return t.hub.store.create("task", { title, status: "next", order: 1, apple: { id: `ext-${title}`, list: "L1", ...apple }, ...more }, space);
}

test("sources: the catalog, its defaults, renames, and refusals", async () => {
  const t = makeHub();
  try {
    // A task an older app linked by the list's name alone: that list has tasks, so it starts on even in Exchange.
    linked(t, "Old homework", { list_title: "Homework" });
    const key = await phone(t, "Jamie's iPhone", "1.0.18");
    const seen = await asDevice(t, key, "PUT", "/prefs/sources/seen", { lists: [ICLOUD_SHOP, SCHOOL, GOOGLE, LOCAL, list("exchange:Work/Tasks", "Tasks", "Work", "exchange", true)] });
    assert.equal(seen.status, 200);
    const v = await seen.json() as SourcesView;
    const on = Object.fromEntries(v.lists.map((l) => [l.title, l.on]));
    assert.deepEqual(on, { Shopping: true, Homework: true, Errands: false, Packing: true, Tasks: false });
    assert.equal(v.lists.find((l) => l.title === "Tasks")!.space, "work");
    assert.equal(v.needs, "1.0.18");
    assert.deepEqual(v.waiting, []);
    const me = v.lists[0].devices[0];
    assert.ok(v.lists.every((l) => l.devices.includes(me)));

    // The main key is not a device: it cannot say what a device sees.
    assert.equal((await t.api("/prefs/sources/seen", { method: "PUT", json: { lists: [] } })).status, 403);
    // Bad bodies are refused whole.
    assert.equal((await asDevice(t, key, "PUT", "/prefs/sources/seen", { lists: [{ key: "x" }] })).status, 422);
    assert.equal((await t.api("/prefs/sources", { method: "PUT", json: { lists: [{ key: "icloud:iCloud/Nope", on: false }] } })).status, 422);
    assert.equal((await t.api("/prefs/sources", { method: "PUT", json: { lists: [{ key: ICLOUD_SHOP.key, on: "no" }] } })).status, 422);
    assert.equal((await t.api("/prefs/sources", { method: "PUT", json: { new_tasks: GOOGLE.key } })).status, 422, "a list that is off cannot take new tasks");
    assert.equal((await t.api("/prefs/sources", { method: "PUT", json: { new_tasks: "exchange:Work/Tasks" } })).status, 422, "nor can a Work list");
    assert.equal((await t.api("/prefs/sources", { method: "PUT", json: { contacts: { device: "not-a-device" } } })).status, 422);

    // A choice, then the list renamed on the device: the choice goes with it, and new tasks follow.
    let r = await (await t.api("/prefs/sources", { method: "PUT", json: { lists: [{ key: GOOGLE.key, on: true }], new_tasks: ICLOUD_SHOP.key } })).json() as SourcesView;
    assert.equal(r.new_tasks, ICLOUD_SHOP.key);
    r = await (await asDevice(t, key, "PUT", "/prefs/sources/seen", { lists: [{ ...ICLOUD_SHOP, key: "icloud:iCloud/Groceries", title: "Groceries", was: ICLOUD_SHOP.key }, SCHOOL, GOOGLE, LOCAL] })).json() as SourcesView;
    assert.equal(r.new_tasks, "icloud:iCloud/Groceries");
    assert.ok(r.lists.some((l) => l.title === "Groceries"));
    assert.ok(!r.lists.some((l) => l.title === "Tasks"), "a list no device sees any more and nobody chose for is forgotten");
    // Switching the list for new tasks off sends them back to each device's default list.
    r = await (await t.api("/prefs/sources", { method: "PUT", json: { lists: [{ key: "icloud:iCloud/Groceries", on: false }] } })).json() as SourcesView;
    assert.equal(r.new_tasks, null);

    // Contacts: one iPhone, iPad or Mac, named so other devices can say who mirrors them.
    r = await (await t.api("/prefs/sources", { method: "PUT", json: { contacts: { device: me } } })).json() as SourcesView;
    assert.deepEqual(r.contacts, { device: me, name: "Jamie's iPhone" });
    // Removed from the hub, it mirrors nothing, and another device may take over.
    assert.equal((await t.api(`/devices/${me}`, { method: "DELETE" })).status, 200);
    r = await (await t.api("/prefs/sources")).json() as SourcesView;
    assert.deepEqual(r.contacts, { device: null, name: null });
  } finally { t.cleanup(); }
});

test("sources: a list that is off hides its tasks everywhere, and nothing about them changes", async () => {
  const t = makeHub();
  try {
    const key = await phone(t, "iPhone", "1.0.18");
    await asDevice(t, key, "PUT", "/prefs/sources/seen", { lists: [ICLOUD_SHOP, ICLOUD_TODO] });
    const now = new Date();
    const soon = new Date(now.getTime() - 60_000).toISOString();
    const block = { start: new Date(now.getTime() + 3_600_000).toISOString(), end: new Date(now.getTime() + 7_200_000).toISOString() };
    const milk = linked(t, "Buy oat milk", { list_title: "Shopping", list_key: ICLOUD_SHOP.key }, { remind_at: soon, status: "scheduled", block });
    // Linked by an older app: its list's name only.
    const eggs = linked(t, "Buy eggs", { list_title: "Shopping" });
    const call = linked(t, "Call the plumber", { list_title: "To do", list_key: ICLOUD_TODO.key }, { remind_at: soon, status: "scheduled" });
    const plain = t.hub.store.create("task", { title: "Water the plants", status: "next", order: 2 });
    const before = [milk, eggs].map((x) => JSON.stringify(t.hub.store.get(x.id)));

    const off = await (await t.api("/prefs/sources", { method: "PUT", json: { lists: [{ key: ICLOUD_SHOP.key, on: false }] } })).json() as SourcesView;
    assert.equal(off.lists.find((l) => l.key === ICLOUD_SHOP.key)!.on, false);
    assert.deepEqual([milk, eggs].map((x) => JSON.stringify(t.hub.store.get(x.id))), before, "switching a list off changes none of its tasks");

    const ids = (xs: { id: string }[]) => xs.map((x) => x.id).sort();
    // Lists of tasks: GET /entities, Today, the week, reminders due, search.
    const listed = await (await t.api("/entities?kind=task")).json() as { id: string }[];
    assert.deepEqual(ids(listed), ids([call, plain]));
    const today = await (await t.api("/planner/today")).json() as { next: { id: string }[]; reminders_due: { id: string }[]; digest: string; now: { id: string } | null };
    assert.deepEqual(ids(today.reminders_due), [call.id]);
    assert.ok(!today.digest.includes("oat milk"));
    const week = await (await t.api("/planner/week")).json() as { days: { blocks: { task_id: string }[]; reminders: { id: string }[] }[] };
    assert.ok(!week.days.some((d) => d.blocks.some((b) => b.task_id === milk.id) || d.reminders.some((x) => x.id === milk.id)));
    const due = await (await t.api("/reminders/due?within=60")).json() as { reminders: { id: string }[] };
    assert.deepEqual(ids(due.reminders), [call.id]);
    const found = await (await t.api("/search?q=milk")).json() as { hits: { id: string }[] };
    assert.ok(!found.hits.some((h) => h.id === milk.id));
    assert.ok((await (await t.api("/search?q=plumber")).json() as { hits: { id: string }[] }).hits.some((h) => h.id === call.id));

    // Alerts: the hidden reminder neither fires nor is marked fired.
    assert.deepEqual(reminderTick(t.hub.store, t.hub.bus, now), [call.id]);
    assert.equal(t.hub.store.get(milk.id)!.fields.fired, undefined);

    // Acting on one through the hub's routes answers as for a task that is not there.
    assert.equal((await t.api(`/entities/${milk.id}`, { method: "PATCH", json: { fields: { title: "x" } } })).status, 404);
    assert.equal((await t.api(`/entities/${milk.id}`, { method: "DELETE" })).status, 404);
    assert.equal((await t.api(`/reminders/${milk.id}/ack`, { method: "POST" })).status, 404);
    assert.equal((await t.api("/planner/schedule", { method: "POST", json: { task_id: eggs.id, start: block.start } })).status, 404);

    // The assistant: its lists, the list's tasks, one item, and the duplicate check.
    const ctx: ToolContext = { sessionId: "s", lastUser: "", topic: "t", store: t.hub.store, cfg: t.hub.cfg, hosts: t.hub.ai.hosts };
    const api = async (method: string, path: string, body?: unknown) => {
      const res = await t.app.request(path, { method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: res.status, data: await res.json().catch(() => null) };
    };
    assert.deepEqual(taskLists(t.hub.store), ["To do"]);
    const shop = await runTool(api, { name: "list_items", arguments: { kind: "task", list: "Shopping" } }, ctx);
    assert.match(shop.text, /no Reminders list named Shopping/);
    const item = await runTool(api, { name: "get_item", arguments: { id: milk.id } }, ctx);
    assert.match(item.text, /not found/);
    const again = await runTool(api, { name: "create_task", arguments: { title: "Buy oat milk" } }, ctx);
    assert.ok(again.ok && !again.text.includes("already an open task"), "a hidden task is not a duplicate");

    // Devices still get every task, so their records stay whole.
    const changes = await (await t.api("/sync/changes?since=0&kinds=task")).json() as { changes: { entity: { id: string } }[] };
    assert.ok(changes.changes.some((c) => c.entity.id === milk.id) && changes.changes.some((c) => c.entity.id === eggs.id));

    // On again: they show again, as they were.
    await t.api("/prefs/sources", { method: "PUT", json: { lists: [{ key: ICLOUD_SHOP.key, on: true }] } });
    const back = await (await t.api("/entities?kind=task")).json() as { id: string }[];
    assert.ok(back.some((x) => x.id === milk.id) && back.some((x) => x.id === eggs.id));
  } finally { t.cleanup(); }
});

test("sources: a Personal or Work choice waits for every iPhone, iPad and Mac, and moves the list's tasks with their links", async () => {
  const t = makeHub();
  try {
    const key = await phone(t, "iPhone", "1.0.18");
    const old = await phone(t, "Mac", "1.0.17", "mac");
    await asDevice(t, key, "PUT", "/prefs/sources/seen", { lists: [ICLOUD_SHOP, ICLOUD_TODO] });
    const a = linked(t, "Badge photo", { list_title: "To do", list_key: ICLOUD_TODO.key });
    const b = linked(t, "Expense report", { list_title: "To do" });
    // In another list: it stays where it is.
    const own = linked(t, "Book flights", { list_title: "Shopping", list_key: ICLOUD_SHOP.key });

    let v = await (await t.api("/prefs/sources", { method: "PUT", json: { lists: [{ key: ICLOUD_TODO.key, space: "work" }] } })).json() as SourcesView;
    let todo = v.lists.find((l) => l.key === ICLOUD_TODO.key)!;
    assert.equal(todo.space, "personal", "the Mac runs 1.0.17: the choice waits");
    assert.equal(todo.wants, "work");
    assert.deepEqual(v.waiting.map((w) => [w.name, w.version]), [["Mac", "1.0.17"]]);
    assert.equal(t.hub.store.get(a.id)!.space, "personal");

    // The Mac is updated: the choice takes effect, and the list's tasks move with their Apple links.
    await asDevice(t, old, "PUT", "/devices/me/app", { kind: "macos", version: "1.0.18" });
    v = await (await t.api("/prefs/sources")).json() as SourcesView;
    todo = v.lists.find((l) => l.key === ICLOUD_TODO.key)!;
    assert.equal(todo.space, "work");
    assert.equal(todo.wants, undefined);
    for (const id of [a.id, b.id]) {
      const e = t.hub.store.get(id)!;
      assert.equal(e.space, "work");
      assert.ok(e.field_ts.space, "moved as a move made in the app is: with its stamp");
      assert.equal((e.fields.apple as { id: string }).id, `ext-${e.fields.title}`, "the Apple link stays");
    }
    assert.equal(t.hub.store.get(own.id)!.space, "personal");

    // An iPad on an older app pairs: before it reads anything, the tasks are back in the account's own space.
    await phone(t, "iPad", "1.0.17", "ipad");
    assert.equal(t.hub.store.get(a.id)!.space, "personal");
    assert.equal(t.hub.store.get(b.id)!.space, "personal");
    v = await (await t.api("/prefs/sources")).json() as SourcesView;
    assert.equal(v.lists.find((l) => l.key === ICLOUD_TODO.key)!.wants, "work");

    // With the work space off, a list cannot be set to Work.
    await t.api("/space/work", { method: "PUT", json: { enabled: false, confirm: "erase work" } });
    assert.equal((await t.api("/prefs/sources", { method: "PUT", json: { lists: [{ key: ICLOUD_SHOP.key, space: "work" }] } })).status, 409);
  } finally { t.cleanup(); }
});

test("sources: work calendars are one choice, devices' own ticks are added once, and the hub's own calendars cannot be work", async () => {
  const t = makeHub();
  try {
    const key = await phone(t, "iPhone", "1.0.18");
    const mac = await phone(t, "Mac", "1.0.18", "mac");
    const cal = (k: string, title: string, account: string, kind: string) => ({ key: `${kind}:${account}/${title}`, title, account, kind, ...(k ? { color: k } : {}) });
    const meetings = cal("#3366ff", "Meetings", "Work", "exchange");
    const standups = cal("", "Standups", "Work", "exchange");
    const family = cal("", "Family", "iCloud", "icloud");
    // The iPhone had ticked Meetings and Standups itself.
    let v = await (await asDevice(t, key, "PUT", "/prefs/sources/seen", { calendars: [meetings, standups, family], ticked: [meetings.key, standups.key] })).json() as SourcesView;
    assert.deepEqual(v.calendars.filter((c) => c.work).map((c) => c.title), ["Meetings", "Standups"]);
    assert.equal(v.calendars.find((c) => c.title === "Meetings")!.color, "#3366FF");
    // Unticked on one device: off for all, and another device's old ticks do not bring it back.
    v = await (await t.api("/prefs/sources", { method: "PUT", json: { calendars: [{ key: standups.key, work: false }] } })).json() as SourcesView;
    v = await (await asDevice(t, mac, "PUT", "/prefs/sources/seen", { calendars: [meetings, standups], ticked: [standups.key] })).json() as SourcesView;
    assert.deepEqual(v.calendars.filter((c) => c.work).map((c) => c.title), ["Meetings"]);
    // Only once per device.
    await t.api("/prefs/sources", { method: "PUT", json: { calendars: [{ key: meetings.key, work: false }] } });
    v = await (await asDevice(t, key, "PUT", "/prefs/sources/seen", { calendars: [meetings, standups, family], ticked: [meetings.key] })).json() as SourcesView;
    assert.deepEqual(v.calendars.filter((c) => c.work).map((c) => c.title), []);

    // The hub keeps the iCloud calendar Family in step itself: it cannot be work, and the catalog says so.
    t.hub.connections.update((c) => {
      c.icloud = [{ email: "jamie@example.com", password: "x", calendar: { calendars: [{ url: "https://caldav.example/family/", name: "Family", writable: true }], chosen: ["https://caldav.example/family/"], target: null } } as never];
    });
    v = await (await t.api("/prefs/sources")).json() as SourcesView;
    assert.equal(v.calendars.find((c) => c.title === "Family")!.hub_kept, true);
    const refused = await t.api("/prefs/sources", { method: "PUT", json: { calendars: [{ key: family.key, work: true }] } });
    assert.equal(refused.status, 422);
    assert.match((await refused.json() as { error: string }).error, /kept in step by your hub/);
  } finally { t.cleanup(); }
});

test("sources: the live stream tells every device when the setting changes", async () => {
  const t = makeHub();
  try {
    const key = await phone(t, "iPhone", "1.0.18");
    const told: SourcesView[] = [];
    const off = t.hub.sources.onChange((v) => told.push(v));
    await asDevice(t, key, "PUT", "/prefs/sources/seen", { lists: [ICLOUD_SHOP] });
    await t.api("/prefs/sources", { method: "PUT", json: { lists: [{ key: ICLOUD_SHOP.key, on: false }] } });
    // The same setting again is not news.
    await t.api("/prefs/sources", { method: "PUT", json: { lists: [{ key: ICLOUD_SHOP.key, on: false }] } });
    off();
    assert.deepEqual(told.map((v) => v.lists.map((l) => l.on)), [[true], [false]]);
  } finally { t.cleanup(); }
});

test("sources: the rule for hidden tasks, and the defaults", () => {
  const lists = [
    { key: "icloud:iCloud/Shopping", title: "Shopping", on: false, was: ["icloud:iCloud/Groceries"] },
    { key: "exchange:School/Tasks", title: "Tasks", on: false },
    { key: "icloud:iCloud/Tasks", title: "Tasks", on: true },
  ];
  const shows = taskFilter(lists);
  assert.equal(shows({ title: "no link" }), true);
  assert.equal(shows({ apple: { id: "1", list: "x", list_key: "icloud:iCloud/Shopping", list_title: "Shopping" } }), false);
  assert.equal(shows({ apple: { id: "1", list: "x", list_title: "Shopping" } }), false, "an older app's link: by name");
  assert.equal(shows({ apple: { id: "1", list: "x", list_key: "icloud:iCloud/Groceries", list_title: "Groceries" } }), false, "a key from before a rename");
  assert.equal(shows({ apple: { id: "1", list: "x", list_title: "Tasks" } }), true, "two lists of that name, one on: shown");
  assert.equal(shows({ apple: { id: "1", list: "x", list_key: "exchange:School/Tasks", list_title: "Tasks" } }), false);
  assert.equal(shows({ apple: { id: "", list: "", list_title: "Shopping" } }), false, "made in the app inside a list that is off");
  assert.equal(shows({ apple: { id: "1", list: "x", list_title: "Unknown" } }), true, "a list the setting has not heard of hides nothing");
  assert.equal(taskFilter([{ key: "k", title: "T", on: true }])({ apple: { list_title: "T" } }), true);
  assert.equal(defaultOn("icloud", false), true);
  assert.equal(defaultOn("local", false), true);
  assert.equal(defaultOn("exchange", false), false);
  assert.equal(defaultOn("caldav", true), true);
  assert.equal(versionAtLeast("1.0.18", "1.0.18"), true);
  assert.equal(versionAtLeast("1.1.0", "1.0.18"), true);
  assert.equal(versionAtLeast("1.0.17", "1.0.18"), false);
});
