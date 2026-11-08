import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { zipSync, strToU8 } from "fflate";
import { makeHub, type TestHub } from "./helpers.js";
import { setBackendOverride, type AiMessage, type Backend } from "../src/ai/backends.js";
import { gptTurns, importsIdle, kick, parseIcs, parseVcf, readEntries, type ImportJob } from "../src/imports/bulk.js";

const conv = (title: string, t: number, turns: [string, string][], branch = false) => {
  const mapping: Record<string, unknown> = { root: { message: null, parent: null } };
  let parent = "root";
  turns.forEach(([role, text], i) => { mapping[`n${i}`] = { message: { author: { role }, content: { content_type: "text", parts: [text] } }, parent }; parent = `n${i}`; });
  // A message the owner edited away: on a branch the conversation did not end on.
  if (branch) mapping.dead = { message: { author: { role: "user" }, content: { content_type: "text", parts: ["the old question"] } }, parent: "root" };
  return { title, create_time: t, current_node: parent, mapping };
};

async function upload(t: TestHub, name: string, data: Uint8Array, learn = false): Promise<ImportJob> {
  const r = await t.api(`/imports/upload?name=${encodeURIComponent(name)}${learn ? "&learn=1" : ""}`, { method: "POST", body: data as unknown as RequestInit["body"] });
  assert.equal(r.status, 200, await r.clone().text());
  const job = (await r.json()) as ImportJob;
  await importsIdle();
  return ((await (await t.api("/imports/jobs")).json()) as { jobs: ImportJob[] }).jobs.find((j) => j.id === job.id)!;
}

test("import: a ChatGPT export becomes notes, and with learn its owner's words become new facts", async () => {
  const t = makeHub();
  const sent: string[] = [];
  setBackendOverride({ name: "ollama", model: "m", chat: async (m: AiMessage[]) => {
    sent.push(m[1].content);
    return { text: JSON.stringify({ facts: [{ category: "relationship", key: "dog name", value: "Their dog is Biscuit, a beagle." }, { category: "identity", key: "name", value: "Jamie" }, { category: "weather", key: "x", value: "nope" }] }), usage: {} };
  }, stream: async () => ({ text: "", usage: {} }) } as Backend);
  try {
    t.hub.store.create("fact", { category: "identity", key: "name", value: "Jamie Rivera" });
    const data = zipSync({
      "conversations.json": strToU8(JSON.stringify([
        conv("Beagle training", 1700000000, [["user", "My beagle Biscuit pulls on the leash"], ["assistant", "Try a front-clip harness."]], true),
        conv("Empty", 1700000500, []),
      ])),
      "dalle-generations/img.png": new Uint8Array(2000),
    });
    const job = await upload(t, "chatgpt-export.zip", data, true);
    assert.equal(job.state, "done", job.error ?? job.detail);
    assert.deepEqual(job.kinds, ["ChatGPT"]);
    assert.equal(job.counts.notes, 1);
    const note = t.hub.store.list({ kind: "note" }).find((n) => n.fields.title === "Beagle training")!;
    assert.equal(note.fields.path, "Imported/ChatGPT/2023-11/Beagle training.md");
    assert.match(String(note.fields.body), /\*\*Me:\*\* My beagle Biscuit pulls on the leash/);
    assert.ok(!String(note.fields.body).includes("the old question"), "only the branch the conversation ended on");
    assert.deepEqual(note.fields.tags, ["imported", "chatgpt"]);
    // Learned: only the owner's words were read, a new fact is kept, a known key and a bad category are not.
    assert.equal(sent.length, 1);
    assert.match(sent[0], /My beagle Biscuit/);
    assert.ok(!sent[0].includes("front-clip"), "never what the other assistant said");
    assert.match(sent[0], /Keys already known: identity:name/);
    assert.equal(job.counts.facts, 1);
    const dog = t.hub.store.list({ kind: "fact" }).find((f) => f.fields.key === "dog_name")!;
    assert.match(String(dog.fields.source), /^import:/);
    assert.equal(t.hub.store.list({ kind: "fact" }).find((f) => f.fields.key === "name")!.fields.value, "Jamie Rivera", "a known fact is never changed");
    assert.equal(fs.existsSync(path.join(t.hub.cfg.dataDir, "imports", job.id)), false, "the upload is gone once it is in");
    // The same export again adds nothing.
    const again = await upload(t, "chatgpt-export.zip", data);
    assert.deepEqual([again.counts.notes, again.counts.skipped], [0, 2]);
  } finally { setBackendOverride(null); t.cleanup(); }
});

