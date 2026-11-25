import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { HubClient, OWN_KEY_SAVE, type Connections } from "./api";
import { APP_KEYS, APP_KEYS_INTRO, appKeys, atlassianSignedIn, connectionsSummary } from "../views/settings/Connections";
import { accountsSummary, googleRemovedNote, hasReadOnlySwitch, lastUseOff, OLDER_GOOGLE_NOTE, olderHubAccounts, syncNowResult } from "../views/settings/Accounts";
import { groupOrder, listedHere, modulesSummary, nestedOrder } from "../views/settings/Modules";
import { readOnlyBox, writableBoxes } from "../lib/mail";

describe("guided setup", () => {
  it("sends a guide's fields only to the hub's own setup routes, iCloud Mail's link included", () => {
    for (const p of ["/connections/google/app", "/connections/atlassian/app", "/connections/steam/key", "/connections/icloud"]) expect(OWN_KEY_SAVE.test(p)).toBe(true);
    // A guide that names anything else (another route, a sub-path, another host) gets nothing typed into it.
    for (const p of ["/connections/icloud/sync", "/connections/icloud/x", "/connections/icloudx", "/setup/pair", "https://evil.example/connections/icloud", "//evil.example/connections/icloud", "/connections/icloud?to=x"]) expect(OWN_KEY_SAVE.test(p)).toBe(false);
  });

  it("names the linked accounts in Accounts, and only services in Connections", () => {
    const c = { steam: { connected: false, hub_key: false }, letterboxd: { connected: true }, health: { last_import: null, samples: 0, total: 0 }, icloud: { accounts: [{ email: "robin@icloud.example" }] } } as unknown as Connections;
    expect(accountsSummary(c)).toBe("robin@icloud.example");
    expect(accountsSummary({ ...c, internet: [{ email: "robin@icloud.example" }, { email: "robin@gmail.example" }] } as unknown as Connections)).toBe("robin@icloud.example and 1 more");
    expect(accountsSummary({ ...c, internet: [] } as unknown as Connections)).toBe("No accounts yet");
    expect(connectionsSummary(c)).toBe("Letterboxd");
    expect(connectionsSummary(null)).not.toMatch(/iCloud|Gmail|Health/);
  });
});

