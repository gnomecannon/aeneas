import { StoreError } from "../store.js";
import { attr, child, children, descendants, parseXml, text, type XNode } from "../reference/xml.js";

/**
 * A small CalDAV client (RFC 4791), just what calendar sync needs: find the calendars, list the events in a time range,
 * read one, write one, delete one. Every request goes over https to the hosts the account allows (for iCloud,
 * caldav.icloud.com and the pNN-caldav.icloud.com servers it sends the hub to), redirects included, with Basic sign-in
 * and a time limit; nothing a server answers can point the hub anywhere else. Tests swap the fetch with setDavFetch.
 */

export interface DavLogin {
  user: string;
  pass: string;
  /** Where discovery starts. */
  root: string;
  /** Whether the hub may talk to this host. */
  allowed: (host: string) => boolean;
}

export interface DavCalendar {
  url: string;
  name: string;
  color?: string;
  /** Whether the owner may add and change events in it. */
  writable: boolean;
  /** Changes whenever anything in the calendar changes (CalendarServer getctag), when the server keeps one. */
  ctag?: string;
}

export interface DavObject { url: string; etag: string | null; data: string }

/** The server said no to the address and password. */
export class DavRefused extends StoreError {
  constructor() { super(422, "The calendar server did not accept this address and app-specific password."); }
}
/** The event changed on the server since it was read (If-Match failed): read it again before writing. */
export class DavConflict extends StoreError {
  constructor() { super(409, "the event changed on the calendar server"); }
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
let davFetch: Fetch = (url, init) => fetch(url, init);
export function setDavFetch(f: Fetch | null) { davFetch = f ?? ((url, init) => fetch(url, init)); }

export const DAV_TIMEOUT_MS = 60_000;
const MAX_BODY = 20 * 1024 * 1024;

/** iCloud's calendar servers, and nothing else. */
export const icloudHost = (host: string) => host === "caldav.icloud.com" || /^p\d{1,3}-caldav\.icloud\.com$/.test(host);

function checkUrl(login: DavLogin, url: string): URL {
  let u: URL;
  try { u = new URL(url); } catch { throw new StoreError(502, "the calendar server gave an address that is not one"); }
  if (u.protocol !== "https:" || (u.port && u.port !== "443") || u.username || u.password || !login.allowed(u.hostname)) {
    throw new StoreError(502, "the calendar server pointed the hub at another address, which it does not follow");
  }
  return u;
}

/** One request, following up to three redirects within the allowed hosts. */
async function request(login: DavLogin, method: string, url: string, opts: { body?: string; headers?: Record<string, string>; depth?: string } = {}): Promise<{ status: number; url: string; headers: Headers; body: string }> {
  let target = checkUrl(login, url).toString();
  for (let hop = 0; hop < 4; hop++) {
    const headers: Record<string, string> = {
      authorization: `Basic ${Buffer.from(`${login.user}:${login.pass}`).toString("base64")}`,
      "user-agent": "Aeneas-hub",
      ...(opts.body ? { "content-type": method === "PUT" ? "text/calendar; charset=utf-8" : "application/xml; charset=utf-8" } : {}),
      ...(opts.depth !== undefined ? { depth: opts.depth } : {}),
      ...opts.headers,
    };
    let res: Response;
    try {
      res = await davFetch(target, { method, headers, body: opts.body, redirect: "manual", signal: AbortSignal.timeout(DAV_TIMEOUT_MS) });
    } catch {
      throw new StoreError(502, "The calendar server could not be reached from the hub, or stopped answering. The hub tries again later.");
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      target = checkUrl(login, new URL(res.headers.get("location")!, target).toString()).toString();
      continue;
    }
    if (res.status === 401) throw new DavRefused();
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > MAX_BODY) throw new StoreError(502, "the calendar server sent more than the hub reads");
    const body = await res.text();
    if (body.length > MAX_BODY) throw new StoreError(502, "the calendar server sent more than the hub reads");
    return { status: res.status, url: target, headers: res.headers, body };
  }
  throw new StoreError(502, "the calendar server redirected the hub too many times");
}

const NS = `xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ic="http://apple.com/ns/ical/"`;

async function propfind(login: DavLogin, url: string, depth: "0" | "1", props: string): Promise<{ base: string; responses: XNode[] }> {
  const r = await request(login, "PROPFIND", url, { depth, body: `<?xml version="1.0" encoding="utf-8"?><d:propfind ${NS}><d:prop>${props}</d:prop></d:propfind>` });
  if (r.status !== 207) throw new StoreError(502, `the calendar server answered ${r.status} when asked for its calendars`);
  return { base: r.url, responses: descendants(parseXml(r.body), "response") };
}

/** The props of a response that came back with 200. */
function okProps(resp: XNode): XNode[] {
  return children(resp, "propstat").filter((ps) => /\s200\s/.test(` ${text(child(ps, "status"))} `)).flatMap((ps) => children(child(ps, "prop") ?? ps));
}
const prop = (resp: XNode, name: string) => okProps(resp).find((p) => (p.localName ?? p.nodeName.replace(/^.*:/, "")) === name) ?? null;
const hrefIn = (n: XNode | null) => text(n ? child(n, "href") : null);

/**
 * The calendars of an account that hold events. `also`, when given, gets the addresses the server knows the account by
 * (its principal's `calendar-user-address-set`, `mailto:` ones, lowercase), read in the same request as the
 * calendars' home: an invitation names the owner by any of them (Invitations).
 */
