import fs from "node:fs";
import path from "node:path";
import type { Hub } from "./hub.js";
import type { Connections } from "./imports/connections.js";
import { inboxOn, receiptsOn } from "./imports/icloud.js";
import { signInEnded } from "./imports/gmail.js";
import { errCode } from "./logsafe.js";

/**
 * Connections that broke after setup (since 2026-11-27). A mailbox whose password was revoked, an Atlassian sign-in
 * that ended or a Steam key Steam stopped taking was said only on its own Settings page, where nobody looks once a
 * thing works: mail and films simply stopped coming in. The hub now lists each one as a plain item for Today's Needs
 * you, the Settings rows and the Mail and Week screens, and alerts once when one newly breaks (`connection`).
 *
 * Only what needs the person counts: a sign-in or key the service refused, or a sync that has failed for more than
 * `FAILING_MS` (one network blip, or a service down for an hour, is not listed: the hub tries again by itself).
 */
export interface ConnectionProblem {
  /** Stable per connection: `account:<key>`, `calendar:<address>`, `google:<address>`, `atlassian`, `steam`, `letterboxd`. */
  id: string;
  /** The service as people say it: iCloud, Gmail, the mail server's name, Google, Confluence, Steam, Letterboxd. */
  service: string;
  /** What broke, in a short line ("iCloud stopped signing in for you@icloud.com"). */
  title: string;
  /** What to do about it, one sentence. */
  detail: string;
  /** Where the fix is: an account's page in Settings, Accounts (`account` names it), or Settings, Connections. */
  fix: "account" | "connections";
  /** The account's key in `GET /connections` `internet` (`icloud:<address>`, `imap:<address>`, a Google sign-in's address). */
  account?: string;
  /** The words on the button that opens the fix. */
  button: string;
  /** The screens that show it besides Today and Settings: Mail for a mailbox, Week for calendars. */
  affects: ("mail" | "calendar" | "wiki" | "games" | "films")[];
  /** When it broke (the refusal, or the first failure of the run), when the hub knows. */
  since: string | null;
}

/** A sync failing this long, with no success between, needs the person. Steam is read every 6 hours, so twice. */
export const FAILING_MS = 6 * 3600_000;

const failing = (error: string | null | undefined, since: string | null | undefined, now: number) =>
  !!error && !!since && now - Date.parse(since) >= FAILING_MS;

