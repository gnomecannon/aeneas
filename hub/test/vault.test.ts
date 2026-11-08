import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeHub } from "./helpers.js";

test("vault: PUT file creates the note, PATCH note rewrites the file, wikilinks and tags are parsed", async () => {
  const t = makeHub();
  try {
    const md = "---\ntags: [printing, 3d]\n---\n# Filament notes\n\nSee [[Prusa MK4]] and [[Bambu|the Bambu]] for #ideas.\n";
    let res = await t.api("/vault/file?path=Programming/Filament.md", { method: "PUT", body: md, headers: { "content-type": "text/markdown" } });
    assert.equal(res.status, 200);
    const put = await res.json() as { path: string; hash: string; mtime: string };
    assert.equal(put.path, "Programming/Filament.md");
    const notes = t.hub.store.list({ kind: "note" });
    assert.equal(notes.length, 1);
    const note = notes[0];
    assert.equal(note.fields.title, "Filament notes");
    assert.equal(note.fields.path, "Programming/Filament.md");
    assert.deepEqual(note.fields.links, ["Prusa MK4", "Bambu"]);
    assert.deepEqual([...note.fields.tags].sort(), ["3d", "ideas", "printing"]);
    // The file on disk now carries the entity id.
    const onDisk = fs.readFileSync(path.join(t.hub.cfg.vaultDir, "Programming/Filament.md"), "utf8");
    assert.match(onDisk, new RegExp(`^---\\nid: ${note.id}\\n`));
    assert.ok(onDisk.includes("[[Prusa MK4]]"));

    // Index lists it with the hash of what is on disk.
    res = await t.api("/vault/index");
    const index = await res.json() as { path: string; hash: string }[];
    assert.equal(index.length, 1);
    assert.equal(index[0].hash, put.hash);

    // PATCH the note: the file is rewritten and links re-derived.
    res = await t.api(`/entities/${note.id}`, { method: "PATCH", json: { fields: { body: "# Filament notes\n\nNow linking [[Voron]] only.\n", tags: ["printing"] } } });
    assert.equal(res.status, 200);
    const after = fs.readFileSync(path.join(t.hub.cfg.vaultDir, "Programming/Filament.md"), "utf8");
    assert.ok(after.includes("[[Voron]]"));
    assert.ok(!after.includes("Prusa"));
    assert.ok(after.startsWith(`---\nid: ${note.id}\ntitle: Filament notes\ntags: [printing]\n---\n`));
    assert.deepEqual(t.hub.store.get(note.id)!.fields.links, ["Voron"]);

    // GET returns the file; the same PUT again is idempotent (one note).
    res = await t.api("/vault/file?path=Programming/Filament.md");
    assert.equal(res.status, 200);
    assert.equal(await res.text(), after);
    await t.api("/vault/file?path=Programming/Filament.md", { method: "PUT", body: after });
    assert.equal(t.hub.store.list({ kind: "note" }).length, 1);

    // Creating a note entity writes a file; deleting removes it.
    const created = await (await t.api("/entities", { method: "POST", json: { kind: "note", fields: { title: "Weather Bot", path: "Programming/App Ideas/Weather Bot.md", body: "Idea.\n" } } })).json() as { id: string };
    assert.ok(fs.existsSync(path.join(t.hub.cfg.vaultDir, "Programming/App Ideas/Weather Bot.md")));
    res = await t.api("/vault/file?path=Programming/App%20Ideas/Weather%20Bot.md", { method: "DELETE" });
    assert.equal(res.status, 200);
    assert.ok(!fs.existsSync(path.join(t.hub.cfg.vaultDir, "Programming/App Ideas/Weather Bot.md")));
    assert.ok(t.hub.store.get(created.id)!.deleted_at);

    // Path traversal is rejected.
    for (const p of ["../x.md", "a/../../x.md", "/etc/passwd.md", "notes.txt"]) {
      res = await t.api(`/vault/file?path=${encodeURIComponent(p)}`, { method: "PUT", body: "x" });
      assert.equal(res.status, 400, p);
    }
  } finally { t.cleanup(); }
});

test("vault export: every note as markdown in a .tar.gz", async () => {
  const t = makeHub();
  try {
    t.hub.store.create("note", { title: "NAS layout", body: "raidz1 on six NVMe", tags: [], path: "Homelab/NAS layout.md" });
    const res = await t.api("/vault/export");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/gzip");
    const buf = Buffer.from(await res.arrayBuffer());
    const tar = (await import("node:zlib")).gunzipSync(buf).toString("latin1");
    assert.match(tar, /Homelab\/NAS layout\.md/);
    assert.match(tar, /raidz1 on six NVMe/);
  } finally { t.cleanup(); }
});