describe("internet accounts", () => {
  const base = { steam: { connected: false, hub_key: false }, letterboxd: { connected: false }, health: { last_import: null, samples: 0, total: 0 } };
  const counts = { linked_at: "2026-11-01T10:00:00Z", last_sync: "2026-11-20T10:00:00Z", listed: 4, to_read: 1, read: 3, failed: 0, filed: { renewals: 1, pet: 0, events: 0 } };

  it("removes an account whole with one request, whatever its kind", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method });
      return new Response(JSON.stringify({ message: "Removed. Revoke its app password at your provider too." }), { status: 200 });
    }) as typeof fetch;
    const c = new HubClient({ hubUrl: "http://hub.test", token: "t" }, fetchImpl);
    for (const key of ["icloud:robin@northwind.example", "imap:robin@larkspur.example", "robin@fabrikam.example"]) {
      expect((await c.removeAccount(key)).message).toContain("Removed");
    }
    expect(calls).toEqual([
      { url: "http://hub.test/connections/accounts/icloud%3Arobin%40northwind.example", method: "DELETE" },
      { url: "http://hub.test/connections/accounts/imap%3Arobin%40larkspur.example", method: "DELETE" },
      { url: "http://hub.test/connections/accounts/robin%40fabrikam.example", method: "DELETE" },
    ]);
    // Remove account asks for that and nothing else: stopping the calendars first took the account away, and the
    // unlink that followed failed.
    const src = fs.readFileSync(path.join(__dirname, "../views/settings/Accounts.tsx"), "utf8");
    const remove = src.slice(src.indexOf("const remove = () => {"), src.indexOf("const calendar = cal?.accounts"));
    expect(remove).toContain("(await client!.removeAccount(a.key)).message");
    expect(remove).not.toMatch(/stopCalendars|disconnect/);
  });

  it("asks before the last switch of an account goes off, since the hub then removes the account", async () => {
    const all = { inbox: true, receipts: true, calendars: true };
    expect(lastUseOff(all, { inbox: false })).toBe(false);
    expect(lastUseOff({ inbox: true, receipts: false, calendars: false }, { inbox: false })).toBe(true);
    expect(lastUseOff({ inbox: false, receipts: true, calendars: null }, { receipts: false })).toBe(true);
    expect(lastUseOff({ inbox: false, receipts: false, calendars: true }, { calendars: false })).toBe(true);
    expect(lastUseOff({ inbox: true, receipts: false, calendars: true }, { calendars: false })).toBe(false);
    // A switch the app does not show (its module is off) still counts as a use: the hub keeps the account for it.
    expect(lastUseOff({ inbox: true, receipts: true, calendars: null }, { receipts: false })).toBe(false);
    // Switching something on, or nothing at all, never asks.
    expect(lastUseOff({ inbox: false, receipts: false, calendars: false }, { inbox: true })).toBe(false);
    expect(lastUseOff({ inbox: false, receipts: false, calendars: false }, {})).toBe(false);
    // The hub's answer says when it removed the account, in its own words, and the screen shows them.
    const fetchImpl = (async () => new Response(JSON.stringify({ inbox: false, receipts: false, removed: true, message: "Nothing on the hub uses this account now. The account is removed." }), { status: 200 })) as typeof fetch;
    const r = await new HubClient({ hubUrl: "http://hub.test", token: "t" }, fetchImpl).setAccountFeatures("imap:robin@larkspur.example", { inbox: false });
    expect([r.removed, r.message]).toEqual([true, "Nothing on the hub uses this account now. The account is removed."]);
    const src = fs.readFileSync(path.join(__dirname, "../views/settings/Accounts.tsx"), "utf8");
    expect(src).toContain("const last = lastUseOff(a.features, { [f]: false });");
    expect(src).toContain("if (last && !confirm(");
    expect(src).toContain("return r.removed ? r.message : undefined;");
  });

  it("sends undo only with a move that takes one back", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ moved: [], failed: 0, to: {} }), { status: 200 });
    }) as typeof fetch;
    const c = new HubClient({ hubUrl: "http://hub.test", token: "t" }, fetchImpl);
    await c.mailMove(["a"], "trash");
    await c.mailMove(["b"], "inbox");
    await c.mailMove(["c"], "inbox", true);
    expect(bodies).toEqual([{ ids: ["a"], to: "trash" }, { ids: ["b"], to: "inbox" }, { ids: ["c"], to: "inbox", undo: true }]);
    // The screen's Undo of a Delete, a Spam or a Move says so; a plain Move to Inbox does not.
    const src = fs.readFileSync(path.join(__dirname, "../views/Mail.tsx"), "utf8");
    expect(src).toContain('run: () => relocate(kept, back, "Moved back", null, true) });');
    expect(src).toContain("const one = await c.mailMove(part, to, undo);");
  });

  it("lists an older hub's accounts from the fields it sends, in place of No accounts yet", () => {
    const older = { ...base, icloud: { accounts: [{ ...counts, email: "robin@northwind.example", last_error: null }] }, google: { app: true, accounts: [{ ...counts, email: "robin@larkspur.example", last_error: "Sign in again." }] } } as unknown as Connections;
    const cal = { accounts: [{ email: "Robin@northwind.example", mail: true, calendars: [], target: null, last_sync: "2026-11-21T08:00:00Z", last_error: "The password was refused." }, { email: "robin@fabrikam.example", mail: false, calendars: [], target: null, last_sync: null, last_error: null }] };
    const list = olderHubAccounts(older, cal)!;
    expect(list.map((a) => [a.email, a.kind, !!a.receipts, !!a.calendars, a.errors])).toEqual([
      ["robin@northwind.example", "iCloud", true, true, ["The password was refused."]],
      ["robin@fabrikam.example", "iCloud", false, true, []],
      ["robin@larkspur.example", "Google, older sign-in", true, false, ["Sign in again."]],
    ]);
    expect(olderHubAccounts(base as unknown as Connections, null)).toEqual([]);
    // A hub with Internet Accounts is not an older hub, with no account or with some.
    expect(olderHubAccounts({ ...older, internet: [] } as unknown as Connections, cal)).toBeNull();
    const src = fs.readFileSync(path.join(__dirname, "../views/settings/Accounts.tsx"), "utf8");
    expect(src).toContain("This hub is older than the app. Update the hub in <a href=\"#/settings/about\">Settings, About</a>, then add, change or remove accounts here.");
    // Add account only on a hub that has accounts to add to.
    const newer = src.slice(src.indexOf("<nav className=\"col accounts-list\""), src.indexOf("{ACCOUNTS_FOOTER}"));
    expect(newer).toContain('href="#/settings/accounts/add"');
    expect(src.slice(src.indexOf("{older ? ("), src.indexOf("<nav className=\"col accounts-list\""))).not.toContain("accounts/add");
  });

  it("says what Sync now came to under its button, and shows an account's own calendar error", () => {
    expect(syncNowResult([{ account: "robin@northwind.example" }, { account: "robin@larkspur.example" }], "robin@northwind.example")).toEqual({ ok: true, text: "Synced." });
    expect(syncNowResult([{ account: "Robin@northwind.example", error: "The password was refused." }], "robin@northwind.example")).toEqual({ ok: false, text: "The password was refused." });
    expect(syncNowResult([{ account: "robin@northwind.example" }, { account: "robin@larkspur.example", error: "The server did not answer." }], "robin@northwind.example")).toEqual({ ok: false, text: "robin@larkspur.example: The server did not answer." });
    const src = fs.readFileSync(path.join(__dirname, "../views/settings/Accounts.tsx"), "utf8");
    expect(src).toContain("{a.last_error && a.last_error !== synced?.text && <div className=\"error small\">{a.last_error}</div>}");
    expect(src).toContain("<Status msg={synced} />");
    expect(src).toContain("{calErr && <div className=\"error small\" role=\"alert\">The calendars could not be read: {calErr}</div>}");
  });
});

