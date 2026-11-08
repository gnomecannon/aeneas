import fs from "node:fs";
import http from "node:http";

/**
 * The model gate: one small server in front of the machine's model server (Ollama) that every hub on the machine talks
 * to, so several people's hubs share one model without getting in each other's way (`tsx src/main.ts gate`).
 *
 * - Model runs (`/api/chat`, `/api/generate`, embeddings, the OpenAI-shaped `/v1/...`) take one of `slots` places
 *   (EA_GATE_SLOTS, default 1: Ollama's OLLAMA_NUM_PARALLEL). The rest wait in a queue.
 * - The queue goes by what each call is for (`x-aeneas-priority`, sent by the hub): someone waiting on a reply
 *   (`chat`) first, then a capture being filed (`filing`), then background reading (`background`: mail, note tags,
 *   imports). Among equals the person served longest ago goes first, so two people asking at once take turns call by
 *   call, and one person's long tool chain cannot shut the other out.
 * - A chat that finds every place taken by background work stops the newest of those (the hub tries it again later,
 *   not counted as a failure: 503 with `x-aeneas-gate: gave-way`).
 * - A warm-up (`warm`: reading the shared prompt into the model's cache when someone opens the assistant) never
 *   waits: it runs only on an idle model that nobody else used in the last two minutes, since it would push their
 *   conversation out of the cache (503 `x-aeneas-gate: busy`).
 * - Who is calling comes from the operating system, not from the request: on Linux the connection's owner (its uid in
 *   /proc/net/tcp) names the account, and each person's hub runs in its own account. A hub cannot claim to be another.
 * - Pulling, deleting or creating models on the shared server is for the account the gate runs as (the machine's owner);
 *   other accounts get 403. `EA_GATE_MODELS` (a comma list) limits which models other accounts may run, so no one
 *   loads a second large model that would push the shared one out of GPU memory.
 * - `GET /gate/status` says how busy it is: counts for everyone, names only for the owner.
 */

export type Priority = "chat" | "filing" | "background" | "warm";
const RANK: Record<Priority, number> = { chat: 0, filing: 1, background: 2, warm: 3 };
export const PRIORITIES = Object.keys(RANK) as Priority[];

/** How long after someone's last model call a warm-up for someone else is refused (it would evict their cache). */
export const WARM_GUARD_MS = 120_000;

export class GateBusy extends Error {
  constructor(message: string) { super(message); this.name = "GateBusy"; }
}

interface Waiting {
  id: number;
  person: string;
  priority: Priority;
  at: number;
  grant: (lease: Lease) => void;
  fail: (e: Error) => void;
  onPreempt?: () => void;
}

interface Running { id: number; person: string; priority: Priority; since: number; onPreempt?: () => void }

export interface Lease { id: number; release: () => void }

/**
 * The queue and the places, without any networking (tested on its own). `acquire` resolves when the call may run; the
 * caller runs it and then calls `release` exactly once (a second call does nothing).
 */
export class Scheduler {
  private seq = 0;
  private readonly queue: Waiting[] = [];
  private readonly running = new Map<number, Running>();
  /** When each person last got a place: the one served longest ago goes first among equals. */
  private readonly served = new Map<string, number>();
  /** When each person last used the model (started or finished a call that was not a warm-up). */
  private readonly used = new Map<string, number>();

  constructor(public slots = 1, private readonly now: () => number = () => Date.now()) {
    if (!Number.isInteger(slots) || slots < 1) this.slots = 1;
  }

