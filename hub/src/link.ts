import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import type { Socket } from "node:net";
import { Duplex } from "node:stream";
import { getRequestListener } from "@hono/node-server";
import type { Config } from "./config.js";
import { isLoopbackHost, isPrivateV4, loadTls, tlsFingerprint, type TlsFiles } from "./tls.js";
import { announce, announcement, type Announcement } from "./announce.js";
import { HomeCertError, HomeListener, homeAddresses, homeCertificate, homeConnectionAllowed, hubId, portOfAnotherHub } from "./homeroute.js";
import { errCode } from "./logsafe.js";
import { doorView, setDoor, type DoorView } from "./tsdoor.js";

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
 *
 * Besides Direct link or Tailscale, the hub also answers on the home network (the home route, homeroute.ts, on unless
 * `home_route: false`), so devices at home keep syncing while the internet is down. Apps learn every route from
 * `GET /link/routes` and tell hubs apart by the hub's id, not by the address they used.
 */
export type LinkMethod = "direct" | "tailscale" | "home";
export const LINK_METHODS: LinkMethod[] = ["direct", "tailscale", "home"];
export const LINK_ALPN = "aeneas/link/1";

/** link.json. `home_route` and `announce` left out mean true; `tailscale_door` left out means off (tsdoor.ts). */
interface LinkFile { method?: LinkMethod; relay?: string; home_route?: boolean; announce?: boolean; tailscale_door?: boolean }

const linkFile = (dataDir: string) => path.join(dataDir, "link.json");

export function readLinkFile(dataDir: string): LinkFile {
  try {
    const j = JSON.parse(fs.readFileSync(linkFile(dataDir), "utf8")) as LinkFile;
    return {
      method: LINK_METHODS.includes(j.method as LinkMethod) ? j.method : undefined,
      relay: typeof j.relay === "string" && /^https:\/\//.test(j.relay) ? j.relay : undefined,
      home_route: typeof j.home_route === "boolean" ? j.home_route : undefined,
      announce: typeof j.announce === "boolean" ? j.announce : undefined,
      tailscale_door: typeof j.tailscale_door === "boolean" ? j.tailscale_door : undefined,
    };
  } catch { return {}; }
}

function writeLinkFile(dataDir: string, f: LinkFile): void {
  const p = linkFile(dataDir);
  fs.writeFileSync(`${p}.tmp`, JSON.stringify(f, null, 2));
  fs.renameSync(`${p}.tmp`, p);
}

/**
 * Whether the Direct link's library (@number0/iroh 1.2.0) has a build for this computer: Apple silicon Macs, Linux
 * on x86_64 and ARM, Windows on x64 and ARM. An Intel Mac has none, so a hub there could never start the link and no
 * device would find it; it is not offered there (deploy/install.sh asks for another way in too).
 */
export function directLinkRuns(platform: string = process.platform, arch: string = process.arch): boolean {
  if (platform === "darwin") return arch === "arm64";
  if (platform === "linux") return arch === "x64" || arch === "arm64" || arch === "arm";
  if (platform === "win32") return arch === "x64" || arch === "arm64";
  return false;
}

const DIRECT_CANNOT_RUN = "Direct link does not run on this computer: its library has no build for it (an Intel Mac, for one). Choose Home Wi-Fi only, or Tailscale to reach the hub away from home. To change it, run the hub installer again.";

const DIRECT_NEEDS_VCRUNTIME = "This PC most likely does not have the Microsoft Visual C++ runtime, which the Direct link needs. Run the hub installer again, which installs it, or install the Microsoft Visual C++ Redistributable (x64) from Microsoft and restart the hub.";

/**
 * What the hub says when the Direct link's library cannot load, or null for a failure that passes (tried again later).
 * On Windows the library is installed but needs the Microsoft Visual C++ runtime (vcruntime140.dll): without it Windows
 * says "The specified module could not be found" and iroh's loader "Cannot find native binding", which read as an npm
 * problem (a clean Windows 11, 2026-11). The hub installer installs the runtime when it is missing.
 */
