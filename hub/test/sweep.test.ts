import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeHub } from "./helpers.js";
import { runSweep } from "../src/sweep.js";

test("sweep: recomputes links and suggests tags for untagged notes without touching files", async () => {
  const t = makeHub();
  try {
    const mk = async (fields: Record<string, unknown>) => (await (await t.api("/entities", { method: "POST", json: { kind: "note", fields } })).json()) as any;
    const pve1 = await mk({ title: "pve2", path: "Homelab/pve2.md", body: "Second Proxmox NUC.", tags: ["homelab", "proxmox"] });
    const cert = await mk({ title: "Proxmox cert renewal", path: "Homelab/Proxmox cert renewal.md", body: "Push the wildcard to pve2 and the homelab DCs." });
    const tagged = await mk({ title: "Tagged already", path: "Inbox/Tagged already.md", body: "mentions proxmox", tags: ["misc"] });
    // Damage the derived links so the sweep has something to fix, quietly so the file keeps its mtime.
    t.hub.vault.patchQuiet(cert.id, { links: ["stale"], suggested_tags: ["wrong"] });
    const file = path.join(t.hub.cfg.vaultDir, "Homelab/Proxmox cert renewal.md");
    const before = fs.statSync(file).mtimeMs;
    const seqBefore = t.hub.store.seq();
    await new Promise((r) => setTimeout(r, 15));

    const r1 = runSweep(t.hub);
    assert.equal(r1.notes, 3);
    assert.equal(r1.links_updated, 1);
    assert.equal(r1.tags_suggested, 1, "only the untagged note gets suggestions");
    const fixed = t.hub.store.get(cert.id)!;
    assert.deepEqual(fixed.fields.links, ["pve2"]);
    assert.ok((fixed.fields.suggested_tags as string[]).includes("homelab"));
    assert.ok((fixed.fields.suggested_tags as string[]).includes("proxmox"));
    assert.equal(t.hub.store.get(tagged.id)!.fields.suggested_tags, undefined, "tagged notes are left alone");
    assert.equal(t.hub.store.get(pve1.id)!.fields.suggested_tags, undefined);
    assert.equal(fs.statSync(file).mtimeMs, before, "file not rewritten");
    assert.equal(t.hub.store.seq(), seqBefore + 1, "one change row for the one note that changed");

    // Idempotent: a second pass writes nothing.
    const r2 = runSweep(t.hub);
    assert.equal(r2.links_updated, 0);
    assert.equal(r2.tags_suggested, 0);
    assert.equal(t.hub.store.seq(), seqBefore + 1);
  } finally { t.cleanup(); }
});

test("sweep: a note in a project's folder belongs to that project", async () => {
  const t = makeHub();
  try {
    const starfall = t.hub.store.create("project", { name: "Starfall", status: "active", definition_of_done: "x" });
    const songs = t.hub.store.create("project", { name: "Songs", status: "active", definition_of_done: "x" });
    const mk = (p: string) => t.hub.store.create("note", { title: path.basename(p, ".md"), path: p, body: "x", tags: ["a"] });
    const quest = mk("Game Design/Games/Starfall/Quest Ideas.md");
    const plan = mk("Projects/Songs/Plan.md");
    const other = mk("Game Design/General Game Ideas.md");
    const named = mk("Game Design/Starfall notes.md");
    const r = runSweep(t.hub);
    assert.equal(r.projects_linked, 2);
    assert.equal(t.hub.store.get(quest.id)!.fields.project_id, starfall.id);
    assert.equal(t.hub.store.get(plan.id)!.fields.project_id, songs.id);
    assert.equal(t.hub.store.get(other.id)!.fields.project_id, undefined);
    assert.equal(t.hub.store.get(named.id)!.fields.project_id, undefined, "a file name is not a folder");
    assert.equal(runSweep(t.hub).projects_linked, 0, "already linked notes are left alone");
  } finally { t.cleanup(); }
});
