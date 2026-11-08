import type { Entity } from "@everythingapp/shared";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Hub } from "../hub.js";
import { StoreError } from "../store.js";
import { fetchWithTimeout, norm, stableId } from "./util.js";

const ART_MAX_BYTES = 2 * 1024 * 1024;
const ART_RETRY_MS = 7 * 24 * 3600_000;

/**
 * A game's header picture, fetched once by the hub from Steam's image CDN and kept in `<data>/game-art/`, so devices
 * never contact Steam's CDN themselves (that would tell it each device's address and, game by game, the library).
 * Only for a Steam game in the library while Steam is linked; a cached picture stays servable after an unlink.
 * Null when Steam has no picture (asked again after 7 days).
 */
export async function steamArt(hub: Hub, appid: string): Promise<{ bytes: Buffer; type: string } | null> {
  if (!/^\d{1,10}$/.test(appid)) throw new StoreError(400, "a Steam app id is digits");
  const dir = path.join(hub.cfg.dataDir, "game-art");
  const file = path.join(dir, `${appid}.jpg`);
  const none = path.join(dir, `${appid}.none`);
  try { return { bytes: fs.readFileSync(file), type: "image/jpeg" }; } catch { /* not cached yet */ }
  try { if (Date.now() - fs.statSync(none).mtimeMs < ART_RETRY_MS) return null; } catch { /* never missing */ }
  const known = hub.store.list({ kind: "game", limit: 100000 }).some((g) => !g.deleted_at && String(g.fields.steam_appid ?? "") === appid);
  if (!hub.connections.get().steam || !known) throw new StoreError(404, "no Steam game with that id in the library");
  const r = await fetchWithTimeout(hub.fetch, `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`, "Steam's image server", { headers: { accept: "image/*" } }, 15_000);
  const host = (() => { try { return new URL(r.url || "https://cdn.cloudflare.steamstatic.com/").hostname; } catch { return ""; } })();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (r.status === 404) { fs.writeFileSync(none, ""); return null; }
  if (!r.ok) throw new StoreError(502, `Steam's image server answered ${r.status}`);
  if (!/(^|\.)steamstatic\.com$/.test(host) || !/^image\//.test(r.headers.get("content-type") ?? "")) throw new StoreError(502, "Steam's image server sent something other than a picture");
  const bytes = Buffer.from(await r.arrayBuffer());
  if (bytes.length > ART_MAX_BYTES) throw new StoreError(502, "Steam's picture is larger than 2 MB");
  const tmp = `${file}.partial`;
  fs.writeFileSync(tmp, bytes, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return { bytes, type: "image/jpeg" };
}

/**
 * Steam: the member signs in through Steam (OpenID), the hub reads that account's owned games with its own Web API
 * key, and keeps them as `game` entities with total and recent playtime. A game typed in by hand with the same name
 * gains the Steam numbers instead of a copy. Members never handle a key.
 */

const API = "https://api.steampowered.com";

interface OwnedGame { appid: number; name?: string; playtime_forever?: number; playtime_2weeks?: number; rtime_last_played?: number }

async function steamJson(hub: Hub, url: string): Promise<any> {
  const r = await fetchWithTimeout(hub.fetch, url, "Steam");
  if (r.status === 401 || r.status === 403) throw new StoreError(422, "Steam did not accept that key. Copy it again from steamcommunity.com/dev/apikey; a key stops working when the Steam password changes, so make a new one there if it did.");
  if (!r.ok) throw new StoreError(502, `Steam answered ${r.status}`);
  return r.json();
}

/**
 * The hub's own Steam Web API key: what a released service keeps on its server so members never need one. From
 * EA_STEAM_KEY, else the one saved in Connections (an older link kept the key on the member's connection).
 */
export function steamKey(hub: Hub): string | null {
  const c = hub.connections.get();
  return process.env.EA_STEAM_KEY || c.steam_key || c.steam?.api_key || null;
}

/** Save the hub's key (checked against Steam first). */
export async function setSteamKey(hub: Hub, body: Record<string, unknown>) {
  const key = typeof body.api_key === "string" ? body.api_key.trim() : "";
  if (!/^[0-9A-Fa-f]{32}$/.test(key)) throw new StoreError(422, "a Steam Web API key is 32 letters and digits");
  const r = await fetchWithTimeout(hub.fetch, `${API}/ISteamWebAPIUtil/GetSupportedAPIList/v1/?key=${encodeURIComponent(key)}`, "Steam");
  if (r.status === 401 || r.status === 403) throw new StoreError(422, "Steam did not accept that key. Copy it again from steamcommunity.com/dev/apikey; a key stops working when the Steam password changes, so make a new one there if it did.");
  hub.connections.update((c) => { c.steam_key = key; });
  return hub.connections.view().steam;
}

// ---------- Sign in through Steam (OpenID 2.0): the member signs in on Steam's own page; the hub learns only the SteamID ----------

const OPENID = "https://steamcommunity.com/openid/login";
const OPENID_NS = "http://specs.openid.net/auth/2.0";
const SIGNIN_TTL_MS = 10 * 60_000;
const pending = new Map<string, { at: number; client: string; returnTo: string }>();

/**
 * Start a sign-in: the URL of Steam's sign-in page, which comes back to `<hub>/connections/steam/return`. `hub` is the
 * address this client reaches the hub at; `client` is "apple" (back to the app through everythingapp://) or "web".
 */
export function steamSignIn(hub: Hub, body: Record<string, unknown>) {
  if (!steamKey(hub)) throw new StoreError(409, "the hub has no Steam Web API key yet");
  let base: URL;
  try {
    base = new URL(String(body.hub ?? ""));
  } catch {
    throw new StoreError(422, "hub must be the address this app reaches the hub at");
  }
  if (!/^https?:$/.test(base.protocol)) throw new StoreError(422, "hub must be an http or https address");
  const now = Date.now();
  for (const [k, v] of pending) if (now - v.at > SIGNIN_TTL_MS) pending.delete(k);
  const state = crypto.randomUUID();
  const returnTo = `${base.origin}/connections/steam/return?state=${state}`;
  pending.set(state, { at: now, client: body.client === "apple" ? "apple" : "web", returnTo });
  const q = new URLSearchParams({
    "openid.ns": OPENID_NS,
    "openid.mode": "checkid_setup",
    "openid.return_to": returnTo,
    "openid.realm": base.origin,
    "openid.identity": `${OPENID_NS}/identifier_select`,
    "openid.claimed_id": `${OPENID_NS}/identifier_select`,
  });
  return { url: `${OPENID}?${q}` };
}

/** Steam's redirect back. Checks the answer with Steam, links the SteamID, reads the library. */
export async function steamReturn(hub: Hub, query: Record<string, string>): Promise<{ client: string; ok: boolean; message: string }> {
  const p = pending.get(query.state ?? "");
  if (!p || Date.now() - p.at > SIGNIN_TTL_MS) return { client: "web", ok: false, message: "This sign-in link expired. Start again from Settings, Connections." };
  pending.delete(query.state);
  const fail = (message: string) => ({ client: p.client, ok: false, message });
  if (query["openid.mode"] !== "id_res") return fail("Steam sign-in was cancelled.");
  if (query["openid.op_endpoint"] !== OPENID || query["openid.return_to"] !== p.returnTo) return fail("That answer did not come from Steam.");
  const check = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (k.startsWith("openid.")) check.set(k, v);
  check.set("openid.mode", "check_authentication");
  const r = await fetchWithTimeout(hub.fetch, OPENID, "Steam", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: check.toString() });
  if (!(await r.text()).includes("is_valid:true")) return fail("Steam did not confirm the sign-in.");
  const id = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/.exec(query["openid.claimed_id"] ?? "")?.[1];
  if (!id) return fail("Steam sent no account id.");
  const key = steamKey(hub);
  if (!key) return fail("The hub has no Steam Web API key.");
  const j = await steamJson(hub, `${API}/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(key)}&steamids=${id}`);
  const player = j?.response?.players?.[0];
  hub.connections.update((c) => {
    // A key kept on the old link (made before Sign in through Steam) is the hub's key: it moves to steam_key
    // instead of going with the link, which left the hub with no key and every sync refused.
    if (c.steam?.api_key && !c.steam_key) c.steam_key = c.steam.api_key;
    c.steam = { steam_id: id, persona: String(player?.personaname ?? ""), profile_url: String(player?.profileurl ?? "") };
  });
  try {
    const s = await syncSteam(hub);
    return { client: p.client, ok: true, message: `Steam linked as ${player?.personaname ?? id}: ${s.games} games.` };
  } catch (e) {
    return { client: p.client, ok: true, message: `Steam linked as ${player?.personaname ?? id}, but the library could not be read: ${(e as Error).message}` };
  }
}

export function disconnectSteam(hub: Hub) {
  hub.connections.update((c) => {
    if (c.steam?.api_key && !c.steam_key) c.steam_key = c.steam.api_key;
    delete c.steam;
  });
  return hub.connections.view().steam;
}

const iso = (sec?: number) => (sec && sec > 0 ? new Date(sec * 1000).toISOString() : undefined);

/** Read the owned games and write the changes. Records the outcome on the connection either way. */
export async function syncSteam(hub: Hub): Promise<{ games: number; created: number; updated: number }> {
  const s = hub.connections.get().steam;
  const key = steamKey(hub);
  if (!s?.steam_id) throw new StoreError(409, "Steam is not linked");
  if (!key) throw new StoreError(409, "the hub has no Steam Web API key");
  try {
    const j = await steamJson(hub, `${API}/IPlayerService/GetOwnedGames/v1/?key=${encodeURIComponent(key)}&steamid=${s.steam_id}&include_appinfo=1&include_played_free_games=1&format=json`);
    const owned = j?.response?.games as OwnedGame[] | undefined;
    if (!owned) throw new StoreError(422, "Steam returned no games. In Steam, open Edit Profile, Privacy Settings, and set Game details to Public.");
    const r = applyOwnedGames(hub, owned);
    hub.connections.update((c) => { if (c.steam) { c.steam.last_sync = new Date().toISOString(); c.steam.games = r.games; delete c.steam.last_error; } });
    return r;
  } catch (e) {
    hub.connections.update((c) => { if (c.steam) c.steam.last_error = (e as Error).message; });
    throw e;
  }
}

/** Merge Steam's list into `game` entities: by app id, else by name, else a new game. Writes only what changed. */
export function applyOwnedGames(hub: Hub, owned: OwnedGame[]): { games: number; created: number; updated: number } {
  const all = hub.store.list({ kind: "game", includeDeleted: true, limit: 1_000_000 });
  const byApp = new Map<number, Entity>();
  const byName = new Map<string, Entity>();
  for (const e of all) {
    if (typeof e.fields.steam_appid === "number") byApp.set(e.fields.steam_appid, e);
    else if (!e.deleted_at) byName.set(norm(String(e.fields.name ?? "")), e);
  }
  let created = 0;
  let updated = 0;
  for (const g of owned) {
    const name = (g.name ?? "").trim();
    if (!g.appid || !name) continue;
    const want: Record<string, unknown> = {
      steam_appid: g.appid,
      playtime_min: Math.max(0, Math.round(g.playtime_forever ?? 0)),
      playtime_2w_min: Math.max(0, Math.round(g.playtime_2weeks ?? 0)),
    };
    const last = iso(g.rtime_last_played);
    const cur = byApp.get(g.appid) ?? byName.get(norm(name));
    if (!cur) {
      const made = hub.store.create("game", { name, ...want, ...(last ? { last_played: last } : {}), source: "steam" }, "personal", stableId(`steam:${g.appid}`));
      byApp.set(g.appid, made);
      created++;
      continue;
    }
    // Once matched by name, the game belongs to this app id: a second Steam game with a name that folds the same
    // ("DOOM" and "Doom.") gets its own entry instead of overwriting this one's numbers.
    if (!byApp.has(g.appid)) { byApp.set(g.appid, cur); byName.delete(norm(name)); if (typeof cur.fields.steam_appid !== "number") want.steam_appid = g.appid; }
    // Deleted by hand: leave it gone.
    if (cur.deleted_at) continue;
    if (last && (!cur.fields.last_played || String(cur.fields.last_played) < last)) want.last_played = last;
    const changed = Object.fromEntries(Object.entries(want).filter(([k, v]) => cur.fields[k] !== v));
    if (Object.keys(changed).length) {
      hub.store.patch(cur.id, changed);
      updated++;
    }
  }
  return { games: owned.length, created, updated };
}
