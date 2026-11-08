import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeHub, type TestHub } from "./helpers.js";
import { setBackendOverride, type AiMessage, type Backend } from "../src/ai/backends.js";
import { cleanTag, linkNote, machineTitle, nextNote, noteFolders, parseLinkerRead } from "../src/note-linker.js";
import { parseNoteFile } from "../src/vault.js";
import { filingPrompt, startFilingJob } from "../src/capture-filer.js";

/** A local model that answers the linker from a table keyed by the note's title. */
function linkerModel(answers: Record<string, unknown>): Backend & { sent: AiMessage[][] } {
  const b = {
    name: "ollama" as const, model: "scripted", sent: [] as AiMessage[][],
    chat: async (msgs: AiMessage[], opts?: { json?: boolean }) => {
      assert.equal(opts?.json, true);
      b.sent.push(msgs);
      const title = /^Note: "(.*)"$/m.exec(msgs[1].content)?.[1] ?? "";
      return { text: JSON.stringify(answers[title] ?? { tags: [], related: [] }), usage: {} };
    },
    stream: async () => ({ text: "", usage: {} }),
  };
  return b;
}

function note(t: TestHub, path_: string, title: string, body: string, tags: string[] = []) {
  return t.hub.store.create("note", { title, body, tags, path: path_ });
}

const file = (t: TestHub, rel: string) => fs.readFileSync(path.join(t.hub.cfg.vaultDir, rel), "utf8");

