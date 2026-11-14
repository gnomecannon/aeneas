import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { Duplex } from "node:stream";
import { getRequestListener } from "@hono/node-server";
import type { Config } from "./config.js";
import { isLoopbackHost, tlsFingerprint } from "./tls.js";
import { announce, announcement } from "./announce.js";

/**
 * How devices reach the hub, chosen in the installer and changeable on the Welcome page and in Settings:
 *
 * - `direct`: Direct link (iroh, https://iroh.computer, open source from n0). Each device connects straight to the
 *   hub, encrypted end to end; when no direct path exists, through a relay that passes bytes it cannot read. The hub's
 *   public key travels in the pairing QR code, and the app accepts only that key, so a relay cannot stand in for the
 *   hub. No account. The hub keeps the relay it was first given (or EA_LINK_RELAYS), so paired devices always find it,
 *   and it publishes nothing to any lookup service.
 * - `tailscale`: Tailscale Serve on this machine (the installer sets it up).
 * - `home`: the home network only, HTTPS with the hub's own certificate, pinned from the QR code.
 *
 * Requests that arrive over the Direct link are handed to the same request handler as the hub's own server, as
 * connections from `iroh:<device key>`: never as this machine (loopback), so they need a paired device's key like any
 * other remote caller, and wrong guesses are slowed per device.
 */
export type LinkMethod = "direct" | "tailscale" | "home";
export const LINK_METHODS: LinkMethod[] = ["direct", "tailscale", "home"];
export const LINK_ALPN = "aeneas/link/1";

interface LinkFile { method?: LinkMethod; relay?: string }

const linkFile = (dataDir: string) => path.join(dataDir, "link.json");

export function readLinkFile(dataDir: string): LinkFile {
  try {
    const j = JSON.parse(fs.readFileSync(linkFile(dataDir), "utf8")) as LinkFile;
    return {
      method: LINK_METHODS.includes(j.method as LinkMethod) ? j.method : undefined,
      relay: typeof j.relay === "string" && /^https:\/\//.test(j.relay) ? j.relay : undefined,
    };
  } catch { return {}; }
}

function writeLinkFile(dataDir: string, f: LinkFile): void {
  const p = linkFile(dataDir);
  fs.writeFileSync(`${p}.tmp`, JSON.stringify(f, null, 2));
  fs.renameSync(`${p}.tmp`, p);
}

/** Whether this hub can offer each method as it is installed now, and what to do when it cannot. */
export function linkAvailability(cfg: Config): Record<LinkMethod, { available: boolean; how?: string }> {
  const tailnet = /\.ts\.net(:\d+)?$/i.test(hostOf(cfg.publicUrl));
  const home = !isLoopbackHost(cfg.bindHost) && !!cfg.tlsCert;
  return {
    direct: { available: true },
    tailscale: tailnet ? { available: true } : { available: false, how: "Run the hub installer again and choose Tailscale: it installs Tailscale and signs this computer in." },
    home: home ? { available: true } : { available: false, how: "Run the hub installer again and choose Home Wi-Fi only: it makes the hub's certificate and lets your network reach it." },
  };
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return ""; }
}

/** The method in use: the one chosen on the Welcome page or in Settings, else the installer's, else what the install shows. */
export function currentMethod(cfg: Config): LinkMethod | null {
  const chosen = readLinkFile(cfg.dataDir).method ?? (cfg.link as LinkMethod | "");
  if (chosen) return chosen;
  const a = linkAvailability(cfg);
  if (a.tailscale.available) return "tailscale";
  if (a.home.available) return "home";
  return null;
}

export interface DirectStatus {
  state: "off" | "starting" | "online" | "error";
  /** The hub's public key (what the QR code carries). */
  id?: string;
  relay?: string;
  /** Who runs the relay, said plainly. */
  relay_by?: string;
  error?: string;
  /** After a failed start: when it is tried again (a hub that started before the network keeps trying). */
  retry_at?: string;
  /** Devices connected now, and how many of them reach the hub directly (not through the relay). */
  connected: number;
  direct: number;
}

type Iroh = typeof import("@number0/iroh");
type Endpoint = import("@number0/iroh").Endpoint;
type BiStream = import("@number0/iroh").BiStream;
type Connection = import("@number0/iroh").Connection;

const CHUNK = 64 * 1024;

