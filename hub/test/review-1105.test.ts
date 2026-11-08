import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub } from "./helpers.js";
import { hubSecretValues } from "../src/secrets.js";
import { recordReading } from "../src/sensors.js";

test("every secret set in hub.env is cut from command output", () => {
  const t = makeHub();
  process.env.EA_STEAM_KEY = "STEAMKEY-FROM-ENV-0123456789";
  try { assert.ok(hubSecretValues(t.hub).includes("STEAMKEY-FROM-ENV-0123456789")); }
  finally { delete process.env.EA_STEAM_KEY; t.cleanup(); }
});

test("sensor readings far in the future, very long names and endless sensors are refused", () => {
  const t = makeHub();
  try {
    const now = new Date("2026-11-05T06:00:00Z");
    assert.throws(() => recordReading(t.hub, "garage.temp", { value: 5, at: "9999-01-01T00:00:00Z" }, now), /future/);
    assert.throws(() => recordReading(t.hub, "x".repeat(200), { value: 5 }, now), /80 characters/);
    recordReading(t.hub, "garage.temp", { value: 5 }, now);
    assert.equal(t.hub.store.list({ kind: "sensor" }).length, 1);
  } finally { t.cleanup(); }
});

test("a push the database cannot save now answers 503, so the device keeps its edits instead of dropping them", async () => {
  const t = makeHub();
  try {
    const orig = t.hub.store.apply.bind(t.hub.store);
    t.hub.store.apply = (() => { const e = new Error("database is locked") as Error & { code: string }; e.code = "SQLITE_BUSY"; throw e; }) as typeof t.hub.store.apply;
    const r = await t.api("/sync/push", { method: "POST", json: { device_id: "d1", patches: [{ id: "3f2a9c1e-0000-4000-8000-0000000000aa", kind: "note", space: "personal", ts: "2026-11-05T06:00:00.000Z", create: true, fields: { title: "x", body: "", path: "Inbox/x.md" } }] } });
    assert.equal(r.status, 503);
    t.hub.store.apply = orig;
  } finally { t.cleanup(); }
});

test("a hub restored from an older copy keeps giving out seqs above the ones devices already have", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const t = makeHub();
  try {
    for (let i = 0; i < 3; i++) t.hub.store.create("note", { title: `n${i}`, body: "", path: `Inbox/n${i}.md` });
    const db = path.join(t.dir, "hub.sqlite");
    t.hub.db.pragma("wal_checkpoint(TRUNCATE)");
    const copy = fs.readFileSync(db);
    for (let i = 3; i < 8; i++) t.hub.store.create("note", { title: `n${i}`, body: "", path: `Inbox/n${i}.md` });
    const ahead = t.hub.store.seq();
    await new Promise((r) => setTimeout(r, 300));
    t.hub.close();
    // The restore: the older database back in place, the mark beside it left as it was.
    fs.writeFileSync(db, copy);
    for (const f of ["hub.sqlite-wal", "hub.sqlite-shm"]) fs.rmSync(path.join(t.dir, f), { force: true });
    const { loadConfig } = await import("../src/config.js");
    const { createHub } = await import("../src/hub.js");
    const hub2 = createHub(loadConfig({ ...t.hub.cfg } as never));
    try {
      assert.ok(hub2.store.seq() >= ahead, "the counter is past every seq given out before");
      const e = hub2.store.create("note", { title: "after", body: "", path: "Inbox/after.md" });
      const page = hub2.store.changes(ahead);
      assert.ok(page.changes.some((c) => c.entity.id === e.id), "a device at the old cursor gets the new change");
    } finally { hub2.close(); }
  } finally { t.cleanup(); }
});
