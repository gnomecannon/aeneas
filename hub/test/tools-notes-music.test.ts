import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub } from "./helpers.js";
import { ctxFor } from "./ai-helpers.js";
import { runTool } from "../src/ai/tools.js";

test("assistant: ideas by tag and folder, and a music idea filed to its music project", async () => {
  const t = makeHub();
  try {
    const a = async (method: string, p: string, body?: unknown) => {
      const res = await t.app.request(p, { method, headers: { authorization: `Bearer ${t.hub.cfg.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: res.status, data: await res.json().catch(() => null) };
    };
    const ctx = ctxFor(t, "tools-1");
    t.hub.store.create("note", { title: "Robot choir", body: "Vacuums keep joining.", tags: ["comedy", "sketch", "idea"], path: "Writing/Sketches/Robot choir.md" });
    t.hub.store.create("note", { title: "Silent auction", body: "Silent.", tags: ["comedy", "sketch"], path: "Writing/Sketches/Silent auction.md" });
    t.hub.store.create("note", { title: "Lighthouse keeper", body: "A light nobody sees.", tags: ["idea", "story"], path: "Writing/Lighthouse keeper.md" });
    const out = (r: { text: string }) => JSON.parse(r.text) as { notes: { title: string }[]; count: number };
    let r = out(await runTool(a, { name: "list_items", arguments: { kind: "note", tag: "idea, sketch" } }, ctx));
    assert.deepEqual(r.notes.map((n) => n.title), ["Robot choir"], "skit ideas: both tags");
    r = out(await runTool(a, { name: "list_items", arguments: { kind: "note", folder: "Writing/Sketches" } }, ctx));
    assert.equal(r.count, 2, "a folder includes the folders inside it");
    const songs = t.hub.store.create("project", { name: "Songs", status: "active", definition_of_done: "One song finished", area: "music" });
    await runTool(a, { name: "music_idea", arguments: { text: "Am F C G 6/8 garden song", project: "songs" } }, ctx);
    assert.equal(t.hub.store.list({ kind: "music_idea" })[0]?.fields.project_id, songs.id);
    const missing = JSON.parse((await runTool(a, { name: "music_idea", arguments: { text: "riff", project: "Album" } }, ctx)).text) as { error?: string; music_projects?: string[] };
    assert.match(String(missing.error), /no music project named Album/);
    assert.deepEqual(missing.music_projects, ["Songs"]);
  } finally { t.cleanup(); }
});

test("assistant: 'I renewed the domain' finds the renewal by name, and a wrong id gets the list back", async () => {
  const t = makeHub();
  try {
    const a = async (method: string, p: string, body?: unknown) => {
      const res = await t.app.request(p, { method, headers: { authorization: `Bearer ${t.hub.cfg.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: res.status, data: await res.json().catch(() => null) };
    };
    const ctx = ctxFor(t, "tools-2");
    const dom = t.hub.store.create("watch", { title: "robin-rivera.example domain", category: "domain", due: "2026-11-23", lead_days: 14, repeat: "every 1 years" });
    t.hub.store.create("watch", { title: "Plex Pass", category: "subscription", due: "2026-11-15" });
    const car = t.hub.store.create("task", { title: "Renew car registration", status: "next", order: 1 });
    const wrong = JSON.parse((await runTool(a, { name: "record_done", arguments: { what: "renewal", id: car.id } }, ctx)).text) as { error?: string; renewals?: { title: string }[] };
    assert.match(String(wrong.error), /not a renewal/);
    assert.deepEqual(wrong.renewals?.map((r) => r.title).sort(), ["Plex Pass", "robin-rivera.example domain"]);
    const r = await runTool(a, { name: "record_done", arguments: { what: "renewal", name: "the domain" } }, ctx);
    assert.equal(r.ok, true);
    assert.equal(t.hub.store.get(dom.id)!.fields.due, "2027-11-23");
  } finally { t.cleanup(); }
});
