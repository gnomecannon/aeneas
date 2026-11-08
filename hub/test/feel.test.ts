import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub } from "./helpers.js";
import { parseKey } from "../src/feel.js";

test("feel: defaults, partial updates, refusals, and following the newest music idea's key", async () => {
  const t = makeHub();
  try {
    const first = await (await t.api("/prefs/feel")).json() as Record<string, any>;
    assert.equal(first.scale, "major_pentatonic");
    assert.equal(first.synth, "sine");
    assert.equal(first.hold, true);
    assert.equal(first.drag_bend, false);
    assert.equal(first.app_theme, "classic");
    assert.deepEqual(first.effective, { key: "C", scale: "major_pentatonic", from: null });
    assert.ok(first.options.synths.includes("pluck"));

    // An older client's single custom color list becomes a named palette.
    const set = await (await t.api("/prefs/feel", { method: "PUT", json: { key: "D", scale: "dorian", synth: "bell", theme: "custom", colors: ["#112233", "#ffaa00"] } })).json() as Record<string, any>;
    assert.equal(set.key, "D");
    assert.equal(set.theme, "custom:mine");
    assert.deepEqual(set.palettes, [{ id: "mine", name: "My colors", colors: ["#112233", "#ffaa00"] }]);
    assert.equal(set.motion, true, "untouched fields keep their value");
    assert.equal((await t.api("/prefs/feel", { method: "PUT", json: { scale: "jazz" } })).status, 422);
    assert.equal((await t.api("/prefs/feel", { method: "PUT", json: { palettes: [{ id: "a", name: "A", colors: ["red"] }] } })).status, 422);
    assert.equal((await t.api("/prefs/feel", { method: "PUT", json: { theme: "custom:nope" } })).status, 422);
    assert.equal((await t.api("/prefs/feel", { method: "PUT", json: { shapes: ["blob"] } })).status, 422);
    // Rename a palette, pick a custom app theme, then delete the palette in use: the choice falls back.
    const renamed = await (await t.api("/prefs/feel", { method: "PUT", json: { palettes: [{ id: "mine", name: "Dusk", colors: ["#112233"] }] } })).json() as Record<string, any>;
    assert.equal(renamed.palettes[0].name, "Dusk");
    const app = await (await t.api("/prefs/feel", { method: "PUT", json: { app_themes: [{ id: "cave", name: "Cave", mode: "dark", accent: "#33CCAA", background: "#101010", surface: "#1A1A1A", text: "#EEEEEE" }], app_theme: "custom:cave" } })).json() as Record<string, any>;
    assert.equal(app.app_theme, "custom:cave");
    assert.ok(app.options.app_themes.some((a: any) => a.id === "midnight"));
    const dropped = await (await t.api("/prefs/feel", { method: "PUT", json: { palettes: [] } })).json() as Record<string, any>;
    assert.equal(dropped.theme, "aurora");

    t.hub.store.create("music_idea", { title: "old riff", type: "riff", status: "idea", tags: [], key: "E minor" });
    await new Promise((r) => setTimeout(r, 5));
    const newest = t.hub.store.create("music_idea", { title: "hummed melody", type: "riff", status: "idea", tags: [], key: "Bb dorian" });
    const follow = await (await t.api("/prefs/feel", { method: "PUT", json: { follow_music: true } })).json() as Record<string, any>;
    assert.equal(follow.key, "D", "the manual key is kept for when following is turned off");
    assert.deepEqual(follow.effective, { key: "A#", scale: "dorian", from: { id: newest.id, title: "hummed melody", key: "Bb dorian" } });
  } finally { t.cleanup(); }
});

test("parseKey reads the ways a key gets written", () => {
  assert.deepEqual(parseKey("A minor"), { key: "A", scale: "minor" });
  assert.deepEqual(parseKey("Am"), { key: "A", scale: "minor" });
  assert.deepEqual(parseKey("F# mixolydian"), { key: "F#", scale: "mixolydian" });
  assert.deepEqual(parseKey("Eb"), { key: "D#", scale: "major" });
  assert.deepEqual(parseKey("C minor pentatonic"), { key: "C", scale: "minor_pentatonic" });
  assert.equal(parseKey("drop D tuning"), null);
  assert.equal(parseKey("120 bpm"), null);
});

test("feel: image shapes upload, serve, refuse the wrong thing, and delete", async () => {
  const t = makeHub();
  try {
    // A 1x1 transparent PNG.
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    const up = await t.api("/prefs/feel/images?name=Leaf", { method: "POST", body: png, headers: { "content-type": "image/png" } });
    assert.equal(up.status, 201);
    const f = await up.json() as Record<string, any>;
    assert.equal(f.images.length, 1);
    assert.equal(f.images[0].name, "Leaf");
    const got = await t.api(`/prefs/feel/images/${f.images[0].id}`);
    assert.equal(got.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), png);
    assert.equal((await t.api("/prefs/feel/images?name=x", { method: "POST", body: Buffer.from("not an image"), headers: { "content-type": "image/png" } })).status, 415);
    assert.equal((await t.api("/prefs/feel/images?name=x", { method: "POST", body: png, headers: { "content-type": "image/jpeg" } })).status, 415);
    const off = await (await t.api("/prefs/feel", { method: "PUT", json: { images: [{ ...f.images[0], name: "Maple", enabled: false }] } })).json() as Record<string, any>;
    assert.deepEqual([off.images[0].name, off.images[0].enabled], ["Maple", false]);
    const gone = await (await t.api(`/prefs/feel/images/${f.images[0].id}`, { method: "DELETE" })).json() as Record<string, any>;
    assert.equal(gone.images.length, 0);
    assert.equal((await t.api(`/prefs/feel/images/${f.images[0].id}`)).status, 404);
  } finally { t.cleanup(); }
});
