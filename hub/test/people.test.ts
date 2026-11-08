import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub } from "./helpers.js";
import { ctxFor } from "./ai-helpers.js";
import { runTool } from "../src/ai/tools.js";
import { tidyPeople } from "../src/people.js";

const api = (t: ReturnType<typeof makeHub>) => async (method: string, p: string, body?: unknown) => {
  const res = await t.app.request(p, { method, headers: { authorization: `Bearer ${t.hub.cfg.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, data: await res.json().catch(() => null) };
};

test("people: what the owner says about someone is remembered on them; contact details add without losing what is there", async () => {
  const t = makeHub();
  try {
    const a = api(t);
    const ctx = ctxFor(t, "people-1");
    const jen = t.hub.store.create("person", { name: "Jennifer Carter", given_name: "Jennifer", nickname: "Jen", phones: [{ label: "mobile", value: "(312) 555-0101" }], apple: { id: "ABC" } });
    // "Jen likes the house salad at Luigi's"
    assert.equal((await runTool(a, { name: "remember", arguments: { category: "preference", key: "jen:luigis_order", value: "Likes the house salad at Luigi's", person: "Jen" } }, ctx)).ok, true);
    const fact = t.hub.store.list({ kind: "fact" }).find((f) => f.fields.key === "jen:luigis_order")!;
    assert.equal(fact.fields.person_id, jen.id);

    const found = JSON.parse((await runTool(a, { name: "people", arguments: { query: "jen" } }, ctx)).text);
    assert.equal(found.people[0].id, jen.id);
    assert.equal(found.people[0].known[0].value, "Likes the house salad at Luigi's");
    assert.equal(found.people[0].apple, undefined, "the device link is not the model's business");

    assert.equal((await runTool(a, { name: "save_person", arguments: { name: "Jen", phones: [{ label: "work", value: "312-555-0199" }, { value: "312.555.0101" }], addresses: [{ label: "home", street: "1 Main St", city: "Springfield", state: "MA" }] } }, ctx)).ok, true);
    const p = t.hub.store.get(jen.id)!;
    assert.equal(p.fields.name, "Jennifer Carter", "a nickname never renames the contact");
    assert.equal((p.fields.phones as any[]).length, 2, "the same number in another format is not added twice");
    assert.equal((p.fields.addresses as any[])[0].city, "Springfield");

    // Someone not in contacts: the fact keeps the name; save_person adds them.
    await runTool(a, { name: "remember", arguments: { category: "relationship", key: "devon:dnd", value: "Runs the D&D campaign", person: "Devon" } }, ctx);
    assert.equal(t.hub.store.list({ kind: "fact" }).find((f) => f.fields.key === "devon:dnd")!.fields.person, "Devon");
    const made = JSON.parse((await runTool(a, { name: "save_person", arguments: { name: "Devon", relationship: "friend from D&D" } }, ctx)).text);
    assert.deepEqual([made.kind, made.name, made.relationship], ["person", "Devon", "friend from D&D"]);
    const devon = JSON.parse((await runTool(a, { name: "people", arguments: { query: "Devon" } }, ctx)).text).people[0];
    assert.equal(devon.known[0].value, "Runs the D&D campaign", "facts kept by name join the person once they exist");

    // A birthday sent as a labeled date goes in the birthday field; other dates stay dates.
    await runTool(a, { name: "save_person", arguments: { name: "Devon", dates: [{ label: "Birthday", date: "--03-14" }, { label: "met", date: "2019-06-01" }] } }, ctx);
    const after = t.hub.store.list({ kind: "person" }).find((p) => p.fields.name === "Devon")!;
    assert.equal(after.fields.birthday, "--03-14");
    assert.deepEqual((after.fields.dates as any[]).map((d) => d.label), ["met"]);

    // Another number is added; a new number replaces the old one.
    await runTool(a, { name: "save_person", arguments: { name: "Devon", phones: [{ label: "mobile", value: "312 555 0142" }] } }, ctx);
    await runTool(a, { name: "save_person", arguments: { name: "Devon", phones: [{ label: "work", value: "312 555 0177" }] } }, ctx);
    assert.equal((t.hub.store.get(after.id)!.fields.phones as any[]).length, 2);
    await runTool(a, { name: "save_person", arguments: { name: "Devon", phones: [{ label: "mobile", value: "312 555 0199" }], replace: true } }, ctx);
    assert.deepEqual((t.hub.store.get(after.id)!.fields.phones as any[]).map((x) => x.value), ["312 555 0199"]);
  } finally { t.cleanup(); }
});

test("remember: the same key about different people is a different fact; separators in keys do not matter", async () => {
  const t = makeHub();
  try {
    const a = api(t);
    const ctx = ctxFor(t, "people-2");
    t.hub.store.create("person", { name: "Jen" });
    t.hub.store.create("person", { name: "Devon Becker", given_name: "Devon" });
    await runTool(a, { name: "remember", arguments: { category: "preference", key: "chocolate", value: "Loves dark chocolate", person: "Jen" } }, ctx);
    await runTool(a, { name: "remember", arguments: { category: "preference", key: "chocolate", value: "Hates chocolate", person: "Devon" } }, ctx);
    await runTool(a, { name: "remember", arguments: { category: "preference", key: "chocolate", value: "Milk chocolate only" } }, ctx);
    const facts = t.hub.store.list({ kind: "fact" });
    assert.deepEqual(facts.map((f) => f.fields.value).sort(), ["Hates chocolate", "Loves dark chocolate", "Milk chocolate only"], "Jen's, Devon's and Robin's own stay apart");

    // "focus_2026_10" after "focus:2026-10" updates the one fact.
    await runTool(a, { name: "remember", arguments: { category: "project", key: "focus:2026-10", value: "Starfall" } }, ctx);
    await runTool(a, { name: "remember", arguments: { category: "project", key: "focus_2026_10", value: "Starfall and AI projects" } }, ctx);
    const focus = t.hub.store.list({ kind: "fact" }).filter((f) => /^focus/.test(String(f.fields.key)));
    assert.deepEqual(focus.map((f) => f.fields.value), ["Starfall and AI projects"]);
  } finally { t.cleanup(); }
});

test("people: the nightly tidy drops repeated numbers and merges sure duplicates; merge_people joins the rest", async () => {
  const t = makeHub();
  try {
    const s = t.hub.store;
    const dev = s.create("device", { name: "Robin-Phone", platform: "iphone" });
    const me = s.create("person", { name: "Robin Rivera", given_name: "Robin", family_name: "Rivera", phones: [{ value: "555-201-0142" }, { label: "mobile", value: "(555) 201-0142" }], emails: [{ value: "robin@riverastudio.example" }], apple: { device: dev.id, id: "C1", me: true } });
    const work = s.create("person", { name: "Robin Rivera", given_name: "Robin", family_name: "Rivera", job_title: "Owner", phones: [{ value: "5552010199" }, { value: "5552010142" }], emails: [{ value: "Robin@riverastudio.example" }, { value: "robin.home@example.com" }], apple: { device: dev.id, id: "C2" } });
    const shop1 = s.create("person", { name: "Corner Auto Shop", organization: "Corner Auto Shop", phones: [{ value: "5550161262" }], apple: { device: dev.id, id: "C3" } });
    const shop2 = s.create("person", { name: "Corner Auto Shop", organization: "Corner Auto Shop", phones: [{ value: "555 016 1262" }], apple: { device: dev.id, id: "C4" } });
    // The same name with different numbers are different people; two voicemail numbers are not one contact.
    s.create("person", { name: "Voicemail", given_name: "Voicemail", phones: [{ value: "5550109900" }], apple: { device: dev.id, id: "C5" } });
    s.create("person", { name: "Voice Mail", given_name: "Voice", family_name: "Mail", phones: [{ value: "5550177243" }], apple: { device: dev.id, id: "C6" } });
    const fact = s.create("fact", { category: "identity", key: "job", value: "Runs Rivera Studio", person_id: work.id, person: "Robin Rivera" });

    assert.deepEqual(tidyPeople(s), { cleaned: 0, merged: 0 }, "nothing until the syncing device's build understands merges");
    s.patch(dev.id, { features: ["contacts-merge"] });
    const r = tidyPeople(s);
    assert.equal(r.merged, 2);
    const kept = s.get(me.id)!;
    assert.deepEqual(kept.fields.phones, [{ value: "555-201-0142" }, { value: "5552010199" }], "repeats dropped, the other card's number joined");
    assert.deepEqual((kept.fields.emails as any[]).map((e) => e.value), ["robin@riverastudio.example", "robin.home@example.com"]);
    assert.equal(kept.fields.job_title, "Owner", "an empty field is filled from the duplicate");
    assert.deepEqual(kept.fields.apple, { device: dev.id, id: "C1", me: true }, "the owner's own card is the one kept");
    assert.equal(s.get(work.id)!.deleted_at !== null, true);
    assert.equal(s.get(work.id)!.fields.merged_into, me.id);
    assert.equal(s.get(fact.id)!.fields.person_id, me.id, "facts follow the kept person");
    assert.equal([shop1, shop2].filter((p) => s.get(p.id)!.deleted_at).length, 1);
    assert.equal(s.list({ kind: "person" }).length, 4);
    assert.deepEqual(tidyPeople(s), { cleaned: 0, merged: 0 }, "a second run finds nothing");

    // Different names for one person are merged on request.
    const sister = s.create("person", { name: "Sister", given_name: "Sister", birthday: "--09-14", phones: [{ value: "5552010143" }], apple: { device: dev.id, id: "C7" } });
    const nora = s.create("person", { name: "Nora Rivera", given_name: "Nora", family_name: "Rivera", phones: [{ value: "555-201-0143" }], apple: { device: dev.id, id: "C8" } });
    const res = await api(t)("POST", "/people/merge", { keep: nora.id, merge: [sister.id] });
    assert.equal(res.status, 200);
    assert.equal(s.get(nora.id)!.fields.birthday, "--09-14");
    assert.equal((s.get(nora.id)!.fields.phones as unknown[]).length, 1);
    assert.equal((await api(t)("POST", "/people/merge", { keep: nora.id, merge: [sister.id] })).status, 404, "a merged person is gone");
  } finally { t.cleanup(); }
});
