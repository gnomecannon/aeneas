import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub } from "./helpers.js";

test("work space off: erases every work item everywhere, refuses new ones, and on again resumes", async () => {
  const t = makeHub();
  try {
    const ev = t.hub.store.create("event", { title: "1:1 with Dana", start: "2026-10-28T14:00:00.000Z", end: "2026-10-28T14:30:00.000Z", all_day: false, source: "eventkit", external_id: "abc" }, "work");
    const task = t.hub.store.create("task", { title: "Quarterly access review", status: "next", order: 1 }, "work");
    const mine = t.hub.store.create("task", { title: "Fix the NAS", status: "next", order: 2 });

    assert.deepEqual(await (await t.api("/space/work")).json(), { enabled: true, events: 1, tasks: 1, other: 0 });
    assert.equal((await t.api("/space/work", { method: "PUT", json: { enabled: false } })).status, 422);
    const off = await (await t.api("/space/work", { method: "PUT", json: { enabled: false, confirm: "erase work" } })).json() as { enabled: boolean; erased: number };
    assert.deepEqual(off, { enabled: false, erased: 2 });

    // Tombstoned with blank fields, so devices drop them and the text is gone from the feed.
    for (const id of [ev.id, task.id]) {
      const e = t.hub.store.get(id)!;
      assert.ok(e.deleted_at);
      assert.equal(e.fields.title, "-");
    }
    const feed = await (await t.api("/sync/changes?since=0")).text();
    assert.ok(!feed.includes("Dana") && !feed.includes("access review"));
    assert.equal(t.hub.store.get(mine.id)!.fields.title, "Fix the NAS");
    assert.deepEqual(await (await t.api("/space/work")).json(), { enabled: false, events: 0, tasks: 0, other: 0 });

    // Nothing new lands in work while it is off: not a new item, not a queued edit from an offline phone, not a capture.
    assert.equal((await t.api("/entities", { method: "POST", json: { kind: "task", space: "work", fields: { title: "x", status: "next", order: 1 } } })).status, 409);
    const push = await (await t.api("/sync/push", { method: "POST", json: { device_id: "phone", patches: [{ id: ev.id, kind: "event", ts: new Date().toISOString(), fields: { title: "1:1 with Dana" } }] } })).json() as { rejected: { reason: string }[] };
    assert.match(push.rejected[0].reason, /work space is turned off/);
    assert.equal(t.hub.store.get(ev.id)!.fields.title, "-");
    const cap = await (await t.api("/capture", { method: "POST", json: { text: "work: email Dana the report", source: "web", auto: true } })).json() as { created?: unknown[] };
    assert.ok(!cap.created?.length);
    assert.equal(t.hub.store.list({ space: "work" }).length, 0);

    assert.deepEqual(await (await t.api("/space/work", { method: "PUT", json: { enabled: true } })).json(), { enabled: true, erased: 0 });
    assert.equal((await t.api("/entities", { method: "POST", json: { kind: "task", space: "work", fields: { title: "y", status: "next", order: 1 } } })).status, 201);
  } finally { t.cleanup(); }
});

test("a work erase takes work names out of chats too", async () => {
  const t = makeHub();
  try {
    t.hub.store.create("event", { title: "Acme - ThreatLocker - Follow up", start: "2026-11-05T16:00:00.000Z", end: "2026-11-05T17:00:00.000Z" }, "work");
    t.hub.ai.sessions.save("chat-1", "general", [{ role: "user", content: "what's on today?" }, { role: "assistant", content: "11:00 AM Acme - ThreatLocker - Follow up, then lunch." }]);
    const { wipeWork } = await import("../src/work.js");
    wipeWork(t.hub);
    const row = t.hub.chatDb.prepare("SELECT messages FROM sessions WHERE session_id = 'chat-1'").get() as { messages: string };
    assert.doesNotMatch(row.messages, /ThreatLocker/);
    assert.match(row.messages, /\[work item\], then lunch/);
  } finally { t.cleanup(); }
});

test("the work key: a rotation saves the new key before resealing, and a zeroed key file is never used", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { WorkKey } = await import("../src/workkey.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-workkey-"));
  try {
    const file = path.join(dir, "work.key");
    const k = new WorkKey(file);
    const sealed = k.seal("e1", "secret meeting");
    fs.writeFileSync(file, Buffer.alloc(32));
    const fresh = new WorkKey(file);
    assert.equal(fresh.open("e1", sealed), null, "the zeroed file is not taken as the key");
    assert.ok(!fs.readFileSync(file).every((b: number) => b === 0), "a real key replaced it");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
