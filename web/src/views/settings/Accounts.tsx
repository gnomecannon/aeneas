import { useCallback, useEffect, useState } from "react";
import { engine } from "../../sync/engine";
import type { CalendarAccount, CalendarSyncView, Connections as ConnectionsView, GmailAccount, HubClient, InternetAccount, OwnKeyGuide as Guide, SendingServer, SourcesView } from "../../sync/api";
import { smtpGuess } from "../../lib/mail";
import { HubError } from "../../sync/api";
import { fmtDate, fmtDateTime } from "../../lib/time";
import { useHubReady } from "../../sync/hooks";
import { SubPage, Toggle, errorText } from "./common";
import { setModules, useModules } from "../../lib/modules";
import { keepSources, sourceAccount } from "../../lib/sources";
import { useConnections } from "./Connections";

/**
 * Settings, Accounts (since 2026-11-24): every mail and calendar account once, each opening its own page; one sheet to
 * add one; and what comes in from the iPhone, iPad and Mac. Adding a mailbox took Settings, Modules first, then
 * Connections, then Add Account, and an account's switches stayed hidden until their module was on: here a switch
 * turns its module on itself. The texts are the same on the iPhone, iPad and Mac (EACore AccountTexts, InternetAccount).
 */

type Msg = { ok: boolean; text: string } | null;
type Run = (f: () => Promise<string | void>) => Promise<void>;

/**
 * Sending (since 2026-11-24): where an account's mail goes out, on its page and in Add account, Other mail. The same
 * on the iPhone, iPad and Mac (EACore AccountTexts.sending).
 */
export const SENDING_TEXTS = {
  title: "Sending",
  /** Under the server, for an account that sends. */
  note: "Mail you send on the Mail screen goes through this server, with this account's app password.",
  /** Another mail account without one. */
  none: "None yet: mail written for this account is saved to Drafts, to send from your mail app. Add its sending server to send from the Mail screen.",
  /** Under the form. */
  form: "Your provider's help pages give its sending server (SMTP). The hub signs in once to check it, connects with TLS only, and never to a server on your own network.",
  /** Add account, Other mail. */
  optional: "Sending server (optional). Without one, mail written for this account is saved to Drafts.",
  tls: "TLS (most often port 465)",
  starttls: "STARTTLS (most often port 587)",
  saved: "The hub signed in to the sending server. Mail written for this account can be sent now.",
  removed: "Mail written for this account is saved to Drafts from now on.",
} as const;
/** A sending server in words: "smtp.gmail.com, port 465, TLS". */
export const sendingLine = (x: SendingServer) => `${x.host}, port ${x.port}, ${x.security === "tls" ? "TLS" : "STARTTLS"}`;
/** A sending server as typed: none when the name is empty; the port from the security when it is empty. */
export function typedSmtp(host: string, port: string, security: "tls" | "starttls"): { host: string; port: number; security: "tls" | "starttls" } | null {
  const h = host.trim();
  if (!h) return null;
  return { host: h, port: Number(port) || (security === "tls" ? 465 : 587), security };
}

/** Under the list of accounts. */
export const ACCOUNTS_FOOTER = "Each address once. Your hub keeps these in step, with every device off.";
/** Under Add account's switches. */
export const ADD_FOOTER = "A switch here turns its module on for you. No trip to Modules first, and no key to make.";
/** What each switch of an account does, said under it. */
export const FEATURE_NOTES = {
  inbox: "Its mail shows on the Mail screen",
  receipts: "Receipts, renewal notices and vet mail are filed for you",
  calendars: "Its calendars and Aeneas stay in step, both ways",
  read_only: "On: Aeneas reads this mailbox and changes nothing in it",
} as const;
/** Add account, Google: beside the link to Google's page. */
export const GOOGLE_HOWTO = "Google makes one in about 2 minutes.";
/** Add account, iCloud: beside the link to account.apple.com. */
export const ICLOUD_HOWTO = "At account.apple.com, open Sign-In and Security, then App-Specific Passwords, and make one named Aeneas. It needs two-factor authentication on your Apple Account.";
/** From your iPhone, iPad and Mac, in the web, Windows and Android apps. */
export const DEVICES_NOTE = "Calendars, Reminders, Contacts and Health come in through your iPhone, iPad and Mac: each switches them on for itself, in Settings, Accounts there. Which lists and calendars come in is one choice for every device, and you can change it here.";

/** Each kind of account in a word or two, on the right of its row (EACore InternetAccount.kindShort, kept the same). */
export const KIND_SHORT: Record<InternetAccount["kind"], string> = { icloud: "iCloud", google: "Google, older sign-in", gmail: "Google", imap: "Other mail" };
/** Each kind in words on its page (another server is named by its address; EACore InternetAccount.kindLabel, kept the same). */
const KIND: Record<InternetAccount["kind"], string> = { icloud: "iCloud", google: "Google, older sign-in", gmail: "Google, with an app password", imap: "" };

/**
 * What an account still on the older Google sign-in says, beside Add an app password (Sign in with Google is offered
 * no more since 2026-11-24; EACore InternetAccount.olderGoogleNote, kept the same).
 */
export const OLDER_GOOGLE_NOTE = "This address uses the older Google sign-in, which reads receipts only. Add an app password for it and Mail can show it too: Receipts and renewals then carries on with the app password, from where the sign-in stopped.";

/**
 * What an account that took over an older Google sign-in of its address says, once (`google_removed_at`; EACore
 * InternetAccount.googleRemovedNote, kept the same).
 */
export const googleRemovedNote = (day: string) => `The older Google sign-in for this address was removed on ${day}. Receipts and renewals carries on with this app password, from where the sign-in stopped.`;

/** What Read only stops, said under its switch while it is on. */
export const READ_ONLY_NOTE = "Aeneas only reads this account: no drafts saved, no mail moved, flagged or marked read there, and no calendar event changed. Mail's Done, Delete, Pin and replies are off for its mail.";

/** What the app asks before the last switch goes off. */
const LAST_USE = "Nothing else uses this account, so it is removed and its password deleted from the hub. What was filed from its mail stays, and the account itself stays with your provider.";

/** The module each switch of an account needs: switching it on here turns that module on too. */
export const MODULE_OF = { inbox: "mail_inbox", receipts: "mail", calendars: "calendars" } as const;
export type Feature = keyof typeof MODULE_OF;

