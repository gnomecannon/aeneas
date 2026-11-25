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
import { accountUsed, icloudSource, imapSource, linkICloud, linkImap, setMailboxFeatures, setSendingServer, unlinkICloud, unlinkImap } from "../imports/icloud.js";
import { guideFor, parseGuideService } from "../guides.js";
import { hubAddress } from "../setup.js";
import { mailboxLabel, mailReading, mailSchedule, readMailNow } from "../mail-filer.js";
import { deleteMailbox, refreshMail } from "../mail-inbox.js";
import { unlinkCalendarAccount } from "../calendar-sync.js";
import { StoreError } from "../store.js";
import { importKeepass, installPasswordManager, keepass, keepassEntries, linkPasswordManager, passwordManagerStatus, passwordManagerView, PROVIDERS, putKeepassEntry, removeKeepassEntry, searchItems, setAccess, setAllowed, signInPasswordManager, unlinkPasswordManager, type Provider } from "../secrets.js";
import { KEEPASS_FILE } from "../keepass.js";
import { errCode } from "../logsafe.js";

/** Linked accounts (Steam, Letterboxd, Atlassian, Gmail, iCloud Mail), Apple Health samples, and ranked lists. */
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
    return c.html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Steam</title><body style="font:16px system-ui;margin:40px auto;max-width:420px;padding:0 16px"><h1>${r.ok ? "Steam linked" : "Steam not linked"}</h1><p>${esc}</p><p>You can close this tab and go back to Aeneas.</p></body>`);
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
    return c.html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Confluence</title><body style="font:16px system-ui;margin:40px auto;max-width:420px;padding:0 16px"><h1>${r.ok ? "Confluence linked" : "Confluence not linked"}</h1><p>${esc}</p><p>You can close this tab and go back to Aeneas.</p></body>`);
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
    return c.html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Gmail</title><body style="font:16px system-ui;margin:40px auto;max-width:420px;padding:0 16px"><h1>${r.ok ? "Gmail linked" : "Gmail not linked"}</h1><p>${esc}</p><p>You can close this tab and go back to Aeneas.</p></body>`);
  });
  r.post("/connections/google/sync", async (c) => c.json(await readMailNow(c.get("hub"), readNowAccount(await readJsonObject(c).catch(() => ({}))))));
  r.delete("/connections/google/:email", async (c) => c.json(await disconnectGoogle(c.get("hub"), decodeURIComponent(c.req.param("email")).toLowerCase())));

  // iCloud Mail (icloud.ts): an app-specific password, checked with iCloud once and kept sealed; never returned.
  r.put("/connections/icloud", async (c) => {
    const hub = c.get("hub");
    // It answers while Receipts and renewals or the Mail screen is on: a new link starts only the ones that are on.
    return c.json(await linkICloud(hub, await readJsonObject(c), (account) => {
      if (hub.modules.on("mail")) void icloudSource.list(hub, account).catch((e) => console.error(`[mail] ${mailboxLabel(hub, account)}: ${errCode(e)}`));
      if (hub.modules.on("mail_inbox")) void refreshMail(hub).catch((e) => console.error(`[mail-inbox] ${errCode(e)}`));
    }));
  });
  r.post("/connections/icloud/sync", async (c) => {
    const hub = c.get("hub");
    if (!hub.modules.on("mail")) throw new StoreError(404, "Receipts and renewals is off. Switch it on for an account in Settings, Accounts.");
    return c.json(await readMailNow(hub, readNowAccount(await readJsonObject(c).catch(() => ({})))));
  });
  r.delete("/connections/icloud/:email", (c) => {
    const hub = c.get("hub");
    const email = decodeURIComponent(c.req.param("email")).toLowerCase();
    // The Mail screen's messages from it go at once, whichever modules are on, and also when the account itself is
    // gone already (removed another way a moment ago): none of its mail may stay behind an error.
    try { return c.json(unlinkICloud(hub, email)); } finally { deleteMailbox(hub.mailDb, `icloud:${email}`); }
  });

  // Other mail accounts for the Mail screen (icloud.ts linkImap, since 2026-11-22): Gmail or any IMAP server, an app
  // password checked with the server once and kept sealed; never returned.
  r.put("/connections/imap", async (c) => {
    const hub = c.get("hub");
    if (!hub.modules.on("mail_inbox") && !hub.modules.on("mail")) throw new StoreError(404, "Neither Mail nor Receipts and renewals is on. Add the account in Settings, Accounts, which switches them on.");
    return c.json(await linkImap(hub, await readJsonObject(c), (account) => {
      if (hub.modules.on("mail_inbox")) void refreshMail(hub).catch((e) => console.error(`[mail-inbox] ${errCode(e)}`));
      if (hub.modules.on("mail") && imapSource.accounts(hub).includes(account)) void imapSource.list(hub, account).catch((e) => console.error(`[mail] ${errCode(e)}`));
    }));
  });
  // Internet Accounts (since 2026-11-22): one account's switches. Mail off takes its mail off the Mail screen at once;
  // Receipts and renewals off drops what was waiting to be read (what was filed stays). The last use switched off
  // removes the account, password and all (`removed` and a `message` in the answer): a password is kept only while
  // something uses it. (It stayed on the hub with every switch off, against what the contract and the guide say.) Read
  // only (since 2026-11-24) stops every write to the account, here on the hub (icloud.ts refuseIfReadOnly,
  // calendar-sync.ts).
  r.put("/connections/accounts/:key", async (c) => {
    const hub = c.get("hub");
    const key = decodeURIComponent(c.req.param("key")).toLowerCase();
    if (!/^(icloud|imap):[^\s@]+@[^\s@]+$/.test(key)) throw new StoreError(404, "that account has no switches");
    const body = await readJsonObject(c);
    const on = setMailboxFeatures(hub, key, body);
    if ((body.inbox === false || body.receipts === false) && !accountUsed(hub, key)) {
      const { message } = await removeAccount(hub, key);
      return c.json({ receipts: false, inbox: false, removed: true, message: `Nothing on the hub uses this account now. ${message}` });
    }
    if (body.inbox === false) deleteMailbox(hub.mailDb, key);
    if (body.inbox === true && hub.modules.on("mail_inbox")) void refreshMail(hub).catch((e) => console.error(`[mail-inbox] ${errCode(e)}`));
    if (body.receipts === false) hub.db.prepare("DELETE FROM mail WHERE account = ? AND state = 'queued'").run(key);
    if (body.receipts === true && hub.modules.on("mail")) {
      const source = key.startsWith("imap:") ? imapSource : icloudSource;
      if (source.accounts(hub).includes(key)) void source.list(hub, key).catch((e) => console.error(`[mail] ${errCode(e)}`));
    }
    return c.json(on);
  });
  // Another mail account's sending server (since 2026-11-24): `{ smtp: { host, port, security } }` or `{ smtp: null }`,
  // signed in to once before it is kept (icloud.ts setSendingServer). Gmail and iCloud send through their own (409).
  r.put("/connections/accounts/:key/sending", async (c) => {
    const key = decodeURIComponent(c.req.param("key")).toLowerCase();
    if (!/^imap:[^\s@]+@[^\s@]+$/.test(key)) throw new StoreError(key.startsWith("icloud:") ? 409 : 404, key.startsWith("icloud:") ? "iCloud Mail sends through smtp.mail.me.com: there is nothing to set." : "that account has no sending server");
    return c.json(await setSendingServer(c.get("hub"), key, await readJsonObject(c)));
  });
  r.delete("/connections/imap/:email", (c) => {
    const hub = c.get("hub");
    const email = decodeURIComponent(c.req.param("email")).toLowerCase();
    try { return c.json(unlinkImap(hub, email)); } finally { deleteMailbox(hub.mailDb, `imap:${email}`); }
  });
  // Remove account (Internet Accounts): the account whole, in one call.
  r.delete("/connections/accounts/:key", async (c) => c.json(await removeAccount(c.get("hub"), decodeURIComponent(c.req.param("key")).toLowerCase())));

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

/** Read now for one account (`{ account }`, an Internet Accounts key), or every account when none is named. */
function readNowAccount(body: Record<string, unknown>): string | undefined {
  if (body.account === undefined) return undefined;
  if (typeof body.account !== "string" || !body.account || body.account.length > 300) throw new StoreError(422, "account is an account's key");
  return body.account.toLowerCase();
}

/**
 * Remove an account whole (Internet Accounts): its calendar sync stops (its events stay in the app), its mail leaves
 * the Mail screen, what waited to be read for receipts goes (what was filed stays), and its password or sign-in is
 * deleted from the hub. One call for all of it, so a part that is gone already never leaves the rest standing: stopping
 * calendar sync removes an account nothing else uses, and a second call to unlink it then found nothing and failed
 * before the kept mail was deleted. `key`: `icloud:<address>`, `imap:<address>`, or a Google sign-in's address.
 */
export async function removeAccount(hub: Hub, key: string): Promise<{ message: string }> {
  const gone = new StoreError(404, "that account is not linked");
  if (key.startsWith("icloud:")) {
    const email = key.slice("icloud:".length);
    const linked = () => (hub.connections.get().icloud ?? []).find((x) => x.email === email);
    try {
      const a = linked();
      if (!a) throw gone;
      if (a.calendar) unlinkCalendarAccount(hub, email);
      // Calendar sync stopped, the unlink takes the password too; it went already when only calendars used the account.
      if (linked()) unlinkICloud(hub, email);
    } finally {
      hub.db.prepare("DELETE FROM mail WHERE account = ?").run(key);
      deleteMailbox(hub.mailDb, key);
    }
    return { message: "The account is removed and its password deleted from the hub. To end the password itself, revoke it at account.apple.com, under Sign-In and Security, App-Specific Passwords." };
  }
  if (key.startsWith("imap:")) {
    try { return { message: unlinkImap(hub, key.slice("imap:".length)).message }; } finally { deleteMailbox(hub.mailDb, key); }
  }
  if (!(hub.connections.get().google ?? []).some((x) => x.email === key)) throw gone;
  await disconnectGoogle(hub, key);
  return { message: "The account is removed and its sign-in deleted from the hub." };
}

/** Hourly (first run 2 minutes after start): the Letterboxd diary and Confluence spaces every hour, Steam playtime every 6 hours, when connected. */
export function startImportJob(hub: Hub, everyMs = 3600_000): () => void {
  let tick = 0;
  const run = async () => {
    const c = hub.connections.get();
    const steamDue = tick++ % 6 === 0;
    if (c.steam && steamDue && hub.modules.on("games")) await syncSteam(hub).then((r) => console.log(`[imports] steam: ${r.games} games, ${r.created} new, ${r.updated} changed`), (e) => console.error(`[imports] steam: ${errCode(e)}`));
    // A link whose sign-in Atlassian ended waits for Reconnect: its refused token is not sent again every hour.
    if (c.atlassian?.spaces?.length && !c.atlassian.expired && hub.modules.on("wiki")) await syncConfluence(hub).then((r) => console.log(`[imports] confluence: ${r.pages} pages, ${r.updated} changed, ${r.removed} removed, ${r.images} images`), (e) => console.error(`[imports] confluence: ${errCode(e)}`));
    if (c.letterboxd?.username && hub.modules.on("films")) await syncLetterboxd(hub).then((r) => console.log(`[imports] letterboxd: ${r.entries} entries, ${r.created} new, ${r.updated} changed`), (e) => console.error(`[imports] letterboxd: ${errCode(e)}`));
  };
  const first = setTimeout(() => void run(), 120_000);
  const timer = setInterval(() => void run(), everyMs);
  first.unref();
  timer.unref();
  return () => { clearTimeout(first); clearInterval(timer); };
}

/**
 * When the hub last used an account's password (since 2026-11-24, for its page in Settings, Accounts): the latest of
 * when it was added, Receipts and renewals' last look at it, the Mail screen's last refresh of it and its calendars'
 * last sync. `last_error` says when that went wrong.
 */
function checkedAt(hub: Hub, a: { key: string; email: string; linked_at: string; last_sync: string | null }): string | null {
  let mailbox: string | null = null;
  try { mailbox = (hub.mailDb.prepare("SELECT last_refresh FROM mailboxes WHERE account = ?").get(a.key) as { last_refresh: string | null } | undefined)?.last_refresh ?? null; } catch { /* no Mail screen table yet */ }
  const calendar = a.key.startsWith("icloud:") ? hub.connections.get().icloud?.find((x) => x.email === a.email)?.calendar?.last_sync ?? null : null;
  const times = [a.linked_at, a.last_sync, mailbox, calendar].filter((t): t is string => !!t && !Number.isNaN(Date.parse(t)));
  return times.length ? times.reduce((x, y) => (Date.parse(y) > Date.parse(x) ? y : x)) : null;
}

/** `GET /connections`: every service, with what each linked mailbox's mail came to. */
export function connectionsView(hub: Hub) {
  const v = hub.connections.view();
  return {
    ...v,
    google: { ...v.google, reading: mailReading(hub), ...mailSchedule(hub), accounts: v.google.accounts.map((a) => ({ ...a, ...mailCounts(hub, a.email) })) },
    icloud: { accounts: v.icloud.accounts.map((a) => ({ ...a, ...mailCounts(hub, `icloud:${a.email}`) })) },
    internet: v.internet.map((a) => ({ ...a, ...(a.features.receipts ? { receipts: mailCounts(hub, a.key) } : {}), checked_at: checkedAt(hub, a) })),
    password_manager: passwordManagerView(hub),
  };
}
