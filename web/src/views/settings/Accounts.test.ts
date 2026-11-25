import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { HubClient, type InternetAccount } from "../../sync/api";
import { ACCOUNTS_FOOTER, ADD_FOOTER, addAccount, broughtIn, DEVICES_NOTE, FEATURE_NOTES, GOOGLE_HOWTO, ICLOUD_HOWTO, KIND_SHORT, modulesToSwitchOn, replacePassword, SENDING_TEXTS, sendingLine, typedSmtp, type NewAccount } from "./Accounts";

/** A hub that records each call and answers what calendar sync answers (or an empty object). */
function hub() {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    calls.push({ method: init?.method ?? "GET", path: decodeURIComponent(u.pathname), body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(u.pathname.startsWith("/calendars") ? { accounts: [], active: false } : {}), { status: 200 });
  }) as typeof fetch;
  return { calls, client: new HubClient({ hubUrl: "http://hub.test", token: "t" }, fetchImpl) };
}
const read = (p: string) => fs.readFileSync(path.join(__dirname, p), "utf8");

describe("Settings, Accounts: Add account", () => {
  it("switches the modules its switches need on first, then links the account with what was asked", async () => {
    const { calls, client } = hub();
    const switched: Record<string, boolean>[] = [];
    const form: NewAccount = { kind: "icloud", email: " Jamie@iCloud.example ", password: "abcd-efgh-ijkl-mnop", want: { inbox: true, receipts: true, calendars: true } };
    const key = await addAccount(client, form, (m) => m === "mail", async (c) => { switched.push(c); });
    expect(key).toBe("icloud:jamie@icloud.example");
    expect(switched).toEqual([{ mail_inbox: true, calendars: true }]);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["PUT /connections/icloud", "PUT /calendars/icloud"]);
    expect(calls[1].body).toEqual({ email: "jamie@icloud.example" });
  });

  it("switches a switch left off off after the link, and links an iCloud account for its calendars alone through calendar sync", async () => {
    const a = hub();
    await addAccount(a.client, { kind: "icloud", email: "jamie@icloud.example", password: "abcd-efgh-ijkl-mnop", want: { inbox: false, receipts: true, calendars: true } }, () => true, async () => undefined);
    expect(a.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["PUT /connections/icloud", "PUT /calendars/icloud", "PUT /connections/accounts/icloud:jamie@icloud.example"]);
    expect(a.calls[2].body).toEqual({ inbox: false });
    const b = hub();
    await addAccount(b.client, { kind: "icloud", email: "jamie@icloud.example", password: "abcd-efgh-ijkl-mnop", want: { inbox: false, receipts: false, calendars: true } }, () => true, async () => undefined);
    expect(b.calls).toEqual([{ method: "PUT", path: "/calendars/icloud", body: { email: "jamie@icloud.example", password: "abcd-efgh-ijkl-mnop" } }]);
  });

  it("adds Google and other mail with an app password, never with calendars", async () => {
    const { calls, client } = hub();
    await addAccount(client, { kind: "google", email: "jamie@gmail.example", password: "abcd efgh ijkl mnop", want: { inbox: true, receipts: false, calendars: false } }, () => true, async () => undefined);
    await addAccount(client, { kind: "imap", email: "jamie@example.com", password: "secret one", host: "imap.example.com", port: 993, user: "jamie", want: { inbox: true, receipts: true, calendars: false } }, () => true, async () => undefined);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["PUT /connections/imap", "PUT /connections/accounts/imap:jamie@gmail.example", "PUT /connections/imap"]);
    expect(calls[0].body).toEqual({ email: "jamie@gmail.example", password: "abcd efgh ijkl mnop", preset: "gmail" });
    expect(calls[2].body).toEqual({ email: "jamie@example.com", password: "secret one", preset: "imap", host: "imap.example.com", port: 993, user: "jamie" });
    expect(modulesToSwitchOn({ inbox: true, receipts: true }, (m) => m === "mail_inbox")).toEqual({ mail: true });
  });

  it("takes a new password with the account's switches kept, through calendar sync for one kept for its calendars alone", async () => {
    const { calls, client } = hub();
    const icloud = (inbox: boolean) => ({ kind: "icloud" as const, email: "jamie@icloud.example", features: { inbox, receipts: false, calendars: true } });
    await replacePassword(client, icloud(false), "abcd-efgh-ijkl-mnop");
    await replacePassword(client, icloud(true), "abcd-efgh-ijkl-mnop");
    await replacePassword(client, { kind: "gmail", email: "jamie@gmail.example", features: { inbox: true, receipts: true, calendars: null } }, "abcd efgh ijkl mnop");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["PUT /calendars/icloud", "PUT /connections/icloud", "PUT /connections/imap"]);
  });

  it("says what each account brings in only while its module is on", () => {
    const a = { features: { inbox: true, receipts: true, calendars: true }, read_only: false } as Pick<InternetAccount, "features" | "read_only">;
    expect(broughtIn(a, () => true)).toBe("Mail, Receipts and renewals, Calendars");
    expect(broughtIn(a, (m) => m === "calendars")).toBe("Calendars");
    expect(broughtIn({ ...a, read_only: true }, () => false)).toBe("Nothing switched on, read only");
  });

  it("is one page of three steps, from Accounts and from the Mail screen with no mailbox", () => {
    const src = read("Accounts.tsx");
    const add = src.slice(src.indexOf("function AddAccountPage("));
    const steps = ["<h2>Which account?</h2>", "<h2>Sign in</h2>", "<h2>What it brings in</h2>"].map((x) => add.indexOf(x));
    expect(steps.every((i) => i >= 0)).toBe(true);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
    expect(add).toContain('useState<Record<Feature, boolean>>({ inbox: true, receipts: true, calendars: false })');
    expect(add).toContain('<a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">Open Google\'s page</a>');
    expect(add).toContain('<a href="https://account.apple.com" target="_blank" rel="noreferrer">Open account.apple.com</a>');
    expect(add).toContain(">Show me how</button>");
    const mail = read("../Mail.tsx");
    expect(mail).toContain('location.hash = "#/settings/accounts/add"; }}>Add an account</button>');
    expect(mail).not.toContain("Settings, Connections");
    for (const text of [src, read("Connections.tsx"), read("Modules.tsx")]) expect(text).not.toMatch(/turn on [^.]*in <a href="#\/settings\/modules">/i);
  });
});

