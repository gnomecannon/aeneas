import { describe, expect, it } from "vitest";
import type { Entity, Patch } from "@everythingapp/shared";
import { applyPatchLocal, mergeIncoming, planFlush, rejectedIds } from "./merge";
import type { OutboxItem } from "./db";

const base: Entity = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "task",
  space: "personal",
  created_at: "2026-10-21T10:00:00.000Z",
  updated_at: "2026-10-21T10:00:00.000Z",
  deleted_at: null,
  fields: { title: "A", status: "next", order: 1 },
  field_ts: { title: "2026-10-21T10:00:00.000Z", status: "2026-10-21T10:00:00.000Z", order: "2026-10-21T10:00:00.000Z" },
};

const patch = (ts: string, fields: Record<string, unknown>, extra: Partial<Patch> = {}): Patch => ({ id: base.id, kind: "task", space: "personal", ts, fields, ...extra });

describe("applyPatchLocal", () => {
  it("creates an entity from a create patch", () => {
    const e = applyPatchLocal(undefined, patch("2026-10-21T11:00:00.000Z", { title: "New", status: "inbox", order: 2 }, { create: true }));
    expect(e.id).toBe(base.id);
    expect(e.fields.title).toBe("New");
    expect(e.field_ts.title).toBe("2026-10-21T11:00:00.000Z");
    expect(e.created_at).toBe("2026-10-21T11:00:00.000Z");
  });

  it("applies newer fields and keeps older ones", () => {
    const e = applyPatchLocal(base, patch("2026-10-21T11:00:00.000Z", { title: "B" }));
    expect(e.fields.title).toBe("B");
    expect(e.fields.status).toBe("next");
    expect(e.updated_at).toBe("2026-10-21T11:00:00.000Z");
  });

  it("ignores a stale patch", () => {
    const e = applyPatchLocal(base, patch("2026-10-21T09:00:00.000Z", { title: "Old" }));
    expect(e.fields.title).toBe("A");
    expect(e.updated_at).toBe("2026-10-21T10:00:00.000Z");
  });

  it("treats deleted_at as an ordinary field", () => {
    const e = applyPatchLocal(base, patch("2026-10-21T12:00:00.000Z", { deleted_at: "2026-10-21T12:00:00.000Z" }));
    expect(e.deleted_at).toBe("2026-10-21T12:00:00.000Z");
  });
});

describe("mergeIncoming", () => {
  it("keeps pending local patches newer than the hub's field_ts", () => {
    const incoming: Entity = { ...base, fields: { ...base.fields, title: "Hub" }, field_ts: { ...base.field_ts, title: "2026-10-21T10:30:00.000Z" } };
    const pending = [patch("2026-10-21T10:45:00.000Z", { title: "Mine" })];
    const out = mergeIncoming(incoming, pending);
    expect(out.fields.title).toBe("Mine");
    expect(out.fields.status).toBe("next");
  });

  it("lets the hub win when its field_ts is newer than the pending patch", () => {
    const incoming: Entity = { ...base, fields: { ...base.fields, title: "Hub" }, field_ts: { ...base.field_ts, title: "2026-10-21T11:00:00.000Z" } };
    const pending = [patch("2026-10-21T10:45:00.000Z", { title: "Mine" })];
    expect(mergeIncoming(incoming, pending).fields.title).toBe("Hub");
  });

  it("applies pending patches in ts order regardless of array order", () => {
    const incoming: Entity = { ...base };
    const pending = [patch("2026-10-21T12:00:00.000Z", { title: "Second" }), patch("2026-10-21T11:00:00.000Z", { title: "First", order: 9 })];
    const out = mergeIncoming(incoming, pending);
    expect(out.fields.title).toBe("Second");
    expect(out.fields.order).toBe(9);
  });

  it("ignores pending patches for other ids", () => {
    const other = { ...patch("2026-10-21T12:00:00.000Z", { title: "X" }), id: "22222222-2222-4222-8222-222222222222" };
    expect(mergeIncoming(base, [other]).fields.title).toBe("A");
  });
});

describe("planFlush", () => {
  const item = (seq: number, ts: string): OutboxItem => ({ seq, attempts: 0, enqueued_at: ts, patch: patch(ts, { title: `t${seq}` }) });

  it("orders by outbox seq, not by ts or array position", () => {
    const items = [item(3, "2026-10-21T10:00:00.000Z"), item(1, "2026-10-21T12:00:00.000Z"), item(2, "2026-10-21T11:00:00.000Z")];
    const batches = planFlush(items);
    expect(batches).toHaveLength(1);
    expect(batches[0].map((b) => b.seq)).toEqual([1, 2, 3]);
  });

  it("splits into batches of the contract page size", () => {
    const items = Array.from({ length: 1201 }, (_, i) => item(i + 1, "2026-10-21T10:00:00.000Z"));
    const batches = planFlush(items, 500);
    expect(batches.map((b) => b.length)).toEqual([500, 500, 201]);
    expect(batches[2][0].seq).toBe(1001);
  });

  it("dedupes rejected ids", () => {
    expect(rejectedIds([{ id: "a", reason: "x" }, { id: "a", reason: "y" }, { id: "b", reason: "z" }])).toEqual(["a", "b"]);
  });
});
