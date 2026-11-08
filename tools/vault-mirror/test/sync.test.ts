import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { hashContent, normalize } from "../src/hash.ts";
import { HubClient } from "../src/hub.ts";
import { buildMatcher, loadIgnore } from "../src/ignore.ts";
import { conflictName } from "../src/local.ts";
import { emptyState, loadState, saveState, type State } from "../src/state.ts";
import { syncOnce, type SyncSummary } from "../src/sync.ts";
import { FakeHub } from "./fake-hub.ts";

const FIXED_NOW = new Date(2026, 9, 21, 14, 32, 5); // 2026-10-21 14:32 local

let hub: FakeHub;
let client: HubClient;
let vault: string;
let state: State;
let lines: string[];

// The machine's own ignore file (~/.config/everythingapp/vault-mirror-ignore.txt) never reaches these tests.
const NO_USER_FILE = path.join(os.tmpdir(), "vault-mirror-test-no-such-file.txt");

async function run(dryRun = false): Promise<SyncSummary> {
  const ignore = await loadIgnore(vault, NO_USER_FILE);
  return syncOnce({ hub: client, vaultDir: vault, state, ignore, dryRun, log: (l) => lines.push(l), logPaths: true, now: () => FIXED_NOW });
}

async function writeVault(rel: string, content: string, mtimeMs?: number): Promise<void> {
  const abs = path.join(vault, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
  if (mtimeMs !== undefined) await fs.utimes(abs, mtimeMs / 1000, mtimeMs / 1000);
}

async function readVault(rel: string): Promise<string> {
  return fs.readFile(path.join(vault, rel), "utf8");
}

async function exists(rel: string): Promise<boolean> {
  return fs
    .access(path.join(vault, rel))
    .then(() => true)
    .catch(() => false);
}

/** Put the same note on both sides and sync once so the state records it. */
async function seedSynced(rel: string, content: string): Promise<void> {
  await writeVault(rel, content);
  await run();
  assert.ok(state.entries[rel], `seed: ${rel} should be in state`);
  assert.equal(hub.files.get(rel)?.content, content);
  lines = [];
}

describe("vault-mirror sync", () => {
  before(async () => {
    hub = new FakeHub("tok");
    const url = await hub.listen();
    client = new HubClient(url, "tok");
  });
  after(async () => hub.close());

  beforeEach(async () => {
    hub.files.clear();
    hub.calls = [];
    vault = await fs.mkdtemp(path.join(os.tmpdir(), "vault-mirror-test-"));
    state = emptyState();
    lines = [];
  });

  it("new local file is PUT to the hub", async () => {
    await writeVault("Programming/Idea.md", "# Idea\n");
    const s = await run();
    assert.equal(s.counts["put-new"], 1);
    assert.equal(hub.files.get("Programming/Idea.md")?.content, "# Idea\n");
    assert.ok(hub.calls.some((c) => c.startsWith("PUT /vault/file?path=Programming%2FIdea.md&mtime=")));
    assert.equal(state.entries["Programming/Idea.md"].remote.hash, FakeHub.hashOf("# Idea\n"));
    assert.equal(state.entries["Programming/Idea.md"].local.hash, hashContent("# Idea\n"));
  });

  it("new remote file is written locally with the hub mtime", async () => {
    hub.set("Food/Soup.md", "soup\n", "2026-01-02T03:04:05.000Z");
    const s = await run();
    assert.equal(s.counts["get-new"], 1);
    assert.equal(await readVault("Food/Soup.md"), "soup\n");
    const st = await fs.stat(path.join(vault, "Food/Soup.md"));
    assert.equal(Math.floor(st.mtimeMs / 1000), Math.floor(Date.parse("2026-01-02T03:04:05.000Z") / 1000));
    assert.ok(state.entries["Food/Soup.md"]);
  });

  it("only local changed: PUT", async () => {
    await seedSynced("A.md", "v1\n");
    await writeVault("A.md", "v2 local\n", Date.now() + 5000);
    const s = await run();
    assert.equal(s.counts.put, 1);
    assert.equal(hub.files.get("A.md")?.content, "v2 local\n");
    assert.match(lines[0], /^PUT\s+A\.md\s+\(changed locally\)$/);
  });

  it("only remote changed: written locally", async () => {
    await seedSynced("B.md", "v1\n");
    hub.set("B.md", "v2 hub\n");
    const s = await run();
    assert.equal(s.counts.get, 1);
    assert.equal(await readVault("B.md"), "v2 hub\n");
    assert.match(lines[0], /^GET\s+B\.md\s+\(changed on hub\)$/);
  });

  it("both changed: hub wins, local saved as conflict copy, nothing PUT", async () => {
    await seedSynced("Notes/C.md", "base\n");
    await writeVault("Notes/C.md", "mine\n", Date.now() + 5000);
    hub.set("Notes/C.md", "theirs\n");
    hub.calls = [];
    const s = await run();
    assert.equal(s.counts.conflict, 1);
    assert.equal(await readVault("Notes/C.md"), "theirs\n");
    const copy = "Notes/C (conflict 2026-10-21 1432).md";
    assert.equal(await readVault(copy), "mine\n");
    assert.ok(!hub.calls.some((c) => c.startsWith("PUT")), "no PUT during a conflict");
    assert.equal(hub.files.get("Notes/C.md")?.content, "theirs\n");
    assert.equal(state.entries["Notes/C.md"].local.hash, hashContent("theirs\n"));
    // next pass the conflict copy is a new local file and goes up
    lines = [];
    const s2 = await run();
    assert.equal(s2.counts["put-new"], 1);
    assert.equal(hub.files.get(copy)?.content, "mine\n");
  });

  it("both changed to identical content: no conflict, state updated", async () => {
    await seedSynced("D.md", "base\n");
    await writeVault("D.md", "same edit\n", Date.now() + 5000);
    hub.set("D.md", "same edit\n");
    const s = await run();
    assert.equal(s.counts.conflict, 0);
    assert.equal(s.counts.same, 1);
    assert.equal(await exists("D (conflict 2026-10-21 1432).md"), false);
  });

  it("deleted locally since last sync: DELETE on hub", async () => {
    await seedSynced("E.md", "bye\n");
    await fs.rm(path.join(vault, "E.md"));
    const s = await run();
    assert.equal(s.counts["delete-remote"], 1);
    assert.equal(hub.files.has("E.md"), false);
    assert.equal(state.entries["E.md"], undefined);
    assert.ok(hub.calls.some((c) => c === "DELETE /vault/file?path=E.md"));
  });

  it("deleted locally but changed on hub: hub wins, file restored", async () => {
    await seedSynced("E2.md", "v1\n");
    await fs.rm(path.join(vault, "E2.md"));
    hub.set("E2.md", "v2\n");
    const s = await run();
    assert.equal(s.counts["restore-local"], 1);
    assert.equal(await readVault("E2.md"), "v2\n");
    assert.equal(hub.files.has("E2.md"), true);
  });

  it("deleted on hub: local moved to .trash keeping its folder", async () => {
    await seedSynced("Sub/F.md", "trash me\n");
    hub.files.delete("Sub/F.md");
    const s = await run();
    assert.equal(s.counts["trash-local"], 1);
    assert.equal(await exists("Sub/F.md"), false);
    assert.equal(await readVault(".trash/Sub/F.md"), "trash me\n");
    assert.equal(state.entries["Sub/F.md"], undefined);
    // .trash is never listed, so nothing is PUT on the next pass
    lines = [];
    const s2 = await run();
    assert.equal(s2.counts["put-new"], 0);
  });

  it("exists on both sides before any sync with different content: conflict, hub wins", async () => {
    await writeVault("G.md", "local first\n");
    hub.set("G.md", "hub first\n");
    const s = await run();
    assert.equal(s.counts.conflict, 1);
    assert.equal(await readVault("G.md"), "hub first\n");
    assert.equal(await readVault("G (conflict 2026-10-21 1432).md"), "local first\n");
  });

  it("exists on both sides before any sync with identical content: recorded as same", async () => {
    await writeVault("H.md", "twin\n");
    hub.set("H.md", "twin\n");
    const s = await run();
    assert.equal(s.counts.same, 1);
    assert.ok(state.entries["H.md"]);
  });

  it("CRLF and BOM differences do not count as a change", async () => {
    await seedSynced("I.md", "line1\nline2\n");
    await writeVault("I.md", "﻿line1\r\nline2\r\n", Date.now() + 5000);
    const s = await run();
    assert.equal(s.counts.put, 0);
    assert.equal(s.counts.same, 1);
  });

  it("built-in ignore list and .obsidian, .trash are never mirrored either way", async () => {
    await writeVault("Recovery Codes.md", "secret\n");
    await writeVault("Bank passwords.md", "secret\n");
    await writeVault("Wallet seed phrase.md", "secret\n");
    await writeVault(".obsidian/workspace.md", "x\n");
    await writeVault(".trash/old.md", "x\n");
    await writeVault("Ok.md", "fine\n");
    hub.set("Recovery Codes.md", "hub secret\n");
    const s = await run();
    assert.equal(s.counts["put-new"], 1);
    assert.equal(hub.files.has("Ok.md"), true);
    assert.equal(hub.files.has("Bank passwords.md"), false);
    assert.equal(hub.files.has("Wallet seed phrase.md"), false);
    assert.equal(await readVault("Recovery Codes.md"), "secret\n", "hub copy must not overwrite the ignored local file");
    assert.equal(hub.files.has(".obsidian/workspace.md"), false);
  });

  it(".mirrorignore patterns are honored", async () => {
    await writeVault(".mirrorignore", "# comment\nPrivate/\n*.draft.md\nWriting/Journal*.md\n");
    await writeVault("Private/x.md", "p\n");
    await writeVault("Thing.draft.md", "d\n");
    await writeVault("Writing/Journal 2026.md", "j\n");
    await writeVault("Writing/Essay.md", "e\n");
    const s = await run();
    assert.equal(s.counts["put-new"], 1);
    assert.deepEqual([...hub.files.keys()], ["Writing/Essay.md"]);
  });

  it("dry-run changes nothing on either side and does not touch state", async () => {
    await seedSynced("J.md", "v1\n");
    await writeVault("J.md", "v2\n", Date.now() + 5000);
    hub.set("K.md", "new on hub\n");
    const before = JSON.stringify(state);
    const s = await run(true);
    assert.equal(s.counts.put, 1);
    assert.equal(s.counts["get-new"], 1);
    assert.equal(hub.files.get("J.md")?.content, "v1\n");
    assert.equal(await exists("K.md"), false);
    assert.equal(JSON.stringify(state), before);
    assert.ok(lines.every((l) => l.startsWith("DRY ")));
  });

  it("once and watch log counts, never a note's file name", async () => {
    await seedSynced("Private/Therapy notes.md", "v1\n");
    await writeVault("Private/Therapy notes.md", "v2\n", Date.now() + 5000);
    hub.set("Private/Diagnosis.md", "new on hub\n");
    const out: string[] = [];
    const ignore = await loadIgnore(vault, NO_USER_FILE);
    const s = await syncOnce({ hub: client, vaultDir: vault, state, ignore, dryRun: false, log: (l) => out.push(l), now: () => FIXED_NOW });
    assert.equal(s.counts.put, 1);
    assert.equal(s.counts["get-new"], 1);
    assert.ok(out.length > 0, "the summary is still logged");
    assert.ok(out.every((l) => !/Therapy|Diagnosis|Private/.test(l)), out.join("\n"));
  });

  it("state round-trips through disk", async () => {
    await seedSynced("L.md", "x\n");
    const file = path.join(vault, ".state", "s.json");
    await saveState(file, state);
    const loaded = await loadState(file);
    assert.deepEqual(loaded, state);
  });
});

describe("helpers", () => {
  it("normalize strips BOM and CRLF", () => {
    assert.equal(normalize("﻿a\r\nb\rc\n"), "a\nb\nc\n");
  });
  it("conflictName", () => {
    assert.equal(conflictName("Folder/Note.md", FIXED_NOW), "Folder/Note (conflict 2026-10-21 1432).md");
  });
  it("matcher defaults", () => {
    const m = buildMatcher([]);
    assert.equal(m.isIgnored("Recovery Codes.md"), true);
    assert.equal(m.isIgnored("Deep/Recovery Codes.md"), true);
    assert.equal(m.isIgnored("Recovery Codes 2.md"), true); // anything named like recovery codes stays out
    assert.equal(m.isIgnored("Recovered Lamp.md"), false);
  });
});