/** The first letter of an address, for its badge. */
export const badgeLetter = (email: string) => (email.trim()[0] ?? "?").toUpperCase();

/**
 * What an account brings in, for its row: "Mail, Receipts and renewals", with ", read only" while that is on. A switch
 * counts only while its module is on, as the account's page shows it (EACore InternetAccount.broughtIn, kept the same).
 */
export function broughtIn(a: Pick<InternetAccount, "features" | "read_only">, on: (m: string) => boolean): string {
  const parts = [
    on(MODULE_OF.inbox) && a.features.inbox === true && "Mail",
    on(MODULE_OF.receipts) && a.features.receipts === true && "Receipts and renewals",
    on(MODULE_OF.calendars) && a.features.calendars === true && "Calendars",
  ].filter((x): x is string => !!x);
  const what = parts.length ? parts.join(", ") : "Nothing switched on";
  return a.read_only === true ? `${what}, read only` : what;
}

/** The modules a set of switches needs that are off now (switching one on here turns its module on). */
export function modulesToSwitchOn(want: Partial<Record<Feature, boolean>>, on: (m: string) => boolean): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const f of Object.keys(MODULE_OF) as Feature[]) if (want[f] && !on(MODULE_OF[f])) out[MODULE_OF[f]] = true;
  return out;
}

/** Add account, filled in: which account, its sign-in, and what it brings in. */
export interface NewAccount {
  kind: "icloud" | "google" | "imap";
  email: string;
  password: string;
  host?: string;
  port?: number;
  user?: string;
  /** Another mail account's sending server, when one was typed (since 2026-11-24). */
  smtp?: { host: string; port: number; security: "tls" | "starttls" } | null;
  want: Record<Feature, boolean>;
}

type AccountClient = Pick<HubClient, "linkICloud" | "linkImap" | "linkCalendars" | "setAccountFeatures">;

/**
 * Add an account as Add account's three steps say, in this order: the modules its switches need are switched on, the
 * hub checks the sign-in and keeps it, then the switches are set (a new account brings in Mail and Receipts and
 * renewals; one left off is switched off, after Calendars so it is never the last use). Returns the account's key.
 */
export async function addAccount(client: AccountClient, a: NewAccount, on: (m: string) => boolean, switchOn: (changes: Record<string, boolean>) => Promise<unknown>): Promise<string> {
  const need = modulesToSwitchOn(a.want, on);
  if (Object.keys(need).length) await switchOn(need);
  const email = a.email.trim().toLowerCase();
  const password = a.password.trim();
  const off = { ...(a.want.inbox ? {} : { inbox: false }), ...(a.want.receipts ? {} : { receipts: false }) };
  if (a.kind === "icloud") {
    const key = `icloud:${email}`;
    if (!a.want.inbox && !a.want.receipts) {
      await client.linkCalendars(email, password);
      return key;
    }
    await client.linkICloud(email, password);
    if (a.want.calendars) await client.linkCalendars(email);
    if (Object.keys(off).length) await client.setAccountFeatures(key, off);
    return key;
  }
  const user = a.user?.trim();
  await client.linkImap(a.kind === "google" ? { email, password, preset: "gmail" } : { email, password, preset: "imap", host: (a.host ?? "").trim(), port: a.port || 993, ...(user ? { user } : {}), ...(a.smtp ? { smtp: a.smtp } : {}) });
  const key = `imap:${email}`;
  if (Object.keys(off).length) await client.setAccountFeatures(key, off);
  return key;
}

/**
 * A new password for an account (its page, Sign-in, Replace): the hub checks it and keeps the account's switches. An
 * iCloud account kept for its calendars alone takes it through calendar sync, which would not link its mail.
 */
export async function replacePassword(client: AccountClient, a: Pick<InternetAccount, "kind" | "email" | "host" | "port" | "user" | "features">, password: string): Promise<void> {
  const p = password.trim();
  if (a.kind === "icloud") {
    if (a.features.inbox || a.features.receipts) await client.linkICloud(a.email, p);
    else await client.linkCalendars(a.email, p);
  } else if (a.kind === "gmail") await client.linkImap({ email: a.email, password: p, preset: "gmail" });
  else await client.linkImap({ email: a.email, password: p, preset: "imap", host: a.host ?? "", port: a.port, ...(a.user ? { user: a.user } : {}) });
}

/** An account as an older hub knows it: what it is, what receipts came to, its calendar sync, and its errors. */
export interface OlderAccount { email: string; kind: string; receipts?: GmailAccount; calendars?: Pick<CalendarAccount, "last_sync">; errors: string[] }

/**
 * The accounts of a hub from before Internet Accounts (its answer has no `internet` list), from the fields it does
 * send: iCloud mailboxes, mailboxes signed in with Google, and the iCloud addresses whose calendars are kept in step.
 * One entry per address and kind, with its errors. Null for a hub that has Internet Accounts.
 */
export function olderHubAccounts(c: Pick<ConnectionsView, "internet" | "icloud" | "google">, cal: Pick<CalendarSyncView, "accounts"> | null): OlderAccount[] | null {
  if (c.internet) return null;
  const out: OlderAccount[] = [];
  for (const a of c.icloud?.accounts ?? []) out.push({ email: a.email, kind: "iCloud", receipts: a, errors: a.last_error ? [a.last_error] : [] });
  for (const a of cal?.accounts ?? []) {
    const known = out.find((x) => x.kind === "iCloud" && x.email.toLowerCase() === a.email.toLowerCase());
    if (known) { known.calendars = a; if (a.last_error && !known.errors.includes(a.last_error)) known.errors.push(a.last_error); }
    else out.push({ email: a.email, kind: "iCloud", calendars: a, errors: a.last_error ? [a.last_error] : [] });
  }
  for (const a of c.google?.accounts ?? []) out.push({ email: a.email, kind: KIND.google, receipts: a, errors: a.last_error ? [a.last_error] : [] });
  return out;
}

/**
 * Whether a change to an account's switches turns off the last thing it does. The hub then removes the account and
 * deletes its password (a password is kept only while something uses it), so the app asks first. A switch whose module
 * is off still counts: the hub keeps the account for it.
 */
