import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tlsModule from "node:tls";
import { fileURLToPath } from "node:url";
import { SecretKey } from "@number0/iroh";
import { deviceKey, fileMode, makeHub, TOKEN, type TestHub } from "./helpers.js";
import { relayInTestHands } from "./iroh-fake.js";
import { crockford32, homeAddresses, homeCertFiles, homeCertificate, HomeCertError, homeConnectionAllowed, HomeListener, hubId, hubIdFile, lan, portOfAnotherHub, selfSignedCertificate } from "../src/homeroute.js";
import { changeLink, directKeyOf, mainPortGuard, readLinkFile, startLink, wantedAnnouncement } from "../src/link.js";
import { dualServer, guardedServer, isLoopback, isPrivateV4, loadTls } from "../src/tls.js";

// Nothing here announces on the network (Bonjour stays off in this test process).
process.env.EA_NO_ANNOUNCE = "1";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "tls");
const FIX_CERT = path.join(FIX, "hub-test.crt");
const FIX_KEY = path.join(FIX, "hub-test.key");

/** Made-up adapters: a home network, a Tailscale address and loopback. */
const FAKE_LAN = {
  wayOut: async () => "192.168.1.20",
  interfaces: () => ({
    lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: true, cidr: "127.0.0.1/8" }],
    eth0: [
      { address: "192.168.1.20", netmask: "255.255.255.0", family: "IPv4", mac: "02:00:00:00:00:01", internal: false, cidr: "192.168.1.20/24" },
      { address: "10.4.5.1", netmask: "255.255.255.0", family: "IPv4", mac: "02:00:00:00:00:01", internal: false, cidr: "10.4.5.1/24" },
      { address: "fe80::1", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: "02:00:00:00:00:01", internal: false, cidr: "fe80::1/64", scopeid: 2 },
    ],
    tailscale0: [{ address: "100.90.0.5", netmask: "255.255.255.255", family: "IPv4", mac: "00:00:00:00:00:00", internal: false, cidr: "100.90.0.5/32" }],
    docker0: [{ address: "172.17.0.1", netmask: "255.255.0.0", family: "IPv4", mac: "02:00:00:00:00:02", internal: false, cidr: "172.17.0.1/16" }],
  }) as NodeJS.Dict<os.NetworkInterfaceInfo[]>,
  hostName: () => "desk-pc.example",
};

async function withLan<T>(fake: Partial<typeof lan>, f: () => Promise<T> | T): Promise<T> {
  const orig = { ...lan };
  Object.assign(lan, fake);
  try { return await f(); } finally { Object.assign(lan, orig); }
}

/** A port nothing listens on now. */
async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const p = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

/** A private IPv4 address of this machine (not loopback, not Tailscale), or null when it has none. */
function ownPrivateAddress(): string | null {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal && isPrivateV4(a.address)) return a.address;
  }
  return null;
}

/** An HTTPS request that accepts only the certificate given (pinned, as the apps do), with a hard timeout. */
function pinnedGet(host: string, port: number, pathName: string, cert: Buffer, headers: Record<string, string> = {}): Promise<{ status: number; body: string; fp: string }> {
  return new Promise((resolve, reject) => {
    const req = https.get({ host, port, path: pathName, headers, agent: false, ca: cert, checkServerIdentity: () => undefined, timeout: 5000 }, (res) => {
      const der = (res.socket as tlsModule.TLSSocket).getPeerCertificate().raw;
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, fp: crypto.createHash("sha256").update(der).digest("hex") }));
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
  });
}

/** A TLS handshake that must not happen: true when the server closed the connection before any certificate came. */
function closedBeforeTls(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = tlsModule.connect({ host, port, rejectUnauthorized: false, timeout: 5000 });
    sock.once("secureConnect", () => { sock.destroy(); resolve(false); });
    sock.once("timeout", () => { sock.destroy(); resolve(false); });
    sock.once("error", () => resolve(true));
    sock.once("close", () => resolve(true));
  });
}

// ---------- the hub's id ----------

