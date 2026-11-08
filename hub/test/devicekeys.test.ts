import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeHub, TOKEN } from "./helpers.js";
import { CODE_TTL_MS, DeviceKeys, normalizeCode } from "../src/devicekeys.js";
import { ModuleStore, MODULES } from "../src/modules.js";

const claim = (t: ReturnType<typeof makeHub>, body: Record<string, unknown>) =>
  t.app.request("/devices/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const asDevice = (t: ReturnType<typeof makeHub>, key: string, p: string, init: RequestInit = {}) =>
  t.app.request(p, { ...init, headers: { authorization: `Bearer ${key}`, ...((init.headers as Record<string, string>) ?? {}) } });

async function pair(t: ReturnType<typeof makeHub>, name = "iPhone", platform = "iphone") {
  const links = (await (await t.api("/devices/pairing", { method: "POST", json: { name } })).json()) as { code: string; app: string; web: string; hub: string };
  const r = await claim(t, { code: links.code, name, platform });
  assert.equal(r.status, 200);
  return { links, ...((await r.json()) as { device_id: string; key: string; name: string }) };
}

test("codes: used once, gone after 10 minutes, typed loosely", () => {
  const k = new DeviceKeys(null);
  const now = Date.now();
  const a = k.newCode("iPhone", now);
  assert.match(a.code, /^[0-9A-HJKMNP-TV-Z]{8}$/);
  const typed = `${a.code.slice(0, 4).toLowerCase()} - ${a.code.slice(4)}`;
  assert.deepEqual(k.claim(typed, now + 1000), { name: "iPhone" });
  assert.equal(k.claim(a.code, now + 2000), null, "a code works once");
  const b = k.newCode("Mac", now);
  assert.equal(k.claim(b.code, now + CODE_TTL_MS + 1), null, "expired");
  assert.equal(normalizeCode("ab0O-iL12"), "AB001112", "O reads as 0, I and L as 1");
  for (let i = 0; i < 8; i++) k.newCode(`d${i}`, now);
  assert.equal(k.waiting(now), 5, "at most five codes wait at once");
});

test("pairing: the links carry a code, never the hub's main key; the code buys one device key", async () => {
  const t = makeHub();
  try {
    const p = await pair(t);
    assert.ok(!p.links.app.includes(TOKEN) && !p.links.web.includes(TOKEN));
    assert.match(p.links.app, /^everythingapp:\/\/setup\?hub=.+&code=[0-9A-Z]{8}&name=iPhone$/);
    assert.match(p.key, /^ead1_[A-Za-z0-9_-]{43}$/);
    // The key works, and the hub knows which device is calling.
    const list = (await (await asDevice(t, p.key, "/devices")).json()) as { devices: { id: string; current: boolean; own_key: boolean }[] };
    const me = list.devices.find((d) => d.id === p.device_id)!;
    assert.equal(me.current, true);
    assert.equal(me.own_key, true);
    // The same code again, or a made-up one, is refused.
    const again = await claim(t, { code: p.links.app.match(/code=([0-9A-Z]+)/)![1], name: "Other", platform: "mac" });
    assert.equal(again.status, 401);
    assert.equal((await claim(t, { code: "ZZZZZZZZ", name: "x", platform: "mac" })).status, 401);
    // Only the key's hash is stored, in its own file outside the database.
    const file = fs.readFileSync(path.join(t.dir, "device-keys.json"), "utf8");
    assert.ok(!file.includes(p.key.slice(5, 20)));
    const rows = Object.values((JSON.parse(file) as { keys: Record<string, { hash: string }> }).keys);
    assert.equal(rows.length, 1);
    assert.match(rows[0].hash, /^[0-9a-f]{64}$/);
    assert.equal(fs.statSync(path.join(t.dir, "device-keys.json")).mode & 0o777, 0o600);
    // GET /setup/pair (older clients) also hands out a code.
    const old = (await (await t.api("/setup/pair?name=iPad")).json()) as { app: string };
    assert.ok(old.app.includes("code=") && !old.app.includes("token="));
  } finally { t.cleanup(); }
});

test("a device key registers only its own device and cannot trade itself for another key", async () => {
  const t = makeHub();
  try {
    const a = await pair(t, "iPhone", "iphone");
    const b = await pair(t, "Mac", "mac");
    const r = await asDevice(t, a.key, "/devices/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Renamed", platform: "iphone", device_id: b.device_id }) });
    assert.equal(((await r.json()) as { device_id: string }).device_id, a.device_id);
    assert.equal(t.hub.store.get(b.device_id)!.fields.name, "Mac", "the other device is untouched");
    const ex = await asDevice(t, a.key, "/devices/exchange", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "x", platform: "iphone" }) });
    assert.equal(ex.status, 409);
  } finally { t.cleanup(); }
});