describe("Settings, Accounts: the page", () => {
  it("sits above Connections, with Work in it and no Work space row of its own", () => {
    const home = read("../Settings.tsx");
    const rows = home.slice(home.indexOf("function SettingsHome("), home.indexOf("/** A Direct link hub"));
    expect(rows.indexOf('href="/settings/accounts"')).toBeGreaterThan(0);
    expect(rows.indexOf('href="/settings/accounts"')).toBeLessThan(rows.indexOf('href="/settings/connections"'));
    expect(rows).not.toContain('href="/settings/work"');
    const src = read("Accounts.tsx");
    const page = src.slice(src.indexOf("function AccountsPage("), src.indexOf("/** An Apple account's name"));
    const order = ["<h2>Accounts</h2>", "<FromYourDevices", "<WorkSection"].map((x) => page.indexOf(x));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(src).toContain('label="Keep work calendar and tasks"');
    expect(src).toContain("<h2>From your iPhone, iPad and Mac</h2>");
  });

  it("speaks plainly: no dashes and no exclamation marks", () => {
    for (const text of [ACCOUNTS_FOOTER, ADD_FOOTER, DEVICES_NOTE, GOOGLE_HOWTO, ICLOUD_HOWTO, ...Object.values(FEATURE_NOTES), ...Object.values(KIND_SHORT)]) {
      expect(text).not.toMatch(/[\u2013\u2014!]/);
    }
    expect(read("Accounts.tsx")).not.toMatch(/[\u2013\u2014]/);
  });
});

describe("accounts: the sending server (since 2026-11-24)", () => {
  it("is shown in words, and typed with the port from the security when none is given", () => {
    expect(sendingLine({ host: "smtp.gmail.com", port: 465, security: "tls" })).toBe("smtp.gmail.com, port 465, TLS");
    expect(sendingLine({ host: "smtp.mail.me.com", port: 587, security: "starttls" })).toBe("smtp.mail.me.com, port 587, STARTTLS");
    expect(typedSmtp(" smtp.fastmail.com ", "", "tls")).toEqual({ host: "smtp.fastmail.com", port: 465, security: "tls" });
    expect(typedSmtp("smtp.fastmail.com", "", "starttls")).toEqual({ host: "smtp.fastmail.com", port: 587, security: "starttls" });
    expect(typedSmtp("", "465", "tls")).toBeNull();
    for (const t of Object.values(SENDING_TEXTS)) expect(t).not.toMatch(/[\u2013\u2014]/);
  });
  it("Add account, Other mail, sends it with the account when one was typed, and none otherwise", async () => {
    const calls: unknown[] = [];
    const client = { linkImap: async (l: unknown) => { calls.push(l); return { accounts: [] }; }, linkICloud: async () => undefined, linkCalendars: async () => ({}), setAccountFeatures: async () => ({ inbox: true, receipts: true }) } as unknown as Parameters<typeof addAccount>[0];
    const want = { inbox: true, receipts: true, calendars: false };
    await addAccount(client, { kind: "imap", email: "robin@mail.example", password: "pw", host: "imap.mail.example", port: 993, smtp: typedSmtp("smtp.mail.example", "", "starttls"), want }, () => true, async () => undefined);
    await addAccount(client, { kind: "imap", email: "robin@mail.example", password: "pw", host: "imap.mail.example", port: 993, smtp: typedSmtp("", "", "tls"), want }, () => true, async () => undefined);
    expect(calls).toEqual([
      { email: "robin@mail.example", password: "pw", preset: "imap", host: "imap.mail.example", port: 993, smtp: { host: "smtp.mail.example", port: 587, security: "starttls" } },
      { email: "robin@mail.example", password: "pw", preset: "imap", host: "imap.mail.example", port: 993 },
    ]);
  });
});
