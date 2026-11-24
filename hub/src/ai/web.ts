import { spawn } from "node:child_process";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { nextMatch, withoutBlocks, withoutComments, withoutTags } from "../imports/mail-text.js";
import { isPrivateHost } from "./hosts.js";

/**
 * Web lookups for the assistant (the Web lookups module, off on a new hub). Search goes through the hub's own SearXNG,
 * which passes the query on to the engines in its settings: each of those engines sees the words searched and the
 * address the request leaves from (the home internet address, unless SearXNG and page reads go through Tor). What
 * SearXNG spares is cookies, accounts and a search history kept under the person's name. Pages are fetched by the hub
 * and reduced to plain text before the model sees them. Capture filing never searches (capture-filer.ts, no_web).
 */

/**
 * Web lookups leave only through Tor: search engines and sites see a Tor exit, never the home address. Without Tor
 * on the hub they are off, unless the owner chose otherwise in hub.env (EA_WEB_WITHOUT_TOR=1).
 */
export function webPrivate(cfg: { torSocks: string; webWithoutTor: boolean }): boolean {
  return !!cfg.torSocks || cfg.webWithoutTor;
}

export const NO_TOR = "web lookups go only through Tor, and Tor is not set up on the hub: run the install command again to add it; nothing was sent";

export interface SearchResult { title: string; url: string; snippet: string; published?: string }

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

async function timed<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(new Error(`timed out after ${Math.round(ms / 1000)} s`)), ms);
  try { return await fn(ctl.signal); } finally { clearTimeout(t); }
}

