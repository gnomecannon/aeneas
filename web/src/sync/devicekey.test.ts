import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { EADatabase, META, getMeta, setMeta } from "./db";
import { SyncEngine } from "./engine";
import { isDeviceKey } from "./api";

const KEY = `ead1_${"a".repeat(43)}`;

/** A hub that knows device keys: exchange answers, and `removed` makes every call a removed device's 401. */
function keyHub(opts: { exchange?: number; removed?: boolean } = {}) {
  const seen: { path: string; auth: string; body?: any }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, "");
    const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({ path, auth, body });
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
    if (opts.removed) return json(401, { error: "unauthorized", device_removed: true });
    if (path === "/devices/exchange") return opts.exchange && opts.exchange !== 200 ? json(opts.exchange, { error: "x" }) : json(200, { device_id: "dev-9", key: KEY, name: "Browser" });
    if (path === "/devices/register") return json(200, { device_id: body?.device_id ?? "dev-1" });
    if (path.startsWith("/sync/changes")) return json(200, { changes: [], seq: 1, more: false });
    if (path === "/sync/push") return json(200, { applied: [], rejected: [], seq: 1 });
    return json(404, { error: "nf" });
  }) as typeof fetch;
  return { seen, fetchImpl };
}

let n = 0;
async function makeDb(token: string) {
  const db = new EADatabase(`key-test-${++n}`);
  await setMeta(META.hubUrl, "http://hub.test", db);
  await setMeta(META.token, token, db);
  return db;
}

describe("device keys", () => {
  it("a device on the hub's main key trades it for its own key and keeps its id", async () => {
    const db = await makeDb("main-key");
    await setMeta(META.deviceId, "dev-9", db);
    const hub = keyHub();
    const eng = new SyncEngine({ db, fetchImpl: hub.fetchImpl, live: false });
    await eng.start();
    expect(await getMeta(META.token, db)).toBe(KEY);
    expect(hub.seen.find((c) => c.path === "/devices/exchange")?.body).toMatchObject({ device_id: "dev-9" });
    // Everything after the trade uses the device's own key.
    const after = hub.seen.slice(hub.seen.findIndex((c) => c.path === "/devices/exchange") + 1);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((c) => c.auth === `Bearer ${KEY}`)).toBe(true);
    eng.stop();
  });

  it("an older hub without the route keeps working on the main key", async () => {
    const db = await makeDb("main-key");
    const hub = keyHub({ exchange: 404 });
    const eng = new SyncEngine({ db, fetchImpl: hub.fetchImpl, live: false });
    await eng.start();
    expect(await getMeta(META.token, db)).toBe("main-key");
    expect(eng.state.status).toBe("synced");
    await eng.cycle();
    expect(hub.seen.filter((c) => c.path === "/devices/exchange").length).toBe(1);
    eng.stop();
  });

  it("a device that already has its own key never asks to trade", async () => {
    const db = await makeDb(KEY);
    const hub = keyHub();
    const eng = new SyncEngine({ db, fetchImpl: hub.fetchImpl, live: false });
    await eng.start();
    expect(hub.seen.some((c) => c.path === "/devices/exchange")).toBe(false);
    eng.stop();
  });

  it("a removed device forgets its key and shows setup with a reason", async () => {
    const db = await makeDb(KEY);
    await setMeta(META.deviceId, "dev-1", db);
    await setMeta(META.theme, "dark", db);
    await db.entities.put({ id: "n1", kind: "note", space: "personal", fields: { title: "private" }, updated_at: "2026-11-06T00:00:00Z" } as never);
    await db.sessions.put({ id: "s1", updated_at: "2026-11-06T00:00:00Z" } as never);
    const eng = new SyncEngine({ db, fetchImpl: keyHub({ removed: true }).fetchImpl, live: false });
    await eng.start();
    expect(await getMeta(META.token, db)).toBe("");
    expect(await getMeta(META.deviceId, db)).toBeUndefined();
    expect(eng.state.status).toBe("setup");
    expect(eng.state.lastError).toMatch(/removed from the hub/);
    // The offline copy goes with the key; the hub address (for pairing again) and the theme stay.
    expect(await db.entities.count()).toBe(0);
    expect(await db.sessions.count()).toBe(0);
    expect(await getMeta(META.hubUrl, db)).toBe("http://hub.test");
    expect(await getMeta(META.theme, db)).toBe("dark");
  });

  it("tells keys apart", () => {
    expect(isDeviceKey(KEY)).toBe(true);
    expect(isDeviceKey("test-token")).toBe(false);
    expect(isDeviceKey("")).toBe(false);
  });
});

describe("two windows on one stored key", () => {
  it("both end on the newest key and nothing is unpaired, even without locks", async () => {
    const db = await makeDb("main-key");
    await setMeta(META.deviceId, "dev-9", db);
    // Like the hub: every trade issues a new key and ends the one before it.
    let n = 0;
    let valid = "";
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace(/^https?:\/\/[^/]+/, "");
      const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "").replace(/^Bearer /, "");
      const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
      if (path === "/devices/exchange") { valid = `ead1_${String(++n).repeat(43).slice(0, 43)}`; return json(200, { device_id: "dev-9", key: valid, name: "x" }); }
      if (auth.startsWith("ead1_") && auth !== valid) return json(401, { error: "unauthorized", device_removed: true });
      if (path === "/devices/register") return json(200, { device_id: "dev-9" });
      if (path.startsWith("/sync/changes")) return json(200, { changes: [], seq: 1, more: false });
      if (path === "/sync/push") return json(200, { applied: [], rejected: [], seq: 1 });
      return json(404, { error: "nf" });
    }) as typeof fetch;
    const a = new SyncEngine({ db, fetchImpl, live: false });
    const b = new SyncEngine({ db, fetchImpl, live: false });
    await Promise.all([a.start(), b.start()]);
    await a.cycle();
    await b.cycle();
    const stored = await getMeta<string>(META.token, db);
    expect(stored).toBe(valid);
    expect(a.state.status).not.toBe("setup");
    expect(b.state.status).not.toBe("setup");
    a.stop(); b.stop();
  });

  it("a key the hub does not know is kept and the reason shown", async () => {
    const db = await makeDb(KEY);
    const fetchImpl = (async () => new Response(JSON.stringify({ error: "unauthorized", unknown_key: true }), { status: 401, headers: { "Content-Type": "application/json" } })) as typeof fetch;
    const eng = new SyncEngine({ db, fetchImpl, live: false });
    await eng.start();
    expect(await getMeta(META.token, db)).toBe(KEY);
    expect(eng.state.status).toBe("offline");
    expect(eng.state.lastError).toMatch(/does not know this device's key/);
    eng.stop();
  });
});
