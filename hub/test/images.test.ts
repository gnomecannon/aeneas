import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { makeHub } from "./helpers.js";
import { scripted } from "./ai-helpers.js";
import { setBackendOverride } from "../src/ai/backends.js";
import { collectGenerated } from "../src/gallery.js";
import { imageWorkers } from "../src/config.js";
import { availableTools } from "../src/ai/tools.js";

test("images: the workers one may pick by hand come from EA_IMAGE_WORKERS, with none by default", async () => {
  assert.deepEqual(imageWorkers(undefined), []);
  assert.deepEqual(imageWorkers(" gpu-a=Big GPU , gpu-b=Desktop GPU,gpu-c,gpu-a=again,"), [{ id: "gpu-a", label: "Big GPU" }, { id: "gpu-b", label: "Desktop GPU" }, { id: "gpu-c", label: "gpu-c" }]);
  const hardware = (cfg: any) => (availableTools(cfg).find((x) => x.name === "generate_image")!.parameters.properties.hardware as { enum: string[] }).enum;
  const plain = makeHub({ imageServiceUrl: "http://gateway.test", imageServiceToken: "proj-token" });
  const set = makeHub({ imageServiceUrl: "http://gateway.test", imageServiceToken: "proj-token", imageWorkers: imageWorkers("gpu-a=Big GPU,gpu-b=Desktop GPU") });
  try {
    plain.hub.fetch = fakeGateway().f as any;
    set.hub.fetch = fakeGateway().f as any;
    assert.deepEqual(((await (await plain.api("/images/capabilities")).json()) as any).hardware, []);
    assert.deepEqual(hardware(plain.hub.cfg), ["auto"], "only Auto when none is set");
    assert.deepEqual(((await (await set.api("/images/capabilities")).json()) as any).hardware, [{ id: "gpu-a", label: "Big GPU" }, { id: "gpu-b", label: "Desktop GPU" }]);
    assert.deepEqual(hardware(set.hub.cfg), ["auto", "gpu-a", "gpu-b"]);
  } finally { plain.cleanup(); set.cleanup(); }
});

function png(w: number, h: number): Buffer {
  const crc = (b: Buffer) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** A stand-in for the shared gateway: one job that is queued once, then done. */
function fakeGateway() {
  const seen: { method: string; path: string; auth: string | null; body: any }[] = [];
  let polls = 0;
  const job = (status: string) => ({ id: "a".repeat(32), status, status_label: status === "queued" ? "Waiting: protecting gameplay" : "Done", reason: null, progress: null, error: null,
    result_asset: status === "succeeded" ? "b".repeat(32) : null, measured: status === "succeeded" ? { total_seconds: 9.5, worker: "gpu-b" } : null,
    plan: { workflow: "flux2-klein-4b-diffusers", output: { width: 1024, height: 1024 }, notes: [], routing_reason: "generate → FLUX.2 Klein 4B" } });
  const f = async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    const body = init.body && typeof init.body === "string" ? JSON.parse(init.body) : init.body ? "<bytes>" : undefined;
    seen.push({ method: init.method ?? "GET", path: url.pathname, auth: init.headers?.authorization ?? null, body });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/v1/capabilities") return json({ api_version: "1.0", workflows: {} });
    if (url.pathname === "/v1/assets" && init.method === "POST") return json({ id: "c".repeat(32) }, 201);
    if (url.pathname === "/v1/jobs" && init.method === "POST") {
      if (body.seamless === "xy") return json({ error: "plan_rejected", message: "the request cannot run as asked", detail: [{ field: "seamless", code: "unsupported" }] }, 422);
      return json({ jobs: [job("queued")] }, 201);
    }
    if (url.pathname === `/v1/jobs/${"a".repeat(32)}`) return json(job(++polls > 1 ? "succeeded" : "queued"));
    if (url.pathname === "/v1/jobs" && (init.method ?? "GET") === "GET") return json({ jobs: [job(polls > 1 ? "succeeded" : "queued")] });
    if (url.pathname === `/v1/assets/${"b".repeat(32)}`) return new Response(png(8, 8), { status: 200, headers: { "content-type": "image/png" } });
    return json({ error: "not_found" }, 404);
  };
  return { f, seen };
}