export function directLoadFailure(msg: string, platform: string = process.platform): string | null {
  if (!/Cannot find module|Cannot find native binding|not supported|ERR_DLOPEN|specified module could not be found/i.test(msg)) return null;
  if (platform === "win32") return DIRECT_NEEDS_VCRUNTIME;
  return `Direct link cannot run on this system (${msg.split("\n")[0]})`;
}

/** Whether this hub can offer each method as it is installed now, and what to do when it cannot. */
export function linkAvailability(cfg: Config): Record<LinkMethod, { available: boolean; how?: string }> {
  const tailnet = /\.ts\.net(:\d+)?$/i.test(hostOf(cfg.publicUrl));
  const home = !isLoopbackHost(cfg.bindHost) && !!cfg.tlsCert;
  return {
    direct: directLinkRuns() ? { available: true } : { available: false, how: DIRECT_CANNOT_RUN },
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
  /**
   * Whether the relay answered. Online without it (no internet), devices at home still connect (the home route, or
   * straight to the hub), and the relay is asked again in the background until it answers.
   */
  relay_ok: boolean;
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

/** After a failed start, and between looks for the relay: 15 s, 30 s, 1 min, 2 min, then every 5 min. */
const RETRY_MS = [15_000, 30_000, 60_000, 120_000, 300_000];

/** `p`, or `onTime` once `ms` passed (the timer never keeps the hub running). */
function within<T, U>(p: Promise<T>, ms: number, onTime: U): Promise<T | U> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<U>((resolve) => { timer = setTimeout(() => resolve(onTime), ms); timer.unref?.(); })]).finally(() => clearTimeout(timer));
}

/**
 * The Direct link key (what `iroh://` addresses and the QR code carry, 64 hex characters) of the 32-byte secret in the
 * link key file: its Ed25519 public key, worked out without iroh. Null for a file that is not such a key.
 */
export function directKeyOf(seed: Buffer): string | null {
  if (seed.length !== 32) return null;
  try {
    const priv = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
    return crypto.createPublicKey(priv).export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  } catch { return null; }
}

