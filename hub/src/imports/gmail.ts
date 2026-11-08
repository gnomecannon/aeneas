import crypto from "node:crypto";
import { nowIso } from "@everythingapp/shared";
import type { Hub } from "../hub.js";
import { StoreError } from "../store.js";
import { fetchWithTimeout } from "./util.js";

/**
 * Gmail, read-only: each mailbox signs in with Google (OAuth 2.0, `gmail.readonly` only, nothing that sends, changes
 * or deletes mail) and the hub lists the mail that looks like a receipt, a renewal or expiry notice, an order or a vet
 * visit. mail-filer.ts reads each one with the local model, so renewals, inventory and the pet's records fill themselves.
 * Mail is read in memory and never stored: the hub keeps each message's id, date and what was filed from it. The hub's
 * own Google app (client id and secret) is what a released service keeps on its server; members never handle a key.
 */

const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const SIGNIN_TTL_MS = 10 * 60_000;
/** The first read goes back this far, so a yearly renewal (a domain, insurance) is seen once. */
export const BACKFILL_DAYS = 400;
/** Each later read starts this long before the last one, so mail that arrived late is not missed. */
const OVERLAP_MS = 2 * 24 * 3600_000;
const pending = new Map<string, { at: number; client: string; redirect: string }>();

/**
 * Gmail's own search narrows the mailbox to likely mail before the model reads anything: receipts, renewals, expiries,
 * trials, cancellations and vet mail. Orders are left out: inventory is not built from mail. `{a b}` is OR.
 */
export const MAIL_QUERY = [
  "-in:chats -in:spam -in:trash",
  "{subject:receipt subject:invoice subject:renewal subject:renew subject:renews subject:renewed",
  "subject:renewing subject:subscription subject:membership subject:plan subject:expire subject:expires subject:expiring",
  "subject:expiration subject:trial subject:payment subject:billing subject:bill",
  "subject:cancelled subject:canceled subject:cancellation subject:appointment subject:vaccine subject:vaccination",
  "veterinary \"animal hospital\"}",
].join(" ");

export interface GoogleAccount {
  email: string;
  access_token: string;
  refresh_token: string;
  expires_at: string;
  linked_at: string;
  /** Mail up to this time has been listed; the next read starts a little before it. */
  listed_to?: string;
  /** The search it was listed with; another search lists the mailbox again. */
  query?: string;
  last_sync?: string;
  last_error?: string | null;
}

export function googleApp(hub: Hub): { client_id: string; client_secret: string } | null {
  const c = hub.connections.get();
  const id = process.env.EA_GOOGLE_CLIENT_ID || c.google_app?.client_id;
  const secret = process.env.EA_GOOGLE_CLIENT_SECRET || c.google_app?.client_secret;
  return id && secret ? { client_id: id, client_secret: secret } : null;
}

/**
 * Check the saved Google app without signing in: Google's token address is sent a code that cannot be real. A Client
 * ID and secret Google knows answer `invalid_grant` (the code is wrong, the app is right); a wrong pair answers
 * `invalid_client`. The return address is only checked at sign-in, where Google says so on its own page.
 */
export async function checkGoogleApp(hub: Hub): Promise<{ ok: boolean; message: string }> {
  const app = googleApp(hub);
  if (!app) throw new StoreError(409, "the hub has no Google app yet");
  let r: Response;
  try {
    r = await fetchWithTimeout(hub.fetch, TOKEN_URL, "Google", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: "4/everythingapp-check", client_id: app.client_id, client_secret: app.client_secret, redirect_uri: "https://localhost/check" }).toString() });
  } catch { return { ok: false, message: "Google could not be reached from the hub. Check the hub's internet connection and try again." }; }
  const j = (await r.json().catch(() => ({}))) as { error?: string };
  if (j.error === "invalid_grant") return { ok: true, message: "Google knows this app. Now sign in with Google." };
  if (j.error === "invalid_client" || j.error === "unauthorized_client") return { ok: false, message: "Google does not know this Client ID and secret together. Copy both again from Clients in the Google Cloud console (the secret is shown when the client is made, or under Client secrets)." };
  return { ok: false, message: `Google answered ${r.status}${j.error ? ` (${j.error})` : ""}. Check the Client ID and secret and try again.` };
}

