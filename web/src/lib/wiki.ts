import { normalizeHubUrl } from "../sync/api";
import { relative } from "./time";
import { safeUrl } from "./markdown";

/**
 * Game design wiki: the hub's read-only mirror of a project's repo docs and Confluence spaces
 * (`GET /wiki`, `/wiki/page`, `/wiki/search`). Pure helpers for the Wiki screen.
 */

export type WikiKind = "repo" | "confluence";

export interface WikiSourceInfo {
  key: string;
  kind: WikiKind;
  project: string;
  name: string;
  url: string | null;
  synced_at: string | null;
  last_error: string | null;
  pages: number;
}

export interface WikiPageRef {
  id: string;
  source: WikiKind;
  source_key: string;
  project: string;
  title: string;
  crumbs: string[];
  depth: number;
  url: string | null;
  updated_at: string;
  words: number;
}

export interface WikiIndex {
  sources: WikiSourceInfo[];
  pages: WikiPageRef[];
}

export interface WikiPage {
  id: string;
  source: WikiKind;
  source_key: string;
  source_name: string;
  project: string;
  title: string;
  crumbs: string[];
  url: string | null;
  updated_at: string;
  rev: string;
  markdown: string;
}

export interface WikiHit {
  id: string;
  title: string;
  source: WikiKind;
  project: string;
  snippet: string;
}

export interface WikiSection {
  source: WikiSourceInfo;
  pages: WikiPageRef[];
}

export interface WikiProject {
  project: string;
  sections: WikiSection[];
}

/** Sources by project in the hub's order, Confluence handbook before repo docs, each with its pages in reading order. */
export function groupWiki(index: WikiIndex): WikiProject[] {
  const bySource = new Map<string, WikiPageRef[]>();
  for (const p of index.pages) {
    const list = bySource.get(p.source_key);
    if (list) list.push(p);
    else bySource.set(p.source_key, [p]);
  }
  const out: WikiProject[] = [];
  for (const s of index.sources) {
    let proj = out.find((g) => g.project === s.project);
    if (!proj) out.push((proj = { project: s.project, sections: [] }));
    proj.sections.push({ source: s, pages: bySource.get(s.key) ?? [] });
  }
  const rank = (k: WikiKind) => (k === "confluence" ? 0 : 1);
  for (const g of out) g.sections = g.sections.map((x, i) => [x, i] as const).sort((a, b) => rank(a[0].source.kind) - rank(b[0].source.kind) || a[1] - b[1]).map(([x]) => x);
  return out;
}

/** Sections longer than this start folded, unless they hold the open page. */
export const FOLD_OVER = 25;

export function startsFolded(section: WikiSection, openId: string | null): boolean {
  return section.pages.length > FOLD_OVER && !section.pages.some((p) => p.id === openId);
}

/** A repo doc's folder, shown above the first doc in it; null when it is the same folder as the doc before, or Confluence (whose tree shows itself). */
export function folderLabel(pages: WikiPageRef[], i: number): string | null {
  const p = pages[i];
  if (p.source !== "repo" || !p.crumbs.length) return null;
  const folder = p.crumbs.join(" › ");
  const prev = i > 0 ? pages[i - 1].crumbs.join(" › ") : "";
  return folder === prev ? null : folder;
}

export type WikiLink = { kind: "page"; id: string } | { kind: "anchor"; id: string } | { kind: "external"; url: string } | { kind: "none" };

/** What a click on a link in a wiki page does: open another page here, scroll to a heading, or leave the app. */
export function classifyLink(href: string | null | undefined): WikiLink {
  if (!href) return { kind: "none" };
  const app = /^everythingapp:\/\/wiki\/?\?(.*)$/i.exec(href);
  if (app) {
    const id = new URLSearchParams(app[1]).get("id");
    return id ? { kind: "page", id } : { kind: "none" };
  }
  if (href.startsWith("#")) return href.length > 1 ? { kind: "anchor", id: decodeURIComponent(href.slice(1)) } : { kind: "none" };
  if (/^(https?:|mailto:)/i.test(href)) return { kind: "external", url: href };
  return { kind: "none" };
}

/** The hash route for a page (or the wiki's front when no id), so a reload opens the same page. */
export function wikiPath(id?: string | null): string {
  return id ? `/wiki?id=${encodeURIComponent(id)}` : "/wiki";
}

/** A hub path such as `/wiki/media/<page>/<file>` as a full address. It carries no key: the key goes in a header. */
export function hubFileUrl(hubUrl: string, path: string): string {
  return `${normalizeHubUrl(hubUrl)}${path}`;
}

/**
 * A hub file fetched with the device key in the Authorization header, as a blob: address for <img> and new tabs. A
 * key in the address would end up in history, logs and the Referer of anything the page opened.
 */
export async function hubFileBlob(url: string, token: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const r = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`hub answered ${r.status}`);
  return URL.createObjectURL(await r.blob());
}

/** The wiki's own pictures with their address moved to `data-hub-src`, so nothing loads before the key is attached. */
export function deferHubImages(html: string, hubUrl: string): string {
  if (!hubUrl) return html;
  const own = `${normalizeHubUrl(hubUrl)}/wiki/media/`;
  return html.split(`<img src="${own}`).join(`<img data-hub-src="${own}`);
}

/** Whether an image address is one of the wiki's own pictures on the hub: only those load in a page (privacy-network.md). */
export function wikiOwnImage(hubUrl: string): (url: string) => boolean {
  const own = `${normalizeHubUrl(hubUrl)}/wiki/media/`;
  return (url) => !!hubUrl && url.startsWith(own);
}

/** Where links and images in a wiki page point: saved images load from the hub, headings stay in the page. */
export function wikiUrls(hubUrl: string): (href: string, kind: "link" | "image") => string | null {
  return (href, kind) => {
    if (href.startsWith("/wiki/media/")) return hubUrl ? hubFileUrl(hubUrl, href) : null;
    if (kind === "link" && href.startsWith("#") && href.length > 1) return href;
    return safeUrl(href, kind);
  };
}

/** A page's markdown without its first heading when that heading is the title the reader already shows. */
export function withoutTitle(markdown: string, title: string): string {
  const m = /^\s*#\s+(.+?)\s*#*\s*(\n|$)/.exec(markdown);
  if (!m) return markdown;
  const plain = (s: string) => s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*_~]/g, "").trim().toLowerCase();
  return plain(m[1]) === plain(title) ? markdown.slice(m[0].length) : markdown;
}

/** "synced 3h ago", or that it has not been read yet. */
export function syncedText(iso: string | null, now = new Date()): string {
  if (!iso) return "not synced yet";
  const r = relative(iso, now);
  return r === "now" ? "synced just now" : `synced ${r}`;
}

/** The one callback address the hub's Atlassian app must list: Atlassian sends people back to it after sign-in. */
export function atlassianCallback(hubUrl: string): string {
  return `${normalizeHubUrl(hubUrl)}/connections/atlassian/return`;
}

export function googleCallback(hubUrl: string): string {
  return `${normalizeHubUrl(hubUrl)}/connections/google/return`;
}

/** Whether the chosen spaces differ from the ones mirrored now, so Save has something to do. */
export function spacesChanged(chosen: Iterable<string>, mirrored: Iterable<string>): boolean {
  const a = new Set(chosen);
  const b = new Set(mirrored);
  return a.size !== b.size || [...a].some((k) => !b.has(k));
}
