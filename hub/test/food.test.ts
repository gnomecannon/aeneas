import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub } from "./helpers.js";
import { runSeed } from "../src/seed.js";
import { texturesFrom } from "../src/food.js";

const pick = (t: ReturnType<typeof makeHub>, body: Record<string, unknown>) => t.api("/food/pick", { method: "POST", json: body }).then((r) => r.json() as Promise<any>);
const byName = (t: ReturnType<typeof makeHub>, name: string) => t.hub.store.list({ kind: "food_option" }).find((o) => o.fields.name === name)!;

test("food: the pick skips avoid, textures and home, scores protein and plant, and explains itself", async () => {
  const t = makeHub();
  try {
    runSeed(t.hub.store, t.hub.cfg.seedDir);
    t.hub.store.create("food_option", { name: "Home stir fry", kind: "home", items: ["chicken", "broccoli"], tags: ["protein", "plant"], rating: 5 });
    t.hub.store.create("food_option", { name: "Mushroom risotto", kind: "delivery", items: ["mushroom risotto"], tags: ["protein", "plant"], rating: 5, cost: 10 });

    const r = await pick(t, { meal: "dinner", mode: "delivery" });
    assert.equal(r.pick.fields.name, "Mediterranean plate", "protein and plant with the doctor's rules, never picked; ties break by name");
    assert.equal(r.runner_up.fields.name, "Thai larb and papaya salad");
    assert.equal(r.why, "protein, plant, never picked, no sweet sauce");
    assert.ok(r.constraints_used.includes("avoid"));
    assert.ok(r.constraints_used.includes("textures: mushroom, olive"));
    assert.ok(r.constraints_used.includes("doctor rules"));
    assert.ok(r.constraints_used.includes("mode delivery"));

    // Deterministic.
    assert.equal((await pick(t, { meal: "dinner", mode: "delivery" })).pick.id, r.pick.id);

    // No mode: delivery, restaurant and grab compete; home never does with diet:no_cook on file.
    const names = new Set<string>();
    for (const mode of [undefined, "delivery", "restaurant", "grab"]) {
      const p = await pick(t, { meal: "lunch", ...(mode ? { mode } : {}) });
      names.add(p.pick.fields.name);
      assert.notEqual(p.pick.fields.name, "Chicken tikka masala", "avoid");
      assert.notEqual(p.pick.fields.name, "Mushroom risotto", "texture");
      assert.notEqual(p.pick.fields.name, "Home stir fry", "no cook");
      assert.notEqual(p.runner_up?.fields.name, "Home stir fry");
    }
    assert.ok(names.size >= 3);
    const home = await pick(t, { meal: "dinner", mode: "home" });
    assert.equal(home.pick.fields.name, "Home stir fry", "mode home is the one way to a home option");

    assert.equal((await t.api("/food/pick", { method: "POST", json: { meal: "brunch" } })).status, 422);
    assert.equal((await t.api("/food/pick", { method: "POST", json: { meal: "lunch", mode: "drone" } })).status, 422);
    assert.deepEqual(texturesFrom("Dislikes olive and mushroom textures."), ["mushroom", "olive"], "in list order");
    assert.deepEqual(texturesFrom(null), []);
  } finally { t.cleanup(); }
});