export function lastUseOff(f: InternetAccount["features"], change: { inbox?: boolean; receipts?: boolean; calendars?: boolean }): boolean {
  if (change.inbox !== false && change.receipts !== false && change.calendars !== false) return false;
  const next = { ...f, ...change };
  return !next.inbox && !next.receipts && !next.calendars;
}

/** Whether an account has a Read only switch: iCloud and app-password accounts on a hub that knows it (the older Google sign-in can only read). */
export const hasReadOnlySwitch = (a: Pick<InternetAccount, "kind" | "read_only">) => a.kind !== "google" && typeof a.read_only === "boolean";

/**
 * What Sync now came to for one account, from the hub's per-account results: its own error; else, when another
 * account's sync failed, that (named); else Synced.
 */
export function syncNowResult(results: { account: string; error?: string }[], email: string): { ok: boolean; text: string } {
  const mine = results.find((x) => x.error && x.account.toLowerCase() === email.toLowerCase());
  if (mine?.error) return { ok: false, text: mine.error };
  const other = results.find((x) => x.error);
  return other?.error ? { ok: false, text: `${other.account}: ${other.error}` } : { ok: true, text: "Synced." };
}

/** "17:00" as "5 PM", "12:00" as "noon". */
function clock(hm: string): string {
  const [h, m] = hm.split(":").map(Number);
  if (h === 12 && m === 0) return "noon";
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "AM" : "PM"}`;
}

/** What one mailbox's mail came to, in a line. */
export function mailLine(a: Pick<GmailAccount, "filed" | "to_read" | "read">): string {
  const n = (x: number, one: string, many: string) => (x === 1 ? `1 ${one}` : `${x} ${many}`);
  const filed = [a.filed.renewals && n(a.filed.renewals, "renewal", "renewals"), a.filed.pet && n(a.filed.pet, "pet record", "pet records"), a.filed.events && n(a.filed.events, "appointment", "appointments")].filter(Boolean);
  const left = a.to_read ? `, ${a.to_read} still to read` : "";
  return `${filed.length ? `Filed ${filed.join(", ")}` : "Nothing filed yet"} from ${n(a.read, "message", "messages")} read${left}.`;
}

/** One line for the Settings list: the linked addresses. */
export function accountsSummary(c: ConnectionsView | null): string {
  if (!c) return "Mail and calendar accounts";
  const emails = c.internet ? c.internet.map((a) => a.email) : [...(c.icloud?.accounts ?? []), ...(c.google?.accounts ?? [])].map((a) => a.email);
  if (!emails.length) return "No accounts yet";
  return emails.length === 1 ? emails[0] : `${emails[0]} and ${emails.length - 1} more`;
}

const when = (iso: string | null | undefined) => (iso ? fmtDateTime(iso) : "never");

function Status({ msg }: { msg: Msg }) {
  return msg ? <div className={msg.ok ? "ok small" : "error small"} role="status">{msg.text}</div> : null;
}

/** Said once on the list after a page removed its account (the hub's own sentence). */
let removedNote: string | null = null;

/** The account a page names: by its key, or an older Google sign-in that an app password has since taken over. */
function findAccount(c: ConnectionsView | null, key: string): InternetAccount | undefined {
  const list = c?.internet ?? [];
  return list.find((a) => a.key === key) ?? (key.includes(":") ? undefined : list.find((a) => a.email === key && a.kind !== "google"));
}

/**
 * Settings, Accounts: each address once, then what comes in from the iPhone, iPad and Mac, then Work. The pages under
 * it: `/settings/accounts/add` (Add account) and `/settings/accounts/<key>` (one account).
 */
export function AccountsSettings({ parts, params }: { parts: string[]; params: URLSearchParams }) {
  const [sub] = parts;
  if (sub === "add") return <AddAccountPage kind={params.get("kind")} email={params.get("email")} />;
  // `?replace=1`: opened from a sign-in that stopped (Today, a banner, Mail), with Replace already open.
  if (sub) return <AccountPage accountKey={decodeURIComponent(sub)} replace={params.get("replace") === "1"} />;
  return <AccountsPage />;
}

function AccountsPage() {
  const { on } = useModules();
  const [c, reload, loadErr] = useConnections();
  const ready = useHubReady();
  const [cal, setCal] = useState<CalendarSyncView | null>(null);
  const [note] = useState(() => { const n = removedNote; removedNote = null; return n; });
  const calendarsOn = on("calendars");
  useEffect(() => {
    // An older hub's accounts kept for calendars alone show only from its calendar list.
    if (calendarsOn && c && !c.internet) void engine.client?.calendarSync().then(setCal, () => setCal(null));
  }, [calendarsOn, c, ready]);
  const older = c ? olderHubAccounts(c, cal) : null;
  const accounts = c?.internet ?? [];
  return (
    <SubPage path="/settings/accounts">
      {!engine.client && <div className="empty">Set up the hub connection first.</div>}
      {engine.client && !c && !loadErr && <div className="muted">Loading</div>}
      {engine.client && !c && loadErr && <div className="error">{loadErr} <button type="button" className="small" onClick={reload}>Try again</button></div>}
      {c && (
        <section className="card col">
          <h2>Accounts</h2>
          {note && <div className="ok small" role="status">{note}</div>}
          {older ? (
            <>
              <div className="warn small">This hub is older than the app. Update the hub in <a href="#/settings/about">Settings, About</a>, then add, change or remove accounts here.</div>
              {older.map((a) => (
                <div key={`${a.kind}:${a.email}`} className="col account-row">
                  <div><strong>{a.email}</strong> <span className="muted small">{a.kind}</span></div>
                  {on("mail") && a.receipts && <div className="small">{mailLine(a.receipts)} <span className="muted">Last checked {when(a.receipts.last_sync)}.</span></div>}
                  {a.calendars && <div className="small">Its calendars are kept in step. <span className="muted">Last synced {when(a.calendars.last_sync)}.</span></div>}
                  {a.errors.map((e) => <div key={e} className="error small">{e}</div>)}
                </div>
              ))}
              {!older.length && <div className="muted small">No accounts yet.</div>}
            </>
          ) : (
            <nav className="col accounts-list" aria-label="Accounts">
              {accounts.map((a) => (
                <a key={a.key} href={`#/settings/accounts/${encodeURIComponent(a.key)}`} className="item settings-row account-link">
                  <span className="account-badge" aria-hidden="true">{badgeLetter(a.email)}</span>
                  <span className="body">
                    <span className="t">{a.email}</span>
                    <span className="meta">{broughtIn(a, on)}</span>
                    {a.last_error && <span className="meta error">{a.last_error}</span>}
                  </span>
                  <span className="muted small account-kind">{KIND_SHORT[a.kind]}</span>
                  <span className="chev" aria-hidden="true">{"›"}</span>
                </a>
              ))}
              {!accounts.length && <div className="muted small">No accounts yet.</div>}
              <a href="#/settings/accounts/add" className="item settings-row account-link account-add">
                <span className="account-badge add" aria-hidden="true">+</span>
                <span className="body"><span className="t">Add account</span></span>
                <span className="chev" aria-hidden="true">{"›"}</span>
              </a>
            </nav>
          )}
          <div className="muted small">{ACCOUNTS_FOOTER}</div>
        </section>
      )}
      {engine.client && <FromYourDevices health={c && on("health") ? c.health : null} />}
      {engine.client && <WorkSection />}
    </SubPage>
  );
}