describe("Confluence Reconnect (gnomecannon/aeneas#24)", () => {
  const linked = { connected: true as const, app: true as const, site_name: "example-studio", site_url: "https://example-studio.atlassian.net", spaces: ["STARFALL"], last_sync: null, last_error: null, pages: 3 };
  it("waits for the sign-in to land: a link Atlassian ended is connected, but not signed in until Reconnect clears it", () => {
    expect(atlassianSignedIn({ ...linked, expired: true, last_error: "Atlassian ended the sign-in." })).toBe(false);
    expect(atlassianSignedIn({ ...linked, expired: false })).toBe(true);
    expect(atlassianSignedIn(linked)).toBe(true);
    expect(atlassianSignedIn({ connected: false, app: true })).toBe(false);
    expect(atlassianSignedIn(undefined)).toBe(false);
  });
  it("offers Reconnect, never only Unlink, for a link whose sign-in ended", () => {
    const src = fs.readFileSync(path.join(__dirname, "../views/settings/Connections.tsx"), "utf8");
    const ended = src.slice(src.indexOf("{expired ? ("), src.indexOf(") : c.connected ? ("));
    expect(ended).toContain('"Reconnect"');
    expect(ended).toContain("onClick={signIn}");
    expect(ended).toContain("The pages already in the wiki stay.");
  });
});