/** The Direct link: one iroh endpoint, started when the method is `direct`, stopped when it changes. */
export class DirectLink {
  private ep: Endpoint | null = null;
  private conns = new Set<Connection>();
  private status_: DirectStatus = { state: "off", relay_ok: false, connected: 0, direct: 0 };
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
    this.status_ = { state: "starting", relay_ok: false, connected: 0, direct: 0 };
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
      if (gen !== this.generation) {
        await ep.close().catch(() => {});
        return this.status();
      }
      // Online once bound, relay or not: with the internet down, devices at home still reach the hub, and the relay
      // is asked again in the background. The relay shown until one answers is the one kept (or set), if any.
      this.ep = ep;
      this.failures = 0;
      const known = relays[0];
      this.status_ = { state: "online", id: ep.id().toString(), relay: known, relay_by: relayOwner(known), relay_ok: false, connected: 0, direct: 0 };
      void this.acceptLoop(ep);
      if (this.opts.noRelay) {
        console.log(`[link] Direct link online, hub key ${ep.id().fmtShort()}, no relay`);
        return this.status();
      }
      const wait = this.opts.onlineMs ?? 30_000;
      const answered = await within(this.watchRelay(ep, gen), wait, false);
      if (!answered && this.ep === ep) console.log(`[link] Direct link online, hub key ${ep.id().fmtShort()}; no relay answered in ${Math.ceil(wait / 1000)} seconds (is this computer online?), so it keeps asking in the background`);
    } catch (e) {
      this.ep = null;
      // The endpoint made before something failed is closed, not left open.
      if (bound) await bound.close().catch(() => {});
      if (gen !== this.generation) return this.status();
      const msg = (e as Error).message ?? String(e);
      const cannotRun = directLoadFailure(msg);
      this.status_ = { state: "error", error: cannotRun ?? msg, relay_ok: false, connected: 0, direct: 0 };
      console.error(`[link] Direct link did not start: ${msg}`);
      if (!cannotRun) this.retryLater(gen);
    }
    return this.status();
  }

  /**
   * Waits for the relay, asking again after the delays of a failed start, until it answers or the link stops. True
   * once it answered: then the relay is shown, and kept in link.json when it is the first one (a relay is written
   * there only once one answered).
   */
  private watchRelay(ep: Endpoint, gen: number): Promise<boolean> {
    const delays = this.opts.retryMs ?? RETRY_MS;
    const live = () => gen === this.generation && this.ep === ep && !this.stopping;
    // One question kept open across rounds; asked anew only when it failed (a throw counts as failing).
    const ask = () => Promise.resolve().then(() => ep.online()).then(() => true, () => false);
    const pause = (ms: number) => within(new Promise<never>(() => {}), ms, null);
    return (async () => {
      let pending: Promise<boolean> | null = null;
      for (let round = 0; live(); round++) {
        const wait = delays[Math.min(round, delays.length - 1)];
        pending ??= ask();
        const r = await within(pending, wait, null);
        if (!live()) return false;
        if (r === true) { this.relayAnswered(ep); return true; }
        if (r === false) { pending = null; await pause(wait); }
      }
      return false;
    })().catch((e) => {
      // Never a rejection nobody handles (that would stop the hub): the link stays up without the relay.
      console.error(`[link] looking for the relay stopped (${errCode(e)})`);
      return false;
    });
  }

  private relayAnswered(ep: Endpoint): void {
    let relay = this.status_.relay;
    try { relay = ep.addr().relayUrl() ?? relay; } catch { /* closing */ }
    this.status_ = { ...this.status_, relay, relay_by: relayOwner(relay), relay_ok: true };
    console.log(`[link] Direct link online, hub key ${ep.id().fmtShort()}, relay ${relay}`);
    // The relay first given is kept: a paired device knows only that one.
    const saved = readLinkFile(this.cfg.dataDir);
    if (this.cfg.linkRelays.length || !relay || relay === saved.relay) return;
    try { writeLinkFile(this.cfg.dataDir, { ...saved, relay }); } catch (e) { console.error(`[link] the relay could not be kept in link.json (${errCode(e)})`); }
  }

  /**
   * A start that failed for a passing reason (after a power cut the PC can boot before the router) is tried again:
   * after 15 s, 30 s, 1 min, 2 min, then every 5 min, until it works or the method changes.
   */
  private retryLater(gen: number): void {
    const delays = this.opts.retryMs ?? RETRY_MS;
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
    this.status_ = { state: "off", relay_ok: false, connected: 0, direct: 0 };
    if (ep) await ep.close().catch(() => {});
  }
}

let active: DirectLink | null = null;
let home: HomeListener | null = null;

/** How long connections on the home route stay open after it is turned off, so the answer to that request gets out. */
const HOME_STOP_GRACE_MS = 1500;

export interface LinkStartOptions {
  /** Tests only: iroh as loaded, and the Direct link's timings. */
  loadIroh?: () => Promise<Iroh>;
  direct?: { noRelay?: boolean; onlineMs?: number; retryMs?: number[] };
  /** Tests only: the one address the home route listens on (every address otherwise). */
  homeHost?: string;
}

/**
 * Called once at start: makes the hub's id if it has none yet, starts the Direct link when it is the method in use,
 * and the home route and its Bonjour announcement when they are on.
 */