/**
 * From your iPhone, iPad and Mac (the web, Windows and Android apps have no device stores of their own): what comes in
 * from the Apple devices, one choice for every device. The switches themselves are on those devices; which Reminders
 * lists come in (and in which space), where new tasks go and which calendars are work can be changed here too.
 */
function FromYourDevices({ health }: { health: ConnectionsView["health"] | null }) {
  const ready = useHubReady();
  const [s, setS] = useState<SourcesView | null>(null);
  const [state, setState] = useState<"loading" | "older" | "error">("loading");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  useEffect(() => {
    engine.client?.sources().then((v) => { setS(v); keepSources(v); }, (e) => setState(e instanceof HubError && e.status === 404 ? "older" : "error"));
  }, [ready]);
  const change = async (body: Parameters<HubClient["setSources"]>[0]) => {
    if (!engine.client) return;
    setBusy(true);
    setMsg(null);
    try { const v = await engine.client.setSources(body); setS(v); keepSources(v); } catch (e) { setMsg({ ok: false, text: errorText(e) }); } finally { setBusy(false); }
  };
  const lists = [...(s?.lists ?? [])].sort((a, b) => sourceAccount(a.account, a.kind).localeCompare(sourceAccount(b.account, b.kind)) || a.title.localeCompare(b.title));
  const personal = lists.filter((l) => l.on && (l.wants ?? l.space) === "personal");
  return (
    <section className="card col">
      <h2>From your iPhone, iPad and Mac</h2>
      <div className="muted small">{DEVICES_NOTE}</div>
      {!s && <div className="muted small">{state === "older" ? "Your hub runs an older version. Update it to see these here." : state === "error" ? "Could not read these from your hub." : "Loading"}</div>}
      {s && (
        <>
          <h3 className="conn-group">Reminders</h3>
          {!lists.length && <div className="muted small">No lists yet. They appear once an iPhone, iPad or Mac syncs Apple Reminders.</div>}
          {lists.map((l) => (
            <div key={l.key} className="col source-row">
              <Toggle checked={l.on} disabled={busy} onChange={(on) => void change({ lists: [{ key: l.key, on }] })} label={l.title} note={sourceAccount(l.account, l.kind)}
                aside={l.on ? (
                  <select aria-label={`Space for ${l.title}`} value={l.wants ?? l.space} disabled={busy} onChange={(e) => void change({ lists: [{ key: l.key, space: e.target.value as "personal" | "work" }] })}>
                    <option value="personal">Personal</option>
                    <option value="work">Work</option>
                  </select>
                ) : undefined} />
              {l.wants && <div className="muted small">{l.wants === "work" ? "Work" : "Personal"} once every device is updated</div>}
            </div>
          ))}
          {!!lists.length && (
            <label className="col small" style={{ gap: 2 }}>
              New tasks go to
              <select value={s.new_tasks ?? ""} disabled={busy} onChange={(e) => void change({ new_tasks: e.target.value || null })}>
                <option value="">Default list</option>
                {personal.map((l) => <option key={l.key} value={l.key}>{lists.filter((x) => x.title === l.title).length > 1 ? `${l.title} (${sourceAccount(l.account, l.kind)})` : l.title}</option>)}
              </select>
            </label>
          )}
          {lists.some((l) => l.wants) && !!s.waiting.length && (
            <div className="muted small">
              Personal or Work takes effect once every iPhone, iPad and Mac runs Aeneas {s.needs} or later. Update these: {s.waiting.map((d) => `${d.name || "a device"} (${d.version ? `runs ${d.version}` : "version not known"})`).join(", ")}.
            </div>
          )}
          <h3 className="conn-group">Work calendars</h3>
          {!s.calendars.length && <div className="muted small">No calendars yet. They appear once an iPhone, iPad or Mac with calendar access syncs.</div>}
          {s.calendars.map((cal) => (
            <Toggle key={cal.key} checked={cal.work} disabled={busy || cal.hub_kept} onChange={(work) => void change({ calendars: [{ key: cal.key, work }] })} label={cal.title}
              note={cal.hub_kept ? "Kept in step by your hub" : sourceAccount(cal.account, cal.kind)} />
          ))}
          <div className="muted small">Meetings in work calendars come in as Work, titles and times only, on every device that has the calendar. A calendar your hub keeps in step cannot be work: its events would come in twice.</div>
          <h3 className="conn-group">Contacts</h3>
          <div className="small">{s.contacts.device ? `Mirrored by ${s.contacts.name || "one of your devices"}.` : "No device mirrors them yet."}</div>
        </>
      )}
      {health && (
        <>
          <h3 className="conn-group">Health</h3>
          <div className="small">{health.last_import ? `${health.total} readings from Health, last sent ${when(health.last_import)}.` : "Nothing from Health yet."}</div>
        </>
      )}
      <Status msg={msg} />
    </section>
  );
}

