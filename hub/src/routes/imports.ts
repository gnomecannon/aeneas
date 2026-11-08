import fs from "node:fs";
import { Hono } from "hono";
import type { Hub } from "../hub.js";
import { readJsonObject } from "../http.js";
import { disconnectSteam, setSteamKey, steamReturn, steamSignIn, syncSteam } from "../imports/steam.js";
import { connectLetterboxd, disconnectLetterboxd, syncLetterboxd } from "../imports/letterboxd.js";
import { importHealth } from "../imports/health.js";
import { listImports, stopImport, textImport, uploadImport } from "../imports/bulk.js";
import { atlassianReturn, atlassianSignIn, atlassianSpaces, disconnectAtlassian, setAtlassianApp, setAtlassianSpaces, syncConfluence } from "../imports/confluence.js";
import { applicationsList, filmsLibrary, gamesLibrary } from "../imports/library.js";
import { checkGoogleApp, disconnectGoogle, googleReturn, googleSignIn, listMail, mailCounts, setGoogleApp } from "../imports/gmail.js";
import { guideFor, parseGuideService } from "../guides.js";
import { hubAddress } from "../setup.js";
import { mailboxLabel, mailReading, mailSchedule, readMailNow } from "../mail-filer.js";
import { importKeepass, installPasswordManager, keepass, keepassEntries, linkPasswordManager, passwordManagerStatus, passwordManagerView, PROVIDERS, putKeepassEntry, removeKeepassEntry, searchItems, setAccess, setAllowed, signInPasswordManager, unlinkPasswordManager, type Provider } from "../secrets.js";
import { KEEPASS_FILE } from "../keepass.js";
import { errCode } from "../logsafe.js";