test("vault: a rewrite keeps the file's other properties, another note's file is never overwritten, quotes and renames hold", async () => {
  const t = makeHub();
  try {
    const v = t.hub.vault;
    // An Obsidian note with its own properties.
    v.write("Notes/chili.md", `---\ntitle: "Mom's \\"famous\\" chili"\naliases:\n  - chili\ncreated: 2024-02-01\ncssclasses: [recipe]\ntags: [food]\n---\nBeans.\n`);
    const chili = t.hub.store.list({ kind: "note", where: { path: "Notes/chili.md" } })[0];
    assert.equal(chili.fields.title, `Mom's "famous" chili`, "the quotes read back as written");
    // The linker tags it: the file is rewritten.
    t.hub.store.patch(chili.id, { tags: ["food", "recipe"] });
    const text = fs.readFileSync(path.join(t.dir, "vault", "Notes/chili.md"), "utf8");
    assert.match(text, /aliases:\n {2}- chili/);
    assert.match(text, /created: 2024-02-01/);
    assert.match(text, /cssclasses: \[recipe\]/);
    // Read back again: the title is unchanged after a round trip (no backslashes added).
    v.write("Notes/chili.md", text);
    assert.equal(t.hub.store.get(chili.id)!.fields.title, `Mom's "famous" chili`);

    // A second note at the same path gets its own file; deleting it leaves the first.
    const first = t.hub.store.create("note", { title: "Silent auction", body: "The owner's.", path: "Writing/Silent auction.md" });
    const second = t.hub.store.create("note", { title: "Silent auction", body: "The filer's.", path: "Writing/Silent auction.md" });
    assert.equal(t.hub.store.get(second.id)!.fields.path, "Writing/Silent auction 2.md");
    assert.match(fs.readFileSync(path.join(t.dir, "vault", "Writing/Silent auction.md"), "utf8"), /The owner's\./);
    t.hub.store.patch(second.id, { deleted_at: new Date().toISOString() });
    assert.ok(fs.existsSync(path.join(t.dir, "vault", "Writing/Silent auction.md")), "the first note's file stays");
    assert.equal(t.hub.store.get(first.id)!.deleted_at, null);

    // A title starting with a dot does not make a hidden file.
    const dots = t.hub.store.create("note", { title: "...and another thing", body: "x", path: "Inbox/...and another thing.md" });
    assert.equal(t.hub.store.get(dots.id)!.fields.path, "Inbox/and another thing.md");

    // Renaming a note moves the related links that named it.
    const a = t.hub.store.create("note", { title: "Old name", body: "a", path: "Notes/a.md" });
    const b = t.hub.store.create("note", { title: "B", body: "b", path: "Notes/b.md", related: ["Old name"] });
    t.hub.store.patch(a.id, { title: "New name" });
    assert.deepEqual(t.hub.store.get(b.id)!.fields.related, ["New name"]);
    // Obsidian opens links by file name: the link carries it.
    assert.match(fs.readFileSync(path.join(t.dir, "vault", "Notes/b.md"), "utf8"), /"\[\[a\|New name\]\]"/);
    assert.deepEqual(t.hub.store.get(b.id)!.fields.related, ["New name"]);
  } finally { t.cleanup(); }
});

test("vault: a note the hub rewrites itself (a plan) keeps the owner's tags and the linker's links", () => {
  const t = makeHub();
  try {
    t.hub.vault.writeOwn("Projects/Game/plan.md", { title: "Plan: Game", tags: ["project", "plan"], body: "# Plan\n" });
    const plan = t.hub.store.list({ kind: "note", where: { path: "Projects/Game/plan.md" } })[0];
    t.hub.store.patch(plan.id, { tags: ["project", "plan", "gamedev"], related: ["Design doc"] });
    t.hub.vault.writeOwn("Projects/Game/plan.md", { title: "Plan: Game", tags: ["project", "plan"], body: "# Plan\nNext: art.\n" });
    const after = t.hub.store.get(plan.id)!;
    assert.deepEqual(after.fields.tags, ["project", "plan", "gamedev"]);
    assert.deepEqual(after.fields.related, ["Design doc"]);
    assert.match(String(after.fields.body), /Next: art\./);
  } finally { t.cleanup(); }
});