/** Work: one switch for the sealed work space. Off erases every work event and task on every device and stops the import. */
function WorkSection() {
  const [st, setSt] = useState<{ enabled: boolean; events: number; tasks: number } | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const ready = useHubReady();
  const load = () => engine.client?.workSpace().then(setSt, (e) => setMsg(errorText(e)));
  useEffect(() => { void load(); }, [ready]);
  const set = async (on: boolean) => {
    if (!engine.client) return;
    if (!on && !confirm("Turn off and erase the work space? Every work event and work task is erased from the hub and every device, and the work calendar stops importing.")) return;
    setBusy(true);
    try {
      const r = await engine.client.setWorkSpace(on);
      setMsg(on ? "Work space on." : `Erased ${r.erased} work items.`);
      await engine.cycle();
      await load();
    } catch (e) {
      setMsg(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card col" id="work">
      <h2>Work</h2>
      {st ? (
        <Toggle checked={st.enabled} disabled={busy} onChange={(on) => void set(on)} label="Keep work calendar and tasks"
          note={st.enabled ? `${st.events} work events and ${st.tasks} work tasks. Titles and times only; never sent to cloud AI.` : "Off. Nothing from work is kept or imported."} />
      ) : msg ? null : (
        <div className="muted small">Loading</div>
      )}
      {msg && <div className="muted small">{msg}</div>}
    </section>
  );
}

/**
 * One account's page: what it brings in (Mail, Receipts and renewals, an iCloud account's Calendars with its calendar
 * list and where new events go, Read only), its sign-in (the app password, when it was last checked, Replace), and
 * Remove account. Switching one on turns its module on; switching off the last use asks first, since the hub then
 * removes the account.
 */
function AccountPage({ accountKey, replace = false }: { accountKey: string; replace?: boolean }) {
  const { list } = useModules();
  const [c, reload, loadErr] = useConnections();
  const ready = useHubReady();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [cal, setCal] = useState<CalendarSyncView | null>(null);
  const [calErr, setCalErr] = useState("");
  const a = findAccount(c, accountKey);
  const client = engine.client;
  const known = (m: string) => !!list?.find((x) => x.id === m)?.on;
  const calendarsOn = known("calendars") && a?.kind === "icloud";
  const loadCal = useCallback(() => {
    if (calendarsOn) void engine.client?.calendarSync().then((v) => { setCal(v); setCalErr(""); }, (e) => { setCal(null); setCalErr(errorText(e)); });
  }, [calendarsOn]);
  useEffect(loadCal, [loadCal, ready]);
  const run: Run = async (f) => {
    setBusy(true);
    setMsg(null);
    try { const t = await f(); if (t) setMsg({ ok: true, text: t }); } catch (e) { setMsg({ ok: false, text: errorText(e) }); } finally { reload(); loadCal(); setBusy(false); }
  };
  const leave = (text: string) => { removedNote = text; location.hash = "#/settings/accounts"; };
  if (!a) {
    return (
      <SubPage path={`/settings/accounts/${encodeURIComponent(accountKey)}`} title="Account">
        {!c && !loadErr && <div className="muted">Loading</div>}
        {loadErr && <div className="error">{loadErr}</div>}
        {c && <div className="muted">This account is not linked any more. <a href="#/settings/accounts">Back to Accounts</a></div>}
      </SubPage>
    );
  }
  const shown = (f: Feature) => known(MODULE_OF[f]) && a.features[f] === true;
  const flip = (f: Feature, want: boolean) => {
    if (want) {
      void run(async () => {
        if (!known(MODULE_OF[f])) await setModules({ [MODULE_OF[f]]: true });
        if (a.features[f] === true) return;
        if (f === "calendars") { setCal(await client!.linkCalendars(a.email)); return "Choose the calendars to keep in step."; }
        await client!.setAccountFeatures(a.key, { [f]: true });
      });
      return;
    }
    if (a.features[f] !== true) return;
    const label = f === "inbox" ? "Mail" : f === "receipts" ? "Receipts and renewals" : "Calendars";
    const last = lastUseOff(a.features, { [f]: false });
    if (f === "calendars") {
      if (!confirm(`Stop keeping ${a.email}'s calendars in step? Its events stay in the app as they are; repeating ones are taken out.${last ? ` ${LAST_USE}` : ""}`)) return;
      void run(async () => { const r = await client!.stopCalendars(a.email); if (last) leave(r.message); return r.message; });
      return;
    }
    if (last && !confirm(`Turn ${label} off for ${a.email}? ${LAST_USE}`)) return;
    // The hub's own sentence when it removed the account with its last use.
    void run(async () => { const r = await client!.setAccountFeatures(a.key, { [f]: false }); if (r.removed) leave(r.message ?? "Removed."); return r.removed ? r.message : undefined; });
  };
  const remove = () => {
    if (!confirm(`Remove ${a.email}? Its password is deleted from the hub, and so is its mail on the Mail screen${a.features.calendars ? "; its calendars stop syncing" : ""}. What was filed from its mail stays, and the account itself stays with your provider.`)) return;
    // One request removes the account whole, whatever its kind: the hub stops its calendars, takes its mail off the
    // Mail screen and deletes its password together, so no step can fail after another already removed the account.
    void run(async () => { const m = (await client!.removeAccount(a.key)).message; leave(m); return m; });
  };
  const calendar = cal?.accounts.find((x) => x.email.toLowerCase() === a.email.toLowerCase());
  const waiting = a.receipts?.to_read ?? 0;
  const reading = !!c?.google?.reading;
  return (
    <SubPage path={`/settings/accounts/${encodeURIComponent(a.key)}`} title={a.email}>
      <section className="card col">
        <div className="muted small">{a.kind === "imap" ? `${a.host}:${a.port}` : KIND[a.kind]}{a.user && a.user !== a.email ? `, signs in as ${a.user}` : ""}</div>
        {a.google_removed_at && <div className="muted small">{googleRemovedNote(fmtDate(a.google_removed_at))}</div>}
        {a.features.inbox !== null && <Toggle checked={shown("inbox")} disabled={busy || !client} onChange={(v) => flip("inbox", v)} label="Mail" note={FEATURE_NOTES.inbox} />}
        {a.features.receipts !== null && (
          <Toggle checked={shown("receipts")} disabled={busy || !client || a.kind === "google"} onChange={(v) => flip("receipts", v)} label="Receipts and renewals" note={FEATURE_NOTES.receipts} />
        )}
        {shown("receipts") && a.receipts && (
          <div className="col account-modules">
            <div className="row wrap" style={{ gap: 8 }}>
              <span className="small grow">{mailLine(a.receipts)} <span className="muted">Last checked {when(a.last_sync)}.</span></span>
              <button type="button" className="small" disabled={busy || !client || reading} onClick={() => void run(async () => { await client!.readMailNow(a.key); return "Reading the waiting mail now. It stops for any chat."; })}>
                {reading ? "Reading" : `Read now${waiting ? ` (${waiting} waiting)` : ""}`}
              </button>
            </div>
            <div className="muted small">
              The hub checks for new mail every 15 minutes and reads it {c?.google?.times?.length ? `at ${c.google.times.map(clock).join(", ")}` : "at set times"} when no game is using the GPU.{c?.google?.waiting_for_gpu && <> Waiting: {c.google.waiting_for_gpu}.</>} For receipts, folders are opened read-only and nothing is marked read; the mail itself is never kept.
            </div>
          </div>
        )}
        {a.kind === "icloud" && a.features.calendars !== null && <Toggle checked={shown("calendars")} disabled={busy || !client} onChange={(v) => flip("calendars", v)} label="Calendars" note={FEATURE_NOTES.calendars} />}
        {hasReadOnlySwitch(a) ? (
          <Toggle checked={!!a.read_only} disabled={busy || !client} onChange={(v) => void run(async () => { await client!.setAccountFeatures(a.key, { read_only: v }); })} label="Read only"
            note={a.read_only ? READ_ONLY_NOTE : FEATURE_NOTES.read_only} />
        ) : a.kind === "google" && <div className="muted small">Read only: the older Google sign-in lets the hub read mail and nothing else.</div>}
        {calErr && <div className="error small" role="alert">The calendars could not be read: {calErr}</div>}
        <Status msg={msg} />
      </section>
      {calendar && shown("calendars") && (
        <section className="card col">
          <h2>Calendars</h2>
          <CalendarChoices a={calendar} busy={busy} run={run} setCal={setCal} />
        </section>
      )}
      {a.kind !== "google" && a.smtp !== undefined && <Sending a={a} busy={busy} run={run} />}
      <SignIn a={a} busy={busy} run={run} startOpen={replace} />
      <div><button type="button" className="ghost danger" disabled={busy || !client} onClick={remove}>Remove account</button></div>
    </SubPage>
  );
}

/** A sending server's name, port and security, as typed; `hint` is only a placeholder (the hub never connects to a guess). */
function SendingFields({ host, port, security, hint, set, label }: { host: string; port: string; security: "tls" | "starttls"; hint: string; set: (host: string, port: string, security: "tls" | "starttls") => void; label?: string }) {
  return (
    <div className="col" style={{ gap: 6 }}>
      {label && <div className="small">{label}</div>}
      <div className="row wrap" style={{ gap: 8 }}>
        <label className="col small" style={{ gap: 2, flex: "1 1 220px" }}>
          Sending server
          <input autoComplete="off" spellCheck={false} value={host} onChange={(e) => set(e.target.value, port, security)} placeholder={hint} />
        </label>
        <label className="col small" style={{ gap: 2, width: 90 }}>
          Port
          <input inputMode="numeric" value={port} onChange={(e) => set(host, e.target.value.replace(/[^0-9]/g, ""), security)} placeholder={security === "tls" ? "465" : "587"} />
        </label>
        <label className="col small" style={{ gap: 2 }}>
          Security
          <select value={security} onChange={(e) => set(host, port, e.target.value === "starttls" ? "starttls" : "tls")}>
            <option value="tls">{SENDING_TEXTS.tls}</option>
            <option value="starttls">{SENDING_TEXTS.starttls}</option>
          </select>
        </label>
      </div>
    </div>
  );
}

/**
 * Sending: where the account's mail goes out. iCloud and Gmail send through their own servers, shown; another mail
 * account through the one the owner gives here (Add, Change, Remove), which the hub signs in to once before it keeps it.
 */
function Sending({ a, busy, run }: { a: InternetAccount; busy: boolean; run: Run }) {
  const [open, setOpen] = useState(false);
  const [host, setHost] = useState(a.smtp?.host ?? "");
  const [port, setPort] = useState(a.smtp ? String(a.smtp.port) : "");
  const [security, setSecurity] = useState<"tls" | "starttls">(a.smtp?.security ?? "tls");
  const client = engine.client;
  const fixed = a.kind === "icloud" || a.kind === "gmail";
  const typed = typedSmtp(host, port, security);
  return (
    <section className="card col">
      <h2>{SENDING_TEXTS.title}</h2>
      {a.smtp ? <div>{sendingLine(a.smtp)}</div> : <div className="muted small">{SENDING_TEXTS.none}</div>}
      {a.smtp && <div className="muted small">{SENDING_TEXTS.note}</div>}
      {!fixed && (open ? (
        <form className="col" onSubmit={(e) => { e.preventDefault(); if (typed) void run(async () => { await client!.setSendingServer(a.key, typed); setOpen(false); return SENDING_TEXTS.saved; }); }}>
          <SendingFields host={host} port={port} security={security} hint={smtpGuess(a.host ?? "")} set={(h, p, x) => { setHost(h); setPort(p); setSecurity(x); }} />
          <div className="muted small">{SENDING_TEXTS.form}</div>
          <div className="row">
            <button type="submit" className="primary" disabled={busy || !client || !typed}>{busy ? "Checking" : "Save"}</button>
            <button type="button" className="ghost" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </form>
      ) : (
        <div className="row">
          <button type="button" disabled={busy || !client} onClick={() => setOpen(true)}>{a.smtp ? "Change" : "Add a sending server"}</button>
          {a.smtp && <button type="button" className="ghost" disabled={busy || !client} onClick={() => void run(async () => { await client!.setSendingServer(a.key, null); return SENDING_TEXTS.removed; })}>Remove</button>}
        </div>
      ))}
    </section>
  );
}

/** Sign-in: the app password and when the hub last used it, with Replace; the older Google sign-in offers an app password. */
function SignIn({ a, busy, run, startOpen = false }: { a: InternetAccount; busy: boolean; run: Run; startOpen?: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const [password, setPassword] = useState("");
  const client = engine.client;
  if (a.kind === "google") {
    return (
      <section className="card col">
        <h2>Sign-in</h2>
        <div className="muted small">{OLDER_GOOGLE_NOTE}</div>
        <div><button type="button" disabled={busy} onClick={() => { location.hash = `#/settings/accounts/add?kind=google&email=${encodeURIComponent(a.email)}`; }}>Add an app password</button></div>
      </section>
    );
  }
  const name = a.kind === "icloud" ? "App-specific password" : "App password";
  return (
    <section className="card col">
      <h2>Sign-in</h2>
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "nowrap" }}>
        <span>{name}</span>
        <span className="muted small">{a.checked_at ? `Last checked ${fmtDateTime(a.checked_at)}` : a.linked_at ? `Added ${fmtDate(a.linked_at)}` : ""}</span>
      </div>
      {a.last_error && <div className="error small">{a.last_error}</div>}
      {open ? (
        <form className="col" onSubmit={(e) => { e.preventDefault(); void run(async () => { await replacePassword(client!, a, password); setPassword(""); setOpen(false); return "The new password works. It replaced the old one."; }); }}>
          <label className="col small" style={{ gap: 2 }}>
            New {name.toLowerCase()}
            <input type="password" autoComplete="off" spellCheck={false} autoFocus value={password} onChange={(e) => setPassword(e.target.value)} placeholder={a.kind === "icloud" ? "abcd-efgh-ijkl-mnop" : a.kind === "gmail" ? "abcd efgh ijkl mnop" : ""} />
          </label>
          <div className="row">
            <button type="submit" className="primary" disabled={busy || !client || !password.trim()}>{busy ? "Checking" : "Save"}</button>
            <button type="button" className="ghost" onClick={() => { setOpen(false); setPassword(""); }}>Cancel</button>
          </div>
        </form>
      ) : (
        <div><button type="button" className={a.last_error ? "primary" : undefined} disabled={busy || !client} onClick={() => setOpen(true)}>Replace</button></div>
      )}
      <div className="muted small">The hub checks a new one before it replaces the old. It is kept on your hub only and never shown again.</div>
    </section>
  );
}

/** An iCloud account's calendars: which to keep in step, where new events go, and Sync now. */
function CalendarChoices({ a, busy, run, setCal }: { a: CalendarAccount; busy: boolean; run: Run; setCal: (v: CalendarSyncView) => void }) {
  const client = engine.client;
  // What Sync now came to, said right under its button.
  const [synced, setSynced] = useState<Msg>(null);
  const chosen = a.calendars.filter((c) => c.chosen);
  const toggle = (url: string, on: boolean) => void run(async () => {
    const next = on ? [...chosen.map((c) => c.url), url] : chosen.map((c) => c.url).filter((u) => u !== url);
    setCal(await client!.chooseCalendars(a.email, { chosen: next, ...(!on && a.target === url ? { target: null } : {}) }));
  });
  return (
    <div className="col" style={{ gap: 4 }}>
      <div className="col" role="group" aria-label={`Calendars of ${a.email}`} style={{ gap: 0 }}>
        <div className="muted small">Calendars to keep in step</div>
        {a.calendars.map((c) => (
          <label key={c.url} className="toggle-row">
            <input type="checkbox" checked={c.chosen} disabled={busy} onChange={(e) => toggle(c.url, e.target.checked)} />
            <span>
              {c.color && <span aria-hidden="true" style={{ display: "inline-block", width: 10, height: 10, borderRadius: 5, background: c.color, marginRight: 6 }} />}
              {c.name}{!c.writable && <span className="muted small"> read only</span>}
            </span>
          </label>
        ))}
      </div>
      {a.read_only ? <div className="muted small">Read only: new events made in Aeneas stay in the app, and changes to these events stay in iCloud's version.</div> : (
        <label className="col small" style={{ gap: 2 }}>
          New events go to
          <select value={a.target ?? ""} disabled={busy} onChange={(e) => void run(async () => { setCal(await client!.chooseCalendars(a.email, { target: e.target.value || null })); })}>
            <option value="">Keep them in the app</option>
            {a.calendars.filter((c) => c.writable).map((c) => <option key={c.url} value={c.url}>{c.name}</option>)}
          </select>
        </label>
      )}
      <div className="muted small">Last synced {when(a.last_sync)}; it syncs every 5 minutes, and soon after you change an event. Work events never leave the hub.</div>
      {/* The account's own calendar error (its last sync's), unless Sync now just said the same below. */}
      {a.last_error && a.last_error !== synced?.text && <div className="error small">{a.last_error}</div>}
      <div>
        <button type="button" disabled={busy || !chosen.length} onClick={() => { setSynced(null); void run(async () => {
          try {
            const r = await client!.syncCalendarsNow();
            setCal(r);
            setSynced(syncNowResult(r.results, a.email));
          } catch (e) { setSynced({ ok: false, text: errorText(e) }); }
        }); }}>
          {busy ? "Syncing" : "Sync now"}
        </button>
      </div>
      <Status msg={synced} />
    </div>
  );
}

