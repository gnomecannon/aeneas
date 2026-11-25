import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeHub } from "./helpers.js";
import { seedChecklists, statesFromNote, US_STATES } from "../src/admin.js";

const DAY = 24 * 3600_000;
const post = (json: unknown) => ({ method: "POST", json });

// ---------- checklists ----------

test("admin: instantiate copies a template with every done_at cleared and from_template set", async () => {
  const t = makeHub();
  try {
    const tpl = t.hub.store.create("checklist", { title: "Day hike", kind: "packing", template: true, tags: ["hiking"], items: [{ text: "Sunscreen", done_at: "2026-10-01T12:00:00.000Z", note: "pocket" }, { text: "Water" }] });
    const res = await t.api(`/checklists/${tpl.id}/instantiate`, post({ title: "Hike Saturday" }));
    assert.equal(res.status, 201);
    const copy = await res.json() as any;
    assert.notEqual(copy.id, tpl.id);
    assert.equal(copy.fields.title, "Hike Saturday");
    assert.equal(copy.fields.template, false);
    assert.equal(copy.fields.from_template, tpl.id);
    assert.equal(copy.fields.kind, "packing");
    assert.deepEqual(copy.fields.tags, ["hiking"]);
    assert.deepEqual(copy.fields.items, [{ text: "Sunscreen", note: "pocket" }, { text: "Water" }]);
    // The template itself is untouched.
    assert.equal(t.hub.store.get(tpl.id)!.fields.items[0].done_at, "2026-10-01T12:00:00.000Z");
    // No body: the title gets today's date.
    const bare = await t.api(`/checklists/${tpl.id}/instantiate`, { method: "POST" });
    assert.equal(bare.status, 201);
    assert.match((await bare.json() as any).fields.title, /^Day hike \d{4}-\d{2}-\d{2}$/);
    // Only templates instantiate.
    assert.equal((await t.api(`/checklists/${copy.id}/instantiate`, post({}))).status, 422);
    assert.equal((await t.api(`/checklists/00000000-0000-4000-8000-000000000000/instantiate`, post({}))).status, 404);
  } finally { t.cleanup(); }
});

test("admin: toggle flips one item, refuses templates and bad indexes", async () => {
  const t = makeHub();
  try {
    const tpl = t.hub.store.create("checklist", { title: "Kit", template: true, items: [{ text: "a" }] });
    const list = t.hub.store.create("checklist", { title: "Trip", items: [{ text: "a" }, { text: "b" }] });
    let res = await t.api(`/checklists/${list.id}/toggle`, post({ index: 1 }));
    assert.equal(res.status, 200);
    let body = await res.json() as any;
    assert.ok(body.fields.items[1].done_at);
    assert.equal(body.fields.items[0].done_at, undefined);
    res = await t.api(`/checklists/${list.id}/toggle`, post({ index: 1 }));
    body = await res.json() as any;
    assert.equal(body.fields.items[1].done_at, undefined);
    assert.equal((await t.api(`/checklists/${list.id}/toggle`, post({ index: 2 }))).status, 422);
    assert.equal((await t.api(`/checklists/${list.id}/toggle`, post({ index: "x" }))).status, 422);
    assert.equal((await t.api(`/checklists/${tpl.id}/toggle`, post({ index: 0 }))).status, 409);
  } finally { t.cleanup(); }
});

test("admin: states are read from checked boxes, plain list lines and bare state lines only", () => {
  const body = [
    "# States visited",
    "- [x] Maine",
    "- [X] New Hampshire",
    "- [ ] Texas",
    "- Vermont",
    "* West Virginia (2019)",
    "1. Rhode Island",
    "Massachusetts",
    "Drove through New York once",
    "- Narnia",
  ].join("\n");
  assert.deepEqual(statesFromNote(body), ["Maine", "Massachusetts", "New Hampshire", "Rhode Island", "Vermont", "West Virginia"]);
});

