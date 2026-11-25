import fs from "node:fs";
import { Readable } from "node:stream";
import { Hono } from "hono";
import { nowIso } from "@everythingapp/shared";
import type { Hub } from "../hub.js";
import { VERSION } from "../hub.js";
import { readJsonObject } from "../http.js";
import { StoreError } from "../store.js";
import { appReleases, compareVersions, isAppPlatform, releaseRepo, type AppPlatform } from "../appreleases.js";
import { parseApp, type DeviceSummary } from "../devices.js";
import { sourcesChanged } from "../sources.js";
import { alertsChanged } from "../alerts.js";

/**
 * How each device can come up to the hub's version:
 * - `current`: it runs the hub's version or a later one;
 * - `self`: the Windows or Android app, which installs the hub's copy of the new app (Settings, About, or when asked);
 * - `store`: the iPhone, iPad, Mac and Watch apps, which update from the App Store or TestFlight;
 * - `reload`: a browser, which loads the hub's own copy of the app and needs only a reload;
 * - `unknown`: it sends no version (an app from before 1.0.5): the Windows and Android ones need the new app installed
 *   by hand once, from the release page.
 */
export type UpdateOutlook = "current" | "self" | "store" | "reload" | "unknown";

export function outlookOf(d: DeviceSummary, version = VERSION): UpdateOutlook {
  if (!d.app) return "unknown";
  if ((compareVersions(d.app.version, version) ?? -1) >= 0) return "current";
  if (d.app.kind === "windows" || d.app.kind === "android") return "self";
  if (d.app.kind === "web") return "reload";
  return "store";
}

/** The platform whose installer a device needs, for the ones that update from the hub. */
function platformOf(d: DeviceSummary): AppPlatform | null {
  return d.app?.kind === "windows" || d.app?.kind === "android" ? d.app.kind : null;
}

export function appUpdatesView(hub: Hub, deviceId?: string) {
  const devices = hub.devices.list().map((d) => ({ ...d, outlook: outlookOf(d) }));
  const me = deviceId ? devices.find((d) => d.id === deviceId) : undefined;
  return {
    version: VERSION,
    repo: releaseRepo(),
    apps: appReleases(hub).view(),
    devices,
    // The asking device's own ask, so an app learns of an update the owner asked for from any device.
    you: me ? { device_id: me.id, app: me.app, request: me.app_update && !me.app_update.declined_at ? me.app_update : null } : null,
  };
}

/**
 * Ask devices to update (`ids`, or every device). Only the Windows and Android apps can, from the hub's copy; each of
 * the others is answered with how it updates instead. Starts fetching the installers the asked devices need.
 */
export function requestAppUpdates(hub: Hub, ids: string[] | null, by?: string) {
  const all = hub.devices.list();
  const chosen = ids ? all.filter((d) => ids.includes(d.id)) : all;
  if (ids && chosen.length !== ids.length) throw new StoreError(404, "no such device", { missing: ids.filter((i) => !all.some((d) => d.id === i)) });
  const rel = appReleases(hub);
  const need = new Set<AppPlatform>();
  const results = chosen.map((d) => {
    const outlook = outlookOf(d);
    if (outlook === "self") {
      hub.store.patch(d.id, { app_update: { requested_at: nowIso(), version: VERSION, ...(by ? { by } : {}) } });
      const p = platformOf(d);
      if (p) need.add(p);
      return { id: d.id, name: d.name, app: d.app, result: "requested" as const };
    }
    return { id: d.id, name: d.name, app: d.app, result: outlook };
  });
  for (const p of need) void rel.prepare(p);
  return { version: VERSION, apps: rel.view(), devices: results };
}

export function appUpdateRoutes() {
  const r = new Hono<{ Variables: { hub: Hub; device_id?: string } }>();

  r.get("/app-updates", (c) => c.json(appUpdatesView(c.get("hub"), c.get("device_id"))));

  // Each app says which app and version it is once a start: { kind, version, build? } (devices.ts, APP_KINDS).
  r.put("/devices/me/app", async (c) => {
    const id = c.get("device_id");
    if (!id) throw new StoreError(400, "only a device signed in with its own key reports its app");
    const app = parseApp(await readJsonObject(c));
    if (!app) throw new StoreError(422, "kind (windows, android, web, ios, ipados, macos or watchos) and version (1.2.3) are required");
    c.get("hub").devices.noteApp(id, app);
    // Said before the device reads anything: an app from before 1.0.18 finds every list's tasks back in its account's
    // own space, and an update may let a Personal or Work choice take effect (sources.ts), or Alert from Apple
    // Reminders off (alerts.ts).
    sourcesChanged(c.get("hub"));
    alertsChanged(c.get("hub"));
    return c.json({ app, hub_version: VERSION });
  });

  // Fetch this platform's installer from the hub's release (GitHub), if the hub does not have it yet. Answers within
  // about 3 seconds with where it stands; GET /app-updates says when it is ready.
  r.post("/app-updates/:platform/prepare", async (c) => {
    const p = c.req.param("platform");
    if (!isAppPlatform(p)) throw new StoreError(404, "the hub serves the Windows and Android apps only");
    const rel = appReleases(c.get("hub"));
    const job = rel.prepare(p);
    const s = await Promise.race([job, new Promise<null>((res) => setTimeout(() => res(null), 3_000))]);
    return c.json(s ?? rel.state(p));
  });

  // The installer itself, once ready. Its SHA-256 and signature are in GET /app-updates (apps), checked by the app.
  r.get("/app-updates/:platform/file", (c) => {
    const p = c.req.param("platform");
    if (!isAppPlatform(p)) throw new StoreError(404, "the hub serves the Windows and Android apps only");
    const f = appReleases(c.get("hub")).ready(p);
    const body = Readable.toWeb(fs.createReadStream(f.path)) as unknown as ReadableStream;
    return new Response(body, {
      headers: {
        "content-type": p === "android" ? "application/vnd.android.package-archive" : "application/octet-stream",
        "content-length": String(f.size),
        "content-disposition": `attachment; filename="${f.file}"`,
        "cache-control": "no-store",
      },
    });
  });

  // Ask devices to update: { devices: [ids] } or every device.
  r.post("/app-updates/request", async (c) => {
    const body = await readJsonObject<{ devices?: unknown }>(c);
    const ids = Array.isArray(body.devices) ? body.devices.filter((x): x is string => typeof x === "string") : null;
    const hub = c.get("hub");
    const asker = c.get("device_id");
    const by = asker ? String(hub.store.get(asker)?.fields.name ?? "") || undefined : undefined;
    return c.json(requestAppUpdates(hub, ids, by));
  });

  // The device's own Not now: the ask stays on record as declined, and the app stops asking until a new one comes.
  r.post("/app-updates/request/decline", (c) => {
    const hub = c.get("hub");
    const id = c.get("device_id");
    if (!id) throw new StoreError(400, "only a device can decline its own update");
    const ask = hub.store.get(id)?.fields.app_update as Record<string, unknown> | null | undefined;
    if (ask) hub.store.patch(id, { app_update: { ...ask, declined_at: nowIso() } });
    return c.json({ declined: !!ask });
  });

  return r;
}