test("home route: the hub's id is 16 random bytes as 26 characters of Crockford base32", () => {
  // An independent reading of the same encoding: the bits in order, padded with zeros, five at a time.
  const ref = (b: Buffer) => {
    const bits = [...b].map((x) => x.toString(2).padStart(8, "0")).join("");
    const padded = bits.padEnd(Math.ceil(bits.length / 5) * 5, "0");
    return padded.match(/.{5}/g)!.map((g) => "0123456789ABCDEFGHJKMNPQRSTVWXYZ"[parseInt(g, 2)]).join("");
  };
  assert.equal(crockford32(Buffer.alloc(16)), "0".repeat(26));
  assert.equal(crockford32(Buffer.alloc(16, 0xff)), `${"Z".repeat(25)}W`);
  for (let i = 0; i < 50; i++) {
    const b = crypto.randomBytes(16);
    assert.equal(crockford32(b), ref(b));
  }
});

test("home route: the hub's id is made once, kept owner-only, and never written over", () => {
  const dirs = [0, 1, 2].map(() => fs.mkdtempSync(path.join(os.tmpdir(), "ea-hubid-")));
  try {
    const id = hubId(dirs[0])!;
    assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.equal(fs.readFileSync(hubIdFile(dirs[0]), "utf8").trim(), id);
    assert.equal(fileMode(hubIdFile(dirs[0])), 0o600);
    assert.equal(hubId(dirs[0]), id, "the same id every time");
    // Another start finds the file and reads it.
    fs.copyFileSync(hubIdFile(dirs[0]), hubIdFile(dirs[1]));
    assert.equal(hubId(dirs[1]), id);
    // A damaged file is left as it is, and no id is given.
    fs.writeFileSync(hubIdFile(dirs[2]), "not an id\n");
    assert.equal(hubId(dirs[2]), null);
    assert.equal(fs.readFileSync(hubIdFile(dirs[2]), "utf8"), "not an id\n");
    assert.notEqual(hubId(fs.mkdtempSync(path.join(os.tmpdir(), "ea-hubid-"))), id, "every hub has its own");
  } finally { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); }
});