export async function webSearch(baseUrl: string, query: string, limit = 8, timeoutMs = 25_000): Promise<{ query: string; results: SearchResult[] }> {
  if (!baseUrl) throw new Error("web search is not configured on the hub (EA_SEARXNG_URL)");
  const url = `${baseUrl}/search?${new URLSearchParams({ q: query, format: "json", safesearch: "0" })}`;
  const data = await timed(timeoutMs, async (signal) => {
    const res = await fetch(url, { signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`search ${res.status}`);
    return (await res.json()) as { results?: { title?: string; url?: string; content?: string; publishedDate?: string | null }[]; answers?: unknown[] };
  });
  const seen = new Set<string>();
  const results: SearchResult[] = [];
  for (const r of data.results ?? []) {
    if (!r.url || seen.has(r.url)) continue;
    seen.add(r.url);
    results.push({ title: (r.title ?? "").trim(), url: r.url, snippet: (r.content ?? "").replace(/\s+/g, " ").trim().slice(0, 300), ...(r.publishedDate ? { published: String(r.publishedDate).slice(0, 10) } : {}) });
    if (results.length >= limit) break;
  }
  return { query, results };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "-", ndash: "-", hellip: "...", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', copy: "(c)", reg: "(r)", trade: "(tm)" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// A page is read in one pass for each step. A page is hostile input (up to 3 MB), and the hub reads it on its one
// thread: as patterns (`<!--[\s\S]*?-->`, `<(script|style)\b[\s\S]*?<\/\1>`, `<li\b[^>]*>`, `<[^>]+>` and the like)
// each step searched to the end of the page again from every `<!--`, `<style`, `<li` or `<` that was never closed, so a
// page of a few hundred thousand of them held the hub for minutes (2026-11-22). The steps below give the same text as
// those patterns did (test/web-hostile.test.ts holds them, word for word, and checks), with the one-pass helpers mail
// uses for the same reason (imports/mail-text.ts).

/** Elements left out of a page with all that is inside them, to their own closing tag. */
const PAGE_BLOCKS = ["script", "style", "noscript", "svg", "template", "iframe", "nav", "footer", "header", "form", "aside"];

/** What is between the page's first `<title…>` and the `</title>` after it: `/<title[^>]*>([\s\S]*?)<\/title>/i`. */
function titleOf(html: string): string {
  const open = /<title/i.exec(html);
  if (!open) return "";
  // A later <title can only have the same ">" or one further on: when this one has no ">" and "</title>" after it,
  // no later one has either.
  const gt = html.indexOf(">", open.index + 6);
  if (gt < 0) return "";
  const close = /<\/title>/gi;
  close.lastIndex = gt + 1;
  const c = close.exec(html);
  return c ? html.slice(gt + 1, c.index) : "";
}

/** `s` without its first `<head>` element, to the `</head>` after it: `.replace(/<head\b[\s\S]*?<\/head>/i, " ")`. */
function withoutFirstHead(s: string): string {
  const open = /<head\b/gi;
  if (!open.exec(s)) return s;
  const at = open.lastIndex - 5;
  const close = /<\/head>/gi;
  close.lastIndex = open.lastIndex;
  return close.exec(s) ? `${s.slice(0, at)} ${s.slice(close.lastIndex)}` : s;
}

/** What is inside the page's first `<main>` or `<article>` that is closed: `/<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i`. */
function mainOf(s: string): string | null {
  const open = /<(main|article)\b/gi;
  const gt = nextMatch(s, />/g);
  const closers: Record<string, (pos: number) => { at: number; end: number }> = { main: nextMatch(s, /<\/main>/gi), article: nextMatch(s, /<\/article>/gi) };
  for (let m = open.exec(s); m; m = open.exec(s)) {
    const g = gt(open.lastIndex);
    if (g.at < 0) return null; // no ">" from here on: no later one has its tag closed either
    const c = closers[m[1].toLowerCase()](g.end);
    if (c.at < 0) continue; // never closed: the other name may still be
    return s.slice(g.end, c.at);
  }
  return null;
}

/**
 * `s` with each opening tag that starts as `open` (global, case-insensitive, ending where the attributes start) and runs
 * to the next `>` replaced by `to(m)`: `.replace(/<li\b[^>]*>/gi, …)` with `open` /<li\b/gi.
 */
function openTagsReplaced(s: string, open: RegExp, to: (m: RegExpExecArray) => string): string {
  const gt = nextMatch(s, />/g);
  let out = "";
  let at = 0;
  open.lastIndex = 0;
  for (let m = open.exec(s); m; m = open.exec(s)) {
    const g = gt(open.lastIndex);
    if (g.at < 0) break; // no ">" from here on: nothing after this is a tag
    out += s.slice(at, m.index) + to(m);
    at = g.end;
    open.lastIndex = g.end;
  }
  return out + s.slice(at);
}

/** `s` with each `<pre…>…</pre>` written as a fenced code block of its text: `/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi`. */
function presFenced(s: string): string {
  const open = /<pre\b/gi;
  const gt = nextMatch(s, />/g);
  const close = nextMatch(s, /<\/pre>/gi);
  let out = "";
  let at = 0;
  for (let m = open.exec(s); m; m = open.exec(s)) {
    const g = gt(open.lastIndex);
    if (g.at < 0) break;
    const c = close(g.end);
    if (c.at < 0) break; // no "</pre>" from here on: no later <pre> is closed either
    out += `${s.slice(at, m.index)}\n\`\`\`\n${withoutTags(s.slice(g.end, c.at), "")}\n\`\`\`\n`;
    at = c.end;
    open.lastIndex = c.end;
  }
  return out + s.slice(at);
}

/** HTML to readable text: main content when the page marks it, block tags to line breaks, code kept. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = decode(titleOf(html).replace(/\s+/g, " ").trim());
  let body = withoutBlocks(withoutFirstHead(withoutComments(html)), ["title"]);
  const main = mainOf(body);
  if (main !== null && main.length > 500) body = main;
  body = presFenced(withoutBlocks(body, PAGE_BLOCKS)).replace(/<(br|hr)\s*\/?>/gi, "\n");
  body = openTagsReplaced(body, /<li\b/gi, () => "\n- ");
  body = openTagsReplaced(body, /<h([1-6])\b/gi, (m) => `\n\n${"#".repeat(Number(m[1]))} `);
  body = body.replace(/<\/(p|div|section|h[1-6]|li|tr|table|ul|ol|blockquote|dd|dt)>/gi, "\n");
  body = withoutTags(openTagsReplaced(body, /<t[dh]\b/gi, () => " | "), "");
  const text = decode(body)
    .split("\n").map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .filter((l, i, a) => l || (a[i - 1] ?? "") !== "")
    .join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { title, text };
}

/**
 * Fetch through a SOCKS proxy with curl (Node's fetch has no SOCKS support). socks5h resolves names on the proxy
 * side, so neither the page request nor its DNS lookup leaves from the owner's own address. Never falls back to direct.
 */
function curlViaSocks(url: string, socks: string, timeoutMs: number): Promise<{ body: string; type: string; finalUrl: string }> {
  return new Promise((resolve, reject) => {
    // -g: [ ] and { } in an address are part of it, not a list of addresses for curl to work through.
    const args = ["-sS", "-g", "-L", "--max-redirs", "5", "--max-time", String(Math.ceil(timeoutMs / 1000)), "--max-filesize", "3000000",
      "--proto", "=http,https", "--proto-redir", "=http,https", "--socks5-hostname", socks, "-A", UA,
      "-H", "Accept: text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5",
      "-w", "%{stderr}\n@@meta@@%{http_code}\t%{content_type}\t%{url_effective}", url];
    const child = spawn("curl", args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    let size = 0;
    child.stdout.on("data", (b: Buffer) => { size += b.length; if (size <= 3_000_000) out.push(b); });
    child.stderr.on("data", (b: Buffer) => { err += b.toString("utf8"); });
    child.on("error", (e) => reject(new Error(`curl unavailable: ${e.message}`)));
    child.on("close", (code) => {
      const meta = /@@meta@@(\d+)\t([^\t]*)\t(.*)$/m.exec(err);
      if (code !== 0 || !meta) return reject(new Error(`could not load the page through Tor (${err.replace(/@@meta@@.*/s, "").trim().slice(0, 160) || `curl exit ${code}`})`));
      if (Number(meta[1]) >= 400) return reject(new Error(`page returned ${meta[1]}`));
      resolve({ body: Buffer.concat(out).toString("utf8"), type: meta[2], finalUrl: meta[3] || url });
    });
  });
}

/** Addresses on the owner's network a page read may still reach: only tests use it (a server on 127.0.0.1). */
export const pageReads = { allow: new Set<string>() };
const refused = (addr: string) => isNonPublicAddress(addr) && !pageReads.allow.has(addr.replace(/^\[|\]$/g, ""));

/**
 * An IPv6 address as its eight groups, however it is written: "::" opened, leading zeros or none, a dotted IPv4 tail
 * read, a zone left off. Null when it is not one.
 */
export function v6Groups(addr: string): number[] | null {
  let s = addr.split("%")[0];
  if (!net.isIPv6(s)) return null;
  const tail = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (tail) s = `${tail[1]}${((Number(tail[2]) << 8) | Number(tail[3])).toString(16)}:${((Number(tail[4]) << 8) | Number(tail[5])).toString(16)}`;
  const [head, rest] = s.split("::");
  const h = head ? head.split(":") : [];
  const r = rest === undefined ? null : rest ? rest.split(":") : [];
  const groups = r === null ? h : [...h, ...Array(Math.max(0, 8 - h.length - r.length)).fill("0"), ...r];
  return groups.length === 8 ? groups.map((g) => parseInt(g, 16)) : null;
}

/**
 * An address that is not on the public internet: private and tailnet ranges, loopback, link-local, the "this
 * network" block, multicast and reserved, the two blocks of 192.0 kept for protocols and for examples (192.0.0.0/24
 * and 192.0.2.0/24: the rest of 192.0 is sites on the internet, and was refused with them), and for IPv6 everything
 * outside the one block the internet's addresses are given out of (2000::/3), which takes
 * unique-local, link-local, site-local, multicast and every other way of writing an IPv4 address inside one
 * (::a.b.c.d, ::ffff:0:a.b.c.d) with it. Two forms are read by the IPv4 address in them: mapped (::ffff:a.b.c.d) and
 * through a NAT64 gateway (64:ff9b::a.b.c.d), as is a 6to4 address (2002:AABB:CCDD::). An IPv6 address is read by its
 * groups, so a long spelling (0:0:0:0:0:0:0:1) is the same address as its short one.
 */
export function isNonPublicAddress(addr: string): boolean {
  const a = addr.replace(/^\[|\]$/g, "").toLowerCase();
  if (net.isIPv4(a)) {
    const [x, y, z] = a.split(".").map(Number);
    return isPrivateHost(a) || x === 0 || x >= 224 || (x === 198 && (y === 18 || y === 19)) || (x === 192 && y === 0 && (z === 0 || z === 2));
  }
  const g = v6Groups(a);
  if (g) {
    const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
    const inside = (hi: number, lo: number) => isNonPublicAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    // The two forms a public IPv4 address is reached through: decided by the address inside.
    if (zero(0, 5) && g[5] === 0xffff) return inside(g[6], g[7]);
    if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return inside(g[6], g[7]);
    // Everything else outside 2000::/3 is no place on the internet: ::, ::1, the old compatible and translated forms
    // of an IPv4 address (::ffff:0:10.0.0.5 was let through), unique-local, link-local, site-local, multicast, the
    // discard block and what is not given out at all.
    if ((g[0] & 0xe000) !== 0x2000) return true;
    if (g[0] === 0x2002) return inside(g[1], g[2]);
    // Teredo and the documentation block.
    return g[0] === 0x2001 && (g[1] === 0 || g[1] === 0xdb8);
  }
  return isPrivateHost(a);
}

/**
 * A DNS lookup for page reads that refuses any address on the owner's own network. It runs at the moment of each
 * connection (every redirect included), so a name that points somewhere public when checked and private when used
 * (DNS rebinding) is caught too.
 */
const publicOnlyLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) { (callback as (e: Error | null, a: string, f: number) => void)(err, "", 0); return; }
    const list = (addresses as unknown as dns.LookupAddress[]);
    const bad = list.find((x) => refused(x.address));
    if (bad || !list.length) { (callback as (e: Error | null, a: string, f: number) => void)(new Error(`${hostname} is on your own network; this tool reads public pages only`), "", 0); return; }
    if ((options as dns.LookupOptions).all) (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
    else (callback as (e: null, a: string, f: number) => void)(null, list[0].address, list[0].family);
  });
};