test("food: recency after /food/picked, budget, exclude, and the doctor's penalties", async () => {
  const t = makeHub();
  try {
    runSeed(t.hub.store, t.hub.cfg.seedDir);
    const med = byName(t, "Mediterranean plate");
    const thai = byName(t, "Thai larb and papaya salad");
    const picked = await t.api("/food/picked", { method: "POST", json: { id: med.id } });
    assert.equal(picked.status, 200);
    const after = await picked.json() as any;
    assert.equal(after.fields.times_picked, 1);
    assert.ok(after.fields.last_picked);
    await t.api("/food/picked", { method: "POST", json: { id: med.id } });
    assert.equal(t.hub.store.get(med.id)!.fields.times_picked, 2);
    assert.equal((await t.api("/food/picked", { method: "POST", json: { id: "nope" } })).status, 404);
    assert.equal((await t.api("/food/picked", { method: "POST", json: {} })).status, 422);

    let r = await pick(t, { meal: "dinner", mode: "delivery" });
    assert.equal(r.pick.fields.name, "Thai larb and papaya salad", "picked today drops to the bottom");
    assert.equal(r.why, "protein, plant, never picked, no sweet sauce");
    assert.equal(r.runner_up.fields.name, "Lentil soup and salad");
    // Picks count local calendar days, so these are dated by day (noon) and hold across a daylight saving change.
    const daysAgo = (n: number) => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate() - n, 12).toISOString(); };
    t.hub.store.patch(thai.id, { last_picked: daysAgo(9), times_picked: 1 });
    r = await pick(t, { meal: "dinner", mode: "delivery" });
    assert.equal(r.pick.fields.name, "Thai larb and papaya salad", "nine days ago is fine");
    assert.equal(r.why, "protein, plant, not picked in 9 days, no sweet sauce");
    t.hub.store.patch(thai.id, { last_picked: daysAgo(2) });
    r = await pick(t, { meal: "dinner", mode: "delivery" });
    assert.equal(r.pick.fields.name, "Lentil soup and salad", "two days ago is recent");
    assert.equal(r.why, "plant, never picked, no sweet sauce");
    assert.equal(r.runner_up.fields.name, "Sushi delivery");

    // Budget against cost.
    r = await pick(t, { meal: "dinner", mode: "delivery", budget: 20 });
    assert.equal(r.pick.fields.name, "Lentil soup and salad");
    assert.equal(r.runner_up.fields.name, "General Tso's chicken", "the only other delivery under 20");
    assert.ok(r.constraints_used.includes("budget 20"));

    // Exclude for "another one"; the sweet-sauce and fried entry only wins when nothing else fits.
    const lentil = byName(t, "Lentil soup and salad");
    r = await pick(t, { meal: "dinner", mode: "delivery", budget: 20, exclude: [lentil.id] });
    assert.equal(r.pick.fields.name, "General Tso's chicken");
    assert.equal(r.why, "protein, never picked, sweet sauce, fried");
    assert.ok(r.constraints_used.includes("exclude 1"));
    assert.equal(r.runner_up, null);
    r = await pick(t, { meal: "dinner", mode: "delivery", exclude: [lentil.id] });
    assert.equal(r.pick.fields.name, "Sushi delivery");

    // Nothing eligible says what to add.
    r = await pick(t, { meal: "snack", mode: "restaurant", budget: 5 });
    assert.equal(r.pick, null);
    assert.equal(r.runner_up, null);
    assert.match(r.why, /^Nothing eligible for snack\. Add a food_option of kind restaurant without avoid and without mushroom, olive costing 5 or less\.$/);

    // Without the doctor's fact the sweet-sauce entry is not penalized and `why` stops mentioning sauce.
    for (const f of t.hub.store.list({ kind: "fact" })) if (f.fields.key === "doctor_rules") t.hub.store.patch(f.id, { deleted_at: new Date().toISOString() });
    r = await pick(t, { meal: "dinner", mode: "delivery", budget: 20, exclude: [lentil.id] });
    assert.equal(r.why, "protein, never picked");
    assert.ok(!r.constraints_used.includes("doctor rules"));
  } finally { t.cleanup(); }
});

test("food: seeding creates the starter options once by name and leaves edits alone", async () => {
  const t = makeHub();
  try {
    const first = runSeed(t.hub.store, t.hub.cfg.seedDir);
    assert.equal(first.food_options.created, 11);
    assert.equal(first.food_options.kept, 0);
    const options = t.hub.store.list({ kind: "food_option" });
    assert.equal(options.length, 11);
    const tso = options.find((o) => o.fields.name === "General Tso's chicken")!;
    assert.deepEqual(tso.fields.tags, ["protein", "sweet-sauce", "fried"]);
    const tikka = options.find((o) => o.fields.name === "Chicken tikka masala")!;
    assert.equal(tikka.fields.avoid, true);
    assert.ok((tikka.fields.tags as string[]).includes("tomato"));
    assert.ok(options.every((o) => o.fields.avoid !== undefined), "avoid defaults to false");

    const sushi = options.find((o) => o.fields.name === "Sushi delivery")!;
    t.hub.store.patch(sushi.id, { rating: 2, cost: 40 });
    t.hub.store.patch(tso.id, { deleted_at: new Date().toISOString() });
    const second = runSeed(t.hub.store, t.hub.cfg.seedDir);
    assert.deepEqual(second.food_options, { created: 0, kept: 11 });
    assert.equal(t.hub.store.get(sushi.id)!.fields.rating, 2);
    assert.ok(t.hub.store.get(tso.id)!.deleted_at, "a deleted option is not resurrected");
    assert.equal(t.hub.store.list({ kind: "food_option" }).length, 10);
    const status = await (await t.api("/status")).json() as any;
    assert.equal(status.home.food_options, 10);
    assert.equal(status.home.pet_events_30d, 0);
  } finally { t.cleanup(); }
});
