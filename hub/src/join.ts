import crypto from "node:crypto";
import type { Endpoint } from "@number0/iroh";
import type { Hub } from "./hub.js";
import { normalizeCode } from "./devicekeys.js";
import { currentMethod, directForJoin } from "./link.js";
import { pairingLinks } from "./setup.js";

/**
 * Joining with a phone's yes (packages/shared/CONTRACT.md, Devices): a computer or tablet that runs Direct link shows
 * a QR code with its own iroh key, its relay and a one-time secret; a paired phone scans it and sends it here; the hub
 * makes a pairing code, connects to that key over Direct link, and hands the device the pairing link with a proof that
 * it knows the secret. The secret went only from the device's screen to the phone's camera and on to this hub with the
 * phone's own key, so the proof tells the device it reached the hub the phone belongs to; the code goes only to the key
 * in the QR code. Nothing needs typing, and no third device carries the link.
 */

export const JOIN_ALPN = "aeneas/join/1";
const ALPN = Array.from(Buffer.from(JOIN_ALPN));
/** n0's public relays (iroh's defaults): `use1-1.relay.n0.iroh.link.` and its siblings. */
const N0_RELAY_HOST = /^[a-z0-9-]+\.relay\.n0\.iroh\.link\.?$/i;
const PLATFORMS = ["mac", "ipad", "windows", "android"];
/** How long the device has to answer, and then to claim its code over its new Direct link. */
const DIAL_MS = 20_000;
const ANSWER_MS = 20_000;
const CLAIM_MS = 60_000;
/** Joins at once: each holds a pairing code and a connection for up to 100 seconds. */
const MAX_RUNNING = 2;

export interface JoinAsk { node: string; relay: string; secret: Buffer; name: string; platform: string }

/** The phone's body, checked; a string says what is wrong. The secret is never echoed. */
export function parseJoinAsk(body: Record<string, unknown>): JoinAsk | string {
  const node = typeof body.node === "string" ? body.node.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{64}$/.test(node)) return "That code is not a join code from Aeneas: its device key is not right.";
  const s = typeof body.s === "string" ? body.s.trim() : "";
  const secret = /^[A-Za-z0-9_-]{43}$/.test(s) ? Buffer.from(s, "base64url") : Buffer.alloc(0);
  if (secret.length !== 32) return "That code is not a join code from Aeneas: its secret is not right.";
  const relay = typeof body.relay === "string" ? body.relay.trim() : "";
  if (!relayUrl(relay)) return "That code is not a join code from Aeneas: its relay is not an https address.";
  const name = (typeof body.name === "string" ? body.name : "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 60) || "New device";
  const platform = typeof body.platform === "string" && PLATFORMS.includes(body.platform) ? body.platform : "";
  return { node, relay, secret, name, platform };
}

function relayUrl(s: string): URL | null {
  try {
    const u = new URL(s);
    return u.protocol === "https:" && !u.username && !u.password ? u : null;
  } catch { return null; }
}

/** One relay named two ways (a trailing dot or slash) is the same relay. */
function sameRelay(a: string, b: string): boolean {
  const x = relayUrl(a), y = relayUrl(b);
  return !!x && !!y && x.hostname.replace(/\.$/, "").toLowerCase() === y.hostname.replace(/\.$/, "").toLowerCase() && x.port === y.port;
}

/**
 * Whether the hub may connect to the device through `relay`: one of its own relays, or one of n0's while the hub uses
 * n0's. Never any other address a QR code names, so a crafted code cannot make the hub contact a host of its choosing.
 */
export function relayCheck(relay: string, own: string[], ownOnly: boolean): "ok" | "bad" | "not-own" {
  const u = relayUrl(relay);
  if (!u) return "bad";
  if (own.some((r) => sameRelay(r, relay))) return "ok";
  if (!N0_RELAY_HOST.test(u.hostname)) return "bad";
  return ownOnly ? "not-own" : "ok";
}

/** base64url HMAC-SHA256 with the device's secret over what the device checks: this hub's key, its own, the link. */
export function joinProof(secret: Buffer, hubKey: string, node: string, link: string): string {
  return crypto.createHmac("sha256", secret).update(`aeneas-join/1\n${hubKey.toLowerCase()}\n${node.toLowerCase()}\n${link}`).digest("base64url");
}

export type JoinDelivery = { ok: true } | { ok: false; reached: boolean; error: string };