export async function startLink(cfg: Config, fetch: (req: Request, env?: unknown) => Response | Promise<Response>, opts: LinkStartOptions = {}): Promise<() => Promise<void>> {
  hubId(cfg.dataDir);
  const direct = new DirectLink(cfg, fetch, opts.loadIroh, opts.direct);
  // A port that was busy and came free later (homeroute.ts tries again) is announced then.
  const listener = new HomeListener(fetch, { host: opts.homeHost, onListening: () => syncAnnouncement(cfg) });
  active = direct;
  home = listener;
  await Promise.all([currentMethod(cfg) === "direct" ? direct.start() : null, syncHome(cfg)]);
  return async () => {
    if (home === listener) { home = null; announce(null); }
    if (active === direct) active = null;
    await Promise.all([direct.stop(), listener.stop()]);
  };
}

export function directStatus(): DirectStatus {
  return active?.status() ?? { state: "off", relay_ok: false, connected: 0, direct: 0 };
}

export interface HomeView { on: boolean; announce: boolean; port: number; urls: string[]; fp: string | null; error?: string }

/** The certificate the home route serves: the hub's own (EA_TLS_CERT) when it has one, else the home certificate. */
function homeFiles(cfg: Config, make: boolean): TlsFiles | null {
  return loadTls(cfg) ?? homeCertificate(cfg.dataDir, { make });
}

/**
 * The home route as Settings and devices see it. A Home Wi-Fi only hub's own port and certificate are its home route;
 * a Direct link or Tailscale hub's are its second listener's, with addresses only while that answers.
 */
async function homeView(cfg: Config): Promise<HomeView> {
  const saved = readLinkFile(cfg.dataDir);
  const announcing = saved.announce !== false;
  if (currentMethod(cfg) === "home") {
    let fp: string | null = null;
    try { fp = tlsFingerprint(cfg); } catch { fp = null; }
    const every = ["0.0.0.0", "::", ""].includes(cfg.bindHost);
    const ips = !fp ? [] : every ? await homeAddresses() : isPrivateV4(cfg.bindHost) ? [cfg.bindHost] : [];
    return { on: true, announce: announcing, port: cfg.port, urls: ips.map((ip) => `https://${ip}:${cfg.port}`), fp };
  }
  const st = home?.state() ?? { listening: false, port: 0, fp: null };
  let fp = st.fp;
  if (!fp) { try { fp = homeFiles(cfg, false)?.fingerprint ?? null; } catch { fp = null; } }
  const port = st.listening ? st.port : cfg.homePort;
  const urls = st.listening ? (await homeAddresses()).map((ip) => `https://${ip}:${port}`) : [];
  return { on: saved.home_route !== false, announce: announcing, port, urls, fp, ...(st.error ? { error: st.error } : {}) };
}

export async function linkView(cfg: Config) {
  const method = currentMethod(cfg);
  const [home, door] = await Promise.all([homeView(cfg), doorView(method, readLinkFile(cfg.dataDir).tailscale_door === true, cfg.port)]);
  return { method, options: linkAvailability(cfg), direct: directStatus(), home, tailscale_door: door, browser: browserAddresses(cfg, method, home, door) };
}

/**
 * Where a web browser opens the web app. A browser cannot use Direct link, so a Direct link hub offers its home route
 * (at home) and its Tailscale door (on the tailnet) while each is on; the other methods have one address of their own.
 */
export function browserAddresses(cfg: Config, method: LinkMethod | null, home: HomeView, door: DoorView): string[] {
  const app = (u: string) => `${u.replace(/\/+$/, "")}/app/`;
  if (method === "home") return home.urls.map(app);
  if (method === "tailscale") return /^https:\/\//.test(cfg.publicUrl) ? [app(cfg.publicUrl)] : [];
  if (method === "direct") return [...(home.on ? home.urls : []), ...(door.on && door.url ? [door.url] : [])].map(app);
  return [];
}

/**
 * The running Direct link's endpoint and the relays it may hand a joining device (join.ts): EA_LINK_RELAYS when set
 * (`own`: n0's are then not taken), else the relay it keeps.
 */