test("a pairing code never takes over a device that still has a key", async () => {
  const t = makeHub();
  try {
    const a = await pair(t, "iPhone", "iphone");
    const links = (await (await t.api("/devices/pairing", { method: "POST", json: { name: "Intruder" } })).json()) as { code: string };
    const r = (await (await claim(t, { code: links.code, name: "Intruder", platform: "mac", device_id: a.device_id })).json()) as { device_id: string };
    assert.notEqual(r.device_id, a.device_id);
    assert.equal((await asDevice(t, a.key, "/status")).status, 200, "the iPhone is still signed in");
    // Removed, then paired again with its old id: it keeps the id.
    await t.api(`/devices/${a.device_id}`, { method: "DELETE" });
    const again = (await (await t.api("/devices/pairing", { method: "POST", json: { name: "iPhone" } })).json()) as { code: string };
    const back = (await (await claim(t, { code: again.code, name: "iPhone", platform: "iphone", device_id: a.device_id })).json()) as { device_id: string };
    assert.equal(back.device_id, a.device_id);
  } finally { t.cleanup(); }
});

test("a device paired with the main key trades it for its own", async () => {
  const t = makeHub();
  try {
    const r = await t.api("/devices/exchange", { method: "POST", json: { name: "Old iPhone", platform: "iphone", device_id: "11111111-2222-3333-4444-555555555555" } });
    assert.equal(r.status, 200);
    const j = (await r.json()) as { device_id: string; key: string };
    assert.equal(j.device_id, "11111111-2222-3333-4444-555555555555", "it keeps its id, so its sync position is kept");
    assert.equal((await asDevice(t, j.key, "/status")).status, 200);
  } finally { t.cleanup(); }
});

test("removing a device ends its key at once, from Settings or by deleting its entity", async () => {
  const t = makeHub();
  try {
    const a = await pair(t, "iPhone", "iphone");
    const b = await pair(t, "iPad", "ipad");
    assert.equal((await t.api(`/devices/${a.device_id}`, { method: "DELETE" })).status, 200);
    const gone = await asDevice(t, a.key, "/status");
    assert.equal(gone.status, 401);
    assert.equal(((await gone.json()) as { device_removed?: boolean }).device_removed, true);
    assert.equal((await asDevice(t, b.key, "/status")).status, 200, "the other device keeps working");
    // Deleting the device entity (sync, the generic route) does the same.
    assert.equal((await t.api(`/entities/${b.device_id}`, { method: "DELETE" })).status, 200);
    assert.equal((await asDevice(t, b.key, "/status")).status, 401);
    assert.equal(t.hub.deviceKeys.pairedAt().size, 0);
    // Pairing again works, with a new key.
    const c = await pair(t, "iPad", "ipad");
    assert.notEqual(c.key, b.key);
    assert.equal((await asDevice(t, c.key, "/status")).status, 200);
  } finally { t.cleanup(); }
});

test("a device key works as ?token= for EventSource and feeds, and a wrong key is refused", async () => {
  const t = makeHub();
  try {
    const a = await pair(t);
    assert.equal((await t.app.request(`/status?token=${encodeURIComponent(a.key)}`)).status, 200);
    assert.equal((await t.app.request("/status?token=ead1_nope")).status, 401);
    assert.equal((await t.app.request("/status")).status, 401);
  } finally { t.cleanup(); }
});