describe("Settings, Connections reworked (gnomecannon/aeneas#10, #25), its accounts in Settings, Accounts since 2026-11-24", () => {
  const conn = fs.readFileSync(path.join(__dirname, "../views/settings/Connections.tsx"), "utf8");
  const src = fs.readFileSync(path.join(__dirname, "../views/settings/Accounts.tsx"), "utf8");
  const page = conn.slice(conn.indexOf("export function ConnectionsPage()"));

  it("has a Read only switch on iCloud and app-password accounts, sent to the hub, and none on a Google sign-in", async () => {
    expect(hasReadOnlySwitch({ kind: "icloud", read_only: false })).toBe(true);
    expect(hasReadOnlySwitch({ kind: "imap", read_only: true })).toBe(true);
    expect(hasReadOnlySwitch({ kind: "gmail", read_only: false })).toBe(true);
    expect(hasReadOnlySwitch({ kind: "google", read_only: true })).toBe(false);
    // A hub older than Read only does not say: no switch the hub would not keep.
    expect(hasReadOnlySwitch({ kind: "icloud" })).toBe(false);
    const sent: unknown[] = [];
    const c = new HubClient({ hubUrl: "http://hub.test", token: "t" }, (async (_u: RequestInfo | URL, init?: RequestInit) => { sent.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify({ inbox: true, receipts: true, read_only: true }), { status: 200 }); }) as typeof fetch);
    expect((await c.setAccountFeatures("imap:robin@larkspur.example", { read_only: true })).read_only).toBe(true);
    expect(sent).toEqual([{ read_only: true }]);
  });

  it("reads one account with its own Read now, and every account without one", async () => {
    const sent: Array<{ url: string; body: unknown }> = [];
    const c = new HubClient({ hubUrl: "http://hub.test", token: "t" }, (async (u: RequestInfo | URL, init?: RequestInit) => { sent.push({ url: String(u), body: JSON.parse(String(init?.body)) }); return new Response("{}", { status: 200 }); }) as typeof fetch);
    await c.readMailNow("icloud:robin@northwind.example");
    await c.readMailNow();
    expect(sent).toEqual([{ url: "http://hub.test/connections/google/sync", body: { account: "icloud:robin@northwind.example" } }, { url: "http://hub.test/connections/google/sync", body: {} }]);
    expect(src).toContain("client!.readMailNow(a.key)");
  });

  it("lists an account's switches in one place, Mail, Receipts and renewals, Calendars and Read only, with no Reminders switch on it (gnomecannon/aeneas#30)", () => {
    const page = src.slice(src.indexOf("function AccountPage("), src.indexOf("/** Sign-in: the app password"));
    const at = ['label="Mail"', 'label="Receipts and renewals"', 'label="Calendars"', 'label="Read only"'].map((x) => page.indexOf(x));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    for (const text of [src, conn]) {
      expect(text).not.toContain("apple_reminders");
      expect(text).not.toContain("Reminders on your iPhone and Mac");
    }
  });

  it("keeps only services in Connections, then the app keys they need, with no key guide left inside a service", () => {
    const order = ["<Steam", "<Letterboxd", "<Confluence", "<PasswordManager", "<CalendarFeed", "<AppKeys"].map((x) => page.indexOf(x));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const gone of ["<InternetAccounts", "<Health", "Internet Accounts", "AddAccount"]) expect(conn).not.toContain(gone);
    const steam = conn.slice(conn.indexOf("function Steam("), conn.indexOf("function NeedsKey("));
    const confluence = conn.slice(conn.indexOf("function Confluence("), conn.indexOf("/** The plan as a calendar"));
    expect(steam).not.toContain("OwnKeyGuide");
    expect(confluence).not.toContain("OwnKeyGuide");
    expect(conn).toContain('<OwnKeyGuide service={k.service} onDone={reload} start={k.added ? { label: "Replace" } : { label: "Set it up", primary: true }} />');
  });

  it("adds Google with an app password only, and offers one, with the address filled in, to an account on the older Google sign-in", () => {
    const add = src.slice(src.indexOf("function AddAccountPage("));
    expect(add).toContain('"App password (16 letters)"');
    expect(add).toContain('<a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">Open Google\'s page</a>');
    for (const text of [src, conn]) for (const gone of ["GoogleSignIn", "googleSignIn", '"Sign in with Google"', "Or sign in with Google"]) expect(text).not.toContain(gone);
    expect(fs.readFileSync(path.join(__dirname, "api.ts"), "utf8")).not.toContain("/connections/google/signin");
    expect(src).not.toContain('<OwnKeyGuide service="google"');
    const signIn = src.slice(src.indexOf("function SignIn("), src.indexOf("/** An iCloud account's calendars"));
    expect(signIn).toContain("<div className=\"muted small\">{OLDER_GOOGLE_NOTE}</div>");
    expect(signIn).toContain("#/settings/accounts/add?kind=google&email=${encodeURIComponent(a.email)}");
    expect(signIn).toContain(">Add an app password</button>");
    expect(src).toContain("{a.google_removed_at && <div className=\"muted small\">{googleRemovedNote(fmtDate(a.google_removed_at))}</div>}");
    expect(src).not.toContain("viaGoogle");
    expect(add).toContain('startKind === "google"');
    expect(OLDER_GOOGLE_NOTE).toMatch(/^This address uses the older Google sign-in, which reads receipts only\. Add an app password/);
    expect(googleRemovedNote("Nov 24")).toBe("The older Google sign-in for this address was removed on Nov 24. Receipts and renewals carries on with this app password, from where the sign-in stopped.");
    for (const text of [OLDER_GOOGLE_NOTE, googleRemovedNote("Nov 24")]) expect(text).not.toMatch(/[\u2013\u2014!]/);
    // The same words on the iPhone, iPad and Mac.
    const swift = fs.readFileSync(path.join(__dirname, "../../../apple/Packages/EACore/Sources/EACore/HubClient+Connections.swift"), "utf8");
    expect(swift).toContain(`"${OLDER_GOOGLE_NOTE}"`);
    expect(swift).toContain(`"${googleRemovedNote("\\(day)")}"`);
    expect(swift).toContain('case "google": return "Google, older sign-in"');
  });
});