export function directForJoin(cfg: Config): { endpoint: Endpoint | null; status: DirectStatus; relays: string[]; own: boolean } {
  const saved = readLinkFile(cfg.dataDir).relay;
  const st = directStatus();
  const relays = cfg.linkRelays.length ? cfg.linkRelays : [st.relay, saved].filter((r): r is string => !!r);
  return { endpoint: active?.endpoint() ?? null, status: st, relays, own: cfg.linkRelays.length > 0 };
}

/** The Direct link address devices use away from home (`iroh://<hub key>?relay=<relay>`), or null without a relay yet. */
function directRemote(cfg: Config): string | null {
  const st = directStatus();
  let id = st.id ?? null;
  if (!id) { try { id = directKeyOf(fs.readFileSync(cfg.linkKeyFile)); } catch { id = null; } }
  const relay = st.relay ?? cfg.linkRelays[0] ?? readLinkFile(cfg.dataDir).relay;
  return id && relay ? `iroh://${id.toLowerCase()}?relay=${encodeURIComponent(relay)}` : null;
}

/**
 * `GET /link/routes` (a device key): every way to this hub now. `remote` is the address away from home (Direct link or
 * Tailscale; null for Home Wi-Fi only), `home` the home network addresses and the certificate to pin there. Apps ask
 * on every connect and keep the answer.
 */
export async function linkRoutes(cfg: Config) {
  const method = currentMethod(cfg);
  const h = await homeView(cfg);
  const remote = method === "direct" ? directRemote(cfg) : method === "tailscale" && /^https:\/\//.test(cfg.publicUrl) ? cfg.publicUrl : null;
  return { hub_id: hubId(cfg.dataDir), method, remote, home: { on: h.on, urls: h.urls, fp: h.fp, announce: h.announce } };
}

export type LinkChange = { ok: true } | { ok: false; status: 409 | 422; error: string };

/** Changes the method. Devices paired over the old one need pairing again; the page says so before asking. */
export async function chooseLink(cfg: Config, method: unknown): Promise<LinkChange> {
  if (!LINK_METHODS.includes(method as LinkMethod)) return { ok: false, status: 422, error: "method is direct, tailscale or home" };
  return changeLink(cfg, { method });
}

/**
 * `PUT /setup/link`: the method, the home route and its announcement, and the Tailscale door, any of them at once. Kept
 * in link.json.
 */
export async function changeLink(cfg: Config, body: { method?: unknown; home_route?: unknown; announce?: unknown; tailscale_door?: unknown }): Promise<LinkChange> {
  const { method, home_route: homeRoute, announce: announcing, tailscale_door: doorAsked } = body;
  if (method === undefined && homeRoute === undefined && announcing === undefined && doorAsked === undefined) return { ok: false, status: 422, error: "send method, home_route, announce or tailscale_door" };
  if (homeRoute !== undefined && typeof homeRoute !== "boolean") return { ok: false, status: 422, error: "home_route is true or false" };
  if (announcing !== undefined && typeof announcing !== "boolean") return { ok: false, status: 422, error: "announce is true or false" };
  if (doorAsked !== undefined && typeof doorAsked !== "boolean") return { ok: false, status: 422, error: "tailscale_door is true or false" };
  let m: LinkMethod | undefined;
  if (method !== undefined) {
    if (!LINK_METHODS.includes(method as LinkMethod)) return { ok: false, status: 422, error: "method is direct, tailscale or home" };
    m = method as LinkMethod;
    const a = linkAvailability(cfg)[m];
    if (!a.available) return { ok: false, status: 409, error: a.how ?? "not available on this hub" };
  }
  const saved = readLinkFile(cfg.dataDir);
  const nextMethod = m ?? currentMethod(cfg);
  // The door belongs to a Direct link hub. Another method closes it, except Tailscale, whose own Serve is the same one.
  let door: boolean | undefined;
  if (typeof doorAsked === "boolean") {
    if (doorAsked) {
      const v = await doorView(nextMethod, false, cfg.port);
      if (!v.available) return { ok: false, status: 409, error: v.how ?? "not available on this hub" };
    }
    const refused = await setDoor(doorAsked, cfg.port);
    if (refused) return { ok: false, status: 409, error: refused };
    door = doorAsked;
  } else if (m && m !== "direct" && saved.tailscale_door) {
    if (m !== "tailscale") {
      const refused = await setDoor(false, cfg.port);
      if (refused) console.error(`[link] the Tailscale door stayed open: ${refused}`);
    }
    door = false;
  }
  writeLinkFile(cfg.dataDir, {
    ...saved,
    ...(m ? { method: m } : {}),
    ...(typeof homeRoute === "boolean" ? { home_route: homeRoute } : {}),
    ...(typeof announcing === "boolean" ? { announce: announcing } : {}),
    ...(typeof door === "boolean" ? { tailscale_door: door } : {}),
  });
  await Promise.all([m === "direct" ? active?.start() : m ? active?.stop() : null, syncHome(cfg, HOME_STOP_GRACE_MS)]);
  return { ok: true };
}