test("admin: checklist seed creates the templates and the 50 states once, marked from the states note", () => {
  const t = makeHub();
  try {
    t.hub.store.create("note", { title: "States visited", path: "Travel/States visited.md", body: "- [x] Maine\n- [x] New Hampshire\n- [ ] Texas\n- Vermont\nMassachusetts\n" });
    const rows = JSON.parse(fs.readFileSync(path.join(t.hub.cfg.seedDir, "checklists.json"), "utf8"));
    const first = seedChecklists(t.hub.store, rows);
    assert.deepEqual(first, { created: 5, kept: 0, states_marked: 4 });
    const lists = t.hub.store.list({ kind: "checklist" });
    const titles = lists.map((c) => c.fields.title).sort();
    assert.deepEqual(titles, ["Camping weekend", "Day hike", "Overnight bag", "US states visited", "Work trip"]);
    for (const c of lists) if (c.fields.title !== "US states visited") assert.equal(c.fields.template, true);
    const states = lists.find((c) => c.fields.title === "US states visited")!;
    assert.equal(states.fields.kind, "states");
    assert.equal(states.fields.template, false);
    assert.equal(states.fields.items.length, 50);
    assert.deepEqual(states.fields.items.map((i: any) => i.text), US_STATES);
    assert.deepEqual(states.fields.items.filter((i: any) => i.done_at).map((i: any) => i.text), ["Maine", "Massachusetts", "New Hampshire", "Vermont"]);
    const camping = lists.find((c) => c.fields.title === "Camping weekend")!;
    const text = camping.fields.items.map((i: any) => i.text).join("\n").toLowerCase();
    for (const w of ["headlamp", "ferro rod", "picaridin", "water filter", "rain shell", "knife"]) assert.ok(text.includes(w), w);
    // A rerun keeps everything, including a list the user deleted.
    t.hub.store.patch(camping.id, { deleted_at: new Date().toISOString() });
    assert.deepEqual(seedChecklists(t.hub.store, rows), { created: 0, kept: 5, states_marked: 0 });
  } finally { t.cleanup(); }
});

// ---------- Job search, taken out on 2026-11-25 ----------

test("admin: Job search is gone: an application is still kept and synced, but nothing makes its follow-up, lists, searches or drafts for it", async () => {
  const t = makeHub();
  try {
    // An older app may still write one: the kind stays, so the hub keeps it instead of refusing the edit.
    const res = await t.api("/entities", post({ kind: "application", fields: { company: "Acme", role: "SysAdmin", stage: "applied", next_at: "2026-11-02T14:00:00.000Z", next_step: "email the recruiter" } }));
    assert.equal(res.status, 201);
    const app = await res.json() as any;
    assert.equal(t.hub.store.list({ kind: "task" }).length, 0, "no follow-up is made");
    // A follow-up made while Job search was on is left as it is: an ordinary task nothing moves.
    const follow = t.hub.store.create("task", { title: "Follow up: Acme SysAdmin", status: "scheduled", order: 1, remind_at: "2026-11-02T14:00:00.000Z", friction: "none", linked_id: app.id });
    t.hub.store.patch(app.id, { reminder_id: follow.id });
    await t.api(`/entities/${app.id}`, { method: "PATCH", json: { fields: { next_at: "2026-11-09T15:00:00.000Z", stage: "rejected" } } });
    assert.equal(t.hub.store.get(follow.id)!.fields.remind_at, "2026-11-02T14:00:00.000Z");
    assert.equal(t.hub.store.get(follow.id)!.deleted_at, null);
    assert.equal(t.hub.store.get(app.id)!.fields.stage, "rejected", "the item itself is kept as written");
    // Its routes are the hub's plain 404 now.
    for (const [method, p] of [["GET", "/applications/board"], ["POST", `/applications/${app.id}/cover-letter`], ["GET", "/library/applications"]]) {
      const r = await t.api(p, method === "POST" ? post({}) : {});
      assert.equal(r.status, 404, p);
      assert.deepEqual(await r.json(), { error: "not found" }, p);
    }
    // Search and the follow-up's related items leave it out.
    const hits = (await (await t.api("/search?q=Acme")).json() as { hits: { id: string }[] }).hits;
    assert.ok(!hits.some((h) => h.id === app.id));
    assert.ok(hits.some((h) => h.id === follow.id), "the task is found");
    const related = await (await t.api(`/entities/${follow.id}/related`)).json() as { id: string }[] | { related: { id: string }[] };
    assert.ok(!JSON.stringify(related).includes(app.id));
    // /status counts lists and games only.
    t.hub.store.create("game", { name: "Valheim" });
    const status = await (await t.api("/status")).json() as any;
    assert.deepEqual(status.admin, { checklists_open: 0, games: 1 });
  } finally { t.cleanup(); }
});

// ---------- games ----------