/** Every connection that needs the person now, mailboxes first. Only for modules that are on. */
export function connectionProblems(hub: Pick<Hub, "connections" | "modules">, now = Date.now()): ConnectionProblem[] {
  let c: Connections;
  try { c = hub.connections.get(); } catch { return []; }
  const on = (m: Parameters<Hub["modules"]["on"]>[0]) => hub.modules.on(m);
  const usesMail = (a: { mail?: boolean; inbox?: boolean }) => (on("mail") && receiptsOn(a)) || (on("mail_inbox") && inboxOn(a));
  const out: ConnectionProblem[] = [];

  for (const a of c.icloud ?? []) {
    const mail = usesMail(a);
    const calendar = on("calendars") && !!a.calendar;
    if (!mail && !calendar) continue;
    if (a.refused_at) {
      out.push({
        id: `account:icloud:${a.email}`, service: "iCloud", title: `iCloud stopped signing in for ${a.email}`,
        detail: "Replace its app-specific password.", fix: "account", account: `icloud:${a.email}`, button: "Replace password",
        affects: [...(mail ? ["mail" as const] : []), ...(calendar ? ["calendar" as const] : [])], since: a.refused_at,
      });
    } else if (calendar && failing(a.calendar!.last_error, a.calendar!.failing_since, now)) {
      out.push({
        id: `calendar:${a.email}`, service: "iCloud", title: `iCloud calendars for ${a.email} stopped syncing`,
        detail: a.calendar!.last_error!, fix: "account", account: `icloud:${a.email}`, button: "Open", affects: ["calendar"], since: a.calendar!.failing_since ?? null,
      });
    }
  }
  for (const a of c.imap ?? []) {
    if (!a.refused_at || !usesMail(a)) continue;
    const gmail = a.preset === "gmail";
    out.push({
      id: `account:imap:${a.email}`, service: gmail ? "Gmail" : a.host, title: `${gmail ? "Gmail" : a.host} stopped signing in for ${a.email}`,
      detail: gmail ? "Replace its app password." : "Replace its password.", fix: "account", account: `imap:${a.email}`, button: "Replace password",
      affects: ["mail"], since: a.refused_at,
    });
  }
  // The older Google sign-in cannot be made again; an app password for the address takes over its receipts.
  if (on("mail")) {
    for (const g of c.google ?? []) {
      if (g.last_error !== signInEnded(g.email)) continue;
      out.push({
        id: `google:${g.email}`, service: "Google", title: `The Google sign-in for ${g.email} ended`, detail: "Add an app password for it.",
        fix: "account", account: g.email, button: "Add app password", affects: ["mail"], since: g.last_sync ?? null,
      });
    }
  }
  if (on("wiki") && c.atlassian?.cloud_id && c.atlassian.expired) {
    out.push({
      id: "atlassian", service: "Confluence", title: "Your Confluence sign-in ended", detail: "Reconnect it to keep the wiki up to date.",
      fix: "connections", button: "Reconnect", affects: ["wiki"], since: null,
    });
  }
  const s = c.steam;
  if (on("games") && s?.steam_id) {
    if (s.key_refused) {
      out.push({
        id: "steam", service: "Steam", title: "Steam stopped accepting the hub's key", detail: "Replace the Steam key to keep playtime coming in.",
        fix: "connections", button: "Replace the Steam key", affects: ["games"], since: s.failing_since ?? null,
      });
    } else if (failing(s.last_error, s.failing_since, now)) {
      out.push({ id: "steam", service: "Steam", title: "Steam stopped updating your games", detail: s.last_error!, fix: "connections", button: "Open", affects: ["games"], since: s.failing_since ?? null });
    }
  }
  const l = c.letterboxd;
  if (on("films") && l?.username && failing(l.last_error, l.failing_since, now)) {
    out.push({ id: "letterboxd", service: "Letterboxd", title: "Letterboxd stopped updating your films", detail: l.last_error!, fix: "connections", button: "Open", affects: ["films"], since: l.failing_since ?? null });
  }
  return out;
}

/**
 * Every 5 minutes (the first look 90 seconds after start): a `notify` of kind `connection` for each problem that was
 * not there at the last look, once. The ones already told are kept in `<data>/connection-alerts.json`, so a restart
 * does not tell them again; one that is fixed leaves the list, and alerts again if it breaks again.
 */
export function startConnectionWatch(hub: Pick<Hub, "bus" | "cfg" | "connections" | "modules">, everyMs = 5 * 60_000, firstMs = 90_000): () => void {
  const file = path.join(hub.cfg.dataDir, "connection-alerts.json");
  const look = () => {
    try { checkConnections(hub, file); } catch (e) { console.error(`[connections] ${errCode(e)}`); }
  };
  const first = setTimeout(look, firstMs);
  first.unref();
  const timer = setInterval(look, everyMs);
  timer.unref();
  return () => { clearTimeout(first); clearInterval(timer); };
}

/** One look: alert for the problems not told yet, and keep the list told. Exported for tests. */
export function checkConnections(hub: Pick<Hub, "bus" | "connections" | "modules">, file: string, now = Date.now()): ConnectionProblem[] {
  let told: string[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { told?: unknown };
    if (Array.isArray(raw.told)) told = raw.told.filter((x): x is string => typeof x === "string");
  } catch { /* none told yet */ }
  const problems = connectionProblems(hub, now);
  const fresh = problems.filter((p) => !told.includes(p.id));
  const at = new Date(now).toISOString();
  for (const p of fresh) {
    hub.bus.emit("notify", { id: `connection:${p.id}:${at}`, kind: "connection", title: `${p.title}. ${p.detail}`, name: p.service, at, fix: p.fix, ...(p.account ? { account: p.account } : {}), button: p.button });
    // The kind only: an id holds an address, which stays out of the log.
    console.warn(`[connections] ${p.id.split(":")[0]} needs the owner`);
  }
  const next = problems.map((p) => p.id);
  if (next.join("\n") !== told.join("\n")) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ told: next }, null, 2), { mode: 0o600 });
  }
  return fresh;
}
