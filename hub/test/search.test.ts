import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub } from "./helpers.js";

test("search: FTS5 hits with snippets across kinds, deleted rows drop out", async () => {
  const t = makeHub();
  try {
    const task = t.hub.store.create("task", { title: "Renew the Tailscale cert on pve1", status: "next", order: 1 });
    t.hub.store.create("runbook", { host: "pve1", title: "Proxmox node", body: "The NIC hangs after resume. Run the reset script.", commands: [{ label: "reset nic", host: "pve1", user: "root", command: "ip link set eno1 down && ip link set eno1 up" }] });
    t.hub.store.create("note", { title: "Shopping", path: "Shopping.md", body: "filament, tape" });
    let res = await t.api("/search?q=pve1");
    assert.equal(res.status, 200);
    let hits = (await res.json() as { hits: { id: string; kind: string; title: string; snippet: string; score: number }[] }).hits;
    assert.equal(hits.length, 2);
    assert.ok(hits.every((h) => typeof h.score === "number"));
    res = await t.api("/search?q=nic%20hang&kinds=runbook");
    hits = (await res.json() as { hits: any[] }).hits;
    assert.equal(hits.length, 1);
    assert.match(hits[0].snippet, /\[NIC\]/);
    res = await t.api("/search?q=eno1");
    assert.equal((await res.json() as { hits: any[] }).hits.length, 1);
    await t.api(`/entities/${task.id}`, { method: "DELETE" });
    res = await t.api("/search?q=pve1&kinds=task");
    assert.equal((await res.json() as { hits: any[] }).hits.length, 0);
  } finally { t.cleanup(); }
});

test("search matches plurals and tenses and still any typed prefix", () => {
  const t = makeHub();
  try {
    const list = t.hub.store.create("checklist", { title: "Groceries", kind: "generic", items: [{ text: "Eggs" }] });
    const note = t.hub.store.create("note", { title: "Pepper", body: "Long walk by the pond", path: "Pets/Pepper.md" });
    assert.ok(t.hub.store.search("grocery").some((h) => h.id === list.id));
    assert.ok(t.hub.store.search("walked").some((h) => h.id === note.id));
    assert.ok(t.hub.store.search("gro").some((h) => h.id === list.id), "a typed prefix still matches");
    const uni = t.hub.store.create("note", { title: "University applications", body: "Happiness and running notes", path: "Inbox/u.md" });
    for (const q of ["universit", "happin", "runn", "running", "ran"]) assert.equal(t.hub.store.search(q).some((h) => h.id === uni.id), q !== "ran", q);
    // Several words, some with endings, in any order: every word must match (it was an FTS syntax error).
    const party = t.hub.store.create("event", { title: "Saturday night party at Rafael's", start: "2026-11-07T19:00:00-05:00", end: "2026-11-07T22:00:00-05:00", all_day: false });
    for (const q of ["saturday night", "night saturday", "parties saturday night", "rafael's party (saturday)"]) assert.ok(t.hub.store.search(q).some((h) => h.id === party.id), q);
    assert.equal(t.hub.store.search("saturday morning").some((h) => h.id === party.id), false);
  } finally { t.cleanup(); }
});

test("a stemmed index is made again plain on start", () => {
  const t = makeHub();
  try {
    // An index from the porter weeks: made again plain, so prefixes match again.
    t.hub.db.exec("DROP TABLE entities_fts; CREATE VIRTUAL TABLE entities_fts USING fts5(id UNINDEXED, kind UNINDEXED, title, text, tokenize = 'porter unicode61 remove_diacritics 2')");
    t.hub.db.pragma("user_version = 5");
    const n = t.hub.store.create("note", { title: "University", body: "", path: "Inbox/u.md" });
    assert.equal(t.hub.store.search("universit").length, 0);
    assert.equal(t.hub.store.reindexFtsIfOutdated(), true);
    assert.ok(t.hub.store.search("universit").some((h) => h.id === n.id));
  } finally { t.cleanup(); }
});
