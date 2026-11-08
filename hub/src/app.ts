import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "@hono/node-server/serve-static";
import fs from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";
import { nowIso } from "@everythingapp/shared";
import { moduleDef, moduleOfPath } from "./modules.js";
import { refuseToolCall } from "./ai/api-guard.js";
import { StoreError } from "./store.js";
import { VERSION, type Hub } from "./hub.js";
import { syncRoutes } from "./routes/sync.js";
import { entityRoutes } from "./routes/entities.js";
import { vaultRoutes } from "./routes/vault.js";
import { MAX_UPLOAD_BYTES } from "./gallery.js";
import { imageRoutes } from "./routes/images.js";
import { aiRoutes } from "./routes/ai.js";
import { noteRoutes } from "./routes/notes.js";
import { statusRoutes } from "./routes/status.js";
import { plannerRoutes } from "./routes/planner.js";
import { memoryRoutes } from "./routes/memory.js";
import { homeRoutes } from "./routes/home.js";
import { creativeRoutes } from "./routes/creative.js";
import { opsRoutes } from "./routes/ops.js";
import { adminRoutes } from "./routes/admin.js";
import { importRoutes } from "./routes/imports.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { wikiRoutes } from "./routes/wiki.js";
import { layoutRoutes } from "./routes/layouts.js";
import { backupRoutes } from "./routes/backup.js";
import { readJsonObject } from "./http.js";
import { registerDevice, removeDevice } from "./devices.js";
import { hubAddress, pairingLinks } from "./setup.js";
import { errCode } from "./logsafe.js";
import { googleApp } from "./imports/gmail.js";

/**
 * The web app at /app: its own scripts and styles only, pictures and recordings from the hub (and blob: and data: ones
 * it makes), requests only to this hub. Inline style attributes stay allowed (React style props).
 */
export const APP_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

/** Origins of the hub's own browser clients that are not served by the hub: the Windows app and the web dev server. */
const BUILTIN_ORIGINS = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", "http://localhost:5173", "https://localhost:5173", "http://127.0.0.1:5173", "https://127.0.0.1:5173"];
export function corsAllowed(origin: string | undefined, extra: string[] = []): boolean {
  if (!origin) return false;
  const o = origin.replace(/\/+$/, "");
  return BUILTIN_ORIGINS.includes(o) || extra.includes(o);
}

/**
 * Whether the main key may be used by this caller. On the hub's own machine: a connection from loopback that no proxy
 * forwarded. Tailscale Serve also connects from loopback, but it adds the forwarding and Tailscale headers, so a
 * request through it counts as remote and must be named in EA_MAIN_KEY_FROM (its tailnet address or Tailscale login),
 * as must a direct one from the network (its address). `*` lets any caller use it (the behaviour before 2026-11-06).
 */
