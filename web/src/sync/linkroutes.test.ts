import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EADatabase, META, getMeta, setMeta } from "./db";
import { OTHER_HUB, SyncEngine, type KeptRoutes } from "./engine";
import { HubRouter } from "./home";

const OURS = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const THEIRS = "01BX5ZZKBKACTAV9WEVGEMMVRZ";
const PIN = "ef".repeat(32);
const HUB = "https://hub.example.ts.net";

/** A hub answering the routes question with `hubId` (or 404 for an older hub), and every sync request. */
function hub(answer: { hubId?: string | null; status?: number }) {
  const paths: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, "");
    paths.push(path.split("?")[0]);
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
    if (path === "/link/routes") {
      if (answer.status) return json(answer.status, { error: "not found" });
      return json(200, { hub_id: answer.hubId ?? null, method: "tailscale", remote: HUB, home: { on: true, urls: ["https://192.168.1.20:8788"], fp: PIN, announce: true } });
    }
    if (path === "/devices/register") return json(200, { device_id: "dev-1" });
    if (path.startsWith("/sync/changes")) return json(200, { changes: [], seq: 7, more: false });
    if (path === "/sync/push") return json(200, { applied: [], rejected: [], seq: 7 });
    return json(404, { error: "nf" });
  }) as typeof fetch;
  return { paths, fetchImpl };
}

/** A router whose probes say no at once: these tests are about what the engine asks and keeps. */
const quietRouter = () => new HubRouter({ home: async () => new Response(), raw: async () => new Response("{}"), probeHome: async () => false, browse: async () => [] });

let n = 0;
async function makeDb(hubId?: string) {
  const db = new EADatabase(`routes-${++n}`);
  await setMeta(META.hubUrl, HUB, db);
  await setMeta(META.token, "ead1_test", db);
  if (hubId) await setMeta(META.hubId, hubId, db);
  return db;
}

describe("the app asks its hub which ways reach it", () => {
  it("syncs with its own hub and keeps the answer for the next start", async () => {
    const db = await makeDb(OURS);
    const h = hub({ hubId: OURS });
    const router = quietRouter();
    const eng = new SyncEngine({ db, fetchImpl: h.fetchImpl, live: false, router });
    await eng.start();
    expect(h.paths.slice(0, 2)).toEqual(["/link/routes", "/devices/register"]);
    expect(h.paths).toContain("/sync/changes");
    expect(eng.state.status).toBe("synced");
    const kept = await getMeta<KeptRoutes>(META.routes, db);
    expect(kept?.home.fp).toBe(PIN);
    expect(router.chooser.pin).toBe(PIN);
    eng.stop();
  });

  it("syncs nothing when the address now leads to another hub", async () => {
    const db = await makeDb(OURS);
    const h = hub({ hubId: THEIRS });
    const eng = new SyncEngine({ db, fetchImpl: h.fetchImpl, live: false, router: quietRouter() });
    await eng.start();
    expect(h.paths).toEqual(["/link/routes"]);
    expect(eng.state.status).toBe("offline");
    expect(eng.state.lastError).toBe(OTHER_HUB);
    expect(eng.state.pairing).toBe("other_hub");
    // Asked again before every sync: nothing goes while it is another hub.
    await eng.cycle();
    expect(h.paths).toEqual(["/link/routes", "/link/routes"]);
    expect(await getMeta(META.routes, db)).toBeUndefined();
    expect(await getMeta(META.hubId, db)).toBe(OURS);
    eng.stop();
  });

  it("learns its hub's id when it was paired before hubs had ids", async () => {
    const db = await makeDb();
    const eng = new SyncEngine({ db, fetchImpl: hub({ hubId: OURS }).fetchImpl, live: false, router: quietRouter() });
    await eng.start();
    expect(await getMeta(META.hubId, db)).toBe(OURS);
    expect(eng.state.status).toBe("synced");
    eng.stop();
  });

  it("syncs with an older hub that has no such route, as before", async () => {
    const db = await makeDb(OURS);
    const h = hub({ status: 404 });
    const eng = new SyncEngine({ db, fetchImpl: h.fetchImpl, live: false, router: quietRouter() });
    await eng.start();
    expect(h.paths).toContain("/sync/changes");
    expect(eng.state.status).toBe("synced");
    // Asked once per connection, not before every sync.
    await eng.cycle();
    expect(h.paths.filter((p) => p === "/link/routes")).toHaveLength(1);
    eng.stop();
  });

  it("never asks in a browser", async () => {
    const db = await makeDb(OURS);
    const h = hub({ hubId: THEIRS });
    const eng = new SyncEngine({ db, fetchImpl: h.fetchImpl, live: false, router: null });
    await eng.start();
    expect(h.paths).not.toContain("/link/routes");
    expect(eng.state.status).toBe("synced");
    expect(eng.state.route).toBeNull();
    eng.stop();
  });
});

describe("racing the routes again", () => {
  let win: EventTarget;
  let doc: EventTarget & { visibilityState: string };
  let connection: EventTarget;
  beforeEach(() => {
    win = new EventTarget();
    doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
    connection = new EventTarget();
    vi.stubGlobal("window", win);
    vi.stubGlobal("document", doc);
    vi.stubGlobal("navigator", { userAgent: "test", connection });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("happens on start, back in the foreground, online, offline and on a network change", async () => {
    const db = await makeDb(OURS);
    const router = quietRouter();
    const trigger = vi.spyOn(router.chooser, "trigger");
    const eng = new SyncEngine({ db, fetchImpl: hub({ hubId: OURS }).fetchImpl, live: false, router });
    await eng.start();
    expect(trigger.mock.calls.map((c) => c[0])).toContain("start");
    trigger.mockClear();
    doc.dispatchEvent(new Event("visibilitychange"));
    win.dispatchEvent(new Event("online"));
    win.dispatchEvent(new Event("offline"));
    connection.dispatchEvent(new Event("change"));
    expect(trigger.mock.calls.map((c) => c[0])).toEqual(["foreground", "network", "network", "network"]);
    eng.stop();
    trigger.mockClear();
    win.dispatchEvent(new Event("online"));
    connection.dispatchEvent(new Event("change"));
    expect(trigger).not.toHaveBeenCalled();
  });

  it("asks the hub again for its routes after coming back", async () => {
    const db = await makeDb(OURS);
    const h = hub({ hubId: OURS });
    const eng = new SyncEngine({ db, fetchImpl: h.fetchImpl, live: false, router: quietRouter() });
    await eng.start();
    await eng.cycle();
    expect(h.paths.filter((p) => p === "/link/routes")).toHaveLength(1);
    win.dispatchEvent(new Event("online"));
    await vi.waitFor(() => expect(h.paths.filter((p) => p === "/link/routes")).toHaveLength(2));
    eng.stop();
  });
});