test("home route: pairing links carry the hub's id (hid=) and the answer names it", async () => {
  const t = makeHub();
  try {
    const l = (await (await t.api("/devices/pairing", { method: "POST", json: { name: "iPhone" } })).json()) as { hub_id: string; app: string; web: string };
    const id = fs.readFileSync(hubIdFile(t.dir), "utf8").trim();
    assert.equal(l.hub_id, id);
    assert.equal(new URL(l.app).searchParams.get("hid"), id);
    assert.match(l.web, /\/app\/#\/setup\?hub=[^&]+&hid=[0-9A-Z]{26}&code=/);
    const old = (await (await t.api("/setup/pair?name=iPad")).json()) as { hub_id: string; app: string };
    assert.equal(new URL(old.app).searchParams.get("hid"), id, "the same id in every link");
    assert.equal(old.hub_id, id);
  } finally { t.cleanup(); }
});

// ---------- the home certificate ----------

test("home route: the certificate is EC P-256, self-signed, for this machine's names and private addresses, 10 years", async () => {
  await withLan(FAKE_LAN, () => {
    const now = new Date();
    const made = selfSignedCertificate({ name: "Aeneas hub", dns: ["localhost", "desk-pc", "desk-pc.local"], ips: ["127.0.0.1", "192.168.1.20", "10.4.5.1"], now });
    const x = new crypto.X509Certificate(made.cert);
    const priv = crypto.createPrivateKey(made.key);
    assert.equal(x.verify(x.publicKey), true, "signed by its own key");
    assert.equal(x.checkPrivateKey(priv), true);
    assert.equal(x.publicKey.asymmetricKeyDetails?.namedCurve, "prime256v1");
    assert.equal(x.subject, "CN=Aeneas hub");
    assert.equal(x.issuer, "CN=Aeneas hub");
    assert.equal(x.ca, false);
    assert.deepEqual(x.keyUsage, ["1.3.6.1.5.5.7.3.1"], "for TLS servers");
    for (const ip of ["127.0.0.1", "192.168.1.20", "10.4.5.1"]) assert.equal(x.checkIP(ip), ip);
    assert.equal(x.checkIP("100.90.0.5"), undefined);
    for (const h of ["localhost", "desk-pc", "desk-pc.local"]) assert.equal(x.checkHost(h), h);
    const from = new Date(x.validFrom).getTime();
    const to = new Date(x.validTo).getTime();
    assert.ok(from <= now.getTime() && from > now.getTime() - 2 * 3600_000, "valid from just before now");
    const tenYears = new Date(now); tenYears.setUTCFullYear(now.getUTCFullYear() + 10);
    assert.ok(Math.abs(to - tenYears.getTime()) < 2000, `valid for 10 years (${x.validTo})`);
    assert.equal(made.fingerprint, crypto.createHash("sha256").update(x.raw).digest("hex"));
    // A date past 2049 is written as GeneralizedTime, and still reads back.
    const late = new crypto.X509Certificate(selfSignedCertificate({ name: "Aeneas hub", dns: ["localhost"], ips: [], now: new Date("2045-06-01T00:00:00Z") }).cert);
    assert.equal(new Date(late.validTo).toISOString(), "2055-06-01T00:00:00.000Z");
  });
});

test("home route: the hub makes its home certificate once, owner-only, and keeps it", async () => {
  const dirs = [0, 1, 2, 3].map(() => fs.mkdtempSync(path.join(os.tmpdir(), "ea-homecert-")));
  const copy = (from: string, to: string, names = ["home.crt", "home.key"]) => {
    fs.mkdirSync(homeCertFiles(to).dir, { recursive: true });
    for (const n of names) fs.copyFileSync(path.join(homeCertFiles(from).dir, n), path.join(homeCertFiles(to).dir, n));
  };
  try {
    await withLan(FAKE_LAN, () => {
      assert.equal(homeCertificate(dirs[0], { make: false }), null, "nothing is made only to be shown");
      const first = homeCertificate(dirs[0])!;
      const f = homeCertFiles(dirs[0]);
      assert.equal(fileMode(f.key), 0o600);
      if (process.platform !== "win32") assert.equal(fs.statSync(f.dir).mode & 0o777, 0o700);
      const x = new crypto.X509Certificate(fs.readFileSync(f.cert));
      // This machine's names and private addresses: never its Tailscale address.
      assert.equal(x.subjectAltName, "DNS:localhost, DNS:desk-pc, DNS:desk-pc.local, IP Address:127.0.0.1, IP Address:192.168.1.20, IP Address:10.4.5.1, IP Address:172.17.0.1");
      assert.equal(x.checkPrivateKey(crypto.createPrivateKey(fs.readFileSync(f.key))), true);
      assert.equal(first.fingerprint, crypto.createHash("sha256").update(x.raw).digest("hex"));
      assert.equal(homeCertificate(dirs[0])!.fingerprint, first.fingerprint);
      // Another start reads the same pair: devices that pinned it go on working.
      copy(dirs[0], dirs[1]);
      assert.equal(homeCertificate(dirs[1])!.fingerprint, first.fingerprint);
      assert.deepEqual(fs.readFileSync(homeCertFiles(dirs[1]).cert), first.cert, "kept as it was");
      // Half a pair (a write cut off) is made again.
      copy(dirs[0], dirs[2], ["home.key"]);
      const remade = homeCertificate(dirs[2])!;
      assert.notEqual(remade.fingerprint, first.fingerprint);
      assert.equal(new crypto.X509Certificate(fs.readFileSync(homeCertFiles(dirs[2]).cert)).checkPrivateKey(crypto.createPrivateKey(fs.readFileSync(homeCertFiles(dirs[2]).key))), true);
      // A pair that cannot be used is an error, and both files stay as they are.
      copy(dirs[0], dirs[3], ["home.crt"]);
      fs.copyFileSync(homeCertFiles(dirs[2]).key, homeCertFiles(dirs[3]).key);
      assert.throws(() => homeCertificate(dirs[3]), (e: unknown) => e instanceof HomeCertError && /does not belong/.test((e as Error).message));
      assert.deepEqual(fs.readFileSync(homeCertFiles(dirs[3]).cert), first.cert);
    });
  } finally { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); }
});