/** Linked accounts (Steam, Letterboxd, Atlassian, Gmail), Apple Health samples, and ranked lists. */
export function importRoutes() {
  const r = new Hono<{ Variables: { hub: Hub } }>();

  r.get("/connections", (c) => c.json(connectionsView(c.get("hub"))));
  r.put("/connections/steam/key", async (c) => c.json(await setSteamKey(c.get("hub"), await readJsonObject(c))));
  r.post("/connections/steam/signin", async (c) => c.json(steamSignIn(c.get("hub"), await readJsonObject(c))));
  // Steam's redirect back lands here in a browser: no bearer token, so it is let through the auth check and is
  // guarded by the one-time state from /signin and by Steam's own check of the answer.
  r.get("/connections/steam/return", async (c) => {
    const r = await steamReturn(c.get("hub"), c.req.query());
    if (r.client === "apple") return c.redirect(`everythingapp://steam?${new URLSearchParams(r.ok ? { linked: "1", message: r.message } : { error: r.message })}`);
    const esc = r.message.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
    return c.html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Steam</title><body style="font:16px system-ui;margin:40px auto;max-width:420px;padding:0 16px"><h1>${r.ok ? "Steam linked" : "Steam not linked"}</h1><p>${esc}</p><p>You can close this tab and go back to EverythingApp.</p></body>`);
  });
  r.post("/connections/steam/sync", async (c) => c.json(await syncSteam(c.get("hub"))));
  r.delete("/connections/steam", (c) => c.json(disconnectSteam(c.get("hub"))));
  r.put("/connections/letterboxd", async (c) => c.json(await connectLetterboxd(c.get("hub"), await readJsonObject(c))));
  r.post("/connections/letterboxd/sync", async (c) => c.json(await syncLetterboxd(c.get("hub"))));
  r.delete("/connections/letterboxd", (c) => c.json(disconnectLetterboxd(c.get("hub"))));

  r.put("/connections/atlassian/app", async (c) => c.json(setAtlassianApp(c.get("hub"), await readJsonObject(c))));
  r.post("/connections/atlassian/signin", async (c) => c.json(atlassianSignIn(c.get("hub"), await readJsonObject(c))));
  // Atlassian's redirect back, like Steam's: no bearer token, guarded by the one-time state from /signin.
  r.get("/connections/atlassian/return", async (c) => {
    const r = await atlassianReturn(c.get("hub"), c.req.query());
    if (r.client === "apple") return c.redirect(`everythingapp://atlassian?${new URLSearchParams(r.ok ? { linked: "1", message: r.message } : { error: r.message })}`);
    const esc = r.message.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
    return c.html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Confluence</title><body style="font:16px system-ui;margin:40px auto;max-width:420px;padding:0 16px"><h1>${r.ok ? "Confluence linked" : "Confluence not linked"}</h1><p>${esc}</p><p>You can close this tab and go back to EverythingApp.</p></body>`);
  });
  r.get("/connections/atlassian/spaces", async (c) => c.json(await atlassianSpaces(c.get("hub"))));
  r.put("/connections/atlassian/spaces", async (c) => c.json(await setAtlassianSpaces(c.get("hub"), await readJsonObject(c))));
  r.post("/connections/atlassian/sync", async (c) => c.json(await syncConfluence(c.get("hub"))));
  r.delete("/connections/atlassian", (c) => c.json(disconnectAtlassian(c.get("hub"))));

  r.put("/connections/google/app", async (c) => c.json(setGoogleApp(c.get("hub"), await readJsonObject(c))));
  r.post("/connections/google/app/test", async (c) => c.json(await checkGoogleApp(c.get("hub"))));
  // Guided setup for the owner's own key or app (guides.ts), filled in for the address this client reaches the hub at.
  r.get("/connections/guides/:service", (c) => {
    const hub = c.get("hub");
    const address = hubAddress(hub, c.req.url, c.req.header("x-forwarded-host"), c.req.header("x-forwarded-proto"));
    return c.json(guideFor(hub, parseGuideService(c.req.param("service")), address));
  });
  r.post("/connections/google/signin", async (c) => c.json(googleSignIn(c.get("hub"), await readJsonObject(c))));
  // Google's redirect back, like Steam's: no bearer token, guarded by the one-time state from /signin.
  r.get("/connections/google/return", async (c) => {
    const hub = c.get("hub");
    const r = await googleReturn(hub, c.req.query(), (email) => { void listMail(hub, email).catch((e) => console.error(`[mail] ${mailboxLabel(hub, email)}: ${errCode(e)}`)); });
    if (r.client === "apple") return c.redirect(`everythingapp://google?${new URLSearchParams(r.ok ? { linked: "1", message: r.message } : { error: r.message })}`);
    const esc = r.message.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
    return c.html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Gmail</title><body style="font:16px system-ui;margin:40px auto;max-width:420px;padding:0 16px"><h1>${r.ok ? "Gmail linked" : "Gmail not linked"}</h1><p>${esc}</p><p>You can close this tab and go back to EverythingApp.</p></body>`);
  });
  r.post("/connections/google/sync", async (c) => c.json(await readMailNow(c.get("hub"))));
  r.delete("/connections/google/:email", async (c) => c.json(await disconnectGoogle(c.get("hub"), decodeURIComponent(c.req.param("email")).toLowerCase())));

  // Password manager (secrets.ts): which one and where its CLI runs, sign-in, and the items the assistant may use.
  r.get("/connections/password-manager", (c) => c.json(passwordManagerView(c.get("hub"))));
  r.get("/connections/password-manager/status", async (c) => {
    const p = c.req.query("provider");
    return c.json(await passwordManagerStatus(c.get("hub"), PROVIDERS.includes(p as Provider) ? p as Provider : undefined, c.req.query("host") || undefined));
  });
  r.put("/connections/password-manager", async (c) => {
    const body = await readJsonObject<{ provider?: string; host?: string }>(c);
    return c.json(await linkPasswordManager(c.get("hub"), body.provider as Provider, String(body.host ?? "")));
  });
  r.post("/connections/password-manager/signin", async (c) => c.json(await signInPasswordManager(c.get("hub"), await readJsonObject(c))));
  r.delete("/connections/password-manager", async (c) => c.json(await unlinkPasswordManager(c.get("hub"))));
  // The assistant's own calls never see excluded items (or, with chosen access, items not chosen).
  r.get("/connections/password-manager/items", async (c) => c.json({ items: await searchItems(c.get("hub"), c.req.query("q") ?? "", c.req.header("x-ea-origin") === "assistant") }));
  r.put("/connections/password-manager/access", async (c) => c.json(setAccess(c.get("hub"), await readJsonObject(c))));
  r.put("/connections/password-manager/allowed", async (c) => c.json(setAllowed(c.get("hub"), (await readJsonObject<{ names?: unknown }>(c)).names)));
  r.post("/connections/password-manager/install", async (c) => c.json(await installPasswordManager(c.get("hub"), String((await readJsonObject<{ provider?: string }>(c)).provider ?? "") as Provider)));
  // The built-in vault (keepass.ts): its items without passwords, adding and removing them, a KeePass file the owner
  // already has, and the file and its master password, to open it in any KeePass app.
  r.get("/connections/password-manager/keepass/entries", async (c) => c.json({ entries: await keepassEntries(c.get("hub")) }));
  r.put("/connections/password-manager/keepass/entries", async (c) => c.json(await putKeepassEntry(c.get("hub"), await readJsonObject(c))));
  r.delete("/connections/password-manager/keepass/entries", async (c) => c.json(await removeKeepassEntry(c.get("hub"), c.req.query("title") ?? "")));
  r.post("/connections/password-manager/keepass/import", async (c) => c.json(await importKeepass(c.get("hub"), await readJsonObject(c))));
  r.get("/connections/password-manager/keepass/file", (c) => {
    const v = keepass(c.get("hub"));
    if (!v.exists()) return c.json({ error: "no vault yet" }, 404);
    return new Response(fs.readFileSync(v.file), { headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${KEEPASS_FILE}"`, "cache-control": "no-store" } });
  });
  r.get("/connections/password-manager/keepass/master", (c) => {
    const pw = c.get("hub").connections.get().keepass?.password;
    return pw ? c.json({ password: pw }, 200, { "cache-control": "no-store" }) : c.json({ error: "no vault yet" }, 404);
  });

  // Bring a past in (imports/bulk.ts): an upload (raw body, ?name=&learn=1), pasted text, the jobs, stopping one.
  r.post("/imports/upload", async (c) => c.json(await uploadImport(c.get("hub"), c.req.query("name") ?? "upload", c.req.raw.body, c.req.query("learn") === "1")));
  r.post("/imports/text", async (c) => c.json(textImport(c.get("hub"), await readJsonObject(c))));
  r.get("/imports/jobs", (c) => c.json({ jobs: listImports(c.get("hub")) }));
  r.post("/imports/jobs/:id/stop", (c) => c.json(stopImport(c.get("hub"), c.req.param("id"))));
  r.post("/imports/health", async (c) => c.json(importHealth(c.get("hub"), await readJsonObject(c))));

  r.get("/library/games", (c) => c.json(gamesLibrary(c.get("hub"), { sort: c.req.query("sort"), limit: c.req.query("limit"), q: c.req.query("q"), played: c.req.query("played") })));
  r.get("/library/films", (c) => c.json(filmsLibrary(c.get("hub"), { sort: c.req.query("sort"), limit: c.req.query("limit"), q: c.req.query("q"), year: c.req.query("year"), watchlist: c.req.query("watchlist") })));
  r.get("/library/applications", (c) => c.json(applicationsList(c.get("hub"), { stage: c.req.query("stage"), limit: c.req.query("limit"), q: c.req.query("q"), since: c.req.query("since") })));
  return r;
}