/** One GET with redirects followed by hand (up to 5), each hop to a public address only; at most 3 MB is read. */
async function getPublic(start: URL, signal: AbortSignal): Promise<{ body: string; type: string; finalUrl: string }> {
  let u = start;
  for (let hop = 0; hop <= 5; hop++) {
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("only http and https pages can be read");
    if (refused(u.hostname)) throw new Error(`${u.hostname} is on your own network; this tool reads public pages only`);
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = (u.protocol === "https:" ? https : http).get(u, { signal, lookup: publicOnlyLookup, headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5" } }, resolve);
      req.on("error", reject);
    });
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      u = new URL(res.headers.location, u);
      continue;
    }
    if (status < 200 || status >= 300) { res.resume(); throw new Error(`page returned ${status}`); }
    const type = String(res.headers["content-type"] ?? "");
    if (!/text\/|json|xml/i.test(type)) { res.resume(); throw new Error(`not a text page (${type || "unknown type"})`); }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of res) {
      chunks.push(chunk as Buffer);
      total += (chunk as Buffer).length;
      if (total > 3_000_000) { res.destroy(); break; }
    }
    return { body: Buffer.concat(chunks).toString("utf8"), type, finalUrl: u.toString() };
  }
  throw new Error("too many redirects");
}

const PICTURE_ACCEPT = "image/webp,image/png,image/jpeg,image/gif,image/*;q=0.5";