// ---------- which connections come in ----------

test("home route: only a private address to a private address of this machine; loopback only on a Home Wi-Fi only hub's port", () => {
  const ok: [string, string][] = [
    ["192.168.1.30", "192.168.1.20"], ["10.0.0.16", "10.4.5.1"], ["172.16.5.4", "172.31.0.1"], ["169.254.3.4", "169.254.9.9"],
    ["::ffff:192.168.1.30", "::ffff:192.168.1.20"], ["::FFFF:10.0.0.16", "::ffff:10.4.5.1"],
  ];
  for (const [r, l] of ok) {
    assert.equal(homeConnectionAllowed(r, l), true, `${r} -> ${l}`);
    assert.equal(homeConnectionAllowed(r, l, { loopback: true }), true, `${r} -> ${l} (home port)`);
  }
  const no: [string | undefined, string | undefined][] = [
    // Tailscale on either end, as IPv4 or IPv4-mapped
    ["100.90.0.5", "192.168.1.20"], ["192.168.1.30", "100.64.0.10"], ["::ffff:100.127.255.1", "::ffff:192.168.1.20"],
    // public addresses (documentation ranges) and the edges of the private ranges
    ["203.0.113.7", "192.168.1.20"], ["192.168.1.30", "198.51.100.4"], ["172.32.0.1", "172.16.0.1"], ["172.15.255.1", "10.4.5.1"],
    ["192.169.0.1", "192.168.1.20"], ["11.0.0.1", "10.4.5.1"], ["169.255.0.1", "169.254.0.2"],
    // IPv6 of any kind, and nothing at all
    ["fe80::1", "fe80::2"], ["fd00::5", "fd00::1"], [undefined, "192.168.1.20"], ["192.168.1.30", undefined], ["", ""],
    // not addresses
    ["192.168.1.300", "192.168.1.20"], ["192.168.1", "192.168.1.20"], ["::ffff:c0a8:011e", "192.168.1.20"],
  ];
  for (const [r, l] of no) {
    assert.equal(homeConnectionAllowed(r, l), false, `${r} -> ${l}`);
    assert.equal(homeConnectionAllowed(r, l, { loopback: true }), false, `${r} -> ${l} (home port)`);
  }
  // Loopback: never on the home route's listener; kept on a Home Wi-Fi only hub's own port.
  for (const [r, l] of [["127.0.0.1", "127.0.0.1"], ["::1", "::1"], ["::ffff:127.0.0.1", "::ffff:127.0.0.1"], ["127.8.9.10", "127.0.0.1"]]) {
    assert.equal(homeConnectionAllowed(r, l), false, `${r} -> ${l}`);
    assert.equal(homeConnectionAllowed(r, l, { loopback: true }), true, `${r} -> ${l} (home port)`);
  }
  // Half loopback is no connection a machine makes to itself.
  assert.equal(homeConnectionAllowed("127.0.0.1", "192.168.1.20", { loopback: true }), false);
  assert.equal(homeConnectionAllowed("192.168.1.30", "127.0.0.1", { loopback: true }), false);
  assert.equal(isLoopback("192.168.1.30"), false);
});

