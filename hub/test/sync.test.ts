import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { makeHub, TOKEN } from "./helpers.js";

test("auth: health is open but says only ok without a key, everything else needs the bearer token", async () => {
  const t = makeHub();
  try {
    const h = await t.app.request("/health");
    assert.equal(h.status, 200);
    assert.deepEqual(await h.json(), { ok: true }, "no version, change count or models for a caller without a key");
    const body = await (await t.api("/health")).json() as { ok: boolean; db_seq: number; version: string };
    assert.equal(body.ok, true);
    assert.equal(typeof body.db_seq, "number");
    assert.equal(typeof body.version, "string");
    assert.deepEqual(await (await t.app.request("/health", { headers: { authorization: "Bearer nope" } })).json(), { ok: true });
    assert.equal((await t.app.request("/dashboard")).status, 401);
    assert.equal((await t.app.request("/dashboard", { headers: { authorization: `Bearer ${TOKEN}x` } })).status, 401);
    assert.equal((await t.api("/dashboard")).status, 200);
  } finally { t.cleanup(); }
});

test("sync: create, per-field LWW with out-of-order patches, and reading back the echo", async () => {
  const t = makeHub();
  try {
    const id = randomUUID();
    // Create at T2 with title A, status next.
    let res = await t.api("/sync/push", { method: "POST", json: { device_id: "dev1", patches: [
      { id, kind: "task", ts: "2026-10-21T10:00:02.000Z", fields: { title: "A", status: "next", order: 5 }, create: true },
    ] } });
    assert.equal(res.status, 200);
    let body = await res.json() as { applied: { id: string; seq: number }[]; rejected: unknown[]; seq: number };
    assert.equal(body.applied.length, 1);
    assert.equal(body.rejected.length, 0);
    const firstSeq = body.applied[0].seq;
    assert.equal(body.seq, firstSeq);

    // An older patch (T1) arrives late: title must not regress, but a key it alone sets (notes) is applied.
    res = await t.api("/sync/push", { method: "POST", json: { device_id: "dev1", patches: [
      { id, kind: "task", ts: "2026-10-21T10:00:01.000Z", fields: { title: "OLD", notes: "from the past" } },
    ] } });
    body = await res.json() as typeof body;
    assert.equal(body.applied.length, 1);
    let e = t.hub.store.get(id)!;
    assert.equal(e.fields.title, "A");
    assert.equal(e.fields.notes, "from the past");
    assert.equal(e.field_ts.title, "2026-10-21T10:00:02.000Z");
    assert.equal(e.field_ts.notes, "2026-10-21T10:00:01.000Z");

    // A newer patch (T3) wins on title only; status keeps its own ts.
    res = await t.api("/sync/push", { method: "POST", json: { device_id: "dev1", patches: [
      { id, kind: "task", ts: "2026-10-21T10:00:03.000Z", fields: { title: "C" } },
    ] } });
    e = t.hub.store.get(id)!;
    assert.equal(e.fields.title, "C");
    assert.equal(e.fields.status, "next");
    assert.equal(e.field_ts.status, "2026-10-21T10:00:02.000Z");

    // Three applied patches produced three change rows; the client reads its own echo.
    res = await t.api(`/sync/changes?since=${firstSeq - 1}`);
    const changes = await res.json() as { changes: { seq: number; entity: any }[]; seq: number; more: boolean };
    assert.equal(changes.changes.length, 3);
    assert.equal(changes.more, false);
    assert.equal(changes.changes[2].entity.fields.title, "C");
    assert.equal(changes.seq, changes.changes[2].seq);

    // Unknown id without create is rejected; invalid fields are rejected; deleted_at goes through LWW.
    res = await t.api("/sync/push", { method: "POST", json: { device_id: "dev1", patches: [
      { id: randomUUID(), kind: "task", ts: "2026-10-21T10:00:04.000Z", fields: { title: "ghost" } },
      { id: randomUUID(), kind: "task", ts: "2026-10-21T10:00:04.000Z", fields: { title: "no status" }, create: true },
      { id, kind: "task", ts: "2026-10-21T10:00:05.000Z", fields: { deleted_at: "2026-10-21T10:00:05.000Z" } },
    ] } });
    body = await res.json() as typeof body;
    assert.equal(body.rejected.length, 2);
    assert.equal(body.applied.length, 1);
    e = t.hub.store.get(id)!;
    assert.equal(e.deleted_at, "2026-10-21T10:00:05.000Z");
    assert.equal(e.field_ts.deleted_at, "2026-10-21T10:00:05.000Z");

    // kinds filter and paging flags.
    res = await t.api("/sync/changes?since=0&kinds=note");
    const none = await res.json() as typeof changes;
    assert.equal(none.changes.length, 0);
    assert.equal(none.seq, t.hub.store.seq());
  } finally { t.cleanup(); }
});

