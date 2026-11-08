import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeHub } from "./helpers.js";
import { MODULES, moduleOfKind, moduleOfPath } from "../src/modules.js";
import { availableTools, runTool, TOOL_MODULE, TOOLS, toolGuide, type ToolContext } from "../src/ai/tools.js";
import { filingPrompt } from "../src/capture-filer.js";

test("a new hub starts with the default modules; one already in use starts with all of them", () => {
  const fresh = makeHub({ modulesPreset: "" });
  try {
    const on = fresh.hub.modules.list().filter((m) => m.on).map((m) => m.id).sort();
    assert.deepEqual(on, MODULES.filter((m) => m.default).map((m) => m.id).sort());
    assert.ok(fs.existsSync(path.join(fresh.dir, "modules.json")), "the first choice is written down, so it never changes by itself");
  } finally { fresh.cleanup(); }

  const used = makeHub({ modulesPreset: "" });
  try {
    used.hub.store.create("capture", { text: "Something already here", source: "web" });
    assert.ok(used.hub.modules.list().every((m) => m.on), "an update never hides what someone used");
  } finally { used.cleanup(); }

  const listed = makeHub({ modulesPreset: "pet, calc" });
  try {
    assert.deepEqual(listed.hub.modules.list().filter((m) => m.on).map((m) => m.id).sort(), ["calc", "pet"]);
  } finally { listed.cleanup(); }
});

test("every module's routes, tools and kinds name a real module, and paths map to the longest prefix", () => {
  const ids = new Set(MODULES.map((m) => m.id));
  for (const m of Object.values(TOOL_MODULE).flat()) assert.ok(ids.has(m), `tool module ${m}`);
  for (const name of Object.keys(TOOL_MODULE)) assert.ok(TOOLS.some((t) => t.name === name), `tool ${name} exists`);
  assert.equal(moduleOfPath("/calc/split"), "calc");
  assert.equal(moduleOfPath("/connections/password-manager/keepass/master"), "homelab");
  assert.equal(moduleOfPath("/connections/google/signin"), "mail");
  assert.equal(moduleOfPath("/connections/letterboxd"), "films");
  assert.equal(moduleOfPath("/calcium"), null, "a prefix matches whole path parts only");
  assert.equal(moduleOfPath("/library/films"), "films");
  assert.equal(moduleOfKind("pet_event"), "pet");
  assert.equal(moduleOfKind("task"), null);
});

test("GET and PUT /modules switch a module for every device; its routes answer 404 while it is off", async () => {
  const t = makeHub();
  try {
    const before = await (await t.api("/calc/split", { method: "POST", json: { total: 30, people: 3 } })).json() as Record<string, unknown>;
    assert.ok(!("error" in before) || !String(before.error).includes("is off"));

    let r = await t.api("/modules", { method: "PUT", json: { calc: false } });
    assert.equal(r.status, 200);
    const body = await r.json() as { modules: { id: string; on: boolean; title: string; summary: string; group: string }[] };
    assert.equal(body.modules.find((m) => m.id === "calc")?.on, false);
    assert.ok(body.modules.every((m) => m.title && m.summary && m.group));

    r = await t.api("/calc/split", { method: "POST", json: { total: 30, people: 3 } });
    assert.equal(r.status, 404);
    const off = await r.json() as { error: string; module: string };
    assert.equal(off.module, "calc");
    assert.match(off.error, /Calculators is off/);

    // Core routes are never switched off.
    assert.equal((await t.api("/profile")).status, 200);

    assert.equal((await t.api("/modules", { method: "PUT", json: { nope: true } })).status, 422);
    assert.equal((await t.api("/modules", { method: "PUT", json: { calc: "yes" } })).status, 422);

    r = await t.api("/modules", { method: "PUT", json: { calc: true } });
    assert.equal(r.status, 200);
    assert.notEqual((await t.api("/calc/split", { method: "POST", json: { total: 30, people: 3 } })).status, 404);
  } finally { t.cleanup(); }
});

test("switching a module on brings its starter content; switching it off keeps its data", async () => {
  const t = makeHub({ modulesPreset: "" });
  try {
    assert.equal(t.hub.store.list({ kind: "food_option" }).length, 0, "food is off on a new hub, so its seed waits");
    await t.api("/modules", { method: "PUT", json: { food: true } });
    const foods = t.hub.store.list({ kind: "food_option" }).length;
    assert.ok(foods > 0, "the food seed ran when Food was switched on");
    await t.api("/modules", { method: "PUT", json: { food: false } });
    assert.equal(t.hub.store.list({ kind: "food_option" }).length, foods, "off hides, never erases");
  } finally { t.cleanup(); }
});

