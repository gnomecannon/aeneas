import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { HubClient, OWN_KEY_SAVE, type Connections } from "./api";
import { connectionsSummary, lastUseOff, olderHubAccounts, syncNowResult } from "../views/settings/Connections";

describe("guided setup", () => {
  it("sends a guide's fields only to the hub's own setup routes, iCloud Mail's link included", () => {
    for (const p of ["/connections/google/app", "/connections/atlassian/app", "/connections/steam/key", "/connections/icloud"]) expect(OWN_KEY_SAVE.test(p)).toBe(true);
    // A guide that names anything else (another route, a sub-path, another host) gets nothing typed into it.
    for (const p of ["/connections/icloud/sync", "/connections/icloud/x", "/connections/icloudx", "/setup/pair", "https://evil.example/connections/icloud", "//evil.example/connections/icloud", "/connections/icloud?to=x"]) expect(OWN_KEY_SAVE.test(p)).toBe(false);
  });

  it("names iCloud Mail among the linked accounts", () => {
    const c = { steam: { connected: false, hub_key: false }, letterboxd: { connected: false }, health: { last_import: null, samples: 0, total: 0 }, icloud: { accounts: [{ email: "robin@icloud.example" }] } } as unknown as Connections;
    expect(connectionsSummary(c)).toBe("iCloud Mail");
    expect(connectionsSummary(null)).toContain("iCloud Mail");
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
    const src = fs.readFileSync(path.join(__dirname, "../views/settings/Connections.tsx"), "utf8");
    const remove = src.slice(src.indexOf("const remove = () => {"), src.indexOf("const toggleCalendars"));
    expect(remove).toContain("void run(async () => (await client!.removeAccount(a.key)).message);");
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
    const src = fs.readFileSync(path.join(__dirname, "../views/settings/Connections.tsx"), "utf8");
    expect(src).toContain("if (lastUseOff(a.features, body) && !confirm(");
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
      ["robin@larkspur.example", "Google, signed in with Google", true, false, ["Sign in again."]],
    ]);
    expect(olderHubAccounts(base as unknown as Connections, null)).toEqual([]);
    // A hub with Internet Accounts is not an older hub, with no account or with some.
    expect(olderHubAccounts({ ...older, internet: [] } as unknown as Connections, cal)).toBeNull();
    const src = fs.readFileSync(path.join(__dirname, "../views/settings/Connections.tsx"), "utf8");
    expect(src).toContain("This hub is older than the app. Update the hub in <a href=\"#/settings/about\">Settings, About</a>, then add, change or remove accounts here.");
    expect(src).toContain("{!older && <AddAccount c={c} on={on}");
  });

  it("says what Sync now came to under its button, and shows an account's own calendar error", () => {
    expect(syncNowResult([{ account: "robin@northwind.example" }, { account: "robin@larkspur.example" }], "robin@northwind.example")).toEqual({ ok: true, text: "Synced." });
    expect(syncNowResult([{ account: "Robin@northwind.example", error: "The password was refused." }], "robin@northwind.example")).toEqual({ ok: false, text: "The password was refused." });
    expect(syncNowResult([{ account: "robin@northwind.example" }, { account: "robin@larkspur.example", error: "The server did not answer." }], "robin@northwind.example")).toEqual({ ok: false, text: "robin@larkspur.example: The server did not answer." });
    const src = fs.readFileSync(path.join(__dirname, "../views/settings/Connections.tsx"), "utf8");
    expect(src).toContain("{a.last_error && a.last_error !== synced?.text && <div className=\"error small\">{a.last_error}</div>}");
    expect(src).toContain("<Status msg={synced} />");
    expect(src).toContain("{calErr && <div className=\"error small\" role=\"alert\">The calendars could not be read: {calErr}</div>}");
  });
});
