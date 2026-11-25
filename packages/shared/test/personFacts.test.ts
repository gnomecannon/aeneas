import { test } from "node:test";
import assert from "node:assert/strict";
import { FieldsByKind, personFactGroups, personFactKey } from "../src/index.ts";

// The same cases as apple/Packages/EACore/Tests/EACoreTests/PersonFactsTests.swift, so a person's page has the same
// sections on every device.

type F = { id: string; created_at?: string; deleted_at?: string | null; fields: Record<string, unknown> };
const jamie = { id: "jamie", fields: { name: "Jamie Hill", given_name: "Jamie" } };
const fact = (id: string, category: string, value: string, extra: Record<string, unknown> = {}, created_at = "2026-11-01T12:00:00.000Z"): F =>
  ({ id, created_at, fields: { category, key: id, value, person_id: "jamie", ...extra } });

test("person facts: each fact in its section, gift ideas not given first and newest first, mentions in Other", () => {
  const facts: F[] = [
    fact("f1", "like", "Loves sushi"),
    fact("f2", "preference", "Prefers window seats"),
    // Kept with their name before they were in People.
    { id: "f3", created_at: "2026-11-01T12:00:00.000Z", fields: { category: "dislike", key: "f3", value: "Hates cilantro", person: "Jamie" } },
    fact("g1", "gift_idea", "Lego castle", {}, "2026-11-01T12:00:00.000Z"),
    fact("g2", "gift_idea", "Wool scarf", { occasion: "birthday" }, "2026-11-10T12:00:00.000Z"),
    fact("g3", "gift_idea", "Board game", { given_at: "2026-10-20" }, "2026-10-01T12:00:00.000Z"),
    fact("g4", "gift_idea", "Concert tickets", { given_at: "2026-11-05" }, "2026-09-01T12:00:00.000Z"),
    fact("h1", "health", "Allergic to peanuts"),
    fact("c1", "constraint", "No caffeine after noon"),
    fact("r1", "relationship", "Sister of Devon"),
    fact("i1", "identity", "Works at the library"),
    // Devon's gift idea that names Jamie: someone else's, so not in Jamie's Gift ideas.
    fact("m1", "gift_idea", "A puzzle for Devon and Jamie", { person_id: "devon" }),
    { ...fact("d1", "like", "Gone"), deleted_at: "2026-11-02T00:00:00.000Z" },
  ];
  const groups = personFactGroups(jamie, facts);
  assert.deepEqual(groups.map((g) => [g.id, g.items.map((f) => f.id)]), [
    ["likes", ["f1", "f2"]],
    ["dislikes", ["f3"]],
    ["gift_ideas", ["g2", "g1", "g4", "g3"]],
    ["health_and_food", ["h1", "c1"]],
    ["history", ["r1"]],
    ["other", ["i1", "m1"]],
  ]);
});

test("person facts: every section is there when there are none, the first three with what they add", () => {
  const groups = personFactGroups(jamie, []);
  assert.deepEqual(groups.map((g) => [g.id, g.title, g.add ?? null, g.empty ?? null, g.items.length]), [
    ["likes", "Likes", "like", "No likes yet", 0],
    ["dislikes", "Dislikes", "dislike", "No dislikes yet", 0],
    ["gift_ideas", "Gift ideas", "gift_idea", "No gift ideas yet", 0],
    ["health_and_food", "Health and food", null, null, 0],
    ["history", "History", null, null, 0],
    ["other", "Other", null, null, 0],
  ]);
});

test("person facts: the key is made from the value, so two ideas never share one", () => {
  assert.equal(personFactKey("gift_idea", "A LEGO castle set, the big one!"), "gift:a_lego_castle_set_the_big");
  assert.equal(personFactKey("like", "Crème brûlée"), "like:creme_brulee");
  assert.equal(personFactKey("dislike", "  "), "dislike:item");
  assert.notEqual(personFactKey("gift_idea", "Wool scarf"), personFactKey("gift_idea", "Board game"));
});

test("person facts: the new categories, given_at and occasion are valid fact fields", () => {
  const ok = FieldsByKind.fact.safeParse({ category: "gift_idea", key: "gift:wool_scarf", value: "Wool scarf", person_id: "jamie", given_at: "2026-12-25", occasion: "Christmas" });
  assert.equal(ok.success, true);
  assert.deepEqual(ok.success && [ok.data.given_at, ok.data.occasion], ["2026-12-25", "Christmas"]);
  for (const c of ["like", "dislike"]) assert.equal(FieldsByKind.fact.safeParse({ category: c, key: "k", value: "v" }).success, true);
  assert.equal(FieldsByKind.fact.safeParse({ category: "gift_idea", key: "k", value: "v", given_at: "Christmas" }).success, false, "given_at is a day");
});