  acquire(person: string, priority: Priority, opts: { onPreempt?: () => void; signal?: AbortSignal } = {}): Promise<Lease> {
    if (priority === "warm") {
      if (this.running.size >= this.slots || this.queue.length) return Promise.reject(new GateBusy("the shared model is in use"));
      const t = this.now();
      for (const [p, at] of this.used) if (p !== person && t - at < WARM_GUARD_MS) return Promise.reject(new GateBusy("someone else used the shared model just now"));
      return Promise.resolve(this.start({ id: ++this.seq, person, priority, onPreempt: opts.onPreempt }));
    }
    return new Promise<Lease>((resolve, reject) => {
      if (opts.signal?.aborted) { reject(new Error("caller left")); return; }
      const w: Waiting = { id: ++this.seq, person, priority, at: this.now(), grant: resolve, fail: reject, onPreempt: opts.onPreempt };
      this.queue.push(w);
      opts.signal?.addEventListener("abort", () => {
        const i = this.queue.indexOf(w);
        if (i >= 0) { this.queue.splice(i, 1); reject(new Error("caller left")); }
      }, { once: true });
      this.dispatch();
      if (this.queue.includes(w) && priority === "chat") this.preemptFor();
    });
  }

  /** Counts per priority and who is running, for /gate/status. */
  status(): { slots: number; running: { person: string; priority: Priority; seconds: number }[]; waiting: { person: string; priority: Priority; seconds: number }[] } {
    const t = this.now();
    return {
      slots: this.slots,
      running: [...this.running.values()].map((r) => ({ person: r.person, priority: r.priority, seconds: Math.round((t - r.since) / 1000) })),
      waiting: this.queue.map((w) => ({ person: w.person, priority: w.priority, seconds: Math.round((t - w.at) / 1000) })),
    };
  }

  private start(r: { id: number; person: string; priority: Priority; onPreempt?: () => void }): Lease {
    const t = this.now();
    this.running.set(r.id, { ...r, since: t });
    this.served.set(r.person, t);
    if (r.priority !== "warm") this.used.set(r.person, t);
    let released = false;
    return {
      id: r.id,
      release: () => {
        if (released) return;
        released = true;
        const was = this.running.get(r.id);
        this.running.delete(r.id);
        if (was && was.priority !== "warm") this.used.set(was.person, this.now());
        this.dispatch();
      },
    };
  }

  /** The next call to run: highest priority, then the person served longest ago, then the one waiting longest. */
  private next(): Waiting | undefined {
    let best: Waiting | undefined;
    for (const w of this.queue) {
      if (!best) { best = w; continue; }
      const byRank = RANK[w.priority] - RANK[best.priority];
      if (byRank) { if (byRank < 0) best = w; continue; }
      const byRunning = this.runningFor(w.person) - this.runningFor(best.person);
      if (byRunning) { if (byRunning < 0) best = w; continue; }
      const byServed = (this.served.get(w.person) ?? 0) - (this.served.get(best.person) ?? 0);
      if (byServed) { if (byServed < 0) best = w; continue; }
      if (w.at < best.at || (w.at === best.at && w.id < best.id)) best = w;
    }
    return best;
  }

  private runningFor(person: string): number {
    let n = 0;
    for (const r of this.running.values()) if (r.person === person) n++;
    return n;
  }

  private dispatch(): void {
    while (this.running.size < this.slots && this.queue.length) {
      const w = this.next()!;
      this.queue.splice(this.queue.indexOf(w), 1);
      w.grant(this.start(w));
    }
  }

  /** A chat is waiting and every place is taken: stop the newest background call, if any holds a place. */
  private preemptFor(): void {
    if (this.running.size < this.slots) return;
    let victim: Running | undefined;
    for (const r of this.running.values()) if (r.priority === "background" && r.onPreempt && (!victim || r.since > victim.since)) victim = r;
    if (!victim) return;
    const stop = victim.onPreempt!;
    victim.onPreempt = undefined;
    stop();
  }
}

/** Paths that run the model and so take a place. */
const RUNS = new Set(["/api/chat", "/api/generate", "/api/embed", "/api/embeddings", "/v1/chat/completions", "/v1/completions", "/v1/embeddings"]);
/** Paths that change what the shared server holds: only the gate's own account. */
const ADMIN = /^\/api\/(pull|push|create|copy|delete|blobs)(\/|$)/;

