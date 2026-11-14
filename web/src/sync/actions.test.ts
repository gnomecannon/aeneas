import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Entity } from "@everythingapp/shared";
import { HubClient } from "./api";
import { engine } from "./engine";
import { capture, CAPTURE_HUB_WAIT_MS } from "./actions";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** The hub as it keeps a capture it saved and filed (stamps older than this device's later copy). */
function filed(id: string, text: string): Entity {
  const at = "2026-11-13T10:00:00.000Z";
  const fields = { text, source: "web", processed: true, suggested_kind: "none", sorted_by: "auto", filing: "done", filed: "Tasks: Buy a new bike seat" };
  return { id, kind: "capture", space: "personal", created_at: at, updated_at: at, deleted_at: null, fields, field_ts: Object.fromEntries(Object.keys(fields).map((k) => [k, at])) } as Entity;
}

/** A request that never answers, and fails the way fetch does once its signal is aborted. */
function hungFetch(onSent: (body: { id: string }, signal: AbortSignal) => void = () => undefined) {
  const sent: { body?: { id: string }; signal?: AbortSignal } = {};
  const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
    sent.body = JSON.parse(String(init?.body));
    sent.signal = init!.signal!;
    onSent(sent.body!, sent.signal);
    return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError"))));
  });
  return { sent, fetchImpl: fetchImpl as unknown as typeof fetch, calls: fetchImpl };
}

function useHub(fetchImpl: typeof fetch, status: "offline" | "synced") {
  engine.client = new HubClient({ hubUrl: "http://hub.test", token: "t" }, fetchImpl);
  engine.state = { ...engine.state, status };
}

describe("capture", () => {
  beforeEach(async () => {
    await engine.db.entities.clear();
    await engine.db.outbox.clear();
  });
  afterEach(() => {
    engine.client = null;
    engine.state = { ...engine.state, status: "setup" };
  });

  it("with the hub known to be out of reach, saves on this device at once without asking it", async () => {
    const fetchImpl = vi.fn(async () => json(500, {}));
    useHub(fetchImpl as unknown as typeof fetch, "offline");
    const r = await capture("call the vet about Pepper", "web");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r.offline).toBe(true);
    expect((await engine.db.entities.get(r.capture.id))?.fields).toMatchObject({ text: "call the vet about Pepper", processed: false, sort: true });
    const out = await engine.db.outbox.toArray();
    expect(out.map((o) => [o.patch.id, o.patch.create])).toEqual([[r.capture.id, true]]);
  });

  it("a hub that does not answer: saved on this device after the short wait, with the id the hub was sent", async () => {
    // Seconds, not the client's 3 minutes.
    expect(CAPTURE_HUB_WAIT_MS).toBeLessThanOrEqual(10_000);
    const hub = hungFetch();
    useHub(hub.fetchImpl, "synced");
    let done = false;
    const saving = capture("buy a new bike seat", "web", 80).finally(() => (done = true));
    await new Promise((r) => setTimeout(r, 30));
    // Still waiting for the hub inside the limit.
    expect(done).toBe(false);
    expect(hub.sent.signal?.aborted).toBe(false);
    const r = await saving;
    expect(hub.sent.signal?.aborted).toBe(true);
    expect(r.offline).toBe(true);
    expect(r.capture.id).toBe(hub.sent.body?.id);
    expect((await engine.db.entities.get(r.capture.id))?.fields).toMatchObject({ text: "buy a new bike seat", processed: false, sort: true });
    expect((await engine.db.outbox.toArray()).map((o) => o.patch.id)).toEqual([r.capture.id]);
  });

  it("a hub that answers in time: its copy is kept and nothing waits to be sent", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const { id, text } = JSON.parse(String(init?.body)) as { id: string; text: string };
      return json(201, { capture: filed(id, text), suggested_kind: "task" });
    });
    useHub(fetchImpl as unknown as typeof fetch, "synced");
    const r = await capture("buy a new bike seat", "web");
    expect(r.offline).toBe(false);
    expect((await engine.db.entities.get(r.capture.id))?.fields.processed).toBe(true);
    expect(await engine.db.outbox.count()).toBe(0);
  });

  it("the hub's filed copy came in by sync while its answer did not: the copy kept here does not undo the filing", async () => {
    let pulled: Promise<void> = Promise.resolve();
    const hub = hungFetch((body) => (pulled = engine.applyChanges([filed(body.id, "buy a new bike seat")])));
    useHub(hub.fetchImpl, "synced");
    const r = await capture("buy a new bike seat", "web", 40);
    await pulled;
    const here = await engine.db.entities.get(r.capture.id);
    expect(here?.fields).toMatchObject({ processed: true, filing: "done" });
    expect(here?.fields.sort).toBeUndefined();
  });
});