/** An iroh stream as a socket for Node's HTTP server, reporting `peer` as its address. */
function streamSocket(bi: BiStream, peer: string): Duplex {
  let reading = false;
  // A stream whose answer was written out and finished is left to close on its own: a reset after that would throw
  // away whatever the other end has not read yet (it did: every answer arrived as "Reset(0)").
  let finished = false;
  let readDone = false;
  const d: Duplex = new Duplex({
    read() {
      if (reading) return;
      reading = true;
      void (async () => {
        for (;;) {
          const c = await bi.recv.read(CHUNK).catch(() => null);
          if (!c || !c.length) { readDone = true; d.push(null); return; }
          if (!d.push(Buffer.from(c))) { reading = false; return; }
        }
      })();
    },
    write(chunk: Buffer, _enc, cb) {
      void (async () => {
        try {
          for (let i = 0; i < chunk.length; i += CHUNK) await bi.send.writeAll(Array.from(chunk.subarray(i, i + CHUNK)));
          cb();
        } catch (e) { cb(e as Error); }
      })();
    },
    final(cb) { bi.send.finish().then(() => { finished = true; cb(); }, () => cb()); },
    destroy(err, cb) {
      if (err || !finished) bi.send.reset(0n).catch(() => {});
      if (!readDone) bi.recv.stop(0n).catch(() => {});
      cb(err);
    },
  });
  const self = () => d;
  Object.assign(d, { remoteAddress: peer, remotePort: 0, encrypted: false, setTimeout: self, setNoDelay: self, setKeepAlive: self, ref: self, unref: self });
  return d;
}