/** Save the hub's Google app (Google Cloud console, OAuth client of type Web application). */
export function setGoogleApp(hub: Hub, body: Record<string, unknown>) {
  const id = typeof body.client_id === "string" ? body.client_id.trim() : "";
  const secret = typeof body.client_secret === "string" ? body.client_secret.trim() : "";
  if (!/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(id)) throw new StoreError(422, "client_id is the Client ID of the OAuth client (it ends in .apps.googleusercontent.com)");
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(secret)) throw new StoreError(422, "client_secret is the Client secret of the OAuth client");
  hub.connections.update((c) => { c.google_app = { client_id: id, client_secret: secret }; });
  return hub.connections.view().google;
}

/** Start a sign-in: Google's account chooser and consent page, which come back to `<hub>/connections/google/return`. */
export function googleSignIn(hub: Hub, body: Record<string, unknown>) {
  const app = googleApp(hub);
  if (!app) throw new StoreError(409, "the hub has no Google app yet");
  let base: URL;
  try {
    base = new URL(String(body.hub ?? ""));
  } catch {
    throw new StoreError(422, "hub must be the address this app reaches the hub at");
  }
  if (base.protocol !== "https:") throw new StoreError(422, "Google sends people back only to an https address");
  const now = Date.now();
  for (const [k, v] of pending) if (now - v.at > SIGNIN_TTL_MS) pending.delete(k);
  const state = crypto.randomUUID();
  const redirect = `${base.origin}/connections/google/return`;
  pending.set(state, { at: now, client: body.client === "apple" ? "apple" : "web", redirect });
  // offline + consent: Google gives a refresh token every time, so a mailbox linked again keeps working.
  const q = new URLSearchParams({ client_id: app.client_id, redirect_uri: redirect, response_type: "code", scope: GMAIL_SCOPE, access_type: "offline", prompt: "select_account consent", state });
  return { url: `${AUTH}?${q}` };
}

async function tokenCall(hub: Hub, body: Record<string, string>) {
  const r = await fetchWithTimeout(hub.fetch, TOKEN_URL, "Google", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });
  const j = (await r.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string };
  if (!r.ok || !j.access_token) throw new StoreError(r.status === 400 || r.status === 401 || r.status === 403 ? 422 : 502, `Google refused the sign-in: ${j.error_description ?? j.error ?? r.status}`);
  return { access: j.access_token, refresh: j.refresh_token ?? "", scope: j.scope ?? "", expires_at: new Date(Date.now() + (j.expires_in ?? 3600) * 1000).toISOString() };
}

