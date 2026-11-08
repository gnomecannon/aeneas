import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub } from "./helpers.js";
import { ctxFor } from "./ai-helpers.js";
import { runTool } from "../src/ai/tools.js";

test("related: a person's page lists what mentions them; an item lists its links and the people in it", async () => {
  const t = makeHub();
  try {
    const s = t.hub.store;
    const jen = s.create("person", { name: "Jennifer Carter", given_name: "Jennifer", nickname: "Jen" });
    s.create("person", { name: "Jenny Borden" });
    const ev = s.create("event", { title: "Tonight: dinner at Luigi's with Jen", start: "2026-10-30T00:00:00.000Z", end: "2026-10-31T00:00:00.000Z", all_day: true });
    const cap = s.create("capture", { source: "iphone", text: "Going out to eat at Luigi's with Jen tonight", converted_to: [ev.id] });
    const fact = s.create("fact", { category: "preference", key: "jen:luigis_order", value: "Likes the house salad", person_id: jen.id });
    s.create("note", { title: "Jenga tower", path: "Home/Jenga tower.md", body: "Stack the Jenga tower" });

    const res = await t.app.request(`/entities/${jen.id}/related`, { headers: { authorization: `Bearer ${t.hub.cfg.token}` } });
    const items = ((await res.json()) as any).items as { id: string; why: string }[];
    const why = Object.fromEntries(items.map((i) => [i.id, i.why]));
    assert.equal(why[fact.id], "About them");
    assert.equal(why[ev.id], "Mentions them");
    assert.equal(why[cap.id], "Mentions them");
    assert.equal(items.some((i) => i.why === "Mentions them" && !why[ev.id]), false);
    assert.equal(items.length, 3, "Jenga and Jenny do not count as Jen");

    const evRel = ((await (await t.app.request(`/entities/${ev.id}/related`, { headers: { authorization: `Bearer ${t.hub.cfg.token}` } })).json()) as any).items as { id: string; why: string }[];
    assert.deepEqual(evRel.map((i) => [i.id, i.why]).sort(), [[cap.id, "Captured"], [jen.id, "Mentioned"]].sort());
    const capRel = ((await (await t.app.request(`/entities/${cap.id}/related`, { headers: { authorization: `Bearer ${t.hub.cfg.token}` } })).json()) as any).items as { id: string; why: string }[];
    assert.equal(capRel.find((i) => i.id === ev.id)?.why, "Filed as");

    const ctx = ctxFor(t, "related-1");
    const api = async (method: string, p: string, body?: unknown) => {
      const r = await t.app.request(p, { method, headers: { authorization: `Bearer ${t.hub.cfg.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: r.status, data: await r.json().catch(() => null) };
    };
    const found = JSON.parse((await runTool(api, { name: "people", arguments: { id: jen.id } }, ctx)).text).people[0];
    assert.deepEqual(found.mentioned_in.map((m: { id: string }) => m.id).sort(), [ev.id, cap.id].sort());

    // A diary day comes with the lines that name them.
    const diary = t.hub.store.create("note", { title: "2026-10-30", path: "Diary/2026-10-30.md", body: "# 2026-10-30\n\n- 12:40 Lunch at Chipotle with Jen, she's starting a new job at Northwind\n- 15:00 Fixed the fan in storage\n" });
    const again = JSON.parse((await runTool(api, { name: "people", arguments: { id: jen.id } }, ctx)).text).people[0];
    const day = again.mentioned_in.find((m: { id: string }) => m.id === diary.id);
    assert.deepEqual(day.lines, ["12:40 Lunch at Chipotle with Jen, she's starting a new job at Northwind"]);
    assert.equal(day.title, "Diary, Friday, Oct 30, 2026");

    // A place's notes name who recommended it, so it shows on their page.
    const ramen = t.hub.store.create("food_option", { name: "Ramen place on Elm St", kind: "restaurant", items: [], tags: [], avoid: false, notes: "Jen recommended it" });
    const third = JSON.parse((await runTool(api, { name: "people", arguments: { id: jen.id } }, ctx)).text).people[0];
    assert.ok(third.mentioned_in.some((m: { id: string }) => m.id === ramen.id));
  } finally {
    t.cleanup();
  }
});
