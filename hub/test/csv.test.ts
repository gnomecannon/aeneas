import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub } from "./helpers.js";
import { entitiesCsv } from "../src/csv.js";

test("csv: leading fields first, lists joined, quotes escaped, formulas kept as text, pictures left out", () => {
  const t = makeHub();
  try {
    t.hub.store.create("snippet", { title: "Restart, \"carefully\"", os: "linux", language: "bash", body: "line one\nline two", tags: ["proxmox", "nas"], host: "core" });
    t.hub.store.create("snippet", { title: "=HYPERLINK(\"x\")", os: "linux", language: "bash", body: "-rf is bad", tags: [], host: "desk-pc" });
    t.hub.store.create("capture", { text: "photo", source: "api", attachments: [{ name: "a.jpg", mime: "image/jpeg", bytes_b64: "AAAA" }] });
    const csv = entitiesCsv(t.hub.store.list({ kind: "snippet" }).reverse());
    const lines = csv.split("\r\n");
    assert.equal(lines[0], "id,space,created_at,updated_at,title,host,body,language,os,params,tags");
    assert.match(csv, /,"Restart, ""carefully""",core,"line one\nline two",bash,linux,,proxmox; nas\r\n/);
    assert.match(csv, /,"'=HYPERLINK\(""x""\)",desk-pc,'-rf is bad,bash,linux,,\r\n/, "rows made in the same millisecond come in either order");
    assert.equal(lines.at(-1), "");
    const cap = entitiesCsv(t.hub.store.list({ kind: "capture" }));
    assert.doesNotMatch(cap, /attachments|AAAA/);
  } finally { t.cleanup(); }
});

test("csv: GET /export/csv/:kind downloads one kind with field filters, oldest first", async () => {
  const t = makeHub();
  try {
    t.hub.store.create("log", { type: "weight", value: 162, unit: "lb", at: "2026-10-01T00:00:00.000Z" });
    t.hub.store.create("log", { type: "med", value: "claritin", at: "2026-10-02T00:00:00.000Z" });
    t.hub.store.create("log", { type: "weight", value: -1, unit: "lb", at: "2026-10-03T00:00:00.000Z" });
    const res = await t.api("/export/csv/log.csv?type=weight");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^text\/csv/);
    assert.match(res.headers.get("content-disposition") ?? "", /attachment; filename="log-\d{4}-\d{2}-\d{2}\.csv"/);
    const rows = (await res.text()).trim().split("\r\n");
    assert.equal(rows.length, 3);
    assert.ok(rows[0].startsWith("id,space,created_at,updated_at,type,value,unit,at"));
    assert.match(rows[1], /,weight,162,lb,/);
    assert.match(rows[2], /,weight,-1,lb,/);
    assert.equal((await t.api("/export/csv/nonsense")).status, 400);
  } finally { t.cleanup(); }
});