export function mainKeyAllowed(c: { env: unknown; req: { header(name: string): string | undefined } }, allow: string[]): boolean {
  if (allow.includes("*")) return true;
  const peer = ((c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress ?? "").replace(/^::ffff:/, "");
  const loopback = !peer || /^(127\.|::1$)/.test(peer);
  const forwarded = c.req.header("x-forwarded-for");
  const login = c.req.header("tailscale-user-login");
  const proxied = !!(forwarded || login || c.req.header("forwarded") || c.req.header("x-forwarded-host") || c.req.header("tailscale-user-name"));
  if (loopback && !proxied) return true;
  const who = new Set<string>();
  if (!loopback) who.add(peer.toLowerCase());
  else {
    for (const a of (forwarded ?? "").split(",")) if (a.trim()) who.add(a.trim().replace(/^::ffff:/, "").toLowerCase());
    if (login) who.add(login.trim().toLowerCase());
  }
  return allow.some((a) => who.has(a.trim().toLowerCase()));
}

/** A device's own key that still belongs to a paired device. */
/**
 * How devices name and color this hub (several people's hubs can share one machine): EA_HUB_NAME, else the owner's
 * name from the profile; EA_HUB_COLOR or null. Only for callers with a key (/health with one).
 */
export function hubIdentity(hub: Hub): { name: string | null; color: string | null } {
  const name = hub.cfg.hubName || (hub.profile.get().name ?? "").trim();
  return { name: name || null, color: hub.cfg.hubColor || null };
}

function liveDeviceKey(hub: Hub, given: string): boolean {
  const found = hub.deviceKeys.lookup(given);
  const device = found && "device" in found ? found.device : null;
  const e = device ? hub.store.get(device) : null;
  return !!device && e?.kind === "device" && !e.deleted_at;
}

/** A Google app is set up or a mailbox is linked: the only time the privacy page Google links to is needed. */
function gmailLinked(hub: Hub): boolean {
  return !!googleApp(hub) || (hub.connections.get().google ?? []).length > 0;
}

/** Largest request body the hub accepts. Captures carry small attachments only; anything bigger is a mistake. */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** `auth`: "owner" for the hub's main key (EA_TOKEN), "device" for a device's own key (devicekeys.ts). */
export type App = Hono<{ Variables: { hub: Hub; device_id?: string; auth?: "owner" | "device" } }>;

function tokenMatches(expected: string, given: string | undefined): boolean {
  if (!expected || !given) return false;
  // Hash both sides so the comparison runs over equal lengths regardless of input.
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(given).digest();
  return timingSafeEqual(a, b);
}

/**
 * Wrong tokens are answered more slowly each time (0.2 s doubling to 5 s) from the same address, so guessing is
 * slow; nobody is locked out, and a right token is never delayed. Addresses come from the proxy in front (Tailscale
 * Serve, a reverse proxy) when there is one.
 */
const failures = new Map<string, { n: number; at: number }>();
/** Events held for one /live client that is not reading before it is dropped. */
const LIVE_QUEUE_MAX = 2000;

export function authDelayMs(key: string, now = Date.now()): number {
  const f = failures.get(key);
  if (!f || now - f.at > 10 * 60_000) return 0;
  return Math.min(5000, 200 * 2 ** Math.max(0, f.n - 1));
}
function noteFailure(key: string, now = Date.now()) {
  const f = failures.get(key);
  failures.set(key, { n: f && now - f.at <= 10 * 60_000 ? f.n + 1 : 1, at: now });
  if (failures.size > 10_000) failures.clear();
}

/**
 * Who is guessing: the connecting address, or, when that is a proxy on this machine (Tailscale Serve), the address it
 * reports. A caller reaching the hub directly cannot pick its own key by sending the header.
 */
function caller(c: { env: unknown; req: { header(name: string): string | undefined } }): string {
  const peer = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress ?? "";
  const viaLocalProxy = !peer || /^(127\.|::1$|::ffff:127\.)/.test(peer);
  return viaLocalProxy ? (c.req.header("tailscale-user-login") ?? c.req.header("x-forwarded-for") ?? "local").split(",")[0].trim() : peer;
}

/** A wrong key or code: noted against the caller, answered after the caller's current delay. */
async function slowDown(who: string): Promise<void> {
  const wait = authDelayMs(who);
  noteFailure(who);
  if (wait) await new Promise((r) => setTimeout(r, wait));
}

/** The pattern of the route that answered (`/entities/:id`), for logs; never the path itself. */
function routeOf(c: { req: { matchedRoutes: { method: string; path: string }[] } }): string {
  const r = c.req.matchedRoutes.filter((m) => m.method !== "ALL").pop();
  return r?.path ?? "(no route)";
}

export function createApp(hub: Hub): App {
  const app: App = new Hono();

  // Plain safety headers on everything; none that would stop the app's own clients loading images across origins.
  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Frame-Options", "DENY");
  });

  // Browser clients on another origin: the Windows app (Tauri) and the web app's dev server, plus EA_CORS_ORIGINS.
  // Any other web page a person has open gets no CORS answer, so it cannot read the hub's replies. The hub's own
  // /app is the same origin and needs none.
  app.use("*", cors({ origin: (o) => (corsAllowed(o, hub.cfg.corsOrigins) ? o : null), allowHeaders: ["Authorization", "Content-Type"], allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"], exposeHeaders: ["Content-Type"], maxAge: 86400 }));
  app.use("*", async (c, next) => {
    c.set("hub", hub);
    const t0 = Date.now();
    await next();
    // Path only (never the query string, which may carry ?token=), never headers or bodies.
    if (hub.cfg.logRequests) {
      const device = c.get("device_id");
      // The route's pattern (/sensors/:name/readings), not the path: a path can name a note, a sensor or a person.
      console.log(`${c.req.method} ${routeOf(c)} ${c.res.status} ${Date.now() - t0}ms${device ? ` device=${String(device).slice(0, 8)}` : ""}`);
    }
  });
  // Gallery uploads (photos) get their own, larger limit; everything else stays small.
  const small = bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: "request body too large", detail: { max_bytes: MAX_BODY_BYTES } }, 413) });
  const upload = bodyLimit({ maxSize: MAX_UPLOAD_BYTES, onError: (c) => c.json({ error: "the file is over 25 MB", detail: { max_bytes: MAX_UPLOAD_BYTES } }, 413) });
  // An import upload streams to disk with its own limit (imports/bulk.ts); pasted text gets 25 MB.
  app.use("*", (c, next) => c.req.path === "/imports/upload" ? next() : (c.req.path === "/images/library" || c.req.path === "/layouts/pictures" || c.req.path === "/imports/text" || c.req.path === "/music/hum" || c.req.path.startsWith("/ai/photos/") || c.req.path === "/connections/password-manager/keepass/import" ? upload : small)(c, next));

  // The built web client, when present, is served at /app so any browser on the tailnet can use it.
  const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  if (fs.existsSync(path.join(webDist, "index.html"))) {
    // The web app loads only its own files and talks only to this hub: a script slipped into a note or a page it
    // shows has nowhere to send what it reads.
    app.use("/app/*", async (c, next) => { await next(); c.header("Content-Security-Policy", APP_CSP); });
    app.get("/app", (c) => c.redirect("/app/"));
    app.use("/app/*", serveStatic({ root: path.relative(process.cwd(), webDist) || ".", rewriteRequestPath: (p) => p.replace(/^\/app\/?/, "/") }));
    app.get("/app/*", (c) => c.html(fs.readFileSync(path.join(webDist, "index.html"), "utf8")));
  }

  // Without a key, only that the hub answers: anyone who can reach it (or a web page in a person's browser) learns no
  // version, no change count and nothing about its models. With a key the device already holds, the full answer.
  app.get("/health", (c) => {
    const m = /^Bearer\s+(.+)$/i.exec(c.req.header("authorization") ?? "");
    const given = m?.[1]?.trim();
    const known = !!given && ((tokenMatches(hub.cfg.token, given) && mainKeyAllowed(c, hub.cfg.mainKeyFrom)) || liveDeviceKey(hub, given));
    return known ? c.json({ ok: true, version: VERSION, time: nowIso(), db_seq: hub.store.seq(), ai: hub.ai.capabilities(), hub: hubIdentity(hub) }) : c.json({ ok: true });
  });

  // Over-the-air iPhone install (no token: Safari cannot send one, and iOS fetches the manifest itself).
  // Reachable only on the tailnet through Tailscale Serve. Files come from <data>/install, written by
  // deploy/publish-ios-build.sh; nothing else is served from there.
  const installDir = path.join(hub.cfg.dataDir, "install");
  const INSTALL_FILES: Record<string, string> = { "EverythingApp.ipa": "application/octet-stream", "manifest.plist": "text/xml", "icon57.png": "image/png", "icon512.png": "image/png" };
  app.get("/install", (c) => {
    let info: { version?: string; build?: string; built_at?: string; commit?: string } = {};
    try { info = JSON.parse(fs.readFileSync(path.join(installDir, "build.json"), "utf8")); } catch { /* no build published */ }
    const ready = fs.existsSync(path.join(installDir, "manifest.plist")) && fs.existsSync(path.join(installDir, "EverythingApp.ipa"));
    const manifest = new URL("/install/manifest.plist", new URL(c.req.url).origin.replace(/^http:/, "https:")).toString();
    const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
    return c.html(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Install Aeneas</title>
<style>body{font:17px -apple-system,system-ui,sans-serif;margin:0;padding:24px;background:#111;color:#eee}a.b{display:block;text-align:center;background:#2f5fbf;color:#fff;padding:16px;border-radius:12px;text-decoration:none;font-weight:600;margin:24px 0}p{color:#aaa;line-height:1.4}</style></head><body>
<h1>Aeneas</h1>
${ready ? `<p>Build ${esc(info.build ?? "?")}${info.built_at ? ` from ${esc(info.built_at)}` : ""}${info.commit ? ` (commit ${esc(info.commit)})` : ""}.</p>
<a class="b" href="itms-services://?action=download-manifest&amp;url=${encodeURIComponent(manifest)}">Install on this iPhone</a>
<p>Tap Install in the box that appears, then go to the Home Screen and wait for the icon to finish. The Watch app updates with it. Keep Tailscale on until it is done.</p>` : "<p>No build has been published yet.</p>"}
</body></html>`);
  });
  app.get("/install/:file", (c) => {
    const name = c.req.param("file");
    const type = INSTALL_FILES[name];
    const file = path.join(installDir, name);
    if (!type || !fs.existsSync(file)) return c.json({ error: "not found" }, 404);
    // Streamed: this route needs no token, and reading the whole app into memory for each request let a few slow
    // readers on the tailnet use up the hub's memory.
    const size = fs.statSync(file).size;
    const body = Readable.toWeb(fs.createReadStream(file)) as unknown as ReadableStream;
    return c.body(body, 200, { "content-type": type, "cache-control": "no-store", "content-length": String(size) });
  });

  // The privacy page Google's sign-in screen links to (Gmail read-only, hub/src/imports/gmail.ts). No token: the
  // consent screen opens it in a plain browser.
  // Shown only while a Gmail mailbox is linked (the one reason it exists), so the owner's name is not on an open page.
  app.get("/privacy", (c) => {
    if (!gmailLinked(hub)) return c.json({ error: "not found" }, 404);
    const p = hub.profile.get();
    const esc = (t: string) => t.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
    const owner = esc(hub.profile.named() ? p.name : "its owner");
    return c.html(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Aeneas privacy</title>
<style>body{font:17px -apple-system,system-ui,sans-serif;margin:0 auto;padding:24px;max-width:680px;background:#111;color:#eee;line-height:1.5}</style></head><body>
<h1>Aeneas privacy</h1>
<p>This Aeneas hub is a personal app run by ${owner} for their own accounts. It runs on their own computer, reachable only on their private network.</p>
<h2>Gmail</h2>
<p>When a mailbox is linked, Aeneas asks Google for read-only access (gmail.readonly). It never sends, changes, deletes or labels mail.</p>
<p>It searches for receipts, renewal notices and vet mail, reads each one with a language model running on the same computer, and keeps only what it finds: a renewal date, a charge, a vet visit. The mail itself is not stored, and nothing from it is sent to any other company or service.</p>
<p>Unlinking a mailbox in Settings, Connections revokes the access with Google and deletes the app's list of that mailbox's messages; things already filed from it (a renewal, a vet visit) stay where they were filed and can be deleted there. Access can also be removed at any time at myaccount.google.com/permissions.</p>
${p.contact ? `<h2>Contact</h2>\n<p>${esc(p.contact)}</p>` : ""}
</body></html>`);
  });

  app.use("*", async (c, next) => {
    if (c.req.path === "/health" || c.req.path === "/privacy" || c.req.path === "/install" || c.req.path.startsWith("/install/")) return next();
    // A new device trades a one-time pairing code for its own key: the code is its only credential.
    if (c.req.method === "POST" && c.req.path === "/devices/claim") return next();
    // One-door keys: a calendar app reads the feed, a sensor board posts readings, and nothing else (feedkeys.ts).
    const key = c.req.query("key") ?? c.req.header("x-ea-key");
    if (key && c.req.method === "GET" && c.req.path === "/calendar.ics" && hub.feedKeys.matches("calendar", key)) return next();
    if (key && c.req.method === "POST" && /^\/sensors\/[^/]+\/readings$/.test(c.req.path) && hub.feedKeys.matches("sensors", key)) return next();
    // Steam's, Atlassian's and Google's sign-in redirects come back in a browser without the token; the route checks its one-time state.
    if (c.req.method === "GET" && (c.req.path === "/connections/steam/return" || c.req.path === "/connections/atlassian/return" || c.req.path === "/connections/google/return")) return next();
    const header = c.req.header("authorization") ?? "";
    const m = /^Bearer\s+(.+)$/i.exec(header);
    const fromHeader = m?.[1]?.trim() || undefined;
    const given = fromHeader || c.req.query("token") || undefined;
    if (!hub.cfg.token) return c.json({ error: "hub has no EA_TOKEN configured" }, 500);
    // The feed token opens one door only, so the machine holding it can report activity and read nothing.
    const feedOnly = c.req.method === "POST" && (c.req.path === "/projects/feed" || c.req.path === "/wiki/feed") && !!hub.cfg.feedToken && tokenMatches(hub.cfg.feedToken, given);
    if (feedOnly) return next();
    if (tokenMatches(hub.cfg.token, given)) {
      // The main key stays on the hub's own machine: never in a link (where it ends up in histories and logs), and from
      // elsewhere only for callers named in EA_MAIN_KEY_FROM. Devices use their own keys.
      if (!fromHeader && !hub.cfg.mainKeyInQuery) { await slowDown(caller(c)); return c.json({ error: "the hub's main key is not accepted in a link; send it in the Authorization header", main_key: "header_only" }, 401); }
      if (!mainKeyAllowed(c, hub.cfg.mainKeyFrom)) { await slowDown(caller(c)); return c.json({ error: "the hub's main key works only on the hub's own machine; pair this device with a code instead (Settings, Devices), or name this caller in EA_MAIN_KEY_FROM", main_key: "not_here" }, 403); }
      c.set("auth", "owner");
      return next();
    }
    // A device's own key: the device is known from the key, and a removed device (its entity deleted) is refused
    // even in the moment before its key is dropped.
    const found = hub.deviceKeys.lookup(given);
    const device = found && "device" in found ? found.device : null;
    const entity = device ? hub.store.get(device) : null;
    if (device && entity?.kind === "device" && !entity.deleted_at) {
      c.set("auth", "device");
      c.set("device_id", device);
      hub.devices.touch(device);
      return next();
    }
    await slowDown(caller(c));
    // A removed device is told so and forgets its key. A key the hub does not know at all (its keys file was lost or
    // restored) is only refused: the device keeps it, so nothing is lost if the file comes back.
    const removed = !!(found && "removed" in found) || (!!device && !!entity?.deleted_at);
    return c.json({ error: "unauthorized", ...(removed ? { device_removed: true } : given?.startsWith("ead1_") ? { unknown_key: true } : {}) }, 401);
  });

  // A module that is off (Settings, Modules) answers like a route that is not there, on every device.
  app.use("*", async (c, next) => {
    const m = moduleOfPath(c.req.path);
    if (m && !hub.modules.on(m)) return c.json({ error: `${moduleDef(m).title} is off. Turn it on in Settings, Modules.`, module: m }, 404);
    return next();
  });

  app.onError((err, c) => {
    if (err instanceof StoreError) return c.json({ error: err.message, ...(err.detail !== undefined ? { detail: err.detail } : {}), ...(err.extra ?? {}) }, err.status as 400);
    if (err instanceof ZodError) return c.json({ error: "validation failed", detail: err.issues }, 422);
    // A bad request body is answered 400 where it is read (readJsonObject); any other SyntaxError is the hub's (an
    // upstream service answering HTML), logged and answered 500 instead of being blamed on the client.
    console.error(`[app] ${c.req.method} ${routeOf(c)}: ${errCode(err)}`);
    // The log has the details; the answer does not, so paths and internals never leave the hub.
    return c.json({ error: "internal error" }, 500);
  });
  app.notFound((c) => c.json({ error: "not found" }, 404));

  // Live events: change, notify, ping.
  app.get("/live", (c) => {
    // A device on its own key is that key's device; the query only names one for a device on the main key.
    const keyed = c.get("auth") === "device" ? c.get("device_id") : undefined;
    const deviceId = keyed ?? c.req.query("device_id");
    if (deviceId && !keyed) { c.set("device_id", deviceId); hub.devices.touch(deviceId); }
    return streamSSE(c, async (stream) => {
      let open = true;
      const queue: { event: string; data: unknown }[] = [];
      let wake: (() => void) | null = null;
      // A client that stopped reading but keeps the socket (a sleeping phone, a stuck proxy) is let go once this many
      // events wait for it, instead of the hub holding every event for it; a client that comes back pulls what it missed.
      const push = (event: string, data: unknown) => {
        if (!open) return;
        if (queue.length >= LIVE_QUEUE_MAX) { open = false; queue.length = 0; wake?.(); try { stream.abort(); } catch { /* already gone */ } return; }
        queue.push({ event, data }); wake?.();
      };
      const offChange = hub.bus.on("change", (e) => push("change", e));
      const offNotify = hub.bus.on("notify", (e) => push("notify", e));
      const offModules = hub.modules.onChange(() => push("modules", { modules: hub.modules.list() }));
      // Removed while connected: the stream ends now, not when the device next reconnects.
      const offRevoke = keyed ? hub.deviceKeys.onRevoke((ids) => { if (ids.includes(keyed)) { open = false; wake?.(); try { stream.abort(); } catch { /* already gone */ } } }) : () => {};
      const ping = setInterval(() => push("ping", { time: nowIso() }), 25000);
      stream.onAbort(() => { open = false; wake?.(); });
      await stream.writeSSE({ event: "ping", data: JSON.stringify({ time: nowIso(), seq: hub.store.seq() }) });
      try {
        while (open) {
          while (queue.length && open) {
            const item = queue.shift()!;
            await stream.writeSSE({ event: item.event, data: JSON.stringify(item.data) });
          }
          if (!open) break;
          await new Promise<void>((resolve) => { wake = resolve; });
          wake = null;
        }
      } finally {
        clearInterval(ping);
        offChange();
        offNotify();
        offModules();
        offRevoke();
      }
    });
  });

  // A device signed in with its own key registers only itself, whatever id it sends.
  app.post("/devices/register", async (c) => {
    const body = await readJsonObject<Record<string, unknown>>(c);
    const { device_id } = registerDevice(hub.store, body, c.get("auth") === "device" ? c.get("device_id") : undefined);
    return c.json({ device_id });
  });

  // ---- pairing (devicekeys.ts) ----
  // A paired device makes a one-time code for the next one: shown as text, a link and a QR code.
  app.post("/devices/pairing", async (c) => {
    const body = await readJsonObject<{ name?: unknown }>(c).catch(() => ({} as { name?: unknown }));
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 60) : "";
    const address = hubAddress(hub, c.req.url, c.req.header("x-forwarded-host"), c.req.header("x-forwarded-proto"));
    return c.json(pairingLinks(hub, address, name, c.get("auth") === "device" ? c.get("device_id") : undefined), 200, { "cache-control": "no-store" });
  });
  // The new device sends the code with its name and platform and gets its own key, once.
  app.post("/devices/claim", async (c) => {
    const body = await readJsonObject<{ code?: unknown; name?: unknown; platform?: unknown; device_id?: unknown; push_token?: unknown }>(c);
    const claimed = typeof body.code === "string" ? hub.deviceKeys.claim(body.code) : null;
    if (!claimed) {
      await slowDown(caller(c));
      throw new StoreError(401, "That pairing code is wrong, used or older than 10 minutes. Make a new one on a device that is already paired.");
    }
    // A code never takes over a device that still has a key: that would sign the real device out. A device paired
    // again after being removed (its key is gone) keeps its old id.
    const askedId = typeof body.device_id === "string" && !hub.deviceKeys.pairedAt().has(body.device_id) ? body.device_id : undefined;
    const d = registerDevice(hub.store, { ...body, device_id: askedId, name: typeof body.name === "string" && body.name.trim() ? body.name : claimed.name || "My device" });
    // A Watch's key is held by the iPhone that made the code for it, and goes when that iPhone is removed.
    const key = hub.deviceKeys.issue(d.device_id, { parent: d.platform === "watch" && claimed.by && claimed.by !== d.device_id ? claimed.by : undefined });
    console.log(`[devices] ${d.device_id.slice(0, 8)} paired (${d.platform})`);
    return c.json({ device_id: d.device_id, key, name: d.name, version: VERSION }, 200, { "cache-control": "no-store" });
  });
  // A device paired before devices had keys (it holds the hub's main key) trades it for its own.
  app.post("/devices/exchange", async (c) => {
    if (c.get("auth") !== "owner") throw new StoreError(409, "this device already has its own key");
    const body = await readJsonObject<Record<string, unknown>>(c);
    const d = registerDevice(hub.store, body);
    // The iPhone trades its Watch's key with its own; the Watch's key goes when that iPhone is removed.
    const parentId = typeof body.parent_id === "string" ? body.parent_id : "";
    const parentOk = d.platform === "watch" && parentId !== d.device_id && hub.store.get(parentId)?.kind === "device";
    const key = hub.deviceKeys.issue(d.device_id, { parent: parentOk ? parentId : undefined });
    console.log(`[devices] ${d.device_id.slice(0, 8)} moved to its own key (${d.platform})`);
    return c.json({ device_id: d.device_id, key, name: d.name }, 200, { "cache-control": "no-store" });
  });
  app.get("/devices", (c) => {
    const paired = hub.deviceKeys.pairedAt();
    const me = c.get("device_id");
    return c.json({ devices: hub.devices.list().map((d) => ({ ...d, paired_at: paired.get(d.id) ?? null, own_key: paired.has(d.id), current: d.id === me })) });
  });
  // Removing a device ends its key now; its entity is marked deleted so every list drops it.
  app.delete("/devices/:id", (c) => {
    const id = c.req.param("id");
    const e = hub.store.get(id);
    if (!e || e.kind !== "device") throw new StoreError(404, "no such device");
    const gone = removeDevice(hub, id);
    return c.json({ removed: id, also: gone.filter((d) => d !== id) });
  });

  app.route("/", syncRoutes());
  app.route("/", entityRoutes());
  app.route("/", vaultRoutes());
  app.route("/", aiRoutes());
  app.route("/", imageRoutes());
  app.route("/", noteRoutes());
  app.route("/", statusRoutes());
  app.route("/", plannerRoutes());
  app.route("/", memoryRoutes());
  app.route("/", homeRoutes());
  app.route("/", importRoutes());
  app.route("/", dashboardRoutes());
  app.route("/", wikiRoutes());
  app.route("/", layoutRoutes());
  app.route("/", creativeRoutes());
  app.route("/", opsRoutes());
  app.route("/", adminRoutes());
  app.route("/", backupRoutes());
  // Assistant tools call this same app in-process, with the hub's own token, so they get the routes' validation and hooks.
  hub.ai.setApi(async (method, path, body) => {
    const refused = refuseToolCall(method, path);
    if (refused) return { status: 403, data: { error: `refused: ${refused}` } };
    const res = await app.request(path, {
      method,
      headers: { authorization: `Bearer ${hub.cfg.token}`, "content-type": "application/json", "x-ea-origin": "assistant" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { error: text.slice(0, 300) }; }
    return { status: res.status, data };
  });

  return app;
}