describe("Read only mailboxes on the Mail screen (gnomecannon/aeneas#10)", () => {
  const boxes = [{ email: "robin@northwind.example", last_refresh: null, last_error: null, more: false, read_only: true }, { email: "robin@larkspur.example", last_refresh: null, last_error: null, more: false }];
  it("knows which mail is in a Read only mailbox, and writes new mail only from the others", () => {
    expect(readOnlyBox(boxes, "Robin@Northwind.example")).toBe(true);
    expect(readOnlyBox(boxes, "robin@larkspur.example")).toBe(false);
    expect(writableBoxes(boxes).map((b) => b.email)).toEqual(["robin@larkspur.example"]);
  });
  it("offers no Done, Pin, Delete, Spam, Move to, reply or draft for it", () => {
    const mail = fs.readFileSync(path.join(__dirname, "../views/Mail.tsx"), "utf8");
    for (const fn of ["function PinButton(", "function DoneButton(", "function FolderActions("]) {
      const body = mail.slice(mail.indexOf(fn), mail.indexOf("\n}\n", mail.indexOf(fn)));
      expect(body, fn).toContain("readOnlyBox(boxes,");
    }
    const move = mail.slice(mail.indexOf("function MoveButtons("), mail.indexOf("function MoveMenu("));
    expect(move).toContain("if (box?.read_only) return null;");
    expect(mail).toContain("const write = asked && !readOnlyBox(boxes, m.mailbox);");
    expect(mail).toContain("const boxes = writableBoxes(linked);");
  });
});

describe("Settings, Modules leaves out a switch that lives elsewhere", () => {
  it("counts and lists every module but one an older hub says is switched elsewhere (Apple Reminders, on hubs of 1.0.17)", () => {
    const list = [
      { id: "renewals", title: "Renewals", summary: "", group: "Plan", on: true },
      { id: "apple_reminders", title: "Apple Reminders", summary: "", group: "On your devices", on: true, switch_in: "connections" as const },
      { id: "mail", title: "Receipts and renewals", summary: "", group: "Plan", on: false },
    ];
    expect(listedHere(list).map((m) => m.id)).toEqual(["renewals", "mail"]);
    expect(modulesSummary(list)).toBe("1 of 2 on");
  });
});

describe("Settings, Modules shows Receipts and renewals under Mail", () => {
  const mod = (id: string, under?: string, on = true) => ({ id, title: id, summary: "", group: "Plan", on, ...(under ? { under } : {}) });
  const ids = (rows: { m: { id: string }; sub: boolean }[]) => rows.map(({ m, sub }) => (sub ? `  ${m.id}` : m.id));

  it("puts a module right after the one it sits under, indented, with that one off too", () => {
    const list = [mod("calendars"), mod("mail", "mail_inbox"), mod("garden"), mod("mail_inbox", undefined, false)];
    expect(ids(nestedOrder(list))).toEqual(["calendars", "garden", "mail_inbox", "  mail"]);
    expect(nestedOrder(list)).toHaveLength(list.length);
  });

  it("shows it as a normal row where the hub put it when the module it sits under is not in the list", () => {
    expect(ids(nestedOrder([mod("mail", "mail_inbox"), mod("calendars")]))).toEqual(["mail", "calendars"]);
    // One level only, and two that name each other both show, as normal rows.
    expect(ids(nestedOrder([mod("a"), mod("b", "a"), mod("c", "b")]))).toEqual(["a", "  b", "c"]);
    expect(ids(nestedOrder([mod("a", "b"), mod("b", "a")]))).toEqual(["a", "b"]);
  });

  it("indents it in the picker and names the area's modules in the order they show", () => {
    const src = fs.readFileSync(path.join(__dirname, "../views/settings/Modules.tsx"), "utf8");
    const picker = src.slice(src.indexOf("export function ModulePicker()"), src.indexOf("/** Settings, Modules. */"));
    expect(picker).toContain("const mods = nestedOrder(list.filter((m) => m.group === g));");
    expect(picker).toContain('className={sub ? "module-sub" : undefined}');
    expect(picker).toContain("{mods.map(({ m }) => m.title).join(\", \")}");
    expect(fs.readFileSync(path.join(__dirname, "../styles.css"), "utf8")).toMatch(/\.module-sub \{[^}]*margin-left[^}]*border-left/);
  });
});