/** Google's redirect back: trade the code for tokens, learn which mailbox it is, keep the link and start reading. */
export async function googleReturn(hub: Hub, query: Record<string, string>, read: (email: string) => void = () => {}): Promise<{ client: string; ok: boolean; message: string }> {
  const p = pending.get(query.state ?? "");
  if (!p || Date.now() - p.at > SIGNIN_TTL_MS) return { client: "web", ok: false, message: "This sign-in link expired. Start again from Settings, Connections." };
  pending.delete(query.state);
  const fail = (message: string) => ({ client: p.client, ok: false, message });
  if (query.error) return fail(query.error === "access_denied" ? "Google sign-in was cancelled." : `Google said: ${query.error_description ?? query.error}`);
  if (!query.code) return fail("Google sent no sign-in code.");
  const app = googleApp(hub);
  if (!app) return fail("The hub has no Google app.");
  try {
    const t = await tokenCall(hub, { grant_type: "authorization_code", client_id: app.client_id, client_secret: app.client_secret, code: query.code, redirect_uri: p.redirect });
    if (!t.scope.split(" ").includes(GMAIL_SCOPE)) return fail("Google did not grant reading mail. Sign in again and leave “View your email messages and settings” ticked.");
    if (!t.refresh) return fail("Google sent no lasting sign-in. Remove EverythingApp at myaccount.google.com/permissions and sign in again.");
    const r = await fetchWithTimeout(hub.fetch, `${API}/profile`, "Gmail", { headers: { authorization: `Bearer ${t.access}` } });
    const profile = (await r.json().catch(() => ({}))) as { emailAddress?: string };
    if (!r.ok || !profile.emailAddress) return fail(`Gmail did not say which mailbox this is (${r.status}).`);
    const email = profile.emailAddress.toLowerCase();
    let again = false;
    hub.connections.update((c) => {
      const list = (c.google ??= []);
      const prev = list.find((a) => a.email === email);
      again = !!prev;
      const acct: GoogleAccount = { ...(prev ?? { linked_at: nowIso() }), email, access_token: t.access, refresh_token: t.refresh, expires_at: t.expires_at, last_error: null };
      if (prev) Object.assign(prev, acct); else list.push(acct);
    });
    read(email);
    return { client: p.client, ok: true, message: again ? `Gmail linked again: ${email}.` : `Gmail linked: ${email}. The hub is reading the last ${Math.round(BACKFILL_DAYS / 30)} months of receipts, renewals, orders and vet mail in the background; renewals, inventory and the Pet page fill in over the next few hours.` };
  } catch (e) {
    return fail((e as Error).message);
  }
}

function account(hub: Hub, email: string): GoogleAccount {
  const a = hub.connections.get().google?.find((x) => x.email === email);
  if (!a) throw new StoreError(404, `${email} is not linked`);
  return a;
}

function saveAccount(hub: Hub, email: string, fields: Partial<GoogleAccount>) {
  hub.connections.update((c) => { const a = c.google?.find((x) => x.email === email); if (a) Object.assign(a, fields); });
}

/** A current access token for a mailbox, refreshed when within two minutes of expiring. Google keeps the refresh token. */
async function accessToken(hub: Hub, email: string): Promise<string> {
  const a = account(hub, email);
  if (Date.parse(a.expires_at) - Date.now() > 120_000) return a.access_token;
  const app = googleApp(hub);
  if (!app) throw new StoreError(409, "the hub has no Google app");
  let t;
  try {
    t = await tokenCall(hub, { grant_type: "refresh_token", client_id: app.client_id, client_secret: app.client_secret, refresh_token: a.refresh_token });
  } catch (e) {
    if (e instanceof StoreError && e.status === 422) throw new StoreError(409, `Google sign-in for ${email} expired: sign in again`);
    throw e;
  }
  saveAccount(hub, email, { access_token: t.access, expires_at: t.expires_at, ...(t.refresh ? { refresh_token: t.refresh } : {}) });
  return t.access;
}

/** One Gmail API call for a mailbox. */
export async function gmailGet(hub: Hub, email: string, pathAndQuery: string): Promise<any> {
  const token = await accessToken(hub, email);
  const r = await fetchWithTimeout(hub.fetch, `${API}${pathAndQuery}`, "Gmail", { headers: { authorization: `Bearer ${token}`, accept: "application/json" } }, 30_000);
  if (r.status === 401) throw new StoreError(409, `Google sign-in for ${email} expired: sign in again`);
  if (r.status === 403) throw new StoreError(422, `Gmail refused for ${email}: the sign-in does not allow reading mail`);
  if (r.status === 404) throw new StoreError(404, "that message is gone");
  if (!r.ok) throw new StoreError(502, `Gmail answered ${r.status}`);
  return r.json();
}