/**
 * One picture for the Mail screen, straight from the hub (mail-inbox.ts, only for a mail whose pictures the person asked
 * for on a hub without Tor): a GET with redirects followed by hand (up to 5), each hop https and to a public address
 * only, exactly as page reads (a mail cannot steer the hub to the router or another machine at home), no cookie, no
 * referrer, at most `maxBytes` read. Null for anything that is not a 2xx answer; the caller checks the bytes are a
 * picture. The sender's server sees the hub's internet address: fetchBytesViaTor is the one that hides it.
 */
export async function fetchPublicBytes(url: string, timeoutMs = 15_000, maxBytes = 2_000_000): Promise<Buffer | null> {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  return timed(timeoutMs, async (signal) => {
    for (let hop = 0; hop <= 5; hop++) {
      if (u.protocol !== "https:") return null;
      if (refused(u.hostname)) return null;
      const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const req = https.get(u, { signal, lookup: publicOnlyLookup, headers: { "user-agent": UA, accept: PICTURE_ACCEPT } }, resolve);
        req.on("error", reject);
      });
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        u = new URL(res.headers.location, u);
        continue;
      }
      if (status < 200 || status >= 300) { res.resume(); return null; }
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of res) {
        total += (chunk as Buffer).length;
        if (total > maxBytes) { res.destroy(); return null; }
        chunks.push(chunk as Buffer);
      }
      return Buffer.concat(chunks);
    }
    return null;
  });
}

