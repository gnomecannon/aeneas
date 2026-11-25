import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub } from "./helpers.js";
import { ctxFor } from "./ai-helpers.js";
import { runTool, TOOLS } from "../src/ai/tools.js";
import { filingPrompt } from "../src/capture-filer.js";
import { buildSystemPrompt, loadMemory } from "../src/ai/prompt.js";

const api = (t: ReturnType<typeof makeHub>) => async (method: string, p: string, body?: unknown) => {
  const res = await t.app.request(p, { method, headers: { authorization: `Bearer ${t.hub.cfg.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, data: await res.json().catch(() => null) };
};

test("filer: a gift idea goes to the person, and becomes a task only when a day is named", () => {
  const p = filingPrompt("Gift idea for Jamie: a wool scarf", new Date("2026-11-25T12:00:00"), undefined, [], [], [], { owner: "Alex", pet: "Biscuit" });
  const gift = p.indexOf("a gift idea for someone");
  assert.ok(gift > 0, "the rule is there");
  assert.ok(gift < p.indexOf("something to do becomes a task"), "before the rule that makes tasks, so it is read first");
  assert.match(p, /a gift idea for someone \(something Alex could give them\) goes to that person: look them up with people, then remember with person= and category gift_idea/);
  assert.match(p, /it becomes a task too only when a day is named for it \(by Friday, or for their birthday when people shows it\), a task due that day, and otherwise no task and nothing on a shopping list/);
  assert.match(p, /category like or dislike for what they like or dislike/);
});

test("remember: likes, dislikes and gift ideas about someone, with the schema the model is given", async () => {
  const remember = TOOLS.find((x) => x.name === "remember")!;
  const props = remember.parameters.properties as Record<string, { enum?: string[]; description?: string }>;
  assert.deepEqual(props.category.enum!.slice(-3), ["like", "dislike", "gift_idea"]);
  assert.ok(props.occasion?.description && props.given_at?.description);
  assert.match(remember.description, /like and dislike are things they like and dislike, gift_idea a gift idea for them/);
  assert.match(remember.description, /own likes and dislikes stay preference/);
  assert.match(TOOLS.find((x) => x.name === "people")!.description, /gift_ideas with the ones already given marked given/);

  const t = makeHub();
  try {
    const a = api(t);
    const ctx = ctxFor(t, "gifts-1");
    const jamie = t.hub.store.create("person", { name: "Jamie Hill", given_name: "Jamie" });
    const run = async (args: Record<string, unknown>) => runTool(a, { name: "remember", arguments: args }, ctx);
    assert.equal((await run({ category: "gift_idea", key: "gift", value: "Wool scarf", person: "Jamie", occasion: "birthday" })).ok, true);
    // The same key from the model, another idea: a second fact, never the first one changed.
    assert.equal((await run({ category: "gift_idea", key: "gift", value: "Lego castle", person: "Jamie" })).ok, true);
    assert.equal((await run({ category: "like", key: "food", value: "Loves sushi", person: "Jamie" })).ok, true);
    assert.equal((await run({ category: "dislike", key: "food", value: "Hates cilantro", person: "Jamie" })).ok, true);
    const facts = t.hub.store.list({ kind: "fact" });
    const scarf = facts.find((f) => f.fields.value === "Wool scarf")!;
    assert.deepEqual([scarf.fields.category, scarf.fields.key, scarf.fields.person_id, scarf.fields.occasion], ["gift_idea", "gift:wool_scarf", jamie.id, "birthday"]);
    assert.equal(facts.find((f) => f.fields.value === "Lego castle")!.fields.key, "gift:lego_castle");
    assert.equal(facts.find((f) => f.fields.value === "Loves sushi")!.fields.category, "like");

    // The owner's own likes stay preferences; a gift idea is for someone; given_at is a day.
    assert.equal((await run({ category: "like", key: "weather", value: "Likes rainy days" })).ok, true);
    const own = t.hub.store.list({ kind: "fact" }).find((f) => f.fields.value === "Likes rainy days")!;
    assert.deepEqual([own.fields.category, own.fields.key, own.fields.person_id], ["preference", "weather", undefined]);
    assert.match((await run({ category: "gift_idea", key: "x", value: "Socks" })).text, /a gift idea is for someone/);
    assert.match((await run({ category: "gift_idea", key: "x", value: "Socks", person: "Jamie", given_at: "Christmas" })).text, /given_at is a day/);

    // Marked given the way the tool description says.
    assert.equal((await runTool(a, { name: "update_item", arguments: { id: scarf.id, fields: { given_at: "2026-11-20" } } }, ctx)).ok, true);

    const found = JSON.parse((await runTool(a, { name: "people", arguments: { query: "Jamie" } }, ctx)).text).people[0];
    assert.deepEqual(Object.keys(found.known), ["likes", "dislikes", "gift_ideas"]);
    assert.deepEqual(found.known.likes, [{ id: facts.find((f) => f.fields.value === "Loves sushi")!.id, value: "Loves sushi" }]);
    assert.deepEqual(found.known.dislikes.map((x: { value: string }) => x.value), ["Hates cilantro"]);
    assert.deepEqual(found.known.gift_ideas.map(({ id: _, ...x }: { id: string }) => x), [
      { value: "Lego castle", given: false },
      { value: "Wool scarf", given: true, given_at: "2026-11-20", occasion: "birthday" },
    ], "ideas not given first, given ones marked");

    // The system prompt says the same about given ideas.
    const p = buildSystemPrompt(loadMemory(t.hub.store, { cloud: false, allowWork: false }), "general");
    assert.match(p, /- Jamie Hill: \[gift idea, given 2026-11-20, for birthday\] gift:wool_scarf: Wool scarf/);
    assert.match(p, /- Jamie Hill: \[gift idea, not given yet\] gift:lego_castle: Lego castle/);
    assert.match(p, /- Jamie Hill: \[like\] like:loves_sushi: Loves sushi/);
  } finally { t.cleanup(); }
});