describe("Settings, Modules shows every area, the ones it does not know too", () => {
  const mod = (id: string, group: string) => ({ id, title: id, summary: "", group, on: true });

  it("puts the areas in the Library's order, whatever order the hub sends them in", () => {
    const list = [mod("web", "Assistant"), mod("projects", "Making"), mod("films", "Media"), mod("mail_inbox", "Plan"), mod("voice", "On your devices"), mod("homelab", "Tech"), mod("reference", "Notes"), mod("renewals", "Life admin"), mod("health", "Body and home")];
    expect(groupOrder(list)).toEqual(["On your devices", "Plan", "Notes", "Media", "Body and home", "Life admin", "Making", "Tech", "Assistant"]);
  });

  it("shows an area it does not know under its own heading, in the hub's order, before what the assistant may do", () => {
    const list = [mod("voice", "On your devices"), mod("garden", "Garden"), mod("web", "Assistant"), mod("radio", "Listening"), mod("projects", "Making")];
    expect(groupOrder(list)).toEqual(["On your devices", "Making", "Garden", "Listening", "Assistant"]);
    // Every module keeps its switch: each group named is shown.
    expect(new Set(groupOrder(list))).toEqual(new Set(list.map((m) => m.group)));
  });
});

describe("Settings, Connections, App keys", () => {
  const base = { letterboxd: { connected: false as const }, health: { last_import: null, samples: 0, total: 0 } };
  const signedIn = [{ email: "robin@larkspur.example", linked_at: "2026-10-01T00:00:00Z", last_sync: null, last_error: null, listed: 0, to_read: 0, read: 0, failed: 0, filed: { renewals: 0, pet: 0, events: 0 } }];
  const c = { ...base, steam: { connected: false as const, hub_key: true }, atlassian: { connected: false as const, app: false }, google: { app: true, accounts: signedIn } };

  it("shows a key only while its module is on, with whether the hub has it", () => {
    expect(appKeys(c, () => true).map((k) => [k.name, k.added])).toEqual([["Google app", true], ["Atlassian app", false], ["Steam key", true]]);
    expect(appKeys(c, (m) => m !== "wiki").map((k) => k.service)).toEqual(["google", "steam"]);
    expect(appKeys(c, () => false)).toEqual([]);
    // The Google app serves only the older Google sign-in: with no mailbox signed in that way, it is not shown.
    expect(appKeys({ ...c, google: { app: true, accounts: [] } }, () => true).map((k) => k.service)).toEqual(["atlassian", "steam"]);
    // A hub too old to say whether it has a Google or Atlassian app shows neither.
    expect(appKeys({ steam: { connected: false, hub_key: false } }, () => true).map((k) => [k.service, k.added])).toEqual([["steam", false]]);
  });

  it("says why keys are asked for, and each says what it is, what uses it and what works without it", () => {
    expect(APP_KEYS_INTRO).toMatch(/^These are optional\./);
    expect(APP_KEYS_INTRO).toContain("Aeneas has no server of its own");
    for (const k of APP_KEYS) {
      for (const text of [APP_KEYS_INTRO, k.purpose, k.what, k.why, k.uses, k.without, k.replacing]) {
        expect(text.length, k.name).toBeGreaterThan(0);
        expect(text, k.name).not.toMatch(/[\u2013\u2014!]/);
      }
    }
    const google = APP_KEYS.find((k) => k.service === "google")!;
    expect(google.what).toContain("gmail.readonly");
    expect(google.without).toContain("app password");
    expect(APP_KEYS.find((k) => k.service === "steam")!.without).toContain("Steam password changes");
  });

  it("says the same on the iPhone, iPad and Mac", () => {
    const swift = fs.readFileSync(path.join(__dirname, "../../../apple/Packages/EACore/Sources/EACore/AppKeys.swift"), "utf8");
    for (const text of [APP_KEYS_INTRO, ...APP_KEYS.flatMap((k) => [k.name, k.by, k.purpose, k.what, k.why, k.uses, k.without, k.replacing])]) expect(swift).toContain(`"${text}"`);
  });

  it("draws each row as a status and what it is for, opens what it is in place, and always has a button", () => {
    const src = fs.readFileSync(path.join(__dirname, "../views/settings/Connections.tsx"), "utf8");
    const row = src.slice(src.indexOf("function AppKeyRow("), src.indexOf("/**\n * Settings, Connections (gnomecannon"));
    expect(row).toContain("Added</span>");
    expect(row).toContain('<span className="muted small">Not added</span>');
    expect(row).toContain('className="ok small"');
    expect(row).toContain('className="info-btn" aria-expanded={open}');
    expect(row).toContain("<strong>Why {k.by} asks for it:</strong>");
    expect(row).not.toMatch(/>Set\.?</);
    expect(src).toContain('<h2>App keys</h2>');
    expect(src).toContain('Go to App keys');
  });
});