export function relayOwner(url: string | undefined): string | undefined {
  if (!url) return undefined;
  return /\.iroh\.link\.?(\/|:|$)/i.test(hostOf(url) || url.replace(/^https:\/\//, "")) ? "n0 (the makers of iroh), free public relay" : hostOf(url);
}

/** The Direct link: one iroh endpoint, started when the method is `direct`, stopped when it changes. */
export class DirectLink {
  private ep: Endpoint | null = null;
  private conns = new Set<Connection>();
  private status_: DirectStatus = { state: "off", connected: 0, direct: 0 };
  private server: http.Server;
  private stopping = false;
  /** Bumped by every stop: a start still waiting on the relay when a stop comes closes what it made instead of running. */
  private generation = 0;
  /** The next try after a failed start, and how many starts failed in a row. */
  private retry: NodeJS.Timeout | null = null;
  private failures = 0;

  constructor(private cfg: Config, fetch: (req: Request, env?: unknown) => Response | Promise<Response>, private loadIroh: () => Promise<Iroh> = () => import("@number0/iroh"), private opts: { noRelay?: boolean; onlineMs?: number; retryMs?: number[] } = {}) {
    this.server = http.createServer(getRequestListener(fetch as never));
    this.server.on("clientError", (_e, socket) => socket.destroy());
  }

  /** The running endpoint (tests reach it on this machine). */
  endpoint(): Endpoint | null { return this.ep; }

  status(): DirectStatus {
    if (this.status_.state !== "online") return { ...this.status_ };
    let direct = 0;
    for (const c of this.conns) {
      try { if (c.paths().some((p) => p.isSelected && !p.isRelay)) direct++; } catch { /* closing */ }
    }
    return { ...this.status_, connected: this.conns.size, direct };
  }

  private key(iroh: Iroh): number[] {
    try {
      const b = fs.readFileSync(this.cfg.linkKeyFile);
      if (b.length === 32) return Array.from(b);
    } catch { /* first start */ }
    const bytes = iroh.SecretKey.generate().toBytes();
    fs.mkdirSync(path.dirname(this.cfg.linkKeyFile), { recursive: true });
    fs.writeFileSync(this.cfg.linkKeyFile, Buffer.from(bytes), { mode: 0o600 });
    return bytes;
  }

  async start(): Promise<DirectStatus> {
    if (this.ep) return this.status();
    if (this.status_.state === "starting") return this.status();
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    const gen = this.generation;
    this.stopping = false;
    this.status_ = { state: "starting", connected: 0, direct: 0 };
    let bound: Endpoint | null = null;
    try {
      const iroh = await this.loadIroh();
      const saved = readLinkFile(this.cfg.dataDir);
      const relays = this.cfg.linkRelays.length ? this.cfg.linkRelays : saved.relay ? [saved.relay] : [];
      const b = iroh.Endpoint.builder();
      // Minimal: no lookup service; devices find the hub through the relay named in the QR code.
      b.applyMinimal();
      b.secretKey(this.key(iroh));
      b.alpns([Array.from(Buffer.from(LINK_ALPN))]);
      b.relayMode(this.opts.noRelay ? iroh.RelayMode.disabled() : relays.length ? iroh.RelayMode.customFromUrls(relays) : iroh.RelayMode.defaultMode());
      const ep = await b.bind();
      bound = ep;
      if (!this.opts.noRelay) await Promise.race([ep.online(), new Promise((_, no) => setTimeout(() => no(new Error("no relay answered in 30 seconds (is this computer online?)")), this.opts.onlineMs ?? 30_000))]);
      if (gen !== this.generation) {
        await ep.close().catch(() => {});
        return this.status();
      }
      const relay = ep.addr().relayUrl() ?? relays[0];
      // The relay first given is kept: a paired device knows only that one.
      if (!this.cfg.linkRelays.length && relay && relay !== saved.relay) writeLinkFile(this.cfg.dataDir, { ...readLinkFile(this.cfg.dataDir), relay });
      this.ep = ep;
      this.failures = 0;
      this.status_ = { state: "online", id: ep.id().toString(), relay: relay ?? undefined, relay_by: relayOwner(relay ?? undefined), connected: 0, direct: 0 };
      void this.acceptLoop(ep);
      console.log(`[link] Direct link online, hub key ${ep.id().fmtShort()}, relay ${relay}`);
    } catch (e) {
      this.ep = null;
      // The endpoint made before the relay timed out is closed, not left open.
      if (bound) await bound.close().catch(() => {});
      if (gen !== this.generation) return this.status();
      const msg = (e as Error).message ?? String(e);
      const cannotRun = /Cannot find module|not supported|ERR_DLOPEN/i.test(msg);
      this.status_ = { state: "error", error: cannotRun ? `Direct link cannot run on this system (${msg.split("\n")[0]})` : msg, connected: 0, direct: 0 };
      console.error(`[link] Direct link did not start: ${msg}`);
      if (!cannotRun) this.retryLater(gen);
    }
    return this.status();
  }

  /**
   * A start that failed for a passing reason (after a power cut the PC can boot before the router) is tried again:
   * after 15 s, 30 s, 1 min, 2 min, then every 5 min, until it works or the method changes.
   */
  private retryLater(gen: number): void {
    const delays = this.opts.retryMs ?? [15_000, 30_000, 60_000, 120_000, 300_000];
    const wait = delays[Math.min(this.failures, delays.length - 1)];
    this.failures++;
    this.status_ = { ...this.status_, retry_at: new Date(Date.now() + wait).toISOString() };
    this.retry = setTimeout(() => {
      this.retry = null;
      if (gen === this.generation && !this.ep && !this.stopping) void this.start();
    }, wait);
    this.retry.unref?.();
  }

  private async acceptLoop(ep: Endpoint): Promise<void> {
    while (!this.stopping) {
      const inc = await ep.acceptNext().catch(() => null);
      if (!inc) return;
      void (async () => {
        let conn: Connection;
        try { conn = await (await inc.accept()).connect(); } catch { return; }
        conn.setMaxConcurrentBiStreams(64n);
        const peer = `iroh:${conn.remoteId().toString()}`;
        this.conns.add(conn);
        void conn.closed().catch(() => {}).finally(() => this.conns.delete(conn));
        for (;;) {
          let bi: BiStream;
          try { bi = await conn.acceptBi(); } catch { this.conns.delete(conn); return; }
          this.server.emit("connection", streamSocket(bi, peer));
        }
      })();
    }
  }

  async stop(): Promise<void> {
    this.generation++;
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    this.failures = 0;
    this.stopping = true;
    const ep = this.ep;
    this.ep = null;
    this.conns.clear();
    this.status_ = { state: "off", connected: 0, direct: 0 };
    if (ep) await ep.close().catch(() => {});
  }
}

let active: DirectLink | null = null;

/** Starts the Direct link when it is the method in use. Called once at start. */
export async function startLink(cfg: Config, fetch: (req: Request, env?: unknown) => Response | Promise<Response>): Promise<() => Promise<void>> {
  active = new DirectLink(cfg, fetch);
  if (currentMethod(cfg) === "direct") await active.start();
  syncAnnouncement(cfg);
  return async () => { announce(null); await active?.stop(); active = null; };
}

export function directStatus(): DirectStatus {
  return active?.status() ?? { state: "off", connected: 0, direct: 0 };
}

export function linkView(cfg: Config) {
  return { method: currentMethod(cfg), options: linkAvailability(cfg), direct: directStatus() };
}

/** Changes the method. Devices paired over the old one need pairing again; the page says so before asking. */
export async function chooseLink(cfg: Config, method: unknown): Promise<{ ok: true } | { ok: false; status: 409 | 422; error: string }> {
  if (!LINK_METHODS.includes(method as LinkMethod)) return { ok: false, status: 422, error: "method is direct, tailscale or home" };
  const m = method as LinkMethod;
  const a = linkAvailability(cfg)[m];
  if (!a.available) return { ok: false, status: 409, error: a.how ?? "not available on this hub" };
  writeLinkFile(cfg.dataDir, { ...readLinkFile(cfg.dataDir), method: m });
  if (m === "direct") await active?.start();
  else await active?.stop();
  syncAnnouncement(cfg);
  return { ok: true };
}

/** Home Wi-Fi only announces the hub on the home network (announce.ts); the other methods do not. */
function syncAnnouncement(cfg: Config): void {
  let fp: string | null = null;
  try { fp = currentMethod(cfg) === "home" ? tlsFingerprint(cfg) : null; } catch { fp = null; }
  announce(fp && process.env.EA_NO_ANNOUNCE !== "1" ? announcement(cfg.port, fp) : null);
}
