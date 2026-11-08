import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { nowIso } from "@everythingapp/shared";
import type { Hub } from "./hub.js";
import { StoreError } from "./store.js";

/**
 * Game design wiki: a read-only mirror of a project's documentation, kept in `<data>/wiki.json`. Two sources feed it:
 * the project's repo docs, posted by the machine that holds the working copy (`POST /wiki/feed`, the project
 * feed), and Confluence spaces read by the hub after a member signs in with Atlassian (`imports/confluence.ts`).
 * Pages keep their own links; a link to another mirrored page, in either source, opens that page in the app.
 */

export type WikiSource = "repo" | "confluence";

export interface WikiPage {
  id: string;
  source: WikiSource;
  /** `repo:<project>` or `confluence:<space key>`. */
  source_key: string;
  title: string;
  /** Repo: the path from the repo root. Confluence: the space key and page id. */
  path: string;
  parent_id: string | null;
  position: number;
  url: string | null;
  updated_at: string;
  rev: string;
  markdown: string;
}

export interface WikiSourceInfo {
  key: string;
  kind: WikiSource;
  project: string;
  name: string;
  url: string | null;
  synced_at: string | null;
  last_error?: string | null;
  /** Repo: `https://github.com/<owner>/<repo>`, for links to files the mirror does not hold. */
  web_base?: string | null;
  /** Confluence: the site, e.g. `https://example.atlassian.net`. */
  site_url?: string | null;
}

interface WikiFile { sources: Record<string, WikiSourceInfo>; pages: Record<string, WikiPage> }

export class WikiStore {
  private data: WikiFile | null = null;
  constructor(private file: string) {}

  private load(): WikiFile {
    if (!this.data) {
      try {
        const d = JSON.parse(fs.readFileSync(this.file, "utf8")) as WikiFile;
        this.data = { sources: d.sources ?? {}, pages: d.pages ?? {} };
      } catch {
        this.data = { sources: {}, pages: {} };
      }
    }
    return this.data;
  }

  private save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }

  sources(): WikiSourceInfo[] { return Object.values(this.load().sources); }
  source(key: string): WikiSourceInfo | undefined { return this.load().sources[key]; }
  pages(): WikiPage[] { return Object.values(this.load().pages); }
  page(id: string): WikiPage | undefined { return this.load().pages[id]; }
  pagesOf(key: string): WikiPage[] { return this.pages().filter((p) => p.source_key === key); }

  /** Apply one batch of changes for a source and write the file once. */
  write(key: string, info: Partial<WikiSourceInfo> | null, upsert: WikiPage[], remove: string[]) {
    const d = this.load();
    if (info) d.sources[key] = { ...(d.sources[key] ?? ({} as WikiSourceInfo)), ...info, key } as WikiSourceInfo;
    for (const p of upsert) d.pages[p.id] = p;
    for (const id of remove) delete d.pages[id];
    this.save();
  }

  dropSource(key: string) {
    const d = this.load();
    delete d.sources[key];
    for (const [id, p] of Object.entries(d.pages)) if (p.source_key === key) delete d.pages[id];
    this.save();
  }
}

// ---------- Repo docs, posted by the machine with the working copy ----------

export interface FeedPage { path: string; sha: string; updated_at?: string; markdown: string }
export interface WikiFeedBody { project?: unknown; web_base?: unknown; manifest?: unknown; pages?: unknown; remove_all?: unknown }

const repoId = (project: string, p: string) => `repo:${project}:${p}`;

