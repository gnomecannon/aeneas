import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Entity } from "@everythingapp/shared";
import { DraftSaver, attachDraft, type DraftOptions } from "./useDraftSave";

type NoteD = { title: string; body: string };
const T0 = "2026-11-13T10:00:00.000Z";

function note(id: string, fields: Record<string, unknown>, field_ts: Record<string, string> = {}): Entity {
  return { id, kind: "note", space: "personal", created_at: T0, updated_at: T0, deleted_at: null, fields, field_ts } as Entity;
}

/** Records each write and stamps the fields it wrote, as updateEntity does on this device. */
function fakeStore() {
  const writes: Array<{ id: string; fields: Record<string, unknown> }> = [];
  let n = 0;
  const save = vi.fn(async (item: Entity, fields: Record<string, unknown>) => {
    writes.push({ id: item.id, fields });
    const ts = `2026-11-13T10:00:${String(++n).padStart(2, "0")}.000Z`;
    const stamps = Object.fromEntries(Object.keys(fields).map((k) => [k, ts]));
    return { ...item, updated_at: ts, fields: { ...item.fields, ...fields }, field_ts: { ...item.field_ts, ...stamps } } as Entity;
  });
  return { writes, save };
}

const noteDraft = (f: Record<string, unknown>): NoteD => ({ title: String(f.title ?? ""), body: String(f.body ?? "") });

function saver(opts: Partial<DraftOptions<NoteD>> = {}) {
  const store = fakeStore();
  const d = new DraftSaver<NoteD>({ toDraft: noteDraft, save: store.save, ...opts });
  return { d, ...store };
}