test("home route: a Home Wi-Fi only hub's port is checked; other methods leave it as it was", async () => {
  const t = makeHub({ bindHost: "0.0.0.0", tlsCert: FIX_CERT, tlsKey: FIX_KEY });
  try {
    const sock = (remoteAddress: string, localAddress: string) => ({ remoteAddress, localAddress }) as net.Socket;
    const guard = mainPortGuard(t.hub.cfg);
    t.hub.cfg.link = "direct";
    assert.equal(guard(sock("100.90.0.5", "100.90.0.4")), true, "a Direct link hub's port is as it was");
    assert.equal((await changeLink(t.hub.cfg, { method: "home" })).ok, true);
    assert.equal(guard(sock("192.168.1.30", "192.168.1.20")), true);
    assert.equal(guard(sock("127.0.0.1", "127.0.0.1")), true, "this machine's own checks go on");
    assert.equal(guard(sock("100.90.0.5", "100.90.0.4")), false, "not from the tailnet");
    assert.equal(guard(sock("203.0.113.7", "192.168.1.20")), false, "not from the internet");
    // On a real port: the guard closes the connection before anything is read, TLS or plain.
    for (const make of [dualServer(loadTls(t.hub.cfg)!, isLoopback, () => false), guardedServer(() => false)]) {
      const server = make({}, (_req, res) => res.end("served"));
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
      const port = (server.address() as net.AddressInfo).port;
      try { assert.equal(await closedBeforeTls("127.0.0.1", port), true); } finally { await new Promise<void>((r) => server.close(() => r())); }
    }
  } finally { t.cleanup(); }
});

test("home route: the listener refuses this machine (loopback) before TLS starts, and reports a port it cannot open", async () => {
  const t = makeHub();
  const l = new HomeListener(t.app.fetch, { host: "127.0.0.1" });
  const files = selfSignedCertificate({ name: "Aeneas hub", dns: ["localhost"], ips: ["127.0.0.1"] });
  const taken = net.createServer();
  try {
    const st = await l.start(files, 0);
    assert.equal(st.listening, true);
    assert.equal(st.fp, files.fingerprint);
    assert.equal(await closedBeforeTls("127.0.0.1", st.port), true, "no certificate, no TLS, nothing for this machine");
    await l.stop();
    assert.equal(l.state().listening, false);
    // A port another program holds: the hub goes on, and says why.
    await new Promise<void>((r) => taken.listen(0, "127.0.0.1", () => r()));
    const port = (taken.address() as net.AddressInfo).port;
    const busy = await l.start(files, port);
    assert.equal(busy.listening, false);
    assert.match(busy.error!, new RegExp(`^Port ${port} is already in use on this computer.*EA_HOME_PORT`));
  } finally {
    await l.stop();
    await new Promise<void>((r) => taken.close(() => r()));
    t.cleanup();
  }
});