/** Tor is not there to fetch through (its SOCKS port refused, or the hub has no curl): nothing was sent; try later. */
export class TorDown extends Error {
  constructor() { super("Tor is not answering on the hub"); }
}

/** The program fetches through Tor run with. Tests swap in a stand-in. */
export const torFetch = { curl: "curl" };

/**
 * One picture for the Mail screen through Tor (mail-inbox.ts): curl through the SOCKS proxy, as curlViaSocks, so the
 * sender's server sees a Tor exit and never the home address, and the name is looked up at the exit too. https only,
 * for the first address and every redirect (a Tor exit can read and change plain http), no cookie, no referrer, at most
 * `maxBytes`. Null for anything that is not a 2xx answer within those limits; the caller checks the bytes are a
 * picture. TorDown when Tor itself is not there. It never falls back to a direct fetch.
 */
export function fetchBytesViaTor(url: string, socks: string, timeoutMs = 45_000, maxBytes = 2_000_000): Promise<Buffer | null> {
  let u: URL;
  try { u = new URL(url); } catch { return Promise.resolve(null); }
  if (u.protocol !== "https:") return Promise.resolve(null);
  if (!socks) return Promise.reject(new TorDown());
  return new Promise((resolve, reject) => {
    // -g: [ ] and { } in an address are part of it, not a list of addresses for curl to work through.
    const args = ["-sS", "-g", "-L", "--max-redirs", "5", "--max-time", String(Math.ceil(timeoutMs / 1000)), "--max-filesize", String(maxBytes),
      "--proto", "=https", "--proto-redir", "=https", "--socks5-hostname", socks, "-A", UA, "-H", `Accept: ${PICTURE_ACCEPT}`,
      "-w", "%{stderr}\n@@meta@@%{http_code}", u.toString()];
    const child = spawn(torFetch.curl, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let size = 0;
    let over = false;
    let err = "";
    child.stdout.on("data", (b: Buffer) => {
      size += b.length;
      // A server that does not say how big its answer is: --max-filesize only goes by what it says, so it stops here.
      if (size > maxBytes) { over = true; child.kill(); return; }
      out.push(b);
    });
    child.stderr.on("data", (b: Buffer) => { if (err.length < 4000) err += b.toString("utf8"); });
    child.on("error", () => reject(new TorDown()));
    child.on("close", (code) => {
      // 7: curl could not connect, and through a SOCKS proxy the only thing it connects to is the proxy.
      if (code === 7) return reject(new TorDown());
      const status = Number(/@@meta@@(\d+)/.exec(err)?.[1] ?? 0);
      resolve(code === 0 && !over && status >= 200 && status < 300 ? Buffer.concat(out) : null);
    });
  });
}

/**
 * RFC 8058 one-click unsubscribe (the Mail screen's Unsubscribe, which the owner confirmed): one POST of
 * `List-Unsubscribe=One-Click` to an https address a mail gave. Through Tor when `socks` is set (curl, as
 * fetchBytesViaTor: the sender sees a Tor exit, never the home address); otherwise directly, and only to a public
 * address (publicOnlyLookup: a mail cannot point the hub at the home network). No redirect followed, no cookie, nothing
 * read back but the status. True for a 2xx answer; TorDown when Tor is not there.
 */
export function postOneClick(url: string, socks: string, timeoutMs = 30_000): Promise<boolean> {
  let u: URL;
  try { u = new URL(url); } catch { return Promise.resolve(false); }
  if (u.protocol !== "https:" || u.username || u.password) return Promise.resolve(false);
  const body = "List-Unsubscribe=One-Click";
  if (socks) {
    return new Promise((resolve, reject) => {
      const args = ["-sS", "-g", "--max-time", String(Math.ceil(timeoutMs / 1000)), "--proto", "=https", "--socks5-hostname", socks, "-A", UA,
        "-X", "POST", "-H", "Content-Type: application/x-www-form-urlencoded", "--data-raw", body, "-o", process.platform === "win32" ? "NUL" : "/dev/null",
        "-w", "%{stderr}\n@@meta@@%{http_code}", u.toString()];
      const child = spawn(torFetch.curl, args, { stdio: ["ignore", "ignore", "pipe"] });
      let err = "";
      child.stderr.on("data", (b: Buffer) => { if (err.length < 4000) err += b.toString("utf8"); });
      child.on("error", () => reject(new TorDown()));
      child.on("close", (code) => {
        if (code === 7) return reject(new TorDown());
        const status = Number(/@@meta@@(\d+)/.exec(err)?.[1] ?? 0);
        resolve(code === 0 && status >= 200 && status < 300);
      });
    });
  }
  if (refused(u.hostname)) return Promise.resolve(false);
  return timed(timeoutMs, async (signal) => {
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = https.request(u, { method: "POST", signal, lookup: publicOnlyLookup, headers: { "user-agent": UA, "content-type": "application/x-www-form-urlencoded", "content-length": String(body.length) } }, resolve);
      req.on("error", reject);
      req.end(body);
    });
    res.resume();
    const status = res.statusCode ?? 0;
    return status >= 200 && status < 300;
  }).then((x) => !!x).catch(() => false);
}