/** The uid owning the local end of a loopback TCP connection from `remotePort`, read from /proc/net/tcp{,6}. */
export function uidForPort(remotePort: number, tables: string[]): number | null {
  const hexPort = remotePort.toString(16).toUpperCase().padStart(4, "0");
  for (const table of tables) {
    for (const line of table.split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      // sl local_address rem_address st tx:rx tr:when retrnsmt uid ...
      if (cols.length < 8) continue;
      const local = cols[1];
      if (!local || !local.endsWith(`:${hexPort}`)) continue;
      const uid = Number(cols[7]);
      if (Number.isInteger(uid)) return uid;
    }
  }
  return null;
}

/** Account names by uid from /etc/passwd. */
export function passwdNames(text: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of text.split("\n")) {
    const f = line.split(":");
    if (f.length >= 3 && /^\d+$/.test(f[2])) out.set(Number(f[2]), f[0]);
  }
  return out;
}

export interface GateOptions {
  port: number;
  host?: string;
  upstream: string;
  slots: number;
  /** Models that may run; empty: any. */
  models: string[];
  /** The account allowed to change the server's models (the gate's own uid). */
  ownerUid: number | null;
  /** For tests and machines without /proc: who a connection belongs to. */
  identify?: (req: http.IncomingMessage) => { uid: number | null; person: string };
}

function readOr(file: string): string { try { return fs.readFileSync(file, "utf8"); } catch { return ""; } }

/** Who is on the other end of a connection to the gate: the Linux account that opened it. */
function procIdentify(req: http.IncomingMessage): { uid: number | null; person: string } {
  const port = req.socket.remotePort;
  const tables = [readOr("/proc/net/tcp"), readOr("/proc/net/tcp6")].filter(Boolean);
  if (!tables.length || !port) return { uid: null, person: "local" };
  const uid = uidForPort(port, tables);
  if (uid === null) return { uid: null, person: "unknown" };
  return { uid, person: passwdNames(readOr("/etc/passwd")).get(uid) ?? `uid ${uid}` };
}

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage, limit = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new Error("too large")); req.destroy(); return; }
      parts.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });
}

/** Forward one request to the model server and stream its answer back. Returns when the answer has ended. */
function forward(opts: GateOptions, req: http.IncomingMessage, res: http.ServerResponse, body: Buffer | null, ctl?: AbortController): Promise<void> {
  return new Promise((resolve) => {
    const up = new URL(req.url ?? "/", opts.upstream);
    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (["host", "connection", "content-length", "transfer-encoding", "x-aeneas-priority", "x-aeneas-person"].includes(k)) continue;
      headers[k] = v;
    }
    if (body) headers["content-length"] = String(body.length);
    const out = http.request(up, { method: req.method, headers, signal: ctl?.signal }, (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
      upRes.on("end", () => resolve());
      upRes.on("error", () => { res.destroy(); resolve(); });
    });
    out.on("error", (e) => {
      if (ctl?.signal.aborted) { resolve(); return; }
      send(res, 502, { error: `model server: ${(e as NodeJS.ErrnoException).code ?? e.message}` });
      resolve();
    });
    res.on("close", () => { if (!res.writableFinished) out.destroy(); resolve(); });
    if (body) out.end(body); else req.pipe(out);
  });
}