test("the linker tags and links a note, keeps the owner's tags and writes [[links]] Obsidian reads", async () => {
  const t = makeHub();
  try {
    const choir = note(t, "Writing/Sketches/Robot choir.md", "Robot choir", "A sketch where vacuums keep joining the choir.", ["comedy"]);
    note(t, "Writing/Sketches/Silent auction.md", "Silent auction", "Everyone at the silent auction takes the name far too literally.", ["comedy", "sketch"]);
    note(t, "Music/Song Ideas & Lyrics/Rain song.md", "Rain song", "Lyrics about rain on a tin roof.", ["music", "lyric"]);
    const model = linkerModel({ "Robot choir": { tags: ["Sketch", "#idea", "robots", "note"], related: ["silent auction", "A note that does not exist", "Robot choir"] } });
    setBackendOverride(model);
    const r = await linkNote(t.hub, choir.id);
    assert.equal(r.state, "linked");
    const after = t.hub.store.get(choir.id)!;
    assert.deepEqual(after.fields.tags, ["comedy", "sketch", "idea", "robots"], "the owner's tag stays first; empty tags are dropped");
    assert.deepEqual(after.fields.ai_tags, ["sketch", "idea", "robots"]);
    assert.deepEqual(after.fields.related, ["Silent auction"], "only real notes, in their own spelling, never itself");
    assert.ok((after.fields.links as string[]).includes("Silent auction"));
    const text = file(t, "Writing/Sketches/Robot choir.md");
    assert.match(text, /^tags: \[comedy, sketch, idea, robots\]$/m);
    assert.match(text, /^related:\n {2}- "\[\[Silent auction\]\]"$/m);
    const parsed = parseNoteFile(text, "Writing/Sketches/Robot choir.md");
    assert.deepEqual(parsed.related, ["Silent auction"], "the file reads back the same");
    // The map and Backlinks see it from both sides.
    const auction = t.hub.map.resolve("Silent auction")!;
    assert.ok(t.hub.map.related(auction.id).backlinks.some((b) => b.id === choir.id));
    assert.ok(t.hub.map.graph().edges.some((e) => e.from === choir.id && e.to === auction.id));
    // The prompt carries the tags in use, the owner's own tags and the other notes.
    const prompt = model.sent[0][1].content;
    assert.match(prompt, /Tags in use \(most used first\): comedy \(2\)/);
    assert.match(prompt, /Tags the owner gave it \(they stay; do not repeat them\): comedy/, "the hub's own prompt names the owner");
    assert.match(prompt, /- "Silent auction" \(Writing\/Sketches; #comedy #sketch\)/);
    // Read once: unchanged, it is not read again.
    model.sent.length = 0;
    for (const n of t.hub.store.list({ kind: "note" })) if (n.id !== choir.id) await linkNote(t.hub, n.id);
    assert.equal(nextNote(t.hub), null);
  } finally { setBackendOverride(null); t.cleanup(); }
});

test("a tag the owner removes is never added back, and new text is read again", async () => {
  const t = makeHub();
  try {
    note(t, "Writing/Horror/Fog.md", "Fog", "Something walks in the fog.", ["horror", "story"]);
    const n = note(t, "Writing/Horror/Lighthouse.md", "Lighthouse", "A keeper hears knocking from below the light.");
    setBackendOverride(linkerModel({ Lighthouse: { tags: ["horror", "story", "ocean", "keeper-lore"], related: [] } }));
    await linkNote(t.hub, n.id);
    assert.deepEqual(t.hub.store.get(n.id)!.fields.tags, ["horror", "story", "ocean"], "tags in use, and one new tag at most");
    // The owner removes "ocean" and adds "keeper", then writes more.
    t.hub.store.patch(n.id, { tags: ["horror", "story", "keeper"] });
    assert.notEqual(nextNote(t.hub)?.id, n.id, "a tag change alone is not new text");
    t.hub.store.patch(n.id, { body: "A keeper hears knocking from below the light. It is his own voice." });
    assert.equal(nextNote(t.hub)?.id, n.id);
    await linkNote(t.hub, n.id);
    const f = t.hub.store.get(n.id)!.fields;
    assert.deepEqual(f.tags, ["keeper", "horror", "story", "keeper-lore"], "ocean stays removed; one new tag joins");
    assert.deepEqual(f.tags_rejected, ["ocean"]);
  } finally { setBackendOverride(null); t.cleanup(); }
});

test("a capture note waiting in Inbox is moved to its folder and given a short title", async () => {
  const t = makeHub();
  try {
    note(t, "Writing/Sketches/Silent auction.md", "Silent auction", "Very quiet bids.", ["comedy", "sketch"]);
    note(t, "Writing/Horror/Lighthouse.md", "Lighthouse", "Knocking.", ["horror"]);
    const body = "A story idea about a lighthouse keeper whose light only works when nobody is watching, and nobody believes him";
    const inbox = note(t, `Inbox/${body.slice(0, 80)}.md`, body.slice(0, 80), body);
    assert.ok(machineTitle(inbox));
    assert.deepEqual(noteFolders(t.hub.store), ["Writing", "Writing/Horror", "Writing/Sketches"]);
    const model = linkerModel({ [body.slice(0, 80)]: { tags: ["idea", "story", "comedy"], related: [], folder: "writing/sketches", title: "The keeper nobody believes" } });
    setBackendOverride(model);
    await linkNote(t.hub, inbox.id);
    const f = t.hub.store.get(inbox.id)!.fields;
    assert.equal(f.title, "The keeper nobody believes");
    assert.equal(f.path, "Writing/Sketches/The keeper nobody believes.md");
    assert.ok(fs.existsSync(path.join(t.hub.cfg.vaultDir, String(f.path))));
    assert.equal(fs.existsSync(path.join(t.hub.cfg.vaultDir, "Inbox", `${body.slice(0, 80)}.md`)), false, "the Inbox file is gone");
    assert.match(model.sent[0][1].content, /give the folder it belongs in, from these: Writing; Writing\/Horror; Writing\/Sketches/);
    assert.match(model.sent[0][1].content, /Its title is only the start of its text/);
    assert.notEqual(nextNote(t.hub)?.id, inbox.id, "the move and the new title are not read as new text");
    // A note the owner titled keeps its title, and a folder that is not one of the owner's is ignored.
    const mine = note(t, "Inbox/Shopping thoughts.md", "Shopping thoughts", "Should I get a new desk?");
    setBackendOverride(linkerModel({ "Shopping thoughts": { tags: ["furniture"], related: [], folder: "Home/Furniture", title: "Desk" } }));
    await linkNote(t.hub, mine.id);
    assert.equal(t.hub.store.get(mine.id)!.fields.title, "Shopping thoughts");
    assert.equal(t.hub.store.get(mine.id)!.fields.path, "Inbox/Shopping thoughts.md");
  } finally { setBackendOverride(null); t.cleanup(); }
});

test("the linker gives way to a chat, retries a bad answer three times, and skips diary days", async () => {
  const t = makeHub();
  try {
    const n = note(t, "Programming/App Ideas/Weather Bot.md", "Weather Bot", "A bot that posts the forecast every morning.");
    t.hub.store.create("note", { title: "2026-11-03", body: "- 09:00 coffee", tags: [], path: "Diary/2026-11-03.md" });
    let calls = 0;
    setBackendOverride({ name: "ollama", model: "scripted", chat: async () => { calls++; return { text: "not json", usage: {} }; }, stream: async () => ({ text: "", usage: {} }) } as Backend);
    for (let i = 0; i < 3; i++) assert.equal((await linkNote(t.hub, n.id)).state, "failed");
    assert.equal(nextNote(t.hub), null, "given up after three tries on the same text; the diary is never read");
    assert.equal(calls, 3);
    assert.equal(parseLinkerRead('{"tags": ["App Ideas", "#OS"], "related": ["[[Weather Bot]]"]}')?.tags.join(","), "app-ideas,os");
    assert.equal(cleanTag("  Sci Fi_Horror!! "), "sci-fi-horror");
  } finally { setBackendOverride(null); t.cleanup(); }
});

test("a capture saved offline with Save is sorted once it reaches the hub", async () => {
  const t = makeHub();
  try {
    // As a device pushes it through sync: not processed, asking to be sorted.
    const cap = t.hub.store.create("capture", { text: "A skit where a robot runs a bakery", source: "iphone", processed: false, sort: true });
    const stop = startFilingJob(t.hub, 20);
    for (let i = 0; i < 50 && !t.hub.store.get(cap.id)!.fields.diary_id; i++) await new Promise((r) => setTimeout(r, 20));
    stop();
    const f = t.hub.store.get(cap.id)!.fields;
    assert.ok(f.diary_id, "written into the day's diary");
    assert.equal(f.processed, true);
    assert.equal(f.sort, false);
    assert.ok(["pending", "done", "failed"].includes(String(f.filing)));
    assert.match(String(t.hub.store.get(String(f.diary_id))!.fields.body), /robot runs a bakery/);
    // POST /capture without auto still keeps it unsorted, for any older client.
    const res = await t.api("/capture", { method: "POST", json: { text: "keep this", source: "web" } });
    assert.equal(((await res.json()) as { capture: { fields: { processed: boolean } } }).capture.fields.processed, false);
  } finally { t.cleanup(); }
});

test("the filer is told the owner's folders and where ideas go", () => {
  const p = filingPrompt("A comedy skit about a robot", new Date(), undefined, [], [], ["Writing/Sketches", "Programming/App Ideas"]);
  assert.match(p, /an idea for something to make .* becomes a note with save_note/);
  assert.match(p, /tags idea plus its form/);
  assert.match(p, /kind=music_idea/);
  assert.match(p, /kind=film with watchlist true and watched false/);
  assert.match(p, /\{\{owner\}\}'s note folders: Writing\/Sketches; Programming\/App Ideas\./, "the owner is named when it is sent");
});
