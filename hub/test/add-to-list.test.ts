import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub } from "./helpers.js";

test("entries go on a list by its name, the list made the first time, none twice, never on a template", async () => {
  const t = makeHub();
  try {
    const add = async (list: string, items: unknown) => (await t.api("/checklists/add", { method: "POST", json: { list, items } })).json() as Promise<any>;
    const first = await add("to watch", ["Devs (Hulu?)"]);
    assert.equal(first.fields.title, "To watch");
    assert.deepEqual(first.added, ["Devs (Hulu?)"]);
    const again = await add("my To Watch list", ["devs (hulu?)", "Severed Signal"]);
    assert.equal(again.id, first.id, "the same list, found by a loose name");
    assert.deepEqual(again.added, ["Severed Signal"], "an entry already there is not added again");
    assert.deepEqual(t.hub.store.get(first.id)!.fields.items, [{ text: "Devs (Hulu?)" }, { text: "Severed Signal" }]);
    // A template of the same name is left alone: a list of its own is made.
    const tpl = t.hub.store.create("checklist", { title: "Packing", kind: "packing", items: [{ text: "Charger" }], template: true, tags: [] });
    const packed = await add("Packing", [{ text: "Passport", note: "in the blue folder" }]);
    assert.notEqual(packed.id, tpl.id);
    assert.deepEqual(t.hub.store.get(tpl.id)!.fields.items, [{ text: "Charger" }]);
    assert.deepEqual(packed.fields.items, [{ text: "Passport", note: "in the blue folder" }]);
    assert.equal((await t.api("/checklists/add", { method: "POST", json: { list: "To watch", items: [] } })).status, 422);
  } finally { t.cleanup(); }
});