test("home route: a port that comes free later is taken then, without a restart", async () => {
  const t = makeHub();
  let told = 0;
  const l = new HomeListener(t.app.fetch, { host: "127.0.0.1", retryMs: [30], onListening: () => { told++; } });
  const files = selfSignedCertificate({ name: "Aeneas hub", dns: ["localhost"], ips: ["127.0.0.1"] });
  const taken = net.createServer();
  try {
    await new Promise<void>((r) => taken.listen(0, "127.0.0.1", () => r()));
    const port = (taken.address() as net.AddressInfo).port;
    assert.equal((await l.start(files, port)).listening, false);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(l.state().listening, false, "still taken: still trying");
    await new Promise<void>((r) => taken.close(() => r()));
    for (let i = 0; i < 100 && !l.state().listening; i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual([l.state().listening, l.state().port, l.state().error, told], [true, port, undefined, 1]);
    // Stopped while waiting to try again, it stays stopped.
    await l.stop();
    const again = net.createServer();
    await new Promise<void>((r) => again.listen(port, "127.0.0.1", () => r()));
    assert.equal((await l.start(files, port)).listening, false);
    await l.stop();
    await new Promise<void>((r) => again.close(() => r()));
    await new Promise((r) => setTimeout(r, 120));
    assert.deepEqual([l.state().listening, l.state().error], [false, undefined]);
  } finally {
    await l.stop();
    if (taken.listening) await new Promise<void>((r) => taken.close(() => r()));
    t.cleanup();
  }
});

test("home route: a device on the home network gets the hub over HTTPS with the home certificate, never as this machine", async (tt) => {
  const ip = ownPrivateAddress();
  if (!ip) { tt.skip("this machine has no private IPv4 address"); return; }
  const t = makeHub();
  const l = new HomeListener(t.app.fetch, { host: ip });
  const files = selfSignedCertificate({ name: "Aeneas hub", dns: ["localhost"], ips: [ip] });
  try {
    const st = await l.start(files, 0);
    assert.equal(st.listening, true, st.error);
    const health = await pinnedGet(ip, st.port, "/health", files.cert);
    assert.deepEqual([health.status, health.fp], [200, files.fingerprint], "the pinned certificate");
    assert.deepEqual(JSON.parse(health.body), { ok: true }, "no key, nothing more");
    // The main key works only on the hub's own machine: from the home network it is refused like any outside caller.
    const main = await pinnedGet(ip, st.port, "/setup", files.cert, { authorization: `Bearer ${TOKEN}` });
    assert.equal(main.status, 403, main.body);
    const key = await deviceKey(t);
    const dev = await pinnedGet(ip, st.port, "/link/routes", files.cert, { authorization: `Bearer ${key}` });
    assert.equal(dev.status, 200, dev.body);
    assert.equal((JSON.parse(dev.body) as { hub_id: string }).hub_id, hubId(t.dir));
  } finally {
    await l.stop();
    t.cleanup();
  }
});

// ---------- the routes ----------

async function routes(t: TestHub, key?: string) {
  const r = key ? await t.app.request("/link/routes", { headers: { authorization: `Bearer ${key}` } }) : await t.api("/link/routes");
  return { status: r.status, body: (await r.json()) as { hub_id: string; method: string | null; remote: string | null; home: { on: boolean; urls: string[]; fp: string | null; announce: boolean } } };
}

test("home route: /link/routes needs a device key and names every route for a Direct link hub", async () => {
  const t = makeHub();
  try {
    assert.equal((await t.app.request("/link/routes")).status, 401);
    // A Direct link hub that has its key and relay but is not running now: the address comes from its key file.
    const seed = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(t.hub.cfg.linkKeyFile), { recursive: true });
    fs.writeFileSync(t.hub.cfg.linkKeyFile, seed, { mode: 0o600 });
    fs.writeFileSync(path.join(t.dir, "link.json"), JSON.stringify({ method: "direct", relay: "https://relay.example.org/" }));
    const node = SecretKey.fromBytes(Array.from(seed)).public().toString();
    const key = await deviceKey(t);
    const r = await routes(t, key);
    assert.equal(r.status, 200);
    assert.equal(r.body.hub_id, hubId(t.dir));
    assert.equal(r.body.method, "direct");
    assert.equal(r.body.remote, `iroh://${node}?relay=${encodeURIComponent("https://relay.example.org/")}`);
    assert.match(r.body.remote!, /^iroh:\/\/[0-9a-f]{64}\?relay=https%3A%2F%2F/);
    assert.deepEqual(r.body.home, { on: true, urls: [], fp: null, announce: true }, "on, but not answering in this test");
    // Without a relay known yet there is no address away from home.
    fs.writeFileSync(path.join(t.dir, "link.json"), JSON.stringify({ method: "direct" }));
    assert.equal((await routes(t, key)).body.remote, null);
  } finally { t.cleanup(); }
});

test("home route: /link/routes for a Tailscale hub and a Home Wi-Fi only hub", async () => {
  const t = makeHub();
  const h = makeHub({ bindHost: "0.0.0.0", tlsCert: FIX_CERT, tlsKey: FIX_KEY });
  try {
    t.hub.cfg.publicUrl = "https://hub.tail1234.ts.net";
    assert.equal((await changeLink(t.hub.cfg, { method: "tailscale" })).ok, true);
    const ts = await routes(t);
    assert.deepEqual([ts.body.method, ts.body.remote], ["tailscale", "https://hub.tail1234.ts.net"]);
    // Home Wi-Fi only: no address away from home; its own port and certificate at home.
    assert.equal((await changeLink(h.hub.cfg, { method: "home" })).ok, true);
    const fp = loadTls(h.hub.cfg)!.fingerprint;
    const home = await withLan(FAKE_LAN, () => routes(h));
    assert.equal(home.body.method, "home");
    assert.equal(home.body.remote, null);
    assert.deepEqual(home.body.home, { on: true, urls: [`https://192.168.1.20:${h.hub.cfg.port}`, `https://10.4.5.1:${h.hub.cfg.port}`], fp, announce: true });
    // The adapter with the way out decides; with none known, every private address (never Tailscale's).
    assert.deepEqual(await withLan({ ...FAKE_LAN, wayOut: async () => null }, () => homeAddresses()), ["192.168.1.20", "10.4.5.1", "172.17.0.1"]);
  } finally { t.cleanup(); h.cleanup(); }
});