/**
 * The guided iCloud steps (the hub's `icloud` guide), shown from Add account's Show me how: what an app-specific
 * password is and how to make one, with the name to copy and the link. The address and password are then typed into
 * Add account itself, so its switches apply; the guide's own last step (its fields) is left out.
 */
function GuideSteps({ service }: { service: "icloud" }) {
  const [guide, setGuide] = useState<Guide | null>(null);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState("");
  useEffect(() => { void engine.client?.ownKeyGuide(service).then(setGuide, (e) => setErr(errorText(e))); }, [service]);
  if (err) return <div className="error small">{err}</div>;
  if (!guide) return <div className="muted small">Loading the guide.</div>;
  const copy = (v: string) => void navigator.clipboard.writeText(v).then(() => { setCopied(v); setTimeout(() => setCopied(""), 1500); });
  return (
    <ol className="col guide-steps small">
      {guide.steps.filter((s) => !s.fields?.length).map((s) => (
        <li key={s.title} className="col" style={{ gap: 4 }}>
          <strong>{s.title}</strong>
          <span>{s.text}</span>
          {s.copy?.map((c) => (
            <span key={c.label} className="row" style={{ gap: 6 }}>
              <span className="muted">{c.label}:</span> <code>{c.value}</code>
              <button type="button" className="ghost small" onClick={() => copy(c.value)}>{copied === c.value ? "Copied" : "Copy"}</button>
            </span>
          ))}
          {s.link && <a href={s.link.url} target="_blank" rel="noreferrer">{s.link.label}</a>}
        </li>
      ))}
    </ol>
  );
}

