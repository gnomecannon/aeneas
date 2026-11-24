import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HELP_DOCS } from "../src/help.js";

// Sign in with Google is retired (2026-11-24): docs/gmail-setup.md stays only for links made before, says so and points
// to the app password steps, and no other page teaches the sign-in or sends people to that page for it.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8");

test("the Gmail setup page says Sign in with Google is no longer offered and gives the app password steps", () => {
  const doc = read("docs/gmail-setup.md");
  assert.match(doc, /Sign in with Google is no longer offered/);
  assert.ok(doc.includes("https://myaccount.google.com/apppasswords"));
  assert.match(doc, /Settings, Accounts, Add account, choose Google/);
  assert.match(doc, /Add an app password/, "what an address signed in before does");
  for (const gone of ["Google Cloud project.", "Authorized redirect URI", "/connections/google/return", "every 7 days"]) assert.ok(!doc.includes(gone), `still teaches the sign-in: ${gone}`);
  assert.ok(doc.split("\n").length < 30, "a short page");
});

test("no page or help text sends people to Sign in with Google", () => {
  assert.ok(!(HELP_DOCS as readonly string[]).includes("docs/gmail-setup.md"), "the assistant answers from the Mail section instead");
  for (const f of ["README.md", "docs/using-aeneas.md", "docs/privacy-network.md", "docs/connections.md", "docs/running-your-hub.md"]) {
    const text = read(f);
    assert.ok(!text.includes("gmail-setup.md"), `${f} links the retired page`);
    assert.ok(!/can use Sign in with Google|offers Sign in with Google|Sign in with Google \(Gmail for receipts\)/.test(text), `${f} offers Sign in with Google`);
  }
});