test("home route: PUT /setup/link takes home_route and announce, alone or with the method, as true or false only", async () => {
  const t = makeHub();
  try {
    for (const body of [{ home_route: "yes" }, { announce: 1 }, { home_route: null }, {}, { method: "carrier pigeon" }, { method: "direct", announce: "no" }]) {
      const r = await t.api("/setup/link", { method: "PUT", json: body });
      assert.equal(r.status, 422, JSON.stringify(body));
    }
    assert.equal(readLinkFile(t.dir).method, undefined, "a refused change writes nothing");
    const off = (await (await t.api("/setup/link", { method: "PUT", json: { home_route: false } })).json()) as { home: { on: boolean; announce: boolean; port: number; urls: string[]; fp: string | null } };
    assert.deepEqual(off.home, { on: false, announce: true, port: t.hub.cfg.port + 1000, urls: [], fp: null });
    const both = (await (await t.api("/setup/link", { method: "PUT", json: { method: "direct", announce: false } })).json()) as { method: string; direct: { relay_ok: boolean }; home: { on: boolean; announce: boolean } };
    assert.deepEqual([both.method, both.home.on, both.home.announce, both.direct.relay_ok], ["direct", false, false, false]);
    assert.deepEqual(readLinkFile(t.dir), { method: "direct", relay: undefined, home_route: false, announce: false, tailscale_door: undefined });
    // An unavailable method is refused as before, and leaves the rest alone.
    assert.equal((await t.api("/setup/link", { method: "PUT", json: { method: "tailscale", home_route: true } })).status, 409);
    assert.equal(readLinkFile(t.dir).home_route, false);
  } finally { t.cleanup(); }
});