/**
 * Add account, one page: 1. Which account? (iCloud, Google, Other mail); 2. Sign in (the address and an app password,
 * or an IMAP server's details); 3. What it brings in (Mail and Receipts and renewals on, an iCloud account's Calendars
 * off). Add account switches on the modules those need and has the hub check the sign-in. `kind` and `email` come from
 * an older Google sign-in's Add an app password: Google, with its address filled in.
 */
function AddAccountPage({ kind: startKind, email: startEmail }: { kind: string | null; email: string | null }) {
  const { list } = useModules();
  const [kind, setKind] = useState<NewAccount["kind"]>(startKind === "google" || startKind === "imap" ? startKind : "icloud");
  const [email, setEmail] = useState(startEmail ?? "");
  const [password, setPassword] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("993");
  const [user, setUser] = useState("");
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("");
  const [smtpSecurity, setSmtpSecurity] = useState<"tls" | "starttls">("tls");
  const [want, setWant] = useState<Record<Feature, boolean>>({ inbox: true, receipts: true, calendars: false });
  const [howTo, setHowTo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const client = engine.client;
  const known = (m: string) => !!list?.find((x) => x.id === m)?.on;
  const wanted = { ...want, calendars: kind === "icloud" && want.calendars };
  const ready = !!email.trim() && !!password.trim() && (kind !== "imap" || !!host.trim()) && (wanted.inbox || wanted.receipts || wanted.calendars);
  const add = async () => {
    if (!client) return;
    setBusy(true);
    setMsg(null);
    try {
      const key = await addAccount(client, { kind, email, password, host, port: Number(port) || 993, user, smtp: kind === "imap" ? typedSmtp(smtpHost, smtpPort, smtpSecurity) : null, want: wanted }, known, setModules);
      setPassword("");
      location.hash = `#/settings/accounts/${encodeURIComponent(key)}`;
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  const kinds: Array<{ k: NewAccount["kind"]; label: string }> = [{ k: "icloud", label: "iCloud" }, { k: "google", label: "Google" }, { k: "imap", label: "Other mail" }];
  return (
    <SubPage path="/settings/accounts/add" title="Add account">
      <form className="col" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <section className="card col">
          <h2>Which account?</h2>
          <div className="row wrap" role="radiogroup" aria-label="Which account?">
            {kinds.map(({ k, label }) => (
              <label key={k} className="toggle-row"><input type="radio" name="account-kind" checked={kind === k} onChange={() => { setKind(k); setHowTo(false); }} /> <span>{label}</span></label>
            ))}
          </div>
        </section>
        <section className="card col">
          <h2>Sign in</h2>
          <label className="col small" style={{ gap: 2 }}>
            Address
            <input type="email" autoComplete="off" spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value)} placeholder={kind === "icloud" ? "jamie@icloud.com" : kind === "google" ? "jamie@gmail.com" : "jamie@example.com"} />
          </label>
          {kind === "imap" && (
            <div className="row wrap" style={{ gap: 8 }}>
              <label className="col small" style={{ gap: 2, flex: "1 1 220px" }}>
                Server
                <input autoComplete="off" spellCheck={false} value={host} onChange={(e) => setHost(e.target.value)} placeholder="imap.example.com" />
              </label>
              <label className="col small" style={{ gap: 2, width: 90 }}>
                Port
                <input inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ""))} placeholder="993" />
              </label>
            </div>
          )}
          {kind === "imap" && (
            <label className="col small" style={{ gap: 2 }}>
              User name
              <input autoComplete="off" spellCheck={false} value={user} onChange={(e) => setUser(e.target.value)} placeholder={email.trim() || "the address"} />
            </label>
          )}
          <label className="col small" style={{ gap: 2 }}>
            {kind === "icloud" ? "App-specific password" : kind === "google" ? "App password (16 letters)" : "Password"}
            <input type="password" autoComplete="off" spellCheck={false} autoFocus={!!startEmail} value={password} onChange={(e) => setPassword(e.target.value)} placeholder={kind === "icloud" ? "abcd-efgh-ijkl-mnop" : kind === "google" ? "abcd efgh ijkl mnop" : ""} />
          </label>
          {kind === "google" && <div className="muted small">{GOOGLE_HOWTO} <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">Open Google's page</a></div>}
          {kind === "icloud" && (
            <>
              <div className="muted small">{ICLOUD_HOWTO} <a href="https://account.apple.com" target="_blank" rel="noreferrer">Open account.apple.com</a></div>
              {howTo ? <GuideSteps service="icloud" /> : <div><button type="button" className="ghost small" onClick={() => setHowTo(true)}>Show me how</button></div>}
            </>
          )}
          {kind === "imap" && <div className="muted small">Your provider's help pages give its server and port, and where to make an app password. The hub connects with TLS only (most often port 993), and only to servers on the internet, never one on your own network.</div>}
          {kind === "imap" && <SendingFields host={smtpHost} port={smtpPort} security={smtpSecurity} hint={smtpGuess(host)} set={(h, p, x) => { setSmtpHost(h); setSmtpPort(p); setSmtpSecurity(x); }} label={SENDING_TEXTS.optional} />}
        </section>
        <section className="card col">
          <h2>What it brings in</h2>
          <Toggle checked={want.inbox} onChange={(v) => setWant({ ...want, inbox: v })} label="Mail" note={FEATURE_NOTES.inbox} />
          <Toggle checked={want.receipts} onChange={(v) => setWant({ ...want, receipts: v })} label="Receipts and renewals" note={FEATURE_NOTES.receipts} />
          {kind === "icloud" && <Toggle checked={want.calendars} onChange={(v) => setWant({ ...want, calendars: v })} label="Calendars" note={FEATURE_NOTES.calendars} />}
          <div><button type="submit" className="primary" disabled={busy || !client || !ready}>{busy ? "Checking" : "Add account"}</button></div>
          <Status msg={msg} />
          <div className="muted small">{ADD_FOOTER}</div>
        </section>
      </form>
    </SubPage>
  );
}