test("images: off without the service, and the hub keeps the project token to itself", async () => {
  const t = makeHub();
  try {
    assert.deepEqual(await (await t.api("/images/capabilities")).json(), { enabled: false });
    assert.equal((await t.api("/images/jobs", { method: "POST", json: { prompt: "x" } })).status, 503);
  } finally { t.cleanup(); }
});

test("images: jobs go through the shared service, refusals come back as they are, results land in the hub's image store", async () => {
  const t = makeHub({ imageServiceUrl: "http://gateway.test", imageServiceToken: "proj-token" });
  const g = fakeGateway();
  t.hub.fetch = g.f as any;
  try {
    const caps = await (await t.api("/images/capabilities")).json() as any;
    assert.equal(caps.enabled, true);
    const refused = await t.api("/images/jobs", { method: "POST", json: { prompt: "rock texture", seamless: "xy" } });
    assert.equal(refused.status, 422);
    assert.equal(((await refused.json()) as any).detail[0].field, "seamless");
    const made = await (await t.api("/images/jobs", { method: "POST", json: { prompt: "a cliff" } })).json() as any;
    assert.equal(made.jobs[0].status, "queued");
    await t.api(`/images/jobs/${"a".repeat(32)}`);
    const done = await (await t.api(`/images/jobs/${"a".repeat(32)}`)).json() as any;
    assert.equal(done.status, "succeeded");
    const img = await t.api(`/ai/images/${done.image_id}`);
    assert.equal(img.status, 200);
    assert.ok(g.seen.every((s) => s.auth === "Bearer proj-token"));
  } finally { t.cleanup(); }
});

test("images: the assistant's generate_image waits for the image and shows it under its reply", async () => {
  const t = makeHub({ imageServiceUrl: "http://gateway.test", imageServiceToken: "proj-token" });
  const g = fakeGateway();
  t.hub.fetch = g.f as any;
  const b = scripted([
    () => ({ calls: [{ name: "generate_image", arguments: { prompt: "a cliff over the sea, no vegetation", aspect: "4:3" } }] }),
    () => ({ text: "Here it is." }),
  ]);
  setBackendOverride(b);
  try {
    const out = await (await t.api("/ai/chat", { method: "POST", json: { session_id: "img-1", message: "Make me a cliff over the sea with no vegetation, 4:3" } })).json() as any;
    assert.equal(out.reply, "Here it is.");
    assert.equal(out.reply_images?.length, 1);
    const sent = g.seen.find((s) => s.path === "/v1/jobs" && s.method === "POST")!.body;
    assert.deepEqual(sent, { prompt: "a cliff over the sea, no vegetation", operation: "generate", aspect: "4:3" }, "only what was asked is sent");
    const s = await (await t.api("/ai/sessions/img-1")).json() as any;
    assert.deepEqual(s.messages.at(-1).images, out.reply_images);
  } finally { setBackendOverride(null); t.cleanup(); }
});