test("the assistant gets no tools, guide lines or kinds of a module that is off", async () => {
  const t = makeHub();
  try {
    t.hub.modules.set({ homelab: false, calc: false, web: false, films: false, games: false, jobs: false, renewals: false });
    const on = t.hub.modules.check;
    const names = availableTools(t.hub.cfg, undefined, on).map((x) => x.name);
    for (const gone of ["run_command", "approve_command", "ops_status", "calculate", "web_search", "read_web_page", "library"]) assert.ok(!names.includes(gone), `${gone} is left out`);
    assert.ok(names.includes("create_task") && names.includes("save_note"), "core tools stay");
    const guide = toolGuide(on);
    assert.doesNotMatch(guide, /run_command|web_search|runbook_note|library for ranked/);
    assert.match(guide, /Their data: for anything about today/);
    assert.equal(t.hub.ai.capabilities().hosts, false);

    const create = TOOLS.find((x) => x.name === "create_item")!;
    const api = async (method: string, p: string, body?: unknown) => { const r = await t.api(p, { method, json: body }); return { status: r.status, data: await r.json() }; };
    const ctx = { sessionId: "s", lastUser: "", topic: "", store: t.hub.store, cfg: t.hub.cfg, hosts: null, moduleOn: on } as ToolContext;
    const out = await runTool(api, { name: "create_item", arguments: { kind: "film", fields: { title: "Heat", watchlist: true } } }, ctx, [create]);
    assert.equal(out.ok, false);
    assert.match(out.text, /Films is switched off/);
    assert.equal(t.hub.store.list({ kind: "film" }).length, 0);
  } finally { t.cleanup(); }
});

test("the filer is not told about modules that are off", () => {
  const all = filingPrompt("Luigi's was great, Rafael recommended it", new Date());
  assert.match(all, /food list/);
  const off = filingPrompt("Luigi's was great, Rafael recommended it", new Date(), undefined, [], [], [], undefined, (m) => m !== "food" && m !== "music");
  assert.doesNotMatch(off, /food list|music_idea/);
  assert.match(off, /film watchlist/);
});

test("Today and the digest leave renewals out while that module is off", async () => {
  const t = makeHub();
  try {
    const soon = new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10);
    t.hub.store.create("watch", { title: "Domain renewal", due: soon, category: "domain" });
    const on = await (await t.api("/planner/today")).json() as { watches_due_soon: unknown[] };
    assert.equal(on.watches_due_soon.length, 1);
    t.hub.modules.set({ renewals: false });
    const off = await (await t.api("/planner/today")).json() as { watches_due_soon: unknown[] };
    assert.equal(off.watches_due_soon.length, 0);
  } finally { t.cleanup(); }
});

test("the dashboard and the metrics tool leave out charts of modules that are off", async () => {
  const t = makeHub();
  try {
    t.hub.store.create("log", { type: "weight", value: 180, unit: "lb", at: new Date().toISOString() });
    const ids = async () => ((await (await t.api("/dashboard/metrics")).json()) as { metrics: { id: string }[] }).metrics.map((m) => m.id);
    assert.ok((await ids()).includes("log:weight"));
    t.hub.modules.set({ health: false });
    assert.ok(!(await ids()).includes("log:weight"));
    await t.api("/prefs/dashboard", { method: "PUT", json: { tiles: [{ metric: "log:weight", range: 30, chart: "line" }, { metric: "captures:created", range: 30, chart: "bar" }] } });
    const board = (await (await t.api("/dashboard/board")).json()) as { tiles: { metric: string }[] };
    assert.deepEqual(board.tiles.map((x) => x.metric), ["captures:created"]);
  } finally { t.cleanup(); }
});

test("a module switched off sets its reminders aside on every device and brings them back when it is on", async () => {
  const t = makeHub();
  try {
    const due = new Date(Date.now() + 3 * 86400_000).toISOString();
    const w = t.hub.store.create("watch", { title: "example.com domain", category: "domain", due, lead_days: 7 });
    const reminder = () => t.hub.store.list({ kind: "task" }).find((x) => x.fields.linked_id === w.id);
    assert.ok(reminder(), "a renewal has its reminder");
    await t.api("/modules", { method: "PUT", json: { renewals: false } });
    assert.equal(reminder(), undefined, "set aside (deleted, so every device drops it)");
    // A write while off makes no new reminder.
    t.hub.store.patch(w.id, { due: new Date(Date.now() + 5 * 86400_000).toISOString() });
    assert.equal(reminder(), undefined);
    // Renewal dates stay out of the calendar feed, Ops and the status page.
    assert.equal((await (await t.api("/ops")).status), 200);
    assert.equal(((await (await t.api("/ops")).json()) as { watches_due_30d: unknown[] }).watches_due_30d.length, 0);
    assert.equal(((await (await t.api("/status")).json()) as { planner: { watches_due_30d: number } }).planner.watches_due_30d, 0);
    await t.api("/modules", { method: "PUT", json: { renewals: true } });
    assert.ok(reminder(), "made again from the renewal");
  } finally { t.cleanup(); }
});