test("home route: people's hubs on one machine keep their ports", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ea-people-"));
  const before = process.env.EA_PEOPLE_ROOT;
  try {
    process.env.EA_PEOPLE_ROOT = root;
    assert.equal(portOfAnotherHub(8788), false, "no list: nothing to leave alone");
    fs.mkdirSync(path.join(root, "etc", "aeneas"), { recursive: true });
    fs.writeFileSync(path.join(root, "etc", "aeneas", "people.json"), JSON.stringify([{ name: "Robin", user: "aeneas-robin", port: 8788 }]));
    assert.equal(portOfAnotherHub(8788), true);
    assert.equal(portOfAnotherHub(8790), false);
  } finally {
    if (before === undefined) delete process.env.EA_PEOPLE_ROOT; else process.env.EA_PEOPLE_ROOT = before;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("home route: a running hub answers at home, follows the settings, and says where in /setup/link and /link/routes", async () => {
  const t = makeHub();
  const relay = relayInTestHands("https://relay.example.org/");
  fs.writeFileSync(path.join(t.dir, "link.json"), JSON.stringify({ method: "direct" }));
  t.hub.cfg.homePort = await freePort();
  let stop: (() => Promise<void>) | null = null;
  try {
    await withLan(FAKE_LAN, async () => {
      stop = await startLink(t.hub.cfg, t.app.fetch, { loadIroh: relay.load, direct: { onlineMs: 50, retryMs: [20] }, homeHost: "127.0.0.1" });
      const cert = homeCertificate(t.dir, { make: false })!;
      assert.ok(cert, "the home certificate was made at start");
      const view = (await (await t.api("/setup/link")).json()) as { direct: { state: string; relay_ok: boolean }; home: { on: boolean; announce: boolean; port: number; urls: string[]; fp: string } };
      assert.deepEqual([view.direct.state, view.direct.relay_ok], ["online", false], "online with no relay (no internet)");
      assert.deepEqual(view.home, { on: true, announce: true, port: t.hub.cfg.homePort, urls: [`https://192.168.1.20:${t.hub.cfg.homePort}`, `https://10.4.5.1:${t.hub.cfg.homePort}`], fp: cert.fingerprint });
      // Bonjour would say the home route's port and certificate (it stays off in tests).
      assert.deepEqual(wantedAnnouncement(t.hub.cfg), { name: `Aeneas hub ${cert.fingerprint.slice(0, 8)}`, host: `aeneas-${cert.fingerprint.slice(0, 8)}.local`, port: t.hub.cfg.homePort, fp: cert.fingerprint });
      // The listener is there (and closes this machine's own connection before TLS).
      assert.equal(await closedBeforeTls("127.0.0.1", t.hub.cfg.homePort), true);
      const key = await deviceKey(t);
      relay.answer();
      for (let i = 0; i < 100 && !((await routes(t, key)).body.remote); i++) await new Promise((r) => setTimeout(r, 20));
      const r = await routes(t, key);
      assert.match(r.body.remote!, /^iroh:\/\/[0-9a-f]{64}\?relay=https%3A%2F%2Frelay\.example\.org%2F$/);
      assert.deepEqual(r.body.home, { on: true, urls: view.home.urls, fp: cert.fingerprint, announce: true });
      // Off: the port closes and the routes say so; Bonjour stops with it.
      await t.api("/setup/link", { method: "PUT", json: { home_route: false } });
      const refused = await new Promise<string>((resolve) => { const s = net.connect(t.hub.cfg.homePort, "127.0.0.1"); s.once("connect", () => { s.destroy(); resolve("connected"); }); s.once("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? "error")); });
      assert.equal(refused, "ECONNREFUSED");
      assert.deepEqual((await routes(t, key)).body.home, { on: false, urls: [], fp: cert.fingerprint, announce: true });
      assert.equal(wantedAnnouncement(t.hub.cfg), null);
      // On again, with the announcement turned off.
      const back = (await (await t.api("/setup/link", { method: "PUT", json: { home_route: true, announce: false } })).json()) as { home: { on: boolean; urls: string[]; fp: string; announce: boolean } };
      assert.deepEqual([back.home.on, back.home.urls.length, back.home.fp, back.home.announce], [true, 2, cert.fingerprint, false]);
      assert.equal(wantedAnnouncement(t.hub.cfg), null);
      // Home Wi-Fi only is not offered here (no certificate of the hub's own), so the home route stays as it is.
      assert.equal((await t.api("/setup/link", { method: "PUT", json: { method: "home" } })).status, 409);
    });
  } finally {
    if (stop) await (stop as () => Promise<void>)();
    t.cleanup();
  }
});

test("home route: the hub's own TLS certificate (EA_TLS_CERT) is the one the home route serves", async () => {
  const t = makeHub({ tlsCert: FIX_CERT, tlsKey: FIX_KEY });
  fs.writeFileSync(path.join(t.dir, "link.json"), JSON.stringify({ method: "tailscale" }));
  t.hub.cfg.publicUrl = "https://hub.tail1234.ts.net";
  t.hub.cfg.homePort = await freePort();
  let stop: (() => Promise<void>) | null = null;
  try {
    stop = await startLink(t.hub.cfg, t.app.fetch, { homeHost: "127.0.0.1" });
    const r = await withLan(FAKE_LAN, () => routes(t));
    assert.equal(r.body.home.fp, loadTls(t.hub.cfg)!.fingerprint);
    assert.equal(fs.existsSync(homeCertFiles(t.dir).cert), false, "no second certificate is made");
    assert.equal(r.body.remote, "https://hub.tail1234.ts.net");
  } finally {
    if (stop) await (stop as () => Promise<void>)();
    t.cleanup();
  }
});

test("home route: the Direct link key worked out from the key file is iroh's own", () => {
  for (let i = 0; i < 5; i++) {
    const sk = SecretKey.generate();
    assert.equal(directKeyOf(Buffer.from(sk.toBytes())), sk.public().toString());
  }
  assert.equal(directKeyOf(Buffer.alloc(31)), null, "not a key file");
});
