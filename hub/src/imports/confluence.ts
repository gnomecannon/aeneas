import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { nowIso } from "@everythingapp/shared";
import type { Hub } from "../hub.js";
import { StoreError } from "../store.js";
import { attachmentsShown, storageToMarkdown } from "../wiki-storage.js";
import { MEDIA_TYPES, mediaPath, type WikiPage } from "../wiki.js";
import { fetchWithTimeout } from "./util.js";

/**
 * Confluence: the member signs in with Atlassian (OAuth 2.0 authorization code, read-only scopes) and picks spaces;
 * the hub reads those spaces every hour into the wiki mirror, with the images their pages show. The hub's own
 * Atlassian app (client id and secret) is what a released service keeps on its server; members never handle a key.
 */

const AUTH = "https://auth.atlassian.com";
const API = "https://api.atlassian.com";
const SCOPES = "read:space:confluence read:page:confluence read:attachment:confluence offline_access";
const SIGNIN_TTL_MS = 10 * 60_000;
const MAX_MEDIA_BYTES = 8 * 1024 * 1024;
const pending = new Map<string, { at: number; client: string; redirect: string }>();

export interface AtlassianConn {
  access_token: string;
  refresh_token: string;
  expires_at: string;
  cloud_id: string;
  site_url: string;
  site_name: string;
  spaces: string[];
  last_sync?: string;
  last_error?: string | null;
  pages?: number;
}

export function atlassianApp(hub: Hub): { client_id: string; client_secret: string } | null {
  const c = hub.connections.get();
  const id = process.env.EA_ATLASSIAN_CLIENT_ID || c.atlassian_app?.client_id;
  const secret = process.env.EA_ATLASSIAN_CLIENT_SECRET || c.atlassian_app?.client_secret;
  return id && secret ? { client_id: id, client_secret: secret } : null;
}

/** Save the hub's Atlassian app (from developer.atlassian.com, OAuth 2.0 integration). */
export function setAtlassianApp(hub: Hub, body: Record<string, unknown>) {
  const id = typeof body.client_id === "string" ? body.client_id.trim() : "";
  const secret = typeof body.client_secret === "string" ? body.client_secret.trim() : "";
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(id)) throw new StoreError(422, "client_id is the Client ID from the app's Settings page");
  if (!/^[A-Za-z0-9_.-]{16,256}$/.test(secret)) throw new StoreError(422, "client_secret is the Secret from the app's Settings page");
  hub.connections.update((c) => { c.atlassian_app = { client_id: id, client_secret: secret }; });
  return hub.connections.view().atlassian;
}

/** Start a sign-in: the URL of Atlassian's consent page, which comes back to `<hub>/connections/atlassian/return`. */
export function atlassianSignIn(hub: Hub, body: Record<string, unknown>) {
  const app = atlassianApp(hub);
  if (!app) throw new StoreError(409, "the hub has no Atlassian app yet");
  let base: URL;
  try {
    base = new URL(String(body.hub ?? ""));
  } catch {
    throw new StoreError(422, "hub must be the address this app reaches the hub at");
  }
  if (base.protocol !== "https:") throw new StoreError(422, "Atlassian sends people back only to an https address");
  const now = Date.now();
  for (const [k, v] of pending) if (now - v.at > SIGNIN_TTL_MS) pending.delete(k);
  const state = crypto.randomUUID();
  const redirect = `${base.origin}/connections/atlassian/return`;
  pending.set(state, { at: now, client: body.client === "apple" ? "apple" : "web", redirect });
  const q = new URLSearchParams({ audience: "api.atlassian.com", client_id: app.client_id, scope: SCOPES, redirect_uri: redirect, state, response_type: "code", prompt: "consent" });
  return { url: `${AUTH}/authorize?${q}` };
}