test("gallery: generated images are collected once, deleted ones stay deleted, attachments and uploads land in Saved", async () => {
  const t = makeHub({ imageServiceUrl: "http://gateway.test", imageServiceToken: "proj-token" });
  const g = fakeGateway();
  t.hub.fetch = g.f as any;
  const images = () => t.hub.store.list({ kind: "image", limit: 100 });
  try {
    assert.equal(await collectGenerated(t.hub), 0, "nothing finished yet");
    await t.api(`/images/jobs/${"a".repeat(32)}`);
    const done = await (await t.api(`/images/jobs/${"a".repeat(32)}`)).json() as any;
    assert.ok(done.gallery_id);
    assert.equal(await collectGenerated(t.hub), 0, "already in the gallery");
    const gen = images().filter((e) => e.fields.source === "generated");
    assert.equal(gen.length, 1);
    assert.equal(gen[0].fields.job_id, "a".repeat(32));
    assert.deepEqual([gen[0].fields.width, gen[0].fields.height], [8, 8]);
    await t.api(`/entities/${gen[0].id}`, { method: "DELETE" });
    assert.equal(await collectGenerated(t.hub), 0, "a deleted image is not brought back");
    assert.equal(images().filter((e) => e.fields.source === "generated").length, 0);

    const big = Buffer.concat([png(64, 48), Buffer.alloc(3 * 1024 * 1024)]);
    const up = await t.api("/images/library?source=photos&name=Beach", { method: "POST", body: big, headers: { "content-type": "image/png" } } as any);
    assert.equal(up.status, 201, "3 MB passes the upload limit");
    const rec = await up.json() as any;
    assert.deepEqual([rec.fields.source, rec.fields.title, rec.fields.width, rec.fields.height], ["photos", "Beach", 64, 48]);
    assert.equal((await t.api(`/ai/images/${rec.fields.image_id}`)).status, 200);
    assert.equal((await t.api("/images/library", { method: "POST", body: Buffer.from("not an image at all, sorry"), headers: { "content-type": "image/png" } } as any)).status, 422);
  } finally { t.cleanup(); }
});

test("gallery: a picture attached in a chat goes to Saved", async () => {
  const t = makeHub();
  setBackendOverride(scripted([() => ({ text: "Nice." })]));
  try {
    await t.api("/ai/chat", { method: "POST", json: { session_id: "att-1", message: "Look at this", images: [png(10, 10).toString("base64")] } });
    const saved = t.hub.store.list({ kind: "image" });
    assert.equal(saved.length, 1);
    assert.deepEqual([saved[0].fields.source, saved[0].fields.session_id, saved[0].fields.title], ["attached", "att-1", "Look at this"]);
  } finally { setBackendOverride(null); t.cleanup(); }
});

test("phone photos: the assistant asks the streaming iPhone, the model sees the photos, and they show under the reply", async () => {
  const t = makeHub();
  const b = scripted([
    () => ({ calls: [{ name: "phone_photos", arguments: { count: 2 } }] }),
    () => ({ text: "Two photos: a red square and a blue square." }),
  ]);
  setBackendOverride(b);
  try {
    const res = await t.api("/ai/chat/stream", { method: "POST", json: { session_id: "ph-1", message: "Describe a few pictures in my photo library", device: { photos: true } } });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let done: any = null;
    while (!done) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (ev === "photos_request") {
          const req = JSON.parse(data!);
          assert.equal(req.count, 2);
          const ok = await t.api(`/ai/photos/${req.id}`, { method: "POST", json: { photos: [{ b64: png(4, 4).toString("base64"), taken_at: "2026-10-30T12:00:00Z" }, { b64: png(6, 6).toString("base64") }] } });
          assert.equal(ok.status, 200);
        }
        if (ev === "done") done = JSON.parse(data!);
      }
    }
    assert.equal(done.reply, "Two photos: a red square and a blue square.");
    assert.equal(done.reply_images.length, 2);
    const shown = b.seen.at(-1)!.find((m) => m.role === "user" && (m as any).images?.length);
    assert.equal((shown as any).images.length, 2, "the model got the photos to look at");
    assert.match(shown!.content, /2026-10-30T12:00:00Z/);
    assert.equal((await t.api("/ai/photos/nobody-waiting", { method: "POST", json: { photos: [] } })).status, 410);
  } finally { setBackendOverride(null); t.cleanup(); }
});

test("phone photos: without photo access the tool says how to turn it on", async () => {
  const t = makeHub();
  const b = scripted([() => ({ calls: [{ name: "phone_photos", arguments: {} }] }), () => ({ text: "Turn on access." })]);
  setBackendOverride(b);
  try {
    await t.api("/ai/chat", { method: "POST", json: { session_id: "ph-2", message: "What is in my camera roll?" } });
    const toolMsg = b.seen.at(-1)!.find((m) => m.role === "tool");
    assert.match(toolMsg!.content, /Full photo library access/);
  } finally { setBackendOverride(null); t.cleanup(); }
});
