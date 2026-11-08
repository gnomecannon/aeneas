import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tlsModule from "node:tls";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { loadConfig, type Config } from "../src/config.js";
import { dualServer, isLoopback, loadTls, tlsFingerprint } from "../src/tls.js";

// A test-only self-signed pair (EC P-256, for 127.0.0.1 and localhost); its key protects nothing.
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "tls");
const CERT = path.join(FIX, "hub-test.crt");
const KEY = path.join(FIX, "hub-test.key");

function cfgWith(tlsCert: string, tlsKey: string): Config {
  process.env.EA_NO_DOTENV = "1";
  return loadConfig({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "ea-tls-")), tlsCert, tlsKey });
}

/** The fingerprint worked out without the hub's code: base64 of the PEM body is the DER. */
function derSha256(pemFile: string): string {
  const b64 = fs.readFileSync(pemFile, "utf8").replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, "");
  return crypto.createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex");
}

test("tls: the fingerprint is the SHA-256 of the certificate's DER bytes, lowercase hex, and null without TLS", () => {
  const fp = tlsFingerprint(cfgWith(CERT, KEY));
  assert.equal(fp, derSha256(CERT));
  assert.match(fp!, /^[0-9a-f]{64}$/);
  assert.equal(tlsFingerprint(cfgWith("", "")), null);
  assert.equal(tlsFingerprint(cfgWith(CERT, "")), null, "half a pair serves no TLS");
});

test("tls: settings come from EA_TLS_CERT and EA_TLS_KEY, and a bad pair is refused with a plain reason", () => {
  const before = { c: process.env.EA_TLS_CERT, k: process.env.EA_TLS_KEY };
  try {
    process.env.EA_NO_DOTENV = "1";
    process.env.EA_TLS_CERT = CERT;
    process.env.EA_TLS_KEY = KEY;
    const cfg = loadConfig();
    assert.deepEqual([cfg.tlsCert, cfg.tlsKey], [CERT, KEY]);
    delete process.env.EA_TLS_CERT;
    delete process.env.EA_TLS_KEY;
    assert.deepEqual([loadConfig().tlsCert, loadConfig().tlsKey], ["", ""]);
  } finally {
    if (before.c === undefined) delete process.env.EA_TLS_CERT; else process.env.EA_TLS_CERT = before.c;
    if (before.k === undefined) delete process.env.EA_TLS_KEY; else process.env.EA_TLS_KEY = before.k;
  }
  assert.equal(loadTls({ tlsCert: "", tlsKey: "" }), null);
  assert.throws(() => loadTls({ tlsCert: CERT, tlsKey: "" }), /go together/);
  assert.throws(() => loadTls({ tlsCert: path.join(FIX, "missing.crt"), tlsKey: KEY }), /could not be read \(ENOENT\)/);
  assert.throws(() => loadTls({ tlsCert: KEY, tlsKey: KEY }), /not a PEM certificate/);
  // A key made for something else.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-tls-key-"));
  try {
    const other = path.join(dir, "other.key");
    fs.writeFileSync(other, crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }));
    assert.throws(() => loadTls({ tlsCert: CERT, tlsKey: other }), /not the key of the certificate/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("tls: loopback is 127.0.0.0/8 and ::1, nothing else", () => {
  for (const a of ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"]) assert.equal(isLoopback(a), true, a);
  for (const a of ["192.168.1.20", "10.0.0.1", "::ffff:192.168.1.20", "fe80::1", "", undefined]) assert.equal(isLoopback(a), false, String(a));
});

function get(mod: typeof http | typeof https, url: string, opts: https.RequestOptions = {}): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = mod.get(url, { agent: false, ...opts, timeout: 5000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
  });
}

async function listen(plainAllowed?: (a: string | undefined) => boolean) {
  const files = loadTls({ tlsCert: CERT, tlsKey: KEY })!;
  const server = serve({
    // The handler says which way the request came, as the hub's own routes see it.
    fetch: async (req: Request) => {
      const body = req.method === "POST" ? await req.text() : "";
      return new Response(`${new URL(req.url).protocol} ${body.length}`);
    },
    port: 0, hostname: "127.0.0.1",
    createServer: dualServer(files, plainAllowed) as unknown as typeof http.createServer,
  });
  await new Promise<void>((r) => server.once("listening", () => r()));
  const port = (server.address() as net.AddressInfo).port;
  return { port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("tls: one port serves HTTPS with the pinned certificate and plain HTTP to this machine only", async () => {
  const s = await listen();
  try {
    const ca = fs.readFileSync(CERT);
    const secure = await get(https, `https://127.0.0.1:${s.port}/health`, { ca });
    assert.deepEqual([secure.status, secure.body], [200, "https: 0"], "the hub sees https, so its addresses say https");
    // The certificate a device sees is the one the fingerprint names.
    const seen = await new Promise<string>((resolve, reject) => {
      const sock = tlsModule.connect({ host: "127.0.0.1", port: s.port, ca, servername: "localhost" }, () => {
        const der = sock.getPeerCertificate().raw as Buffer;
        sock.end();
        resolve(crypto.createHash("sha256").update(der).digest("hex"));
      });
      sock.on("error", reject);
    });
    assert.equal(seen, derSha256(CERT));
    const plain = await get(http, `http://127.0.0.1:${s.port}/health`);
    assert.deepEqual([plain.status, plain.body], [200, "http: 0"], "health checks and Tailscale Serve on 127.0.0.1 keep working");
    // A plain request in several pieces (headers, then a body) arrives whole.
    const big = "x".repeat(200_000);
    const posted = await new Promise<string>((resolve, reject) => {
      const sock = net.connect(s.port, "127.0.0.1", () => {
        sock.write(`POST /x HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: ${big.length}\r\nConnection: close\r\n\r\n`);
        setTimeout(() => sock.end(big), 20);
      });
      let out = "";
      sock.on("data", (d) => { out += d.toString("utf8"); });
      sock.on("end", () => resolve(out));
      sock.on("error", reject);
    });
    assert.match(posted, /^HTTP\/1\.1 200/);
    assert.match(posted, /http: 200000$/);
    // A client that does not trust the certificate is refused, and the server goes on.
    await assert.rejects(get(https, `https://127.0.0.1:${s.port}/health`), /self.signed|unable to verify|certificate/i);
    assert.equal((await get(https, `https://127.0.0.1:${s.port}/health`, { ca })).status, 200);
  } finally { await s.close(); }
});

test("tls: plain HTTP from the network is sent to https and never served", async () => {
  const s = await listen(() => false);
  try {
    const r = await get(http, `http://127.0.0.1:${s.port}/setup?x=1`);
    assert.equal(r.status, 308);
    assert.equal(r.headers.location, `https://127.0.0.1:${s.port}/setup?x=1`);
    assert.match(r.body, /HTTPS only/);
    const bad = await get(http, `http://127.0.0.1:${s.port}/`, { headers: { host: "evil.example/<script>" } });
    assert.equal(bad.status, 400);
    // HTTPS still works for the same connections.
    assert.equal((await get(https, `https://127.0.0.1:${s.port}/`, { ca: fs.readFileSync(CERT) })).body, "https: 0");
  } finally { await s.close(); }
});

