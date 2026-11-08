import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { makeHub } from "./helpers.js";

/** A real (tiny, solid) PNG of the given size. */
function png(w: number, h: number): Buffer {
  const crc = (b: Buffer) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type: string, data: Buffer) => { const t = Buffer.from(type, "latin1"); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h, 200);
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

test("layouts: a picture goes up raw, a sketch keeps its moved parts, and the list leaves the pieces out", async () => {
  const t = makeHub();
  try {
    const up = await t.api("/layouts/pictures", { method: "POST", body: png(390, 844), headers: { "content-type": "image/png" } });
    assert.equal(up.status, 201);
    const pic = (await up.json()) as { picture_id: string; width: number; height: number };
    assert.deepEqual([pic.width, pic.height], [390, 844], "the size comes from the picture, not the client");

    const made = await t.api("/layouts", { method: "POST", json: { title: "iPhone Today", platform: "iphone", screen: "Today", picture_id: pic.picture_id } });
    assert.equal(made.status, 201);
    const l = (await made.json()) as { id: string; status: string; width: number; pieces: unknown[] };
    assert.equal(l.status, "draft");
    assert.equal(l.width, 390);

    const pieces = [
      { id: "p1", from: { x: 0, y: 100, w: 390, h: 60 }, to: { x: 0, y: 400, w: 390, h: 60 }, note: "lower" },
      { id: "p2", from: { x: 0, y: 200, w: 100, h: 40 }, to: null },
      { id: "p3", from: null, to: { x: 20, y: 20, w: 120, h: 40 }, label: "Capture button" },
    ];
    const after = (await (await t.api("/layouts/pictures", { method: "POST", body: png(390, 844).subarray(0), headers: { "content-type": "image/png" } })).json()) as { picture_id: string };
    const put = await t.api(`/layouts/${l.id}`, { method: "PUT", json: { pieces, status: "ready", after_id: after.picture_id, note: "Capture first" } });
    assert.equal(put.status, 200);
    const got = (await (await t.api(`/layouts/${l.id}`)).json()) as { pieces: { id: string }[]; status: string; after_id: string; note: string };
    assert.deepEqual(got.pieces.map((p) => p.id), ["p1", "p2", "p3"]);
    assert.equal(got.status, "ready");
    assert.equal(got.note, "Capture first");

    const list = (await (await t.api("/layouts")).json()) as { layouts: { id: string; pieces_count: number; pieces?: unknown }[] };
    assert.equal(list.layouts.length, 1);
    assert.equal(list.layouts[0].pieces_count, 3);
    assert.equal(list.layouts[0].pieces, undefined);

    const img = await t.api(`/layouts/pictures/${pic.picture_id}`);
    assert.equal(img.headers.get("content-type"), "image/png");

    assert.equal((await t.api(`/layouts/${l.id}`, { method: "DELETE" })).status, 200);
    assert.equal((await t.api(`/layouts/${l.id}`)).status, 404);
    assert.equal(((await (await t.api("/layouts")).json()) as { layouts: unknown[] }).layouts.length, 0);
    assert.ok(fs.existsSync(path.join(t.hub.cfg.dataDir, "layouts", `${l.id}.json`)), "a deleted sketch is kept on disk");
  } finally { t.cleanup(); }
});

test("layouts: bad pieces, unknown pictures and other files are refused", async () => {
  const t = makeHub();
  try {
    const pic = (await (await t.api("/layouts/pictures", { method: "POST", body: png(100, 100) })).json()) as { picture_id: string };
    assert.equal((await t.api("/layouts/pictures", { method: "POST", body: Buffer.from("GIF89a" + "x".repeat(40)) })).status, 422);
    assert.equal((await t.api("/layouts", { method: "POST", json: { title: "x", platform: "iphone", picture_id: "0".repeat(32) } })).status, 422);
    assert.equal((await t.api("/layouts", { method: "POST", json: { title: "x", platform: "phone", picture_id: pic.picture_id } })).status, 422);
    const l = (await (await t.api("/layouts", { method: "POST", json: { title: "x", platform: "web", picture_id: pic.picture_id } })).json()) as { id: string };
    const bad = [
      [{ id: "a", from: null, to: null }],
      [{ id: "a", from: { x: 0, y: 0, w: 1, h: 1 }, to: null }, { id: "a", from: { x: 0, y: 0, w: 1, h: 1 }, to: null }],
      [{ id: "a", from: { x: 0, y: 0, w: 0, h: 1 }, to: null }],
      [{ id: "a", from: { x: 0, y: 0, w: 5, h: 5 }, to: null, extra: 1 }],
    ];
    for (const pieces of bad) assert.equal((await t.api(`/layouts/${l.id}`, { method: "PUT", json: { pieces } })).status, 422, JSON.stringify(pieces));
    assert.equal((await t.api("/layouts/../../etc")).status, 404);
    assert.equal((await t.api("/layouts/zzzzzzzzzzzzzzzz")).status, 404);
  } finally { t.cleanup(); }
});

test("layouts: the module switch hides the routes", async () => {
  const t = makeHub({ modulesPreset: "renewals" });
  try {
    const r = await t.api("/layouts");
    assert.equal(r.status, 404);
    assert.match(((await r.json()) as { error: string }).error, /Layout sketches is off/);
  } finally { t.cleanup(); }
});