test("switching a module on seeds only that module, and a damaged modules.json is kept and logged, not reset", async () => {
  const t = makeHub();
  try {
    const { runSeeds } = await import("../src/seed.js");
    runSeeds(t.hub.store, t.hub.cfg, t.hub.modules.check);
    const list = t.hub.store.list({ kind: "checklist" })[0];
    assert.ok(list, "the fixture seeds a checklist");
    t.hub.store.patch(list.id, { title: "Renamed by the owner" });
    const lists = t.hub.store.list({ kind: "checklist" }).length;
    const monitors = t.hub.store.list({ kind: "monitor" }).length;
    await t.api("/modules", { method: "PUT", json: { calc: false } });
    await t.api("/modules", { method: "PUT", json: { calc: true } });
    assert.equal(t.hub.store.list({ kind: "checklist" }).length, lists, "the renamed starter list did not come back as a copy");
    assert.equal(t.hub.store.list({ kind: "monitor" }).length, monitors);
  } finally { t.cleanup(); }
  const d = makeHub({ modulesPreset: "" });
  try {
    const file = path.join(d.dir, "modules.json");
    fs.writeFileSync(file, '{ "homelab": false, "health": false, }');
    const { ModuleStore } = await import("../src/modules.js");
    const errors: string[] = [];
    const orig = console.error;
    console.error = (m: unknown) => { errors.push(String(m)); };
    try {
      const s = new ModuleStore(file, { existing: () => false, preset: "" });
      assert.equal(s.on("homelab"), true, "every module counts as on meanwhile");
      assert.match(fs.readFileSync(file, "utf8"), /"homelab": false, "health": false, \}/, "the owner's file is left to mend");
      assert.match(errors.join("\n"), /could not be read/);
    } finally { console.error = orig; }
  } finally { d.cleanup(); }
});

test("with Homelab off a waiting change does not run, and its items are not written; search leaves off modules out", async () => {
  const t = makeHub();
  try {
    await t.api("/modules", { method: "PUT", json: { homelab: false, games: false } });
    const r = await t.api("/ai/chat", { method: "POST", json: { session_id: "s-off", message: "yes", approve_action_id: "nope" } });
    assert.equal(r.status, 404, "an unknown action is still 404");
    assert.equal((await t.api("/ai/hosts")).status, 404);
    t.hub.store.create("game", { name: "Zork the Searchable" });
    t.hub.store.create("note", { title: "Zork notes", body: "Zork", path: "Inbox/zork.md" });
    const hits = ((await (await t.api("/search?q=Zork")).json()) as { hits: { kind: string }[] }).hits;
    assert.deepEqual(hits.map((h) => h.kind), ["note"]);
  } finally { t.cleanup(); }
});

test("a renewal mail read while Renewals is off waits, and goes back in the queue when it is switched on", async () => {
  const t = makeHub();
  try {
    const { mailModule } = await import("../src/mail-filer.js");
    assert.equal(mailModule("renewal_notice"), "renewals");
    assert.equal(mailModule("vet_due"), "pet");
    assert.equal(mailModule("none"), null);
    await t.api("/modules", { method: "PUT", json: { renewals: false } });
    const ins = t.hub.db.prepare("INSERT INTO mail (account, id, at, state, attempts, result) VALUES (?, ?, ?, ?, 0, ?)");
    ins.run("a@example.com", "m1", "2026-11-05T05:00:00Z", "parked", JSON.stringify({ type: "renewal_notice", parked_for: "renewals" }));
    ins.run("a@example.com", "m2", "2026-11-05T05:00:00Z", "parked", JSON.stringify({ type: "vet_due", parked_for: "pet" }));
    await t.api("/modules", { method: "PUT", json: { renewals: true } });
    const state = (id: string) => (t.hub.db.prepare("SELECT state FROM mail WHERE id = ?").get(id) as { state: string }).state;
    assert.equal(state("m1"), "queued");
    assert.equal(state("m2"), "parked", "only the module switched on");
  } finally { t.cleanup(); }
});
