import { spawn } from "node:child_process";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
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

/** HTML to readable text: main content when the page marks it, block tags to line breaks, code kept. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = decode((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim());
  let body = html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<head\b[\s\S]*?<\/head>/i, " ").replace(/<title\b[\s\S]*?<\/title>/gi, " ");
  const main = /<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(body);
  if (main && main[2].length > 500) body = main[2];
  body = body
    .replace(/<(script|style|noscript|svg|template|iframe|nav|footer|header|form|aside)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner: string) => `\n\`\`\`\n${inner.replace(/<[^>]+>/g, "")}\n\`\`\`\n`)
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<h([1-6])\b[^>]*>/gi, (_m, n: string) => `\n\n${"#".repeat(Number(n))} `)
    .replace(/<\/(p|div|section|h[1-6]|li|tr|table|ul|ol|blockquote|dd|dt)>/gi, "\n")
    .replace(/<t[dh]\b[^>]*>/gi, " | ")
    .replace(/<[^>]+>/g, "");
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
    const args = ["-sS", "-L", "--max-redirs", "5", "--max-time", String(Math.ceil(timeoutMs / 1000)), "--max-filesize", "3000000",
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
 * An address that is not on the public internet: private and tailnet ranges, loopback, link-local, the "this
 * network" block, multicast and reserved, IPv6 unique-local and link-local, and IPv4 written inside IPv6.
 */
export function isNonPublicAddress(addr: string): boolean {
  const a = addr.replace(/^\[|\]$/g, "").toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) return isNonPublicAddress(mapped[1]);
  // The URL parser writes an IPv4 address inside IPv6 in hex (::ffff:a00:1 for 10.0.0.1).
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
  if (hex) { const h = parseInt(hex[1], 16), l = parseInt(hex[2], 16); return isNonPublicAddress(`${h >> 8}.${h & 255}.${l >> 8}.${l & 255}`); }
  if (net.isIPv4(a)) {
    const [x, y] = a.split(".").map(Number);
    return isPrivateHost(a) || x === 0 || x >= 224 || (x === 198 && (y === 18 || y === 19)) || (x === 192 && y === 0);
  }
  if (net.isIPv6(a)) return a === "::" || isPrivateHost(a) || a.startsWith("ff");
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