function cleanPath(p: unknown): string | null {
  if (typeof p !== "string") return null;
  const s = p.replace(/\\/g, "/").replace(/^\.?\//, "");
  if (!s || s.length > 400 || s.split("/").some((x) => x === ".." || x === "") || !/\.md$/i.test(s)) return null;
  return s;
}

/** A doc's title: its first `# ` heading, else the file name with spaces between words. */
export function titleOf(p: string, markdown: string): string {
  const h = /^#\s+(.+?)\s*#*\s*$/m.exec(markdown);
  if (h) return h[1].replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").trim();
  const base = path.posix.basename(p).replace(/\.md$/i, "");
  return base === "README" ? path.posix.dirname(p).split("/").pop() || "README" : base.replace(/[_-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").trim();
}

/**
 * `{ project, web_base?, manifest: [{ path, sha }], pages?: [{ path, sha, updated_at, markdown }] }`. The manifest is
 * every doc the repo has now: pages missing from it are removed. Pages whose sha changed and were not sent this time
 * come back in `need`, so the sender can post them in batches under the body limit.
 */
export function applyWikiFeed(hub: Hub, body: WikiFeedBody) {
  const project = typeof body.project === "string" ? body.project.trim() : "";
  if (!project || project.length > 80) throw new StoreError(422, "project is required");
  if (!Array.isArray(body.manifest)) throw new StoreError(422, "manifest must list every doc as { path, sha }");
  const manifest = new Map<string, string>();
  for (const m of body.manifest as { path?: unknown; sha?: unknown }[]) {
    const p = cleanPath(m?.path);
    if (p && typeof m.sha === "string") manifest.set(p, m.sha);
  }
  if (!manifest.size && body.manifest.length) throw new StoreError(422, "no manifest entry is a markdown path");
  const key = `repo:${project}`;
  const existing = new Map(hub.wiki.pagesOf(key).map((p) => [p.path, p]));
  // An empty list from a sender whose checkout failed (or a script run in the wrong folder) would wipe the mirror:
  // emptying a repo's docs on purpose says so.
  if (!manifest.size && existing.size && body.remove_all !== true) throw new StoreError(422, "the manifest is empty; send remove_all: true to remove every doc of this project");
  const upsert: WikiPage[] = [];
  const sent = new Set<string>();
  for (const raw of Array.isArray(body.pages) ? (body.pages as Partial<FeedPage>[]) : []) {
    const p = cleanPath(raw?.path);
    if (!p || !manifest.has(p) || typeof raw.markdown !== "string") continue;
    sent.add(p);
    const sha = manifest.get(p)!;
    if (existing.get(p)?.rev === sha) continue;
    upsert.push({
      id: repoId(project, p), source: "repo", source_key: key, title: titleOf(p, raw.markdown), path: p, parent_id: null, position: 0,
      url: null, updated_at: typeof raw.updated_at === "string" && !Number.isNaN(Date.parse(raw.updated_at)) ? raw.updated_at : nowIso(), rev: sha, markdown: raw.markdown,
    });
  }
  const remove = [...existing.values()].filter((p) => !manifest.has(p.path)).map((p) => p.id);
  const webBase = typeof body.web_base === "string" && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(body.web_base) ? body.web_base : hub.wiki.source(key)?.web_base ?? null;
  hub.wiki.write(key, { kind: "repo", project, name: `${project} repo docs`, url: webBase, web_base: webBase, synced_at: nowIso(), last_error: null }, upsert, remove);
  const need = [...manifest].filter(([p, sha]) => !sent.has(p) && existing.get(p)?.rev !== sha).map(([p]) => p);
  return { pages: manifest.size, updated: upsert.length, removed: remove.length, need };
}

// ---------- Reading ----------

function crumbsOf(p: WikiPage, byId: Map<string, WikiPage>): string[] {
  if (p.source === "repo") {
    const dirs = path.posix.dirname(p.path).split("/").filter((d) => d && d !== ".");
    return dirs[0] === "Docs" ? dirs.slice(1) : dirs;
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (let q = p.parent_id ? byId.get(p.parent_id) : undefined; q && !seen.has(q.id); q = q.parent_id ? byId.get(q.parent_id) : undefined) {
    seen.add(q.id);
    out.unshift(q.title);
  }
  return out;
}

/** One source's pages in reading order: a Confluence tree depth first by position, repo docs by folder then title. */
function ordered(pages: WikiPage[]): WikiPage[] {
  if (!pages.length) return [];
  if (pages[0].source === "repo") {
    const rank = (p: WikiPage) => [path.posix.dirname(p.path) === "." ? "" : path.posix.dirname(p.path), /readme\.md$/i.test(p.path) ? "" : p.title.toLowerCase()];
    return [...pages].sort((a, b) => { const x = rank(a), y = rank(b); return x[0].localeCompare(y[0]) || x[1].localeCompare(y[1]); });
  }
  const ids = new Set(pages.map((p) => p.id));
  const kids = new Map<string, WikiPage[]>();
  for (const p of pages) {
    const parent = p.parent_id && ids.has(p.parent_id) ? p.parent_id : "";
    if (!kids.has(parent)) kids.set(parent, []);
    kids.get(parent)!.push(p);
  }
  for (const list of kids.values()) list.sort((a, b) => a.position - b.position || a.title.localeCompare(b.title));
  const out: WikiPage[] = [];
  const seen = new Set<string>();
  const walk = (id: string) => { for (const p of kids.get(id) ?? []) if (!seen.has(p.id)) { seen.add(p.id); out.push(p); walk(p.id); } };
  walk("");
  return out;
}

const words = (s: string) => (s.match(/[\p{L}\p{N}']+/gu) ?? []).length;

/** `GET /wiki`: every source and every page without its body, grouped by project, in reading order. */
export function wikiIndex(hub: Hub) {
  const all = hub.wiki.pages();
  const byId = new Map(all.map((p) => [p.id, p]));
  const sources = hub.wiki.sources().sort((a, b) => a.project.localeCompare(b.project) || (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "confluence" ? -1 : 1));
  const pages = sources.flatMap((s) => ordered(hub.wiki.pagesOf(s.key)).map((p) => {
    const crumbs = crumbsOf(p, byId);
    return { id: p.id, source: p.source, source_key: p.source_key, project: s.project, title: p.title, crumbs, depth: crumbs.length, url: p.url, updated_at: p.updated_at, words: words(p.markdown) };
  }));
  return {
    sources: sources.map((s) => ({ key: s.key, kind: s.kind, project: s.project, name: s.name, url: s.url ?? null, synced_at: s.synced_at ?? null, last_error: s.last_error ?? null, pages: pages.filter((p) => p.source_key === s.key).length })),
    pages,
  };
}

/** Rewrite a page's links for reading: mirrored pages become `everythingapp://wiki?id=…`, images `/wiki/media/…`. */
export function resolveLinks(hub: Hub, page: WikiPage): string {
  const all = hub.wiki.pages();
  const src = hub.wiki.source(page.source_key);
  const repoByPath = new Map<string, Map<string, WikiPage>>();
  const confById = new Map<string, WikiPage>();
  const confByTitle = new Map<string, WikiPage>();
  const githubBases = new Map<string, string>();
  for (const s of hub.wiki.sources()) if (s.kind === "repo" && s.web_base) githubBases.set(s.web_base.toLowerCase(), s.key);
  for (const p of all) {
    if (p.source === "repo") {
      if (!repoByPath.has(p.source_key)) repoByPath.set(p.source_key, new Map());
      repoByPath.get(p.source_key)!.set(p.path.toLowerCase(), p);
    } else {
      confById.set(p.path.split("/")[1] ?? "", p);
      confByTitle.set(`${p.source_key.slice("confluence:".length).toLowerCase()}/${p.title.toLowerCase()}`, p);
    }
  }
  const open = (p: WikiPage) => `everythingapp://wiki?id=${encodeURIComponent(p.id)}`;
  const confluenceUrl = (href: string) => /^https:\/\/[\w.-]+\.atlassian\.net\/wiki\/spaces\/[^/]+\/pages\/(\d+)/.exec(href)?.[1];
  // A link to the space itself opens the space's home page, the top of its page tree.
  const spaceHome = (href: string) => {
    const key = /^https:\/\/[\w.-]+\.atlassian\.net\/wiki\/spaces\/([^/?#]+)\/?(?:overview\/?)?(?:[?#].*)?$/.exec(href)?.[1];
    if (!key) return undefined;
    const pages = all.filter((p) => p.source_key.toLowerCase() === `confluence:${decodeURIComponent(key)}`.toLowerCase());
    const ids = new Set(pages.map((p) => p.id));
    return pages.filter((p) => !p.parent_id || !ids.has(p.parent_id)).sort((a, b) => a.position - b.position)[0];
  };
  const githubDoc = (href: string) => {
    const m = /^(https:\/\/github\.com\/[\w.-]+\/[\w.-]+)\/(?:blob|tree)\/[^/]+\/([^#?]+)/i.exec(href);
    if (!m) return undefined;
    const key = githubBases.get(m[1].toLowerCase());
    return key ? repoByPath.get(key)?.get(decodeURIComponent(m[2]).toLowerCase()) : undefined;
  };

  const target = (href: string): string => {
    if (href.startsWith("wiki-title:")) {
      const [space, title] = href.slice("wiki-title:".length).split("/").map((x) => decodeURIComponent(x ?? ""));
      const hit = confByTitle.get(`${space.toLowerCase()}/${title.toLowerCase()}`);
      if (hit) return open(hit);
      return src?.site_url ? `${src.site_url}/wiki/search?text=${encodeURIComponent(title)}` : "";
    }
    if (href.startsWith("wiki-media:")) return `/wiki/media/${href.slice("wiki-media:".length)}`;
    const cid = confluenceUrl(href);
    if (cid && confById.has(cid)) return open(confById.get(cid)!);
    const home = spaceHome(href);
    if (home) return open(home);
    const gh = githubDoc(href);
    if (gh) return open(gh);
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#") || href.startsWith("/")) return href;
    if (page.source !== "repo") return href;
    // A relative link in a repo doc: another mirrored doc opens here, any other file on GitHub.
    const [rel] = href.split("#");
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(page.path), decodeURIComponent(rel)));
    if (resolved.startsWith("..")) return "";
    const doc = repoByPath.get(page.source_key)?.get(resolved.toLowerCase());
    if (doc) return open(doc);
    return src?.web_base ? `${src.web_base}/blob/HEAD/${resolved.split("/").map(encodeURIComponent).join("/")}` : "";
  };

  return page.markdown.replace(/(!?)\[((?:[^\[\]]|\[[^\]]*\])*)\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g, (m, bang: string, text: string, href: string) => {
    const t = target(href);
    if (!t) return text;
    return `${bang}[${text}](${t})`;
  });
}

/** `GET /wiki/page?id=`. */
export function wikiPage(hub: Hub, id: string) {
  const p = hub.wiki.page(id);
  if (!p) throw new StoreError(404, "no such wiki page");
  const byId = new Map(hub.wiki.pages().map((x) => [x.id, x]));
  const s = hub.wiki.source(p.source_key);
  return { id: p.id, source: p.source, source_key: p.source_key, source_name: s?.name ?? p.source_key, project: s?.project ?? "", title: p.title, crumbs: crumbsOf(p, byId), url: p.url, updated_at: p.updated_at, rev: p.rev, markdown: resolveLinks(hub, p) };
}

/** `GET /wiki/search?q=`: every word must appear; title hits rank first. */
export function wikiSearch(hub: Hub, q: string, limit = 30) {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  if (!terms.length) return { results: [] };
  const plain = (s: string) => s.replace(/^[ \t]*(?:[-*+]|\d+\.)[ \t]+(?:\[[ xX]\][ \t]+)?/gm, "").replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[#*_`>|]+/g, " ").replace(/\s+/g, " ");
  const hits: { id: string; title: string; source: WikiSource; project: string; snippet: string; score: number }[] = [];
  for (const p of hub.wiki.pages()) {
    const title = p.title.toLowerCase();
    const body = p.markdown.toLowerCase();
    if (!terms.every((t) => title.includes(t) || body.includes(t))) continue;
    let score = 0;
    for (const t of terms) {
      if (title.includes(t)) score += 20;
      let n = 0;
      for (let i = body.indexOf(t); i >= 0 && n < 20; i = body.indexOf(t, i + t.length)) n++;
      score += n;
    }
    const text = plain(p.markdown);
    const at = Math.max(0, text.toLowerCase().indexOf(terms[0]));
    const start = Math.max(0, at - 60);
    const snippet = (start ? "…" : "") + text.slice(start, start + 180).trim() + (start + 180 < text.length ? "…" : "");
    hits.push({ id: p.id, title: p.title, source: p.source, project: hub.wiki.source(p.source_key)?.project ?? "", snippet, score });
  }
  hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return { results: hits.slice(0, Math.max(1, Math.min(100, limit))).map(({ score: _s, ...h }) => h) };
}

// ---------- Images stored on Confluence pages ----------

const MEDIA_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", pdf: "application/pdf" };

export function mediaPath(hub: Hub, pageId: string, file: string): string {
  const ext = (/\.([a-z0-9]+)$/i.exec(file)?.[1] ?? "bin").toLowerCase();
  const h = crypto.createHash("sha1").update(file).digest("hex").slice(0, 20);
  return path.join(hub.cfg.dataDir, "wiki-media", pageId.replace(/[^\w-]/g, ""), `${h}.${ext}`);
}

/** `GET /wiki/media/:page/:file`: an image the hub saved while reading Confluence. */
export function wikiMedia(hub: Hub, pageId: string, file: string): { bytes: Uint8Array<ArrayBuffer>; type: string } {
  const p = mediaPath(hub, pageId, file);
  if (!fs.existsSync(p)) throw new StoreError(404, "not mirrored");
  const ext = path.extname(p).slice(1);
  return { bytes: new Uint8Array(fs.readFileSync(p)), type: MEDIA_TYPES[ext] ?? "application/octet-stream" };
}

export { MEDIA_TYPES };
