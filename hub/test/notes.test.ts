import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub } from "./helpers.ts";

test("knowledge map derives links from title mentions, suggests tags, relates and graphs", async () => {
  const t = makeHub();
  try {
    const mk = async (fields: Record<string, unknown>) => (await (await t.api("/entities", { method: "POST", json: { kind: "note", fields } })).json()) as any;
    const g2 = await mk({ title: "pve2", path: "Homelab/pve2.md", body: "Second Proxmox NUC, i3, 16 GB.", tags: ["homelab", "proxmox"] });
    const cert = await mk({ title: "Proxmox cert renewal", path: "Homelab/Proxmox cert renewal.md", body: "acme.sh issues the wildcard, then push it to pve2 and the homelab DCs. See [[Cloudflare DNS]]." });
    const after = t.hub.store.get(cert.id)!;
    assert.deepEqual([...(after.fields.links as string[])].sort(), ["Cloudflare DNS", "pve2"]);

    const rel = await (await t.api(`/notes/${cert.id}/related`)).json() as any;
    assert.equal(rel.links[0].id, g2.id);
    const relBack = await (await t.api(`/notes/${g2.id}/related`)).json() as any;
    assert.ok(relBack.backlinks.some((x: any) => x.id === cert.id), "pve2 should have the cert note as a backlink");

    const sug = await (await t.api(`/notes/${cert.id}/suggest`, { method: "POST" })).json() as any;
    assert.ok(sug.suggested_tags.includes("homelab"), `expected homelab in ${sug.suggested_tags}`);
    assert.ok(sug.suggested_tags.includes("proxmox"));
    assert.equal(sug.ai_used, false);
    const stored = t.hub.store.get(cert.id)!;
    assert.ok((stored.fields.suggested_tags as string[]).includes("homelab"), "suggested_tags must persist (schema must allow the field)");

    const acc = await (await t.api(`/notes/${cert.id}/accept`, { method: "POST", json: { tags: ["homelab"] } })).json() as any;
    assert.ok(acc.fields.tags.includes("homelab"));
    assert.ok(!acc.fields.suggested_tags.includes("homelab"));
    assert.ok(acc.fields.suggested_tags.includes("proxmox"));

    const graph = await (await t.api("/notes/graph")).json() as any;
    assert.equal(graph.nodes.length, 2);
    assert.deepEqual(graph.edges, [{ from: cert.id, to: g2.id }]);

    // the vault file carries the derived links only as the user wrote them; no loop, body untouched
    const file = t.hub.vault.read("Homelab/Proxmox cert renewal.md")!;
    assert.ok(file.includes("push it to pve2"));
  } finally { t.cleanup(); }
});