async function tokenCall(hub: Hub, body: Record<string, string>) {
  const r = await fetchWithTimeout(hub.fetch, `${AUTH}/oauth/token`, "Atlassian", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = (await r.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!r.ok || !j.access_token) throw new StoreError(r.status === 400 || r.status === 401 || r.status === 403 ? 422 : 502, `Atlassian refused the sign-in: ${j.error_description ?? j.error ?? r.status}`);
  return { access: j.access_token, refresh: j.refresh_token ?? "", expires_at: new Date(Date.now() + (j.expires_in ?? 3600) * 1000).toISOString() };
}

/** Atlassian's redirect back: trade the code for tokens, find the Confluence site, keep the link. */
export async function atlassianReturn(hub: Hub, query: Record<string, string>): Promise<{ client: string; ok: boolean; message: string }> {
  const p = pending.get(query.state ?? "");
  if (!p || Date.now() - p.at > SIGNIN_TTL_MS) return { client: "web", ok: false, message: "This sign-in link expired. Start again from Settings, Connections." };
  pending.delete(query.state);
  const fail = (message: string) => ({ client: p.client, ok: false, message });
  if (query.error) return fail(query.error === "access_denied" ? "Atlassian sign-in was cancelled." : `Atlassian said: ${query.error_description ?? query.error}`);
  if (!query.code) return fail("Atlassian sent no sign-in code.");
  const app = atlassianApp(hub);
  if (!app) return fail("The hub has no Atlassian app.");
  try {
    const t = await tokenCall(hub, { grant_type: "authorization_code", client_id: app.client_id, client_secret: app.client_secret, code: query.code, redirect_uri: p.redirect });
    const r = await fetchWithTimeout(hub.fetch, `${API}/oauth/token/accessible-resources`, "Atlassian", { headers: { authorization: `Bearer ${t.access}`, accept: "application/json" } });
    const sites = (await r.json().catch(() => [])) as { id: string; url: string; name: string; scopes?: string[] }[];
    const site = Array.isArray(sites) ? sites.find((s) => (s.scopes ?? []).some((x) => x.includes("confluence"))) ?? sites[0] : undefined;
    if (!site) return fail("That Atlassian account has no Confluence site.");
    const prev = hub.connections.get().atlassian;
    hub.connections.update((c) => {
      c.atlassian = { access_token: t.access, refresh_token: t.refresh, expires_at: t.expires_at, cloud_id: site.id, site_url: site.url.replace(/\/$/, ""), site_name: site.name, spaces: prev?.cloud_id === site.id ? prev.spaces : [] };
    });
    const spaces = hub.connections.get().atlassian!.spaces;
    if (!spaces.length) return { client: p.client, ok: true, message: `Confluence linked: ${site.name}. Choose the spaces to mirror in Settings, Connections.` };
    const s = await syncConfluence(hub);
    return { client: p.client, ok: true, message: `Confluence linked: ${site.name}, ${s.pages} pages.` };
  } catch (e) {
    return fail((e as Error).message);
  }
}

/** A current access token, refreshed when it is within two minutes of expiring. Atlassian rotates the refresh token. */
async function accessToken(hub: Hub): Promise<AtlassianConn> {
  const c = hub.connections.get().atlassian;
  if (!c) throw new StoreError(409, "Confluence is not linked");
  if (Date.parse(c.expires_at) - Date.now() > 120_000) return c;
  const app = atlassianApp(hub);
  if (!app) throw new StoreError(409, "the hub has no Atlassian app");
  if (!c.refresh_token) throw new StoreError(409, "Atlassian sign-in expired: sign in again");
  let t;
  try {
    t = await tokenCall(hub, { grant_type: "refresh_token", client_id: app.client_id, client_secret: app.client_secret, refresh_token: c.refresh_token });
  } catch (e) {
    if (e instanceof StoreError && e.status === 422) throw new StoreError(409, "Atlassian sign-in expired: sign in again");
    throw e;
  }
  hub.connections.update((x) => { if (x.atlassian) Object.assign(x.atlassian, { access_token: t.access, refresh_token: t.refresh || x.atlassian.refresh_token, expires_at: t.expires_at }); });
  return hub.connections.get().atlassian!;
}

async function confluence(hub: Hub, c: AtlassianConn, pathOrNext: string): Promise<any> {
  const url = pathOrNext.startsWith("http") ? pathOrNext : `${API}/ex/confluence/${c.cloud_id}${pathOrNext}`;
  const r = await fetchWithTimeout(hub.fetch, url, "Confluence", { headers: { authorization: `Bearer ${c.access_token}`, accept: "application/json" } }, 30_000);
  if (r.status === 401) throw new StoreError(409, "Atlassian sign-in expired: sign in again");
  if (r.status === 403) throw new StoreError(422, "Confluence refused: the account cannot read that");
  if (!r.ok) throw new StoreError(502, `Confluence answered ${r.status}`);
  return r.json();
}

async function* paged(hub: Hub, c: AtlassianConn, first: string) {
  let next: string | undefined = first;
  for (let n = 0; next && n < 200; n++) {
    const j: any = await confluence(hub, c, next);
    for (const x of j?.results ?? []) yield x;
    const link: string | undefined = j?._links?.next;
    next = link ? (link.startsWith("/wiki/") ? link : `/wiki${link}`) : undefined;
  }
}

/** `GET /connections/atlassian/spaces`: the site's spaces, marked when mirrored. */
export async function atlassianSpaces(hub: Hub) {
  const c = await accessToken(hub);
  const out: { key: string; name: string; type: string; mirrored: boolean }[] = [];
  for await (const s of paged(hub, c, "/wiki/api/v2/spaces?limit=250&status=current")) {
    out.push({ key: String(s.key), name: String(s.name ?? s.key), type: String(s.type ?? ""), mirrored: c.spaces.includes(String(s.key)) });
  }
  out.sort((a, b) => Number(b.mirrored) - Number(a.mirrored) || a.name.localeCompare(b.name));
  return { spaces: out };
}

/** `PUT /connections/atlassian/spaces` body `{ keys }`: which spaces to mirror; spaces dropped leave the wiki. */
export async function setAtlassianSpaces(hub: Hub, body: Record<string, unknown>) {
  if (!hub.connections.get().atlassian) throw new StoreError(409, "Confluence is not linked");
  const keys = Array.isArray(body.keys) ? [...new Set(body.keys.filter((k): k is string => typeof k === "string" && /^[A-Za-z0-9~_-]{1,255}$/.test(k)))] : null;
  if (!keys) throw new StoreError(422, "keys must be a list of space keys");
  const before = hub.connections.get().atlassian!.spaces;
  hub.connections.update((c) => { c.atlassian!.spaces = keys; });
  for (const k of before) if (!keys.includes(k)) hub.wiki.dropSource(`confluence:${k}`);
  const sync = keys.length ? await syncConfluence(hub) : { spaces: 0, pages: 0, updated: 0, removed: 0, images: 0 };
  return { connection: hub.connections.view().atlassian, sync };
}

/** Read every mirrored space: changed pages are converted again, deleted ones leave, shown images are saved. */
export async function syncConfluence(hub: Hub) {
  const result = { spaces: 0, pages: 0, updated: 0, removed: 0, images: 0 };
  let c: AtlassianConn;
  try {
    c = await accessToken(hub);
  } catch (e) {
    hub.connections.update((x) => { if (x.atlassian) x.atlassian.last_error = (e as Error).message; });
    throw e;
  }
  const errors: string[] = [];
  for (const key of c.spaces) {
    const sourceKey = `confluence:${key}`;
    try {
      const sj: any = await confluence(hub, c, `/wiki/api/v2/spaces?keys=${encodeURIComponent(key)}`);
      const space = sj?.results?.[0];
      if (!space) throw new StoreError(404, `space ${key} was not found`);
      const existing = new Map(hub.wiki.pagesOf(sourceKey).map((p) => [p.id, p]));
      const seen = new Set<string>();
      const upsert: WikiPage[] = [];
      for await (const pg of paged(hub, c, `/wiki/api/v2/spaces/${space.id}/pages?body-format=storage&status=current&limit=250`)) {
        const id = `confluence:${pg.id}`;
        seen.add(id);
        const rev = String(pg.version?.number ?? "");
        const old = existing.get(id);
        const parent = pg.parentId && pg.parentType !== "whiteboard" ? `confluence:${pg.parentId}` : null;
        const position = typeof pg.position === "number" ? pg.position : 0;
        const url = pg._links?.webui ? `${c.site_url}/wiki${pg._links.webui}` : null;
        if (old && old.rev === rev && old.title === pg.title && old.parent_id === parent && old.position === position) continue;
        const storage = String(pg.body?.storage?.value ?? "");
        // A page whose pictures did not all come down keeps a version that is not the page's, so the next sync
        // fetches them again instead of never.
        let kept = rev;
        if (!old || old.rev !== rev) {
          const got = await saveImages(hub, c, String(pg.id), storage).catch(() => ({ saved: 0, failed: 1 }));
          result.images += got.saved;
          if (got.failed) kept = `${rev}+images-missing`;
        }
        upsert.push({ id, source: "confluence", source_key: sourceKey, title: String(pg.title ?? "Untitled"), path: `${key}/${pg.id}`, parent_id: parent, position, url, updated_at: pg.version?.createdAt ?? pg.createdAt ?? nowIso(), rev: kept, markdown: storageToMarkdown(storage, String(pg.id), key) });
      }
      const remove = [...existing.keys()].filter((id) => !seen.has(id));
      for (const id of remove) fs.rmSync(path.dirname(mediaPath(hub, id.split(":")[1], "x")), { recursive: true, force: true });
      hub.wiki.write(sourceKey, { kind: "confluence", project: String(space.name ?? key), name: `${space.name ?? key} handbook`, url: `${c.site_url}/wiki/spaces/${encodeURIComponent(key)}`, site_url: c.site_url, synced_at: nowIso(), last_error: null }, upsert, remove);
      result.spaces++;
      result.pages += seen.size;
      result.updated += upsert.length;
      result.removed += remove.length;
    } catch (e) {
      const msg = (e as Error).message;
      errors.push(`${key}: ${msg}`);
      const src = hub.wiki.source(sourceKey);
      if (src) hub.wiki.write(sourceKey, { last_error: msg }, [], []);
      if (e instanceof StoreError && e.status === 409) break;
    }
  }
  hub.connections.update((x) => { if (x.atlassian) Object.assign(x.atlassian, { last_sync: nowIso(), last_error: errors.length ? errors.join("; ") : null, pages: result.pages }); });
  return result;
}

/** Save the images a page shows from its own attachments, so the apps can show them without Atlassian. */
/** The pictures a page shows, saved beside its mirror. `failed` counts the downloads that did not work (to try again). */
async function saveImages(hub: Hub, c: AtlassianConn, pageId: string, storage: string): Promise<{ saved: number; failed: number }> {
  const wanted = attachmentsShown(storage).filter((f) => (/\.([a-z0-9]+)$/i.exec(f)?.[1]?.toLowerCase() ?? "") in MEDIA_TYPES);
  if (!wanted.length) return { saved: 0, failed: 0 };
  let saved = 0, failed = 0;
  for await (const a of paged(hub, c, `/wiki/api/v2/pages/${pageId}/attachments?limit=250`)) {
    const file = String(a.title ?? "");
    if (!wanted.includes(file) || !a.downloadLink || (a.fileSize ?? 0) > MAX_MEDIA_BYTES) continue;
    try {
      const r = await fetchWithTimeout(hub.fetch, `${API}/ex/confluence/${c.cloud_id}/wiki${a.downloadLink}`, "Confluence", { headers: { authorization: `Bearer ${c.access_token}` } }, 60_000);
      if (!r.ok) { failed++; continue; }
      const bytes = new Uint8Array(await r.arrayBuffer());
      if (bytes.length > MAX_MEDIA_BYTES) continue;
      const dest = mediaPath(hub, pageId, file);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, bytes);
      saved++;
    } catch { failed++; }
  }
  return { saved, failed };
}

/** Unlink: the tokens go, and so do the mirrored Confluence pages and their images. */
export function disconnectAtlassian(hub: Hub) {
  const c = hub.connections.get().atlassian;
  for (const k of c?.spaces ?? []) {
    for (const p of hub.wiki.pagesOf(`confluence:${k}`)) fs.rmSync(path.dirname(mediaPath(hub, p.path.split("/")[1] ?? "", "x")), { recursive: true, force: true });
    hub.wiki.dropSource(`confluence:${k}`);
  }
  hub.connections.update((x) => { delete x.atlassian; });
  return hub.connections.view().atlassian;
}