/** Hourly (first run 2 minutes after start): the Letterboxd diary and Confluence spaces every hour, Steam playtime every 6 hours, when connected. */
export function startImportJob(hub: Hub, everyMs = 3600_000): () => void {
  let tick = 0;
  const run = async () => {
    const c = hub.connections.get();
    const steamDue = tick++ % 6 === 0;
    if (c.steam && steamDue && hub.modules.on("games")) await syncSteam(hub).then((r) => console.log(`[imports] steam: ${r.games} games, ${r.created} new, ${r.updated} changed`), (e) => console.error(`[imports] steam: ${errCode(e)}`));
    if (c.atlassian?.spaces?.length && hub.modules.on("wiki")) await syncConfluence(hub).then((r) => console.log(`[imports] confluence: ${r.pages} pages, ${r.updated} changed, ${r.removed} removed, ${r.images} images`), (e) => console.error(`[imports] confluence: ${errCode(e)}`));
    if (c.letterboxd?.username && hub.modules.on("films")) await syncLetterboxd(hub).then((r) => console.log(`[imports] letterboxd: ${r.entries} entries, ${r.created} new, ${r.updated} changed`), (e) => console.error(`[imports] letterboxd: ${errCode(e)}`));
  };
  const first = setTimeout(() => void run(), 120_000);
  const timer = setInterval(() => void run(), everyMs);
  first.unref();
  timer.unref();
  return () => { clearTimeout(first); clearInterval(timer); };
}

/** `GET /connections`: every service, with what each linked mailbox's mail came to. */
export function connectionsView(hub: Hub) {
  const v = hub.connections.view();
  return { ...v, google: { ...v.google, reading: mailReading(hub), ...mailSchedule(hub), accounts: v.google.accounts.map((a) => ({ ...a, ...mailCounts(hub, a.email) })) }, password_manager: passwordManagerView(hub) };
}
