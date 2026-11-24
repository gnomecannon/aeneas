import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Endpoint, RelayMode } from "@number0/iroh";
import { deviceKey, makeHub } from "./helpers.js";
import { JOIN_ALPN, joinDevice, joinProof, parseJoinAsk, relayCheck } from "../src/join.js";
import { startLink } from "../src/link.js";

const SECRET = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const N0 = "https://euc1-1.relay.n0.iroh.link./";

test("join: the proof matches the vector the apps test against", () => {
  // The same vector is in the Apple, Windows and Android tests: all of them must agree byte for byte.
  const link = "everythingapp://setup?hid=0123456789ABCDEFGHJKMNPQRS&code=ABCD-EFGH&name=Test%20Mac&link=direct&node=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&relay=https%3A%2F%2Feuc1-1.relay.n0.iroh.link.";
  assert.equal(SECRET.toString("base64url"), "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8");
  assert.equal(joinProof(SECRET, "a".repeat(64), "b".repeat(64), link), "pmOb6wyZdAoeMeQrFEWiughYPHWeACKZ3207YsF76Gs");
});

test("join: the hub reaches only its own relay or n0's, never another host a QR code names", () => {
  assert.equal(relayCheck(N0, [], false), "ok");
  assert.equal(relayCheck("https://use1-1.relay.n0.iroh.link/", [N0], false), "ok", "another of n0's relays");
  assert.equal(relayCheck("https://evil.example.org/", [N0], false), "bad");
  assert.equal(relayCheck("https://relay.n0.iroh.link.evil.org/", [], false), "bad");
  assert.equal(relayCheck("http://euc1-1.relay.n0.iroh.link/", [], false), "bad", "https only");
  assert.equal(relayCheck("https://relay.home.example/", ["https://relay.home.example"], true), "ok", "the hub's own relay");
  assert.equal(relayCheck(N0, ["https://relay.home.example"], true), "not-own", "a hub on its own relays does not use n0's");
});

test("join: a malformed code is refused before anything is reached", () => {
  const good = { node: "b".repeat(64), relay: N0, s: SECRET.toString("base64url"), name: "Robin's MacBook", platform: "mac" };
  const ok = parseJoinAsk(good);
  assert.ok(typeof ok !== "string" && ok.secret.equals(SECRET) && ok.platform === "mac");
  assert.equal(typeof parseJoinAsk({ ...good, node: "b".repeat(63) }), "string");
  assert.equal(typeof parseJoinAsk({ ...good, s: SECRET.subarray(0, 31).toString("base64url") }), "string");
  assert.equal(typeof parseJoinAsk({ ...good, relay: "relay.example" }), "string");
  const unnamed = parseJoinAsk({ ...good, name: "\u0007", platform: "toaster" });
  assert.ok(typeof unnamed !== "string" && unnamed.name === "New device" && unnamed.platform === "");
});

test("join: POST /devices/join says plainly when this hub cannot do it", async () => {
  const t = makeHub();
  try {
    const key = await deviceKey(t);
    const ask = { node: "b".repeat(64), relay: N0, s: SECRET.toString("base64url"), name: "Mac", platform: "mac" };
    const call = (json: unknown) => t.app.request("/devices/join", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(json) });
    const bad = await call({ ...ask, s: "short" });
    assert.equal(bad.status, 422);
    assert.equal(bad.headers.get("cache-control"), "no-store");
    const notDirect = await call(ask);
    assert.equal(notDirect.status, 409);
    assert.match(((await notDirect.json()) as { error: string }).error, /not on Direct link/);
    // Without a key it is refused like every other route.
    assert.equal((await t.app.request("/devices/join", { method: "POST", body: JSON.stringify(ask) })).status, 401);
  } finally { t.cleanup(); }
});