export function createGate(opts: GateOptions): { server: http.Server; scheduler: Scheduler } {
  const scheduler = new Scheduler(opts.slots);
  const identify = opts.identify ?? procIdentify;
  const server = http.createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const who = identify(req);
    try {
      if (req.method === "GET" && path === "/gate/status") {
        const s = scheduler.status();
        const isOwner = opts.ownerUid !== null && who.uid === opts.ownerUid;
        // Other people see that the model is busy, not whose question it is.
        const view = isOwner ? s : {
          slots: s.slots,
          running: s.running.map((r) => ({ priority: r.priority, seconds: r.seconds, mine: r.person === who.person })),
          waiting: s.waiting.map((w) => ({ priority: w.priority, seconds: w.seconds, mine: w.person === who.person })),
        };
        send(res, 200, { gate: true, you: who.person, ...view });
        return;
      }
      if (ADMIN.test(path) && (opts.ownerUid === null || who.uid !== opts.ownerUid)) {
        send(res, 403, { error: "only the machine's owner adds or removes models on the shared model server" });
        return;
      }
      if (req.method !== "POST" || !RUNS.has(path)) { await forward(opts, req, res, null); return; }

      const body = await readBody(req);
      // The owner may run any model (they choose the machine's models); everyone else the shared ones.
      const isOwner = opts.ownerUid !== null && who.uid === opts.ownerUid;
      if (opts.models.length && !isOwner) {
        let model = "";
        try { model = String((JSON.parse(body.toString("utf8")) as { model?: unknown }).model ?? ""); } catch { /* not JSON: the server says so */ }
        const norm = (m: string) => (m.includes(":") ? m : `${m}:latest`);
        if (model && !opts.models.some((m) => norm(m) === norm(model))) {
          send(res, 403, { error: `the shared model server runs ${opts.models.join(", ")} for everyone on this machine; ${model} is not one of them` });
          return;
        }
      }
      const raw = String(req.headers["x-aeneas-priority"] ?? "chat");
      const priority: Priority = (PRIORITIES as string[]).includes(raw) ? (raw as Priority) : "chat";
      const left = new AbortController();
      res.on("close", () => { if (!res.writableFinished) left.abort(); });
      const upstream = new AbortController();
      let gaveWay = false;
      let lease: Lease;
      try {
        lease = await scheduler.acquire(who.person, priority, {
          signal: left.signal,
          onPreempt: () => { gaveWay = true; upstream.abort(); send(res, 503, { error: "stopped for someone's chat; try again later" }, { "x-aeneas-gate": "gave-way" }); },
        });
      } catch (e) {
        if (e instanceof GateBusy) send(res, 503, { error: e.message }, { "x-aeneas-gate": "busy" });
        else res.destroy();
        return;
      }
      try {
        if (!left.signal.aborted) await forward(opts, req, res, body, upstream);
      } finally {
        lease.release();
        // Counts only: whose call it was stays out of the log.
        if (gaveWay) console.log(`[gate] a ${priority} call gave way to a chat`);
      }
    } catch (e) {
      send(res, 500, { error: (e as Error).message.slice(0, 200) });
    }
  });
  // Replies can take minutes while a long answer is written.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  return { server, scheduler };
}

export function gateOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): GateOptions {
  const slots = Number(env.EA_GATE_SLOTS ?? 1);
  return {
    port: Number(env.EA_GATE_PORT ?? 11435),
    host: env.EA_GATE_HOST || "127.0.0.1",
    upstream: (env.EA_GATE_UPSTREAM || "http://127.0.0.1:11434").replace(/\/+$/, ""),
    slots: Number.isInteger(slots) && slots > 0 ? slots : 1,
    models: (env.EA_GATE_MODELS ?? "").split(",").map((m) => m.trim()).filter(Boolean),
    ownerUid: typeof process.getuid === "function" ? process.getuid() : null,
  };
}

export function runGate(opts: GateOptions = gateOptionsFromEnv()): http.Server {
  const { server } = createGate(opts);
  server.listen(opts.port, opts.host ?? "127.0.0.1", () => {
    console.log(`[gate] on ${opts.host ?? "127.0.0.1"}:${opts.port} in front of ${opts.upstream}, ${opts.slots} place${opts.slots === 1 ? "" : "s"}${opts.models.length ? `, models ${opts.models.join(", ")}` : ""}`);
  });
  return server;
}