describe("DraftSaver", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("saves a title and the body typed after it in one write once typing pauses", async () => {
    const { d, writes } = saver();
    d.see(note("n1", { title: "Old", body: "" }));
    d.edit({ title: "Lighthouse" });
    await vi.advanceTimersByTimeAsync(600);
    d.edit({ body: "A keeper hears" });
    await vi.advanceTimersByTimeAsync(600);
    d.edit({ body: "A keeper hears knocking" });
    // Each keystroke restarts the quiet time: nothing written yet.
    await vi.advanceTimersByTimeAsync(999);
    expect(writes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(writes).toEqual([{ id: "n1", fields: { title: "Lighthouse", body: "A keeper hears knocking" } }]);
  });

  it("shows the words typed over the stored copy, and follows the stored copy for fields not being edited", () => {
    const { d } = saver();
    d.see(note("n1", { title: "Old", body: "Old body" }));
    d.edit({ title: "Typed" });
    const changed = note("n1", { title: "From the iPhone", body: "New body" }, { title: "2026-11-13T10:00:30.000Z", body: "2026-11-13T10:00:30.000Z" });
    d.see(changed);
    expect(d.view(changed)).toEqual({ title: "Typed", body: "New body" });
    expect(d.isSaved(changed)).toBe(false);
  });

  it("keeps the words typed while they are written and after, until another device writes the field", async () => {
    // As in Music: tags typed as text are stored as a list, so the stored copy reads back differently from what was typed.
    const store = fakeStore();
    const d = new DraftSaver<{ tags: string }>({
      toDraft: (f) => ({ tags: ((f.tags as string[] | undefined) ?? []).join(", ") }),
      toFields: (e) => ({ tags: String(e.tags ?? "").split(",").map((s) => s.trim()).filter(Boolean) }),
      save: store.save,
    });
    const before = note("m1", { tags: ["riff"] }, { tags: T0 });
    d.see(before);
    d.edit({ tags: "riff, rock, " });
    const writing = d.flush();
    // Being written: the stored copy is still the old one, and the box keeps the text (no jump back).
    d.see(before);
    expect(d.view(before)).toEqual({ tags: "riff, rock, " });
    await writing;
    // Written, but the live copy has not caught up yet.
    d.see(before);
    expect(d.view(before)).toEqual({ tags: "riff, rock, " });
    // This device's own write in the stored copy: still the text as typed, so the next word is not glued on.
    const mine = note("m1", { tags: ["riff", "rock"] }, { tags: "2026-11-13T10:00:01.000Z" });
    d.see(mine);
    expect(d.view(mine)).toEqual({ tags: "riff, rock, " });
    expect(d.isSaved(mine)).toBe(true);
    // Another device writes the field later: the box follows it.
    const elsewhere = note("m1", { tags: ["jazz"] }, { tags: "2026-11-13T10:05:00.000Z" });
    d.see(elsewhere);
    expect(d.view(elsewhere)).toEqual({ tags: "jazz" });
  });

  it("an edit for one item never lands on the next item shown", async () => {
    const { d, writes } = saver();
    const a = note("a", { title: "A", body: "" });
    const b = note("b", { title: "B", body: "" });
    d.see(a);
    d.edit({ title: "A edited" });
    d.see(b);
    expect(d.view(b)).toEqual({ title: "B", body: "" });
    d.edit({ body: "B body" });
    expect(writes).toEqual([{ id: "a", fields: { title: "A edited" } }]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(writes).toEqual([{ id: "a", fields: { title: "A edited" } }, { id: "b", fields: { body: "B body" } }]);
  });

  it("a write that fails keeps the edits waiting for the next save", async () => {
    const { d, writes, save } = saver();
    const n1 = note("n1", { title: "Old", body: "" });
    save.mockImplementationOnce(async () => {
      throw new Error("storage full");
    });
    d.see(n1);
    d.edit({ title: "Kept" });
    await d.flush();
    d.see(n1);
    expect(d.view(n1)).toEqual({ title: "Kept", body: "" });
    expect(d.isSaved(n1)).toBe(false);
    await d.flush();
    expect(writes).toEqual([{ id: "n1", fields: { title: "Kept" } }]);
  });
});

describe("attachDraft (the hook's effect)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("closing the editor saves the words still waiting at once, and once", async () => {
    const { d, writes } = saver();
    const close = attachDraft(d);
    d.see(note("n1", { title: "Old", body: "" }));
    d.edit({ title: "New" });
    d.edit({ body: "last words" });
    close();
    expect(writes).toEqual([{ id: "n1", fields: { title: "New", body: "last words" } }]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(writes).toHaveLength(1);
  });

  it("showing another item (the effect runs again) saves the last item's edits to it", () => {
    const { d, writes } = saver();
    let close = attachDraft(d);
    d.see(note("a", { title: "A", body: "" }));
    d.edit({ body: "typed into A" });
    d.see(note("b", { title: "B", body: "" }));
    close();
    close = attachDraft(d);
    expect(writes).toEqual([{ id: "a", fields: { body: "typed into A" } }]);
    close();
  });

  it("calls nothing of an editor that is gone when its last save finishes", async () => {
    const onSaved = vi.fn();
    const { d } = saver({ onSaved });
    const onChange = vi.fn();
    d.onChange = onChange;
    const close = attachDraft(d);
    d.see(note("n1", { title: "Old", body: "" }));
    d.edit({ title: "New" });
    onChange.mockClear();
    close();
    await vi.advanceTimersByTimeAsync(0);
    expect(onSaved).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("the app hidden or the page going away", () => {
  // The page's listeners are added once, by the first editor opened in a page: one window and document for these.
  const g = globalThis as Record<string, unknown>;
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const win = new EventTarget();

  beforeAll(() => {
    g.window = win;
    g.document = doc;
  });
  afterAll(() => {
    delete g.window;
    delete g.document;
  });
  beforeEach(() => {
    vi.useFakeTimers();
    doc.visibilityState = "visible";
  });
  afterEach(() => vi.useRealTimers());

  it("saves what every open editor has waiting, without waiting for the pause", () => {
    const first = saver();
    const second = saver();
    const closeFirst = attachDraft(first.d);
    const closeSecond = attachDraft(second.d);
    first.d.see(note("n1", { title: "One", body: "" }));
    second.d.see(note("n2", { title: "Two", body: "" }));
    first.d.edit({ body: "before the app went to the background" });
    second.d.edit({ title: "Two, renamed" });
    // Android sends the app to the background.
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(first.writes).toEqual([{ id: "n1", fields: { body: "before the app went to the background" } }]);
    expect(second.writes).toEqual([{ id: "n2", fields: { title: "Two, renamed" } }]);
    // The page itself going away.
    doc.visibilityState = "visible";
    first.d.edit({ body: "and then closed" });
    win.dispatchEvent(new Event("pagehide"));
    expect(first.writes).toHaveLength(2);
    expect(first.writes[1]).toEqual({ id: "n1", fields: { body: "and then closed" } });
    closeFirst();
    closeSecond();
  });

  it("an editor already closed is not saved again", () => {
    const { d, writes } = saver();
    const close = attachDraft(d);
    d.see(note("n1", { title: "One", body: "" }));
    d.edit({ title: "Changed" });
    close();
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(writes).toHaveLength(1);
  });
});