test("modules: personal-data modules list what they read and ask for; an older hub keeps features it always had", () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "ea-mod-"));
  try {
    const file = path.join(dir, "modules.json");
    // A modules.json from before voice, alerts, Apple Reminders, Calendar, Contacts and mail were modules.
    fs.writeFileSync(file, JSON.stringify({ renewals: true, health: false }));
    const m = new ModuleStore(file, { preset: "", existing: () => true });
    for (const id of ["voice", "notifications", "apple_reminders", "apple_calendar", "contacts", "mail"] as const) assert.equal(m.on(id), true, id);
    assert.equal(m.on("health"), false);
    assert.equal(m.on("games"), false, "a module that was never core keeps its default");
    const voice = m.list().find((x) => x.id === "voice")!;
    assert.deepEqual(voice.permissions, ["microphone", "speech"]);
    assert.ok(voice.reads);
    assert.equal(m.list().find((x) => x.id === "games")!.setup?.minutes, "2");
    // A brand-new hub writes every module, so nothing counts as missing there.
    const fresh = new ModuleStore(path.join(dir, "new.json"), { preset: "", existing: () => false });
    assert.equal(fresh.on("contacts"), MODULES.find((x) => x.id === "contacts")!.default);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a hub serving its own certificate puts its fingerprint in pairing links, and only over https", async () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "tls");
  const t = makeHub({ tlsCert: path.join(dir, "hub-test.crt"), tlsKey: path.join(dir, "hub-test.key") });
  try {
    const { createHash, X509Certificate } = await import("node:crypto");
    const want = createHash("sha256").update(new X509Certificate(fs.readFileSync(path.join(dir, "hub-test.crt"))).raw).digest("hex");
    t.hub.cfg.publicUrl = "https://192.168.1.20:8787";
    const l = (await (await t.api("/devices/pairing", { method: "POST", json: { name: "iPhone" } })).json()) as { fp: string; app: string };
    assert.equal(l.fp, want);
    assert.equal(new URL(l.app).searchParams.get("fp"), want);
    t.hub.cfg.publicUrl = "http://127.0.0.1:8787";
    const plain = (await (await t.api("/devices/pairing", { method: "POST", json: {} })).json()) as { fp: string | null; app: string };
    assert.equal(plain.fp, null);
    assert.ok(!plain.app.includes("fp="));
  } finally { t.cleanup(); }
});

test("a key the hub does not know is refused without telling the device to forget it; a removed one is told", async () => {
  const t = makeHub();
  try {
    const a = await pair(t);
    const b = await pair(t, "Mac", "mac");
    await t.api(`/devices/${b.device_id}`, { method: "DELETE" });
    // The keys file is lost (or the hub restored without it): a known device's key is unknown, not removed.
    fs.rmSync(path.join(t.dir, "device-keys.json"));
    (t.hub as { deviceKeys: DeviceKeys }).deviceKeys = new DeviceKeys(path.join(t.dir, "device-keys.json"));
    const r = (await (await asDevice(t, a.key, "/status")).json()) as { device_removed?: boolean; unknown_key?: boolean };
    assert.deepEqual([r.device_removed, r.unknown_key], [undefined, true]);
  } finally { t.cleanup(); }
});

