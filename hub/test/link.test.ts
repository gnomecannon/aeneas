import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Endpoint, EndpointAddr, RelayMode } from "@number0/iroh";
import { deviceKey, makeHub, TOKEN } from "./helpers.js";
import { chooseLink, currentMethod, DirectLink, LINK_ALPN, linkAvailability, relayOwner } from "../src/link.js";
import { pairingLinks } from "../src/setup.js";

const ALPN = Array.from(Buffer.from(LINK_ALPN));

/** One HTTP request over a fresh stream of `conn`, answered in full. */
async function over(conn: import("@number0/iroh").Connection, pathName: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  const bi = await conn.openBi();
  const head = Object.entries({ host: "hub", connection: "close", ...headers }).map(([k, v]) => `${k}: ${v}\r\n`).join("");
  await bi.send.writeAll(Array.from(Buffer.from(`GET ${pathName} HTTP/1.1\r\n${head}\r\n`)));
  const raw = Buffer.from(await bi.recv.readToEnd(1 << 20)).toString();
  const [top, ...rest] = raw.split("\r\n\r\n");
  let body = rest.join("\r\n\r\n");
  if (/transfer-encoding: chunked/i.test(top)) body = body.replace(/(^|\r\n)[0-9a-f]+\r\n/gi, "").replace(/\r\n$/, "");
  return { status: Number(top.split(" ")[1]), body };
}

test("link: Direct link requests reach the hub as a remote device, never as this machine", async () => {
  const t = makeHub();
  const link = new DirectLink(t.hub.cfg, t.app.fetch, undefined, { noRelay: true });
  const cli = await (() => { const b = Endpoint.builder(); b.applyMinimal(); b.relayMode(RelayMode.disabled()); return b.bind(); })();
  try {
    const st = await link.start();
    assert.equal(st.state, "online", st.error);
    // The key is kept, owner-only, next to the other keys: the same hub key after a restart.
    assert.ok(fs.existsSync(t.hub.cfg.linkKeyFile));
    const ep = link.endpoint()!;
    const addrs = ep.boundSockets().filter((a) => a.startsWith("0.0.0.0:") || a.startsWith("127.")).map((a) => a.replace(/^0\.0\.0\.0/, "127.0.0.1"));
    const conn = await cli.connect(new EndpointAddr(ep.id(), null, addrs), ALPN);
    // The main key, which this machine itself may use, is refused over the link.
    const main = await over(conn, "/setup", { authorization: `Bearer ${TOKEN}` });
    assert.equal(main.status, 403, main.body);
    // A paired device's own key works.
    const key = await deviceKey(t);
    const dev = await over(conn, "/setup", { authorization: `Bearer ${key}` });
    assert.equal(dev.status, 200, dev.body);
    assert.ok(JSON.parse(dev.body).owner !== undefined);
    // No key at all is refused.
    assert.equal((await over(conn, "/setup")).status, 401);
    const id = ep.id().toString();
    await link.stop();
    assert.equal(link.status().state, "off");
    const again = await link.start();
    assert.equal(again.id, id, "the hub keeps its key across restarts");
  } finally {
    await cli.close();
    await link.stop();
    t.cleanup();
  }
});

test("link: methods this install cannot offer say how to get them; the choice is kept", async () => {
  const t = makeHub();
  try {
    assert.equal(currentMethod(t.hub.cfg), null, "nothing chosen and nothing set up: no method assumed");
    const a = linkAvailability(t.hub.cfg);
    assert.equal(a.direct.available, true);
    assert.equal(a.tailscale.available, false);
    assert.match(a.tailscale.how!, /installer again/);
    const r = await chooseLink(t.hub.cfg, "tailscale");
    assert.equal(r.ok, false);
    assert.deepEqual(await chooseLink(t.hub.cfg, "carrier pigeon"), { ok: false, status: 422, error: "method is direct, tailscale or home" });
    t.hub.cfg.publicUrl = "https://hub.tail1234.ts.net";
    assert.equal(currentMethod(t.hub.cfg), "tailscale", "a Tailscale install shows as Tailscale");
    assert.equal((await chooseLink(t.hub.cfg, "tailscale")).ok, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(t.hub.cfg.dataDir, "link.json"), "utf8")).method, "tailscale");
    // The route says the same.
    const view = await (await t.api("/setup/link")).json() as { method: string; options: Record<string, { available: boolean }> };
    assert.equal(view.method, "tailscale");
    const bad = await t.api("/setup/link", { method: "PUT", json: { method: "home" } });
    assert.equal(bad.status, 409);
    // Pairing on a Tailscale hub carries no Direct link fields.
    const p = pairingLinks(t.hub, "https://hub.tail1234.ts.net", "iPhone");
    assert.doesNotMatch(p.app, /node=|relay=/);
  } finally { t.cleanup(); }
});

test("link: the relay's owner is said plainly", () => {
  assert.match(relayOwner("https://use1-1.relay.n0.iroh.link./")!, /^n0/);
  assert.equal(relayOwner("https://relay.example.org/"), "relay.example.org");
});

test("link: a stop while the Direct link is still starting wins (a choice changed during start-up)", async () => {
  const t = makeHub();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  // iroh as loaded, held at the import until the stop has come.
  const link = new DirectLink(t.hub.cfg, t.app.fetch, async () => { await gate; return import("@number0/iroh"); }, { noRelay: true });
  try {
    const starting = link.start();
    assert.equal(link.status().state, "starting");
    await link.stop();
    release();
    await starting;
    assert.equal(link.status().state, "off");
    assert.equal(link.endpoint(), null);
  } finally {
    await link.stop();
    t.cleanup();
  }
});

test("link: an answer is all there for a client that reads it late (no reset after a clean finish)", async () => {
  const t = makeHub();
  const link = new DirectLink(t.hub.cfg, t.app.fetch, undefined, { noRelay: true });
  const cli = await (() => { const b = Endpoint.builder(); b.applyMinimal(); b.relayMode(RelayMode.disabled()); return b.bind(); })();
  try {
    await link.start();
    const ep = link.endpoint()!;
    const addrs = ep.boundSockets().filter((a) => a.startsWith("0.0.0.0:") || a.startsWith("127.")).map((a) => a.replace(/^0\.0\.0\.0/, "127.0.0.1"));
    const conn = await cli.connect(new EndpointAddr(ep.id(), null, addrs), ALPN);
    const key = await deviceKey(t);
    const bi = await conn.openBi();
    // HTTP/1.0 and the request side finished at once, as the apps send it.
    await bi.send.writeAll(Array.from(Buffer.from(`GET /setup HTTP/1.0\r\nhost: hub\r\nauthorization: Bearer ${key}\r\n\r\n`)));
    await bi.send.finish();
    await new Promise((r) => setTimeout(r, 300));
    const raw = Buffer.from(await bi.recv.readToEnd(1 << 20)).toString();
    assert.match(raw, /^HTTP\/1\.1 200/);
    assert.ok(JSON.parse(raw.split("\r\n\r\n")[1]).owner !== undefined);
  } finally {
    await cli.close();
    await link.stop();
    t.cleanup();
  }
});