/** A device showing a join code: an endpoint on this machine that checks the proof and answers as the apps do. */
async function joiningDevice(opts: { refuse?: boolean } = {}) {
  const b = Endpoint.builder();
  b.applyMinimal();
  b.relayMode(RelayMode.disabled());
  b.alpns([Array.from(Buffer.from(JOIN_ALPN))]);
  const ep = await b.bind();
  const got: { link: string; from: string; proofOk: boolean }[] = [];
  void (async () => {
    for (;;) {
      const inc = await ep.acceptNext().catch(() => null);
      if (!inc) return;
      const conn = await (await inc.accept()).connect();
      const bi = await conn.acceptBi();
      const msg = JSON.parse(Buffer.from(await bi.recv.readToEnd(8192)).toString()) as { v: number; link: string; proof: string };
      const from = conn.remoteId().toString();
      const proofOk = msg.v === 1 && msg.proof === joinProof(SECRET, from, ep.id().toString(), msg.link);
      got.push({ link: msg.link, from, proofOk });
      await bi.send.writeAll(Array.from(Buffer.from(JSON.stringify(proofOk && !opts.refuse ? { ok: true } : { ok: false, error: "wrong proof" }))));
      await bi.send.finish();
      await conn.closed().catch(() => {});
    }
  })();
  const addrs = ep.boundSockets().filter((a) => a.startsWith("0.0.0.0:") || a.startsWith("127.")).map((a) => a.replace(/^0\.0\.0\.0/, "127.0.0.1"));
  return { ep, got, addrs, node: ep.id().toString() };
}

test("join: the hub hands the device a pairing link it can prove, and the phone hears who joined", async () => {
  const t = makeHub();
  fs.writeFileSync(path.join(t.dir, "link.json"), JSON.stringify({ method: "direct", home_route: false }));
  const stop = await startLink(t.hub.cfg, t.app.fetch, { direct: { noRelay: true } });
  const dev = await joiningDevice();
  try {
    const ask = { node: dev.node, relay: N0, s: SECRET.toString("base64url"), name: "Robin's MacBook", platform: "mac" };
    const pending = joinDevice(t.hub, ask, undefined, "http://hub", { addresses: dev.addrs, claimMs: 10_000 });
    // The device checks the proof, then claims the code in the link over its new Direct link (here: the app itself).
    for (let i = 0; i < 100 && !dev.got.length; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(dev.got.length, 1, "the hub reached the device");
    assert.equal(dev.got[0].proofOk, true, "the proof checks out with the hub's own key");
    const code = new URL(dev.got[0].link).searchParams.get("code")!;
    assert.match(dev.got[0].link, /^everythingapp:\/\/setup\?/);
    const claim = await t.app.request("/devices/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: "Robin's MacBook", platform: "mac" }) });
    assert.equal(claim.status, 200);
    const r = await pending;
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.name, "Robin's MacBook");
    assert.equal(r.body.device_id, ((await claim.json()) as { device_id: string }).device_id);
  } finally {
    await dev.ep.close();
    await stop();
    t.cleanup();
  }
});

test("join: a device that refuses, or never answers, is a plain 502 and its code is spent", async () => {
  const t = makeHub();
  fs.writeFileSync(path.join(t.dir, "link.json"), JSON.stringify({ method: "direct", home_route: false }));
  const stop = await startLink(t.hub.cfg, t.app.fetch, { direct: { noRelay: true } });
  const dev = await joiningDevice({ refuse: true });
  try {
    const before = t.hub.deviceKeys.waiting();
    const refused = await joinDevice(t.hub, { node: dev.node, relay: N0, s: SECRET.toString("base64url"), name: "Mac", platform: "mac" }, undefined, "http://hub", { addresses: dev.addrs });
    assert.equal(refused.status, 502);
    assert.equal(refused.body.error, "Mac did not take the link. Wrong proof. Scan the code on its screen again.");
    assert.equal(t.hub.deviceKeys.waiting(), before, "the code made for it no longer works");
    // A key nobody answers for.
    const silent = await joinDevice(t.hub, { node: "c".repeat(64), relay: N0, s: SECRET.toString("base64url"), name: "Mac", platform: "mac" }, undefined, "http://hub", { addresses: ["127.0.0.1:9"], dialMs: 1500 });
    assert.equal(silent.status, 502);
    assert.match(String(silent.body.error), /Mac did not answer/);
  } finally {
    await dev.ep.close();
    await stop();
    t.cleanup();
  }
});