test("a database restored from an older copy keeps every device paired", async () => {
  const t = makeHub();
  try {
    const a = await pair(t);
    // Keys are not in hub.sqlite, so rolling the database back (a Litestream point in time) cannot touch them.
    assert.equal((t.hub.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'device_keys'").get() as { n: number }).n, 0);
    assert.equal((await asDevice(t, a.key, "/status")).status, 200);
  } finally { t.cleanup(); }
});

test("a keys file that cannot be read is never written over, and pairing says why", async () => {
  const t = makeHub();
  try {
    const file = path.join(t.dir, "device-keys.json");
    fs.writeFileSync(file, "{ not json");
    (t.hub as { deviceKeys: DeviceKeys }).deviceKeys = new DeviceKeys(file);
    const links = await t.api("/devices/pairing", { method: "POST", json: { name: "iPhone" } });
    const code = ((await links.json()) as { code: string }).code;
    const r = await claim(t, { code, name: "iPhone", platform: "iphone" });
    assert.equal(r.status, 500);
    assert.match(((await r.json()) as { error: string }).error, /device keys file cannot be read/);
    assert.equal(fs.readFileSync(file, "utf8"), "{ not json", "the owner's file is left as it was");
    // With a good copy from before the last write, that copy is used.
    fs.writeFileSync(`${file}.bak`, JSON.stringify({ v: 1, keys: {}, revoked: {} }));
    (t.hub as { deviceKeys: DeviceKeys }).deviceKeys = new DeviceKeys(file);
    const again = ((await (await t.api("/devices/pairing", { method: "POST", json: { name: "iPhone" } })).json()) as { code: string }).code;
    assert.equal((await claim(t, { code: again, name: "iPhone", platform: "iphone" })).status, 200);
  } finally { t.cleanup(); }
});

test("a Watch's key, held by its iPhone, goes when the iPhone is removed", async () => {
  const t = makeHub();
  try {
    const phone = await pair(t, "iPhone", "iphone");
    const links = (await (await asDevice(t, phone.key, "/devices/pairing", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "iPhone Watch" }) })).json()) as { code: string };
    const watch = (await (await claim(t, { code: links.code, name: "iPhone Watch", platform: "watch" })).json()) as { device_id: string; key: string };
    assert.equal(t.hub.deviceKeys.parentOf(watch.device_id), phone.device_id);
    // An iPad paired from the iPhone is its own device and stays.
    const ipadLinks = (await (await asDevice(t, phone.key, "/devices/pairing", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "iPad" }) })).json()) as { code: string };
    const ipad = (await (await claim(t, { code: ipadLinks.code, name: "iPad", platform: "ipad" })).json()) as { device_id: string; key: string };
    const del = (await (await t.api(`/devices/${phone.device_id}`, { method: "DELETE" })).json()) as { also: string[] };
    assert.deepEqual(del.also, [watch.device_id]);
    for (const k of [phone.key, watch.key]) {
      const r = (await (await asDevice(t, k, "/status")).json()) as { device_removed?: boolean };
      assert.equal(r.device_removed, true);
    }
    assert.ok(t.hub.store.get(watch.device_id)?.deleted_at, "the Watch leaves the device list too");
    assert.equal((await asDevice(t, ipad.key, "/status")).status, 200);
  } finally { t.cleanup(); }
});

test("removing a device ends its open live stream at once", async () => {
  const t = makeHub();
  try {
    const a = await pair(t);
    const res = await asDevice(t, a.key, "/live");
    assert.equal(res.status, 200);
    const reader = res.body!.getReader();
    await reader.read(); // the first ping
    const ended = (async () => { for (;;) { const r = await reader.read(); if (r.done) return true; } })();
    await t.api(`/devices/${a.device_id}`, { method: "DELETE" });
    const done = await Promise.race([ended, new Promise((r) => setTimeout(() => r(false), 3000))]);
    assert.equal(done, true);
  } finally { t.cleanup(); }
});

test("a Watch traded with the main key names its iPhone, and goes with it", async () => {
  const t = makeHub();
  try {
    const phone = (await (await t.api("/devices/exchange", { method: "POST", json: { name: "iPhone", platform: "iphone", device_id: "11111111-2222-3333-4444-555555555555" } })).json()) as { device_id: string; key: string };
    const watch = (await (await t.api("/devices/exchange", { method: "POST", json: { name: "iPhone Watch", platform: "watch", device_id: "66666666-2222-3333-4444-555555555555", parent_id: phone.device_id } })).json()) as { device_id: string; key: string };
    assert.equal(t.hub.deviceKeys.parentOf(watch.device_id), phone.device_id);
    await t.api(`/devices/${phone.device_id}`, { method: "DELETE" });
    assert.equal((await asDevice(t, watch.key, "/status")).status, 401);
  } finally { t.cleanup(); }
});
