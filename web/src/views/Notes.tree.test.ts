import { describe, expect, it } from "vitest";
import type { Entity } from "@everythingapp/shared";
import { folderTree, ideaGroups } from "./Notes";

const note = (id: string, path: string, title: string, tags: string[] = [], created_at = "2026-11-03T12:00:00Z"): Entity =>
  ({ id, kind: "note", space: "personal", created_at, updated_at: created_at, deleted_at: null, fields: { title, body: "", tags, path } }) as unknown as Entity;

describe("folderTree", () => {
  it("nests folders, counts everything inside, and keeps top-level notes apart", () => {
    const t = folderTree([
      note("1", "Writing/Comedy/Sketches/Robot choir.md", "Robot choir"),
      note("2", "Writing/Comedy/Word play.md", "Word play"),
      note("3", "Writing/Horror/Lighthouse.md", "Lighthouse"),
      note("4", "Music/Rain.md", "Rain"),
      note("5", "Loose.md", "Loose"),
    ]);
    expect(t.children.map((c) => `${c.name} ${c.count}`)).toEqual(["Music 1", "Writing 3"]);
    const writing = t.children[1];
    expect(writing.children.map((c) => `${c.path} ${c.count}`)).toEqual(["Writing/Comedy 2", "Writing/Horror 1"]);
    expect(writing.children[0].notes.map((n) => n.fields.title)).toEqual(["Word play"]);
    expect(writing.children[0].children[0].path).toBe("Writing/Comedy/Sketches");
    expect(t.notes.map((n) => n.fields.title)).toEqual(["Loose"]);
  });

  it("lists diary days newest first", () => {
    const t = folderTree([note("a", "Diary/2026-11-01.md", "Diary 2026-11-01"), note("b", "Diary/2026-11-03.md", "Diary 2026-11-03")]);
    expect(t.children[0].notes.map((n) => n.id)).toEqual(["b", "a"]);
  });
});

describe("ideaGroups", () => {
  it("groups ideas by form, newest first, wherever they are filed", () => {
    const g = ideaGroups([
      note("1", "Writing/Sketches/Choir.md", "Choir", ["comedy", "idea", "sketch"], "2026-11-03T14:35:00Z"),
      note("2", "Writing/Sketches/Auction.md", "Auction", ["idea", "sketch"], "2026-11-01T10:00:00Z"),
      note("3", "Writing/Keeper.md", "Keeper", ["Idea", "story"]),
      note("4", "Inventions/Lamp.md", "Lamp", ["idea"]),
      note("5", "Writing/Not an idea.md", "Plain", ["sketch"]),
    ]);
    expect(g.map(([form, label, items]) => `${form}:${label}:${items.map((n) => n.id).join(",")}`)).toEqual(["story:Stories:3", "sketch:Sketches:1,2", "other:Other:4"]);
  });
});
