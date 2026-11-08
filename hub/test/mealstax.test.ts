import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub } from "./helpers.js";
import { MEALS_TAX, loadShapes, mealsTax, stateAt, type StateShapes } from "../src/mealstax.js";
import { StoreError } from "../src/store.js";

// Two made-up square states and one with a hole, so the test does not depend on the real outlines.
const SHAPES: StateShapes = {
  MA: [[[[-72, 42], [-70, 42], [-70, 43], [-72, 43], [-72, 42]]]],
  NH: [[[[-72, 43], [-70, 43], [-70, 45], [-72, 45], [-72, 43]]]],
  VT: [[[[-75, 43], [-73, 43], [-73, 45], [-75, 45], [-75, 43]], [[-74.5, 43.5], [-73.5, 43.5], [-73.5, 44.5], [-74.5, 44.5], [-74.5, 43.5]]]],
};

test("meals tax: the state comes from the outline the position is in, holes are outside", () => {
  assert.equal(stateAt(42.5, -71, SHAPES), "MA");
  assert.equal(stateAt(44, -71, SHAPES), "NH");
  assert.equal(stateAt(43.2, -74.8, SHAPES), "VT");
  assert.equal(stateAt(44, -74, SHAPES), null, "inside the hole");
  assert.equal(stateAt(10, 10, SHAPES), null);
});

test("meals tax: the answer is the state's meals rate, with a note that local tax can add to it", () => {
  assert.deepEqual(mealsTax({ lat: 42.5, lon: -71 }, SHAPES), { state: "MA", name: "Massachusetts", pct: 6.25, note: "Massachusetts's rate on restaurant meals. Your city or county may add its own." });
  assert.equal(mealsTax({ lat: 44, lon: -71 }, SHAPES).pct, 8.5, "New Hampshire taxes meals though it has no sales tax");
  const status = (f: () => unknown) => { try { f(); return 200; } catch (e) { return (e as StoreError).status; } };
  assert.equal(status(() => mealsTax({ lat: 10, lon: 10 }, SHAPES)), 404);
  assert.equal(status(() => mealsTax({ lat: "42", lon: -71 }, SHAPES)), 422);
  assert.equal(status(() => mealsTax({ lat: 42.5, lon: -71 }, null)), 503);
});

test("meals tax: every state and DC has a rate between 0 and 10 percent", () => {
  assert.equal(Object.keys(MEALS_TAX).length, 51);
  for (const [code, r] of Object.entries(MEALS_TAX)) assert.ok(r.pct >= 0 && r.pct <= 10 && r.name, code);
});

test("meals tax: with the real outlines, places near state lines land in the right state", { skip: !loadShapes() && "the outlines are not in this copy" }, () => {
  const shapes = loadShapes()!;
  assert.deepEqual(Object.keys(shapes).sort(), Object.keys(MEALS_TAX).sort(), "an outline for every state and DC");
  const places: [string, number, number][] = [
    ["MA", 42.36, -71.06], ["NH", 43.21, -71.54], ["VT", 44.48, -73.21], ["ME", 43.66, -70.26], ["RI", 41.82, -71.41],
    ["CT", 41.77, -72.67], ["NY", 40.71, -74.01], ["NJ", 40.73, -74.17], ["DC", 38.9, -77.04], ["VA", 38.88, -77.1],
    ["CA", 34.05, -118.24], ["WA", 47.61, -122.33], ["OR", 45.52, -122.68], ["TX", 29.76, -95.37], ["FL", 25.76, -80.19],
    ["IL", 41.88, -87.63], ["CO", 39.74, -104.99], ["HI", 21.31, -157.86], ["AK", 61.22, -149.9], ["MO", 38.63, -90.2],
    // Cities that sit on a state line, a few kilometres from the other side.
    ["MO", 39.1, -94.58], ["KS", 39.11, -94.63], ["TX", 33.43, -94.06], ["AR", 33.44, -94.03], ["IL", 38.62, -90.15],
    ["NY", 42.1, -79.24], ["PA", 41.99, -80.08], ["OR", 45.57, -122.67], ["WA", 45.64, -122.66],
  ];
  for (const [code, lat, lon] of places) assert.equal(stateAt(lat, lon, shapes), code, `${lat}, ${lon}`);
});

test("meals tax: POST /calc/meals-tax answers, and the calculators module asks for location", async () => {
  const t = makeHub();
  try {
    const r = await t.api("/calc/meals-tax", { method: "POST", json: { lat: "x", lon: 1 } });
    assert.equal(r.status, 422);
    const mods = await (await t.api("/modules")).json() as { modules: { id: string; permissions?: string[] }[] } | { id: string; permissions?: string[] }[];
    const list = Array.isArray(mods) ? mods : mods.modules;
    assert.deepEqual(list.find((m) => m.id === "calc")?.permissions, ["location"]);
  } finally { t.cleanup(); }
});
