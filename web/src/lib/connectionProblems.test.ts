import { describe, expect, it } from "vitest";
import { fixPath, mailboxKey, problemsFor, rowWarning, type ConnectionProblem } from "./connectionProblems";

const mailbox: ConnectionProblem = {
  id: "account:icloud:jamie@icloud.com", service: "iCloud", title: "iCloud stopped signing in for jamie@icloud.com", detail: "Replace its app-specific password.",
  fix: "account", account: "icloud:jamie@icloud.com", button: "Replace password", affects: ["mail", "calendar"], since: null,
};
const steam: ConnectionProblem = { id: "steam", service: "Steam", title: "Steam stopped accepting the hub's key", detail: "Replace the Steam key to keep playtime coming in.", fix: "connections", button: "Replace the Steam key", affects: ["games"], since: null };

describe("connection problems", () => {
  it("opens the account's page with Replace open, or Settings, Connections", () => {
    expect(fixPath(mailbox)).toBe("/settings/accounts/icloud%3Ajamie%40icloud.com?replace=1");
    expect(fixPath(steam)).toBe("/settings/connections?show=steam");
    expect(fixPath({ id: "atlassian", fix: "connections" })).toBe("/settings/connections?show=confluence");
    expect(fixPath({ id: "something-new", fix: "connections" })).toBe("/settings/connections");
    expect(fixPath({ fix: "account" })).toBe("/settings/accounts");
  });

  it("lists on Mail and Week only what affects them", () => {
    expect(problemsFor([mailbox, steam], "calendar").map((p) => p.id)).toEqual(["account:icloud:jamie@icloud.com"]);
    expect(problemsFor([steam], "mail")).toEqual([]);
    expect(problemsFor(undefined, "mail")).toEqual([]);
  });

  it("marks the Accounts row for accounts and the Connections row for the rest", () => {
    expect(rowWarning([mailbox, steam], "account")).toBe("iCloud stopped signing in for jamie@icloud.com");
    expect(rowWarning([mailbox, steam], "connections")).toBe("Steam stopped accepting the hub's key");
    expect(rowWarning([mailbox, { ...mailbox, id: "b" }], "account")).toBe("2 accounts need you");
    expect(rowWarning([], "account")).toBeNull();
    expect(rowWarning(undefined, "connections")).toBeNull();
  });

  it("names a Mail screen mailbox by its account key", () => {
    expect(mailboxKey({ email: "a@icloud.com", kind: "icloud" })).toBe("icloud:a@icloud.com");
    expect(mailboxKey({ email: "a@gmail.com", kind: "gmail" })).toBe("imap:a@gmail.com");
  });
});