function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)} seconds`)), ms); timer.unref?.(); })])
    .finally(() => clearTimeout(timer));
}

/**
 * Connects to the device, writes `{ v: 1, link, proof }` on one stream and reads its answer. `addresses`: tests only
 * (the device on this machine, no relay).
 */
export async function deliverJoin(ep: Endpoint, ask: JoinAsk, link: string, opts: { addresses?: string[]; dialMs?: number; answerMs?: number } = {}): Promise<JoinDelivery> {
  const iroh = await import("@number0/iroh");
  const hubKey = ep.id().toString().toLowerCase();
  let conn: import("@number0/iroh").Connection;
  try {
    const addr = new iroh.EndpointAddr(iroh.EndpointId.fromString(ask.node), opts.addresses ? null : ask.relay, opts.addresses ?? []);
    conn = await within(ep.connect(addr, ALPN), opts.dialMs ?? DIAL_MS, "reaching the device");
  } catch (e) {
    return { ok: false, reached: false, error: (e as Error).message };
  }
  try {
    const bi = await conn.openBi();
    const msg = JSON.stringify({ v: 1, link, proof: joinProof(ask.secret, hubKey, ask.node, link) });
    await bi.send.writeAll(Array.from(Buffer.from(msg)));
    await bi.send.finish();
    const raw = Buffer.from(await within(bi.recv.readToEnd(4096), opts.answerMs ?? ANSWER_MS, "the device's answer")).toString("utf8");
    let answer: { ok?: unknown; error?: unknown } = {};
    try { answer = JSON.parse(raw) as typeof answer; } catch { return { ok: false, reached: true, error: "its answer was not readable" }; }
    if (answer.ok === true) return { ok: true };
    const said = typeof answer.error === "string" ? answer.error.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200) : "";
    return { ok: false, reached: true, error: said || "it refused the link" };
  } catch (e) {
    return { ok: false, reached: true, error: (e as Error).message };
  } finally {
    try { conn.close(0n, Array.from(Buffer.from("done"))); } catch { /* already closed */ }
  }
}

/** Codes handed to joining devices, waiting for their claim (app.ts calls `joinClaimed` from POST /devices/claim). */
const waiting = new Map<string, (d: { device_id: string; name: string }) => void>();

export function joinClaimed(code: string, device: { device_id: string; name: string }): void {
  waiting.get(normalizeCode(code))?.(device);
}

function claimOf(code: string, ms: number): { promise: Promise<{ device_id: string; name: string } | null>; cancel: () => void } {
  let done: (d: { device_id: string; name: string } | null) => void = () => {};
  const promise = new Promise<{ device_id: string; name: string } | null>((resolve) => { done = resolve; });
  const timer = setTimeout(() => done(null), ms);
  timer.unref?.();
  const finish = (d: { device_id: string; name: string } | null) => { clearTimeout(timer); waiting.delete(code); done(d); };
  waiting.set(code, (d) => finish(d));
  return { promise, cancel: () => finish(null) };
}

/** The device's own sentence, kept whole; it usually says what to do, else the phone is told to scan again. */
function refusedBy(name: string, said: string): string {
  const sentence = /[.?]$/.test(said) ? said : `${said}.`;
  return `${name} did not take the link. ${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}${/again/i.test(sentence) ? "" : " Scan the code on its screen again."}`;
}

let running = 0;

export interface JoinResult { status: 200 | 202 | 409 | 422 | 429 | 502; body: Record<string, unknown> }

/**
 * `POST /devices/join`: the phone's yes. `by` is the phone's device id (the code is made by it, as with Pair another
 * device); `address` is the address the phone reached the hub at, which the link carries as pairing links do.
 */
export async function joinDevice(hub: Hub, body: Record<string, unknown>, by: string | undefined, address: string,
  opts: { addresses?: string[]; dialMs?: number; answerMs?: number; claimMs?: number } = {}): Promise<JoinResult> {
  const ask = parseJoinAsk(body);
  if (typeof ask === "string") return { status: 422, body: { error: ask } };
  if (currentMethod(hub.cfg) !== "direct") {
    return { status: 409, body: { error: `This hub is not on Direct link, so ${ask.name} cannot join this way. On ${ask.name}, type the hub's address and a pairing code instead.` } };
  }
  const d = directForJoin(hub.cfg);
  if (!d.endpoint || d.status.state !== "online" || !d.status.id || (!d.status.relay && !opts.addresses)) {
    return { status: 409, body: { error: "This hub's Direct link is not online right now. Try again in a minute." } };
  }
  if (!opts.addresses) {
    const relay = relayCheck(ask.relay, d.relays, d.own);
    if (relay === "bad") return { status: 422, body: { error: "That code is not a join code from Aeneas: its relay is not one this hub uses." } };
    if (relay === "not-own") return { status: 409, body: { error: `This hub uses its own relay, so ${ask.name} cannot join this way. Open a pairing link on ${ask.name} instead.` } };
  }
  if (running >= MAX_RUNNING) return { status: 429, body: { error: "Two devices are joining already. Wait a minute, then try again." } };
  running++;
  try {
    const links = pairingLinks(hub, address, ask.name, by);
    if (!links.node && !opts.addresses) return { status: 409, body: { error: "This hub's Direct link is not online right now. Try again in a minute." } };
    const code = normalizeCode(links.code);
    const claim = claimOf(code, opts.claimMs ?? CLAIM_MS);
    const sent = await deliverJoin(d.endpoint, ask, links.app, opts);
    if (!sent.ok) {
      claim.cancel();
      // The code it was made for is spent here, so nobody else can use it.
      hub.deviceKeys.claim(code);
      // What the device said is not logged: it is the device's text, not the hub's.
      console.log(`[devices] join of ${ask.node.slice(0, 8)} failed: ${sent.reached ? "it refused the link" : "not reached"}`);
      return {
        status: 502,
        body: { error: sent.reached
          ? refusedBy(ask.name, sent.error)
          : `${ask.name} did not answer. Keep Set up open on it, check it is online, then scan its code again.` },
      };
    }
    console.log(`[devices] join: ${ask.node.slice(0, 8)} took the link (${ask.platform || "device"})`);
    const claimed = await claim.promise;
    if (claimed) return { status: 200, body: { device_id: claimed.device_id, name: claimed.name } };
    return { status: 202, body: { name: ask.name, state: "sent" } };
  } finally {
    running--;
  }
}
