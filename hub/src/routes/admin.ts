import { Hono } from "hono";
import type { Hub } from "../hub.js";
import { readJsonObject } from "../http.js";
import { StoreError } from "../store.js";
import { autoModel, hubAddress, pairingLinks, pullState, removeAi, saveAi, setupDetect, setupView, setupViewChecked, startPull } from "../setup.js";
import {
  applicationBoard, calcPayoff, calcSplit, calcUnit, draftCoverLetter, instantiateChecklist,
  markPlayed, pickGame, subscriptions, toggleChecklistItem,
} from "../admin.js";
import { calcTakeHome } from "../takehome.js";
import { mealsTax } from "../mealstax.js";
import { readRetention, setRetention, RETENTION_CHOICES } from "../retention.js";
import { steamArt } from "../imports/steam.js";

/** Optional JSON body: empty is `{}`, anything else must be an object. */
async function optionalBody(c: Parameters<typeof readJsonObject>[0]): Promise<Record<string, unknown>> {
  const text = await c.req.raw.clone().text();
  return text.trim() ? readJsonObject(c) : {};
}

/** Module 7: checklists, the job pipeline, games, calculators and subscriptions. */
export function adminRoutes() {
  const r = new Hono<{ Variables: { hub: Hub } }>();

  r.post("/checklists/:id/instantiate", async (c) => c.json(instantiateChecklist(c.get("hub").store, c.req.param("id"), await optionalBody(c)), 201));
  r.post("/checklists/:id/toggle", async (c) => c.json(toggleChecklistItem(c.get("hub").store, c.req.param("id"), await readJsonObject(c))));

  // First-run setup (setup.ts): the machine's graphics card and model servers, choosing the model (local or cloud),
  // fetching it into Ollama, and links that pair a device in one step.
  r.get("/setup", async (c) => c.json(await setupViewChecked(c.get("hub"))));
  r.get("/setup/detect", async (c) => c.json(await setupDetect(c.get("hub"))));
  r.put("/setup/ai", async (c) => c.json(await saveAi(c.get("hub"), await readJsonObject(c))));
  r.delete("/setup/ai/:kind", (c) => c.json(removeAi(c.get("hub"), c.req.param("kind"))));
  r.post("/setup/ollama/pull", async (c) => c.json(startPull(c.get("hub"), String((await readJsonObject<{ model?: string }>(c)).model ?? "").trim())));
  // The single confirmation: find this machine's Ollama, use it with the model, and start the download if needed.
  r.post("/setup/model/auto", async (c) => c.json(await autoModel(c.get("hub"), await optionalBody(c))));
  r.get("/setup/ollama/pull", (c) => c.json({ pull: pullState() }));
  r.get("/setup/pair", (c) => {
    const hub = c.get("hub");
    const address = hubAddress(hub, c.req.url, c.req.header("x-forwarded-host"), c.req.header("x-forwarded-proto"));
    return c.json(pairingLinks(hub, address, (c.req.query("name") ?? "").trim().slice(0, 60)), 200, { "cache-control": "no-store" });
  });

  // Who the hub belongs to: the name the assistant uses for its owner (profile.ts).
  r.get("/profile", (c) => { const hub = c.get("hub"); return c.json({ ...hub.profile.get(), named: hub.profile.named() }); });
  r.put("/profile", async (c) => {
    const body = await readJsonObject<{ name?: unknown; pet?: unknown; contact?: unknown }>(c);
    if (body.name !== undefined && typeof body.name !== "string") throw new StoreError(422, "name is text");
    try { return c.json(c.get("hub").profile.set({ name: body.name as string | undefined, pet: typeof body.pet === "string" ? body.pet : undefined, contact: typeof body.contact === "string" ? body.contact : undefined })); }
    catch (e) { throw new StoreError(422, (e as Error).message); }
  });

  // One-door keys (feedkeys.ts): the calendar feed and sensor boards get these, never the hub token.
  r.get("/feeds", (c) => {
    const hub = c.get("hub");
    return c.json({ calendar: { key: hub.feedKeys.get("calendar"), path: `/calendar.ics?key=${hub.feedKeys.get("calendar")}` }, sensors: { key: hub.feedKeys.get("sensors"), path: "/sensors/<name>/readings?key=<key>" } });
  });
  r.post("/feeds/:kind/rotate", (c) => {
    const hub = c.get("hub");
    const kind = c.req.param("kind");
    if (kind !== "calendar" && kind !== "sensors") throw new StoreError(404, "no such key: calendar or sensors");
    hub.feedKeys.rotate(kind);
    return c.json({ calendar: { key: hub.feedKeys.get("calendar"), path: `/calendar.ics?key=${hub.feedKeys.get("calendar")}` }, sensors: { key: hub.feedKeys.get("sensors"), path: "/sensors/<name>/readings?key=<key>" } });
  });

  // Modules (modules.ts): which parts of the app are on, one setting for every device.
  r.get("/modules", (c) => c.json({ modules: c.get("hub").modules.list() }));
  r.put("/modules", async (c) => {
    const hub = c.get("hub");
    const body = await readJsonObject<Record<string, unknown>>(c);
    try { hub.modules.set(body); } catch (e) { throw new StoreError(422, (e as Error).message); }
    return c.json({ modules: hub.modules.list() });
  });

  r.get("/applications/board", (c) => c.json(applicationBoard(c.get("hub").store)));
  r.post("/applications/:id/cover-letter", async (c) => c.json(await draftCoverLetter(c.get("hub"), c.req.param("id"), await optionalBody(c))));

  r.post("/games/pick", async (c) => c.json(pickGame(c.get("hub").store, await readJsonObject(c))));
  r.post("/games/:id/played", async (c) => c.json(markPlayed(c.get("hub").store, c.req.param("id"), await optionalBody(c))));
  // A Steam game's header picture through the hub, so no device contacts Steam's image CDN (privacy-network.md).
  r.get("/games/art/:appid", async (c) => {
    const art = await steamArt(c.get("hub"), c.req.param("appid"));
    if (!art) return c.json({ error: "Steam has no picture for this game" }, 404);
    return new Response(new Uint8Array(art.bytes), { headers: { "content-type": art.type, "cache-control": "private, max-age=604800" } });
  });

  r.post("/calc/split", async (c) => c.json(calcSplit(await readJsonObject(c))));
  r.post("/calc/payoff", async (c) => c.json(calcPayoff(await readJsonObject(c))));
  r.post("/calc/unit", async (c) => c.json(calcUnit(await readJsonObject(c))));
  r.post("/calc/takehome", async (c) => c.json(calcTakeHome(await readJsonObject(c))));
  r.post("/calc/meals-tax", async (c) => c.json(mealsTax(await readJsonObject(c))));

  // How long chats and host command output are kept (retention.ts); 0 keeps forever, the default.
  r.get("/settings/retention", (c) => c.json({ ...readRetention(c.get("hub")), choices: RETENTION_CHOICES }));
  r.put("/settings/retention", async (c) => c.json(setRetention(c.get("hub"), await readJsonObject(c))));

  r.get("/finance/subscriptions", (c) => c.json(subscriptions(c.get("hub").store)));

  return r;
}