test("import: Google Takeout fills notes, people, tasks and a calendar history note, and skips what is here already", async () => {
  const t = makeHub();
  try {
    t.hub.store.create("person", { name: "Jo Park", phones: [{ value: "(555) 010-2000" }], emails: [], dates: [], addresses: [] });
    t.hub.store.create("task", { title: "Renew passport", status: "inbox", order: 1 });
    const ics = ["BEGIN:VCALENDAR", "X-WR-CALNAME:Personal", "BEGIN:VEVENT", "DTSTART;VALUE=DATE:20220704", "SUMMARY:BBQ at Jo's", "LOCATION:Jo's house\\, Springfield", "END:VEVENT",
      "BEGIN:VEVENT", "DTSTART:20231225T180000Z", "SUMMARY:Holiday dinner", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
    const vcf = ["BEGIN:VCARD", "VERSION:3.0", "FN:Jo Park", "TEL:+1 555 010 2000", "END:VCARD", "BEGIN:VCARD", "VERSION:3.0", "FN:Chris Lee", "N:Lee;Chris;;;", "EMAIL;TYPE=INTERNET:Chris@Example.com", "BDAY:1990-04-02", "ORG:Acme;", "END:VCARD"].join("\r\n");
    const data = zipSync({
      "Takeout/Keep/Groceries.json": strToU8(JSON.stringify({ title: "Groceries", listContent: [{ text: "eggs", isChecked: true }, { text: "rice" }], labels: [{ name: "Home Stuff" }], userEditedTimestampUsec: 1700000000000000 })),
      "Takeout/Keep/Old.json": strToU8(JSON.stringify({ title: "Trashed", textContent: "x", isTrashed: true })),
      "Takeout/Keep/Groceries.html": strToU8("<html>ignored</html>"),
      "Takeout/Calendar/Personal.ics": strToU8(ics),
      "Takeout/Contacts/All Contacts/All Contacts.vcf": strToU8(vcf),
      "Takeout/Tasks/Tasks.json": strToU8(JSON.stringify({ items: [{ title: "My Tasks", items: [{ title: "Renew passport", status: "needsAction" }, { title: "Call the dentist", status: "needsAction", due: "2026-12-01T00:00:00.000Z" }, { title: "Done thing", status: "completed" }] }] })),
    });
    const job = await upload(t, "takeout-20261103.zip", data);
    assert.equal(job.state, "done", job.error ?? "");
    assert.deepEqual(job.kinds, ["Google Keep", "Google Tasks", "Contacts", "Calendar history"]);
    assert.deepEqual([job.counts.notes, job.counts.people, job.counts.tasks], [3, 1, 1]);
    const groceries = t.hub.store.list({ kind: "note" }).find((n) => n.fields.title === "Groceries")!;
    assert.match(String(groceries.fields.body), /- \[x\] eggs\n- \[ \] rice/);
    assert.deepEqual(groceries.fields.tags, ["imported", "keep", "home-stuff"]);
    const chris = t.hub.store.list({ kind: "person" }).find((p) => p.fields.name === "Chris Lee")!;
    assert.deepEqual([chris.fields.given_name, chris.fields.family_name, chris.fields.birthday, chris.fields.organization], ["Chris", "Lee", "1990-04-02", "Acme"]);
    assert.equal(t.hub.store.list({ kind: "person" }).length, 2, "Jo is matched by phone");
    assert.ok(t.hub.store.list({ kind: "task" }).some((x) => x.fields.title === "Call the dentist" && String(x.fields.due).startsWith("2026-12-01")));
    assert.equal(t.hub.store.list({ kind: "task" }).length, 2);
    const y2022 = t.hub.store.list({ kind: "note" }).find((n) => n.fields.title === "Personal 2022")!;
    assert.match(String(y2022.fields.body), /- 2022-07-04 BBQ at Jo's \(Jo's house, Springfield\)/);
    assert.equal(t.hub.store.list({ kind: "event" }).length, 0, "calendar history never becomes events");
  } finally { t.cleanup(); }
});