test("sync: work space rejects notes", async () => {
  const t = makeHub();
  try {
    const res = await t.api("/sync/push", { method: "POST", json: { device_id: "d", patches: [
      { id: randomUUID(), kind: "note", space: "work", ts: "2026-10-21T10:00:00.000Z", fields: { title: "x", path: "x.md" }, create: true },
    ] } });
    const body = await res.json() as { rejected: { reason: string }[] };
    assert.equal(body.rejected.length, 1);
    assert.match(body.rejected[0].reason, /work space/);
  } finally { t.cleanup(); }
});

test("compactChanges keeps the newest row per entity and clients still converge", async () => {
  const { makeHub } = await import("./helpers.ts");
  const t = makeHub();
  try {
    const a = t.hub.store.create("task", { title: "a", status: "next", order: 1 });
    for (let i = 0; i < 5; i++) t.hub.store.patch(a.id, { order: i + 2 });
    const b = t.hub.store.create("task", { title: "b", status: "next", order: 1 });
    const before = (t.hub.db.prepare("SELECT count(*) n FROM changes").get() as { n: number }).n;
    const r = t.hub.store.compactChanges();
    assert.equal(r.removed, before - 2);
    assert.equal(r.remaining, 2);
    const feed = t.hub.store.changes(0);
    assert.deepEqual(feed.changes.map((c) => c.entity.id).sort(), [a.id, b.id].sort());
    assert.equal(feed.changes.find((c) => c.entity.id === a.id)!.entity.fields.order, 6);
  } finally { t.cleanup(); }
});

test("sync: a cursor past the hub's latest seq (a restored hub) starts over from the beginning", async () => {
  const { makeHub } = await import("./helpers.js");
  const t = makeHub();
  try {
    const a = t.hub.store.create("task", { title: "Kept", status: "next", order: 1 });
    const latest = t.hub.store.seq();
    const ahead = await (await t.api(`/sync/changes?since=${latest + 500}`)).json() as { changes: { entity: { id: string } }[]; reset?: boolean; seq: number };
    assert.equal(ahead.reset, true);
    assert.ok(ahead.changes.some((ch) => ch.entity.id === a.id));
    assert.equal(ahead.seq, latest);
    const normal = await (await t.api(`/sync/changes?since=${latest}`)).json() as { changes: unknown[]; reset?: boolean };
    assert.equal(normal.reset, undefined);
    assert.equal(normal.changes.length, 0);
  } finally { t.cleanup(); }
});

test("sync: purging the newest change rows does not move the hub's seq back, so no device is told to start over", async () => {
  const { makeHub } = await import("./helpers.js");
  const t = makeHub();
  try {
    t.hub.store.create("task", { title: "Stays", status: "next", order: 1 });
    const last = t.hub.store.create("task", { title: "Purged", status: "next", order: 2 });
    const seq = t.hub.store.seq();
    t.hub.store.purge([last.id]);
    assert.equal(t.hub.store.seq(), seq);
    const res = await (await t.api(`/sync/changes?since=${seq}`)).json() as { reset?: boolean; changes: unknown[] };
    assert.equal(res.reset, undefined);
    assert.equal(res.changes.length, 0);
  } finally { t.cleanup(); }
});