/**
 * List a mailbox's likely mail since it was last listed (the first time, the last BACKFILL_DAYS) and queue what is
 * new for the filer, oldest first, so the filer (which takes the newest first) reads recent mail before old.
 */
export async function listMail(hub: Hub, email: string, now: Date = new Date()): Promise<{ listed: number; queued: number }> {
  let a = account(hub, email);
  // The search changed (orders were dropped): mail queued under the old one goes, and the mailbox is listed again
  // from the start; mail already read is never queued twice.
  if (a.listed_to && a.query !== MAIL_QUERY) {
    hub.db.prepare("DELETE FROM mail WHERE account = ? AND state = 'queued'").run(email);
    saveAccount(hub, email, { listed_to: undefined });
    a = account(hub, email);
  }
  const from = a.listed_to ? new Date(Date.parse(a.listed_to) - OVERLAP_MS) : new Date(now.getTime() - BACKFILL_DAYS * 86400_000);
  const ids: string[] = [];
  let pageToken: string | undefined;
  try {
    for (let n = 0; n < 60; n++) {
      const q = new URLSearchParams({ q: `${MAIL_QUERY} after:${Math.floor(from.getTime() / 1000)}`, maxResults: "500", ...(pageToken ? { pageToken } : {}) });
      const j = await gmailGet(hub, email, `/messages?${q}`);
      for (const m of j.messages ?? []) if (typeof m.id === "string") ids.push(m.id);
      pageToken = j.nextPageToken;
      if (!pageToken) break;
    }
  } catch (e) {
    saveAccount(hub, email, { last_sync: nowIso(), last_error: (e as Error).message });
    throw e;
  }
  // Gmail lists newest first; the queue's numbering then runs oldest to newest.
  const insert = hub.db.prepare("INSERT OR IGNORE INTO mail (account, id, state) VALUES (?, ?, 'queued')");
  let queued = 0;
  hub.db.transaction(() => { for (const id of ids.reverse()) queued += insert.run(email, id).changes; }).immediate();
  saveAccount(hub, email, { listed_to: now.toISOString(), query: MAIL_QUERY, last_sync: nowIso(), last_error: null });
  return { listed: ids.length, queued };
}

/** What a mailbox's mail came to: messages listed, still to read, and what was filed. */
export function mailCounts(hub: Hub, email: string) {
  const rows = hub.db.prepare("SELECT state, COUNT(*) AS n FROM mail WHERE account = ? GROUP BY state").all(email) as { state: string; n: number }[];
  const by = Object.fromEntries(rows.map((r) => [r.state, r.n])) as Record<string, number>;
  const filed = hub.db.prepare("SELECT result FROM mail WHERE account = ? AND state = 'filed'").all(email) as { result: string }[];
  const kinds = { renewals: 0, pet: 0, events: 0 };
  for (const f of filed) {
    for (const x of (JSON.parse(f.result ?? "{}").filed ?? []) as { kind: string; action: string }[]) {
      if (x.action === "deleted") continue;
      if (x.kind === "watch") kinds.renewals++;
      else if (x.kind === "pet_event") kinds.pet++;
      else if (x.kind === "event") kinds.events++;
    }
  }
  return { listed: rows.reduce((n, r) => n + r.n, 0), to_read: by.queued ?? 0, read: (by.filed ?? 0) + (by.skipped ?? 0), failed: by.failed ?? 0, filed: kinds };
}

/** Unlink a mailbox: Google is told to drop the sign-in, the tokens and the mailbox's queue go; filed records stay. */
export async function disconnectGoogle(hub: Hub, email: string) {
  const a = account(hub, email);
  await fetchWithTimeout(hub.fetch, REVOKE_URL, "Google", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: a.refresh_token }).toString() }).catch(() => null);
  hub.db.prepare("DELETE FROM mail WHERE account = ?").run(email);
  hub.connections.update((c) => { c.google = (c.google ?? []).filter((x) => x.email !== email); });
  return hub.connections.view().google;
}
