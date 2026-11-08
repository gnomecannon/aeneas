import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { Config } from "./config.js";

/**
 * HTTPS for a hub reached over a home network instead of Tailscale (EA_TLS_CERT and EA_TLS_KEY, made by
 * deploy/install.sh as a self-signed certificate that devices pin by its fingerprint).
 *
 * One port answers both ways: TLS from anywhere, and plain HTTP only to connections from this machine itself
 * (Tailscale Serve, the installer's health check, the hub health monitor). A plain request from the network gets a
 * redirect to the https address and nothing else.
 */

export interface TlsFiles { key: Buffer; cert: Buffer; fingerprint: string }

type TlsPaths = Pick<Config, "tlsCert" | "tlsKey">;

const loaded = new Map<string, TlsFiles>();

/**
 * The certificate and key the hub serves, read once per pair of paths (so the fingerprint stays the one being served
 * even when the files change under a running hub). Null when neither is set; an error when only one is, when a file
 * cannot be read, or when the key does not belong to the certificate.
 */
export function loadTls(cfg: TlsPaths): TlsFiles | null {
  if (!cfg.tlsCert && !cfg.tlsKey) return null;
  if (!cfg.tlsCert || !cfg.tlsKey) throw new Error(`EA_TLS_CERT and EA_TLS_KEY go together, and only ${cfg.tlsCert ? "EA_TLS_CERT" : "EA_TLS_KEY"} is set`);
  const id = `${cfg.tlsCert}\0${cfg.tlsKey}`;
  const known = loaded.get(id);
  if (known) return known;
  const read = (file: string, name: string) => {
    try { return fs.readFileSync(file); } catch (e) { throw new Error(`${name} ${file} could not be read (${(e as NodeJS.ErrnoException).code ?? "error"})`); }
  };
  const cert = read(cfg.tlsCert, "EA_TLS_CERT");
  const key = read(cfg.tlsKey, "EA_TLS_KEY");
  let x509: crypto.X509Certificate;
  try { x509 = new crypto.X509Certificate(cert); } catch { throw new Error(`EA_TLS_CERT ${cfg.tlsCert} is not a PEM certificate`); }
  let priv: crypto.KeyObject;
  try { priv = crypto.createPrivateKey(key); } catch { throw new Error(`EA_TLS_KEY ${cfg.tlsKey} is not a PEM private key`); }
  if (!x509.checkPrivateKey(priv)) throw new Error("EA_TLS_KEY is not the key of the certificate in EA_TLS_CERT");
  const files = { key, cert, fingerprint: crypto.createHash("sha256").update(x509.raw).digest("hex") };
  loaded.set(id, files);
  return files;
}

/**
 * SHA-256 of the served certificate's DER bytes, lowercase hex with no colons (what a device pins), or null when the
 * hub does not serve TLS.
 */
export function tlsFingerprint(cfg: Config): string | null {
  if (!cfg.tlsCert || !cfg.tlsKey) return null;
  return loadTls(cfg)?.fingerprint ?? null;
}

/** A connection from this machine itself (127.0.0.0/8, ::1, or IPv4 loopback written as IPv6). */
export function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.toLowerCase();
  return a === "::1" || /^127\./.test(a) || /^::ffff:127\./.test(a);
}

/** The bind address keeps the hub on this machine only. */
export function isLoopbackHost(host: string): boolean {
  return host === "localhost" || isLoopback(host);
}

const HOST_RE = /^[A-Za-z0-9.\-]+(:\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](:\d{1,5})?$/;

/**
 * A `createServer` for @hono/node-server: a listener that hands each connection, by its first byte, to an HTTPS
 * server (a TLS handshake starts with 0x16) or to a plain HTTP one. Plain HTTP is served to `plainAllowed`
 * connections only (this machine, unless a test says otherwise); any other gets a redirect to https.
 */
export function dualServer(files: { key: Buffer; cert: Buffer }, plainAllowed: (addr: string | undefined) => boolean = isLoopback) {
  return (_options: unknown, listener: http.RequestListener): net.Server => {
    const secure = https.createServer({ key: files.key, cert: files.cert, minVersion: "TLSv1.2" }, listener);
    const plain = http.createServer(listener);
    const redirect = http.createServer((req, res) => {
      const host = req.headers.host ?? "";
      const where = req.url?.startsWith("/") ? req.url : "/";
      if (!HOST_RE.test(host)) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8", connection: "close" });
        res.end("This hub answers over HTTPS only.\n");
        return;
      }
      res.writeHead(308, { location: `https://${host}${where}`, "content-type": "text/plain; charset=utf-8", connection: "close" });
      res.end("This hub answers over HTTPS only.\n");
    });
    // A failed handshake (a client that does not trust the certificate yet) ends that connection only.
    secure.on("tlsClientError", (_e, socket) => socket.destroy());
    const front = net.createServer((socket) => {
      const idle = () => socket.destroy();
      const broken = () => socket.destroy();
      socket.setTimeout(20_000, idle);
      socket.once("error", broken);
      socket.once("data", (first: Buffer) => {
        socket.setTimeout(0);
        socket.removeListener("timeout", idle);
        socket.removeListener("error", broken);
        socket.pause();
        socket.unshift(first);
        const target = first[0] === 0x16 ? secure : plainAllowed(socket.remoteAddress) ? plain : redirect;
        target.emit("connection", socket);
        process.nextTick(() => socket.resume());
      });
    });
    // The inner servers never listen themselves: their header and request time limits start with the front's.
    front.on("listening", () => { for (const s of [secure, plain, redirect]) s.emit("listening"); });
    front.on("close", () => { for (const s of [secure, plain, redirect]) s.close(); });
    return front;
  };
}