test("admin: game pick honours ownership, player count, coop, hours, recency, rating and exclude", async () => {
  const t = makeHub();
  try {
    const s = t.hub.store;
    const ago = (d: number) => new Date(Date.now() - d * DAY).toISOString();
    const drg = s.create("game", { name: "Deep Rock Galactic", owned_by: ["Robin", "Jamie"], session_hours: 1, last_played: ago(10), rating: 5 });
    const valheim = s.create("game", { name: "Valheim", owned_by: ["Robin", "Jamie", "Alex"], max_players: 10, session_hours: 3, rating: 4 });
    s.create("game", { name: "Mario Kart", owned_by: ["Robin"], coop: false, max_players: 8 });
    const rl = s.create("game", { name: "Rocket League", owned_by: ["Robin", "Jamie"], coop: false, max_players: 8 });
    s.create("game", { name: "Portal 2", owned_by: ["Robin", "Jamie", "Alex"], min_players: 2, max_players: 2, last_played: ago(2) });

    const pick = async (body: unknown) => (await t.api("/games/pick", post(body))).json() as Promise<any>;
    let r = await pick({ players: ["Robin", "jamie"] });
    assert.equal(r.pick.fields.name, "Valheim"); // never played, rated above Rocket League
    assert.equal(r.runner_up.fields.name, "Rocket League");
    assert.equal(r.considered, 4);
    assert.match(r.why, /never played/);
    r = await pick({ players: ["Robin", "Jamie"], coop: true, hours: 2 });
    assert.equal(r.pick.fields.name, "Deep Rock Galactic"); // Valheim too long, Portal 2 played more recently
    assert.match(r.why, /last played 10 days ago/);
    r = await pick({ players: ["Robin", "Jamie"], coop: false });
    assert.equal(r.pick.fields.name, "Rocket League");
    r = await pick({ players: ["Robin", "Jamie", "Alex"] });
    assert.equal(r.pick.fields.name, "Valheim"); // Portal 2 is two players only
    assert.equal(r.considered, 1);
    r = await pick({ players: ["Robin", "Jamie"], coop: true, exclude: [valheim.id] });
    assert.equal(r.pick.fields.name, "Deep Rock Galactic");
    r = await pick({ players: ["Robin", "Bob"] });
    assert.equal(r.pick, null);
    assert.match(r.why, /No game fits 2 players/);
    assert.equal((await t.api("/games/pick", post({ players: [] }))).status, 422);

    const played = await t.api(`/games/${rl.id}/played`, { method: "POST" });
    assert.equal(played.status, 200);
    assert.ok(Date.now() - new Date((await played.json() as any).fields.last_played).getTime() < 5000);
    r = await pick({ players: ["Robin", "Jamie"], coop: false });
    assert.equal(r.pick.fields.name, "Rocket League");
    assert.match(r.why, /played today/);
    assert.equal(drg.fields.coop, true);
  } finally { t.cleanup(); }
});

// ---------- calculators ----------

test("admin: split rounds to cents and gives the remainder to the first person", async () => {
  const t = makeHub();
  try {
    let r = await (await t.api("/calc/split", post({ subtotal: 100, people: 3 }))).json() as any;
    assert.deepEqual(r.per_person, [33.34, 33.33, 33.33]);
    assert.equal(r.total, 100);
    assert.equal(r.remainder_cents, 1);
    r = await (await t.api("/calc/split", post({ subtotal: 87.4, tax_pct: 6.25, tip_pct: 20, people: 3 }))).json() as any;
    assert.deepEqual({ tax: r.tax, tip: r.tip, total: r.total, per: r.per_person }, { tax: 5.46, tip: 17.48, total: 110.34, per: [36.78, 36.78, 36.78] });
    r = await (await t.api("/calc/split", post({ subtotal: 10, people: 3, shares: [2, 1, 1] }))).json() as any;
    assert.deepEqual(r.per_person, [5, 2.5, 2.5]);
    r = await (await t.api("/calc/split", post({ subtotal: 10, people: 3, shares: [1, 1, 1.5] }))).json() as any;
    assert.deepEqual(r.per_person, [2.87, 2.85, 4.28]);
    assert.equal((await t.api("/calc/split", post({ subtotal: 10, people: 0 }))).status, 422);
    assert.equal((await t.api("/calc/split", post({ subtotal: 10, people: 2, shares: [1] }))).status, 422);
  } finally { t.cleanup(); }
});