/**
 * Read a page for the assistant. Only public pages: an address on the owner's own network (a router's admin page,
 * another machine, the hub itself) is refused, so a page or a message cannot steer the assistant into reading
 * them; machines are reached with host commands (Homelab) instead.
 */
export async function fetchPage(url: string, maxChars = 12_000, timeoutMs = 20_000, socks = "", direct = false): Promise<{ url: string; title: string; text: string; truncated: boolean; via?: string }> {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error("not a valid URL"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("only http and https pages can be read");
  if (refused(u.hostname)) throw new Error(`${u.hostname} is on your own network; this tool reads public pages only`);
  if (!socks && !direct) throw new Error(NO_TOR);
  if (socks) {
    // Through Tor the name is looked up at the exit, which does not reach private networks.
    const r = await curlViaSocks(u.toString(), socks, Math.max(timeoutMs, 45_000));
    if (!/text\/|json|xml/i.test(r.type)) throw new Error(`not a text page (${r.type || "unknown type"})`);
    const { title, text } = /html|xml/i.test(r.type) ? htmlToText(r.body) : { title: "", text: r.body };
    return { url: r.finalUrl, title, text: text.slice(0, maxChars), truncated: text.length > maxChars, via: "tor" };
  }
  const { body, type, finalUrl } = await timed(timeoutMs, (signal) => getPublic(u, signal));
  const { title, text } = /html|xml/i.test(type) ? htmlToText(body) : { title: "", text: body };
  return { url: finalUrl, title, text: text.slice(0, maxChars), truncated: text.length > maxChars };
}