export async function discoverCalendars(login: DavLogin, also?: { addresses?: string[] }): Promise<DavCalendar[]> {
  const p1 = await propfind(login, login.root, "0", "<d:current-user-principal/>");
  const principal = p1.responses.map((r) => hrefIn(prop(r, "current-user-principal"))).find(Boolean);
  if (!principal) throw new StoreError(502, "the calendar server did not say whose calendars these are");
  const principalUrl = new URL(principal, p1.base).toString();
  const p2 = await propfind(login, principalUrl, "0", "<c:calendar-home-set/><c:calendar-user-address-set/>");
  if (also) {
    also.addresses = [...new Set(p2.responses.flatMap((r) => { const set = prop(r, "calendar-user-address-set"); return set ? children(set, "href").map((h) => text(h)) : []; })
      .map((h) => h.trim()).filter((h) => /^mailto:/i.test(h)).map((h) => h.slice(7).trim().toLowerCase()).filter((h) => /^[^\s@]+@[^\s@]+$/.test(h) && h.length <= 254))].slice(0, 20);
  }
  const home = p2.responses.map((r) => hrefIn(prop(r, "calendar-home-set"))).find(Boolean);
  if (!home) throw new StoreError(502, "the calendar server did not say where the calendars are");
  const homeUrl = new URL(home, p2.base).toString();
  const p3 = await propfind(login, homeUrl, "1", "<d:resourcetype/><d:displayname/><ic:calendar-color/><c:supported-calendar-component-set/><d:current-user-privilege-set/><cs:getctag/>");
  const out: DavCalendar[] = [];
  for (const r of p3.responses) {
    const href = text(child(r, "href"));
    const rt = prop(r, "resourcetype");
    if (!href || !rt || !child(rt, "calendar")) continue;
    const comps = prop(r, "supported-calendar-component-set");
    if (comps && !children(comps, "comp").some((c) => attr(c, "name").toUpperCase() === "VEVENT")) continue;
    const privs = prop(r, "current-user-privilege-set");
    const names = privs ? descendants(privs, "privilege").flatMap((p) => children(p).map((c) => c.localName ?? c.nodeName.replace(/^.*:/, ""))) : ["all"];
    const color = text(prop(r, "calendar-color")).slice(0, 9);
    const ctag = text(prop(r, "getctag"));
    out.push({
      url: checkUrl(login, new URL(href, p3.base).toString()).toString(),
      name: text(prop(r, "displayname")).slice(0, 120) || "Calendar",
      ...(/^#[0-9a-f]{6,8}$/i.test(color) ? { color: color.slice(0, 7) } : {}),
      writable: names.some((n) => n === "all" || n === "write" || n === "write-content" || n === "bind"),
      ...(ctag ? { ctag } : {}),
    });
  }
  return out;
}

/** The calendar's ctag now, or undefined when the server keeps none. */
export async function calendarCtag(login: DavLogin, url: string): Promise<string | undefined> {
  const r = await propfind(login, url, "0", "<cs:getctag/>");
  return r.responses.map((x) => text(prop(x, "getctag"))).find(Boolean);
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** Every event in the calendar that touches the time range, with its etag and data. */
export async function listEvents(login: DavLogin, calendarUrl: string, from: Date, to: Date): Promise<DavObject[]> {
  const body = `<?xml version="1.0" encoding="utf-8"?><c:calendar-query ${NS}><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${stamp(from)}" end="${stamp(to)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
  const r = await request(login, "REPORT", calendarUrl, { depth: "1", body });
  if (r.status !== 207) throw new StoreError(502, `the calendar server answered ${r.status} when asked for events`);
  const out: DavObject[] = [];
  for (const resp of descendants(parseXml(r.body), "response")) {
    const href = text(child(resp, "href"));
    const data = text(prop(resp, "calendar-data"));
    if (!href || !data) continue;
    out.push({ url: checkUrl(login, new URL(href, r.url).toString()).toString(), etag: text(prop(resp, "getetag")) || null, data });
  }
  return out;
}

/** One event by its address, or null when it is gone. */
export async function getEvent(login: DavLogin, url: string): Promise<DavObject | null> {
  const r = await request(login, "GET", url);
  if (r.status === 404 || r.status === 410) return null;
  if (r.status !== 200) throw new StoreError(502, `the calendar server answered ${r.status} when asked for an event`);
  return { url: r.url, etag: r.headers.get("etag"), data: r.body };
}

/** Add (etag null: only if nothing is there) or change (only if it is still the version read) an event. Returns its new etag when the server says. */
export async function putEvent(login: DavLogin, url: string, data: string, etag: string | null): Promise<string | null> {
  const r = await request(login, "PUT", url, { body: data, headers: etag ? { "if-match": etag } : { "if-none-match": "*" } });
  if (r.status === 412) throw new DavConflict();
  if (r.status < 200 || r.status >= 300) throw new StoreError(502, `the calendar server answered ${r.status} when an event was written`);
  return r.headers.get("etag");
}

/** Delete an event, only if it is still the version read. A missing one counts as deleted. */
export async function deleteEvent(login: DavLogin, url: string, etag: string | null): Promise<void> {
  const r = await request(login, "DELETE", url, { headers: etag ? { "if-match": etag } : {} });
  if (r.status === 412) throw new DavConflict();
  if (r.status === 404 || r.status === 410) return;
  if (r.status < 200 || r.status >= 300) throw new StoreError(502, `the calendar server answered ${r.status} when an event was deleted`);
}