test("admin: payoff by payment, by months, and the never case", async () => {
  const t = makeHub();
  try {
    let r = await (await t.api("/calc/payoff", post({ balance: 4200, apr_pct: 28.99, payment: 200 }))).json() as any;
    assert.equal(r.mode, "payment");
    assert.equal(typeof r.months, "number");
    assert.equal(r.schedule.length, 12);
    assert.deepEqual(r.schedule[0], { month: 1, payment: 200, interest: 101.47, principal: 98.53, balance: 4101.47 });
    assert.equal(Math.round((r.total_paid - r.total_interest) * 100), 420000);
    r = await (await t.api("/calc/payoff", post({ balance: 1000, apr_pct: 12, months: 12 }))).json() as any;
    assert.equal(r.mode, "months");
    assert.equal(r.payment, 88.85);
    assert.equal(r.payoff_months, 12);
    assert.equal(r.schedule[11].balance, 0);
    r = await (await t.api("/calc/payoff", post({ balance: 1200, apr_pct: 0, months: 12 }))).json() as any;
    assert.equal(r.payment, 100);
    assert.equal(r.total_interest, 0);
    r = await (await t.api("/calc/payoff", post({ balance: 4200, apr_pct: 28.99, payment: 100 }))).json() as any;
    assert.equal(r.months, "never");
    assert.equal(r.total_interest, null);
    assert.equal(r.schedule.length, 12);
    assert.ok(r.schedule[11].balance > 4200);
    assert.match(r.why, /101\.47/);
    assert.equal((await t.api("/calc/payoff", post({ balance: 100, apr_pct: 10 }))).status, 422);
  } finally { t.cleanup(); }
});

test("admin: unit pricing, cheapest first", async () => {
  const t = makeHub();
  try {
    assert.equal((await t.api("/calc/change", post({ from: 80, to: 92.5 }))).status, 404);
    const u = await (await t.api("/calc/unit", post({ items: [
      { name: "Store brand", price: 3.99, qty: 16, unit: "oz" },
      { name: "Bulk bag", price: 3.0, qty: 500, unit: "g" },
      { name: "Name brand", price: 3.49, qty: 1, unit: "lb" },
    ] }))).json() as any;
    assert.equal(u.unit, "oz");
    assert.deepEqual(u.items.map((i: any) => i.name), ["Bulk bag", "Name brand", "Store brand"]);
    assert.equal(u.items[1].per_unit, 0.2181);
    assert.equal(u.cheapest, "Bulk bag");
    const bad = await t.api("/calc/unit", post({ items: [{ name: "a", price: 1, qty: 1, unit: "oz" }, { name: "b", price: 1, qty: 1, unit: "ml" }] }));
    assert.equal(bad.status, 422);
  } finally { t.cleanup(); }
});

// ---------- subscriptions ----------

test("admin: subscriptions turn repeats into monthly and yearly totals and skip entries without cost", async () => {
  const t = makeHub();
  try {
    const s = t.hub.store;
    s.create("watch", { title: "Domain", category: "subscription", due: "2027-03-01", cost: 120, repeat: "every 1 years" });
    s.create("watch", { title: "Streaming", category: "subscription", due: "2026-11-15", cost: 15.99, repeat: "every 1 months" });
    s.create("watch", { title: "Coffee club", category: "subscription", due: "2026-11-01", cost: 5, repeat: "every 1 weeks" });
    s.create("watch", { title: "VPS", category: "subscription", due: "2026-11-20", cost: 1, repeat: "every 10 days" });
    s.create("watch", { title: "Free tier", category: "subscription", due: "2026-12-01", repeat: "every 1 months" });
    s.create("watch", { title: "Cert", category: "cert", due: "2026-12-01", cost: 50, repeat: "every 1 years" });
    const r = await (await t.api("/finance/subscriptions")).json() as any;
    const byTitle = Object.fromEntries(r.items.map((i: any) => [i.title, i]));
    assert.equal(r.items.length, 4);
    assert.equal(byTitle.Domain.monthly, 10);
    assert.equal(byTitle.Streaming.monthly, 15.99);
    assert.equal(byTitle.Streaming.yearly, 191.88);
    assert.equal(byTitle["Coffee club"].monthly, 21.74);
    assert.equal(byTitle["Coffee club"].yearly, 260.89);
    assert.equal(byTitle.VPS.monthly, 3.04);
    assert.equal(r.monthly_total, 50.77);
    assert.equal(r.yearly_total, 609.3);
    assert.deepEqual(r.skipped.map((x: any) => [x.title, x.reason]), [["Free tier", "no cost"]]);
  } finally { t.cleanup(); }
});