/**
 * The check on the hub's own port (main.ts). A Home Wi-Fi only hub takes connections from its home network and from
 * this machine itself, and closes any other before TLS starts; with the other methods the port stays as it is.
 */
export function mainPortGuard(cfg: Config): (socket: Socket) => boolean {
  return (socket) => currentMethod(cfg) !== "home" || homeConnectionAllowed(socket.remoteAddress, socket.localAddress, { loopback: true });
}

/** Starts, keeps or stops the home route to match link.json (`graceMs`: see HOME_STOP_GRACE_MS), then the announcement. */
async function syncHome(cfg: Config, graceMs = 0): Promise<void> {
  const l = home;
  if (l) {
    const m = currentMethod(cfg);
    if ((m !== "direct" && m !== "tailscale") || readLinkFile(cfg.dataDir).home_route === false) await l.stop(graceMs);
    else if (cfg.homePort === cfg.port) await l.fail(`EA_HOME_PORT is the hub's own port (${cfg.port}). Set it to another free port in hub.env and restart the hub.`);
    else if (portOfAnotherHub(cfg.homePort)) await l.fail(`Port ${cfg.homePort} belongs to another person's hub on this computer. Set EA_HOME_PORT in hub.env to a free port and restart the hub.`);
    else {
      let files: TlsFiles | null = null;
      try { files = homeFiles(cfg, true); } catch (e) {
        console.error(`[home] no certificate for the home network (${errCode(e)})`);
        await l.fail(e instanceof HomeCertError ? e.message : `The home certificate could not be made (${(e as NodeJS.ErrnoException).code ?? "error"}).`);
      }
      if (files) await l.start(files, cfg.homePort);
    }
  }
  syncAnnouncement(cfg);
}

/**
 * Bonjour (announce.ts) says where the hub is on the home network: a Home Wi-Fi only hub's own port, or the home
 * route's, each with its certificate's fingerprint, unless `announce` is off. Only a running hub announces (startLink).
 */
function syncAnnouncement(cfg: Config): void {
  announce(home && process.env.EA_NO_ANNOUNCE !== "1" ? wantedAnnouncement(cfg) : null);
}

/** What Bonjour should say now, or null for nothing. */
export function wantedAnnouncement(cfg: Config): Announcement | null {
  if (readLinkFile(cfg.dataDir).announce === false) return null;
  const m = currentMethod(cfg);
  if (m === "home") {
    let fp: string | null = null;
    try { fp = tlsFingerprint(cfg); } catch { fp = null; }
    return fp ? announcement(cfg.port, fp) : null;
  }
  const st = home?.state();
  return (m === "direct" || m === "tailscale") && st?.listening && st.fp ? announcement(st.port, st.fp) : null;
}
