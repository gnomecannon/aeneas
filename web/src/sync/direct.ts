import { isTauri } from "../tauri/bridge";

/**
 * Direct link (iroh) addresses, the same as the iPhone and Mac apps keep: `iroh://<hub key>?relay=<relay url>`. The hub
 * key is 64 hex characters (the public key the pairing QR code carries); the relay is the one the hub named there.
 *
 * Requests to such a hub go through the Windows and Android apps' own Direct link (src-tauri/src/link.rs). A plain
 * browser cannot open one: the web app in a browser is served by the hub itself and reaches it at its own address.
 */
export interface DirectHub { node: string; relay: string }

const KEY_RE = /^[0-9a-f]{64}$/;

export function validRelay(r: string): boolean {
  try { return new URL(r).protocol === "https:"; } catch { return false; }
}

export function directAddress(node: string, relay: string): string {
  return `iroh://${node.toLowerCase()}?relay=${encodeURIComponent(relay)}`;
}

export function parseDirect(address: string): DirectHub | null {
  const m = /^iroh:\/\/([0-9a-fA-F]{64})\/?(?:\?(.*))?$/.exec(address.trim());
  if (!m) return null;
  const relay = new URLSearchParams(m[2] ?? "").get("relay") ?? "";
  if (!validRelay(relay)) return null;
  return { node: m[1].toLowerCase(), relay };
}

export function isDirect(address: string): boolean {
  return /^iroh:\/\//i.test(address.trim());
}

/** The hubs this page talks to over Direct link, by key (a request URL carries the key only). */
const relays = new Map<string, string>();

/** The base for request URLs to a Direct link hub (`iroh://<key>`), its relay kept for the requests. */
export function directBase(address: string): string | null {
  const d = parseDirect(address);
  if (!d) return null;
  relays.set(d.node, d.relay);
  return `iroh://${d.node}`;
}

/** Who runs a relay, said plainly (the same words as the hub's Settings). */
export function relayOwner(relay: string): string {
  let host = relay;
  try { host = new URL(relay).hostname; } catch { /* as given */ }
  return /\.iroh\.link\.?$/.test(host) ? "n0, the makers of iroh (free public relay)" : host;
}

type LinkEvent =
  | { kind: "head"; status: number; headers: [string, string][] }
  | { kind: "data"; b64: string }
  | { kind: "end" }
  | { kind: "error"; message: string };

let nextId = 1;

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** `fetch` for a Direct link hub, through the app's own connection. The answer streams (the live updates). */
export async function directFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const req = new Request(raw.replace(/^iroh:/i, "http:"), input instanceof Request ? new Request(input, init) : init);
  const url = new URL(req.url);
  const node = url.hostname.toLowerCase();
  const relay = relays.get(node);
  if (!KEY_RE.test(node) || !relay) throw new TypeError("This Direct link hub is not known to this page");
  if (!isTauri) throw new TypeError("Direct link works in the Aeneas app (Windows, Android, iPhone, Mac), not in a browser");
  const { invoke, Channel } = await import("@tauri-apps/api/core");
  const body = req.body ? new Uint8Array(await req.arrayBuffer()) : null;
  const headers: [string, string][] = [];
  req.headers.forEach((v, k) => headers.push([k, v]));
  const id = nextId++;
  const signal = init.signal ?? undefined;
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  return new Promise<Response>((resolve, reject) => {
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let settled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(c) { controller = c; },
      cancel() { void invoke("link_cancel", { id }); },
    });
    const fail = (e: Error) => {
      if (!settled) { settled = true; reject(e); }
      else { try { controller?.error(e); } catch { /* closed */ } }
    };
    signal?.addEventListener("abort", () => {
      void invoke("link_cancel", { id });
      fail(new DOMException("Aborted", "AbortError"));
    }, { once: true });
    const channel = new Channel<LinkEvent>();
    channel.onmessage = (ev) => {
      if (ev.kind === "head") {
        settled = true;
        // A response to a HEAD, or a 204/304, has no body.
        const empty = req.method === "HEAD" || ev.status === 204 || ev.status === 304;
        resolve(new Response(empty ? null : stream, { status: ev.status, headers: ev.headers }));
      } else if (ev.kind === "data") {
        try { controller?.enqueue(unb64(ev.b64)); } catch { /* the page stopped reading */ }
      } else if (ev.kind === "end") {
        try { controller?.close(); } catch { /* closed */ }
      } else {
        fail(new TypeError(`Could not reach the hub over Direct link: ${ev.message}`));
      }
    };
    invoke("link_fetch", { id, node, relay, method: req.method, path: url.pathname + url.search, headers, body: body ? b64(body) : null, onEvent: channel })
      .catch((e) => fail(new TypeError(String(e))));
  });
}

/** The connection right now, for Settings: null outside the app. */
export async function directState(node: string): Promise<{ connected: boolean; direct: boolean; rtt_ms: number | null } | null> {
  if (!isTauri) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("link_state", { node });
}

/** `fetch`, or the Direct link for `iroh://` addresses. */
export function hubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return /^iroh:\/\//i.test(u) ? directFetch(input, init) : fetch(input, init);
}
