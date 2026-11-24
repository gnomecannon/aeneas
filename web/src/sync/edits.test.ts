import { afterEach, describe, expect, it, vi } from "vitest";
import type { Patch } from "@everythingapp/shared";
import { engine } from "./engine";
import { moveToSpace, updateEntity } from "./edits";

describe("edits and spaces", () => {
  afterEach(() => vi.restoreAllMocks());

  it("an edit names no space, so it cannot move an item back that was moved on another device; a move names it", async () => {
    const sent: Patch[] = [];
    vi.spyOn(engine, "enqueue").mockImplementation(async (p: Patch) => {
      sent.push(p);
      return {} as never;
    });
    const task = { id: "7d3c2b1a-0000-4000-8000-000000000001", kind: "task" as const, space: "personal" as const };
    await updateEntity(task, { title: "Ask Robin about the slides" });
    expect(sent[0]).not.toHaveProperty("space");
    await moveToSpace(task, "work");
    expect(sent[1]).toMatchObject({ id: task.id, kind: "task", space: "work", fields: {} });
  });
});