test("import: a zipped Obsidian vault keeps its folders and tags, Notion ids go, Evernote and pasted text become notes", async () => {
  const t = makeHub();
  try {
    const vault = zipSync({
      "My Vault/Writing/Horror/Fog.md": strToU8("---\ntags: [horror, story]\n---\nSomething walks in the fog. [[Lighthouse]]"),
      "My Vault/Lighthouse.md": strToU8("A keeper hears knocking."),
      "My Vault/.obsidian/workspace.json": strToU8("{}"),
      "My Vault/Projects/Plan 0123456789abcdef0123456789abcdef.md": strToU8("Notion page"),
    });
    const job = await upload(t, "vault.zip", vault);
    assert.equal(job.state, "done", job.error ?? "");
    const fog = t.hub.store.list({ kind: "note" }).find((n) => n.fields.title === "Fog")!;
    assert.equal(fog.fields.path, "Writing/Horror/Fog.md");
    assert.deepEqual(fog.fields.tags, ["horror", "story"]);
    assert.ok(t.hub.store.list({ kind: "note" }).some((n) => n.fields.path === "Projects/Plan.md"));
    const enex = `<?xml version="1.0"?><en-export><note><title>Trip ideas</title><content><![CDATA[<en-note><div>Iceland</div><div>Japan &amp; Korea</div></en-note>]]></content><created>20190102T000000Z</created><tag>travel</tag></note></en-export>`;
    const ev = await upload(t, "Travel.enex", strToU8(enex));
    assert.deepEqual(ev.kinds, ["Evernote"]);
    const trip = t.hub.store.list({ kind: "note" }).find((n) => n.fields.title === "Trip ideas")!;
    assert.equal(trip.fields.path, "Imported/Evernote/Travel/Trip ideas.md");
    assert.match(String(trip.fields.body), /Iceland\nJapan & Korea/);
    const r = await t.api("/imports/text", { method: "POST", json: { title: "Brain dump", text: "I want to build a cabin someday." } });
    assert.equal(r.status, 200);
    await importsIdle();
    const dump = ((await (await t.api("/imports/jobs")).json()) as { jobs: ImportJob[] }).jobs[0];
    assert.deepEqual([dump.state, dump.kinds], ["done", ["Text"]]);
    assert.ok(t.hub.store.list({ kind: "note" }).some((n) => n.fields.path === "Imported/Text/Brain dump.md"));
    // Something it cannot read says what it can.
    const bad = await upload(t, "photo.jpg", new Uint8Array(500).fill(7));
    assert.equal(bad.state, "failed");
    assert.match(String(bad.error), /ChatGPT export, a Google Takeout/);
  } finally { t.cleanup(); }
});

test("import: parsers", () => {
  assert.deepEqual(parseIcs("BEGIN:VEVENT\nDTSTART:20240101T100000\nSUMMARY:New\n  year\nEND:VEVENT").events, [{ day: "2024-01-01", title: "New year", location: "" }]);
  assert.equal(parseVcf("BEGIN:VCARD\nN:Doe;Ann;;;\nBDAY:--0315\nEND:VCARD")[0].birthday, "--03-15");
  assert.equal(parseVcf("BEGIN:VCARD\nN:Doe;Ann;;;\nEND:VCARD")[0].name, "Ann Doe");
  assert.deepEqual(gptTurns({ mapping: {} }), []);
});

test("import: one upload reads at most so much, and says how many files it left out", async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "ea-read-"));
  try {
    const file = path.join(dir, "notes.zip");
    fs.writeFileSync(file, zipSync({ "a.md": strToU8("a".repeat(100)), "b.md": strToU8("b".repeat(100)), "c.md": strToU8("c".repeat(100)), "photo.jpg": strToU8("x") }));
    const byCount = { leftOut: 0 };
    assert.equal((await readEntries(file, byCount, { total: 1e9, entries: 2 })).length, 2);
    assert.equal(byCount.leftOut, 1);
    const bySize = { leftOut: 0 };
    assert.equal((await readEntries(file, bySize, { total: 250, entries: 100 })).length, 2);
    assert.equal(bySize.leftOut, 1, "the file that went over the total is dropped whole, and photos never count");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("import: a job the hub stopped in twice while reading fails instead of stopping the hub on every start", async () => {
  const t = makeHub();
  try {
    const dir = path.join(t.dir, "imports");
    const id = "11111111-2222-3333-4444-555555555555";
    fs.mkdirSync(path.join(dir, id), { recursive: true });
    fs.writeFileSync(path.join(dir, id, `${id}_huge.zip`), "PK");
    const job: ImportJob = { id, name: "huge.zip", kinds: [], state: "reading", learn: false, created_at: new Date().toISOString(), finished_at: null, counts: { notes: 0, people: 0, tasks: 0, facts: 0, skipped: 0 }, learned: { done: 0, total: 0 }, detail: "Reading the file", error: null, interrupted: { at: -1, times: 1 } };
    fs.writeFileSync(path.join(dir, "jobs.json"), JSON.stringify([job]));
    kick(t.hub);
    await importsIdle();
    const after = ((await (await t.api("/imports/jobs")).json()) as { jobs: ImportJob[] }).jobs[0];
    assert.equal(after.state, "failed");
    assert.match(after.error ?? "", /stopped twice while reading/);
    assert.ok(!fs.existsSync(path.join(dir, id)), "the upload is removed");
  } finally { t.cleanup(); }
});
