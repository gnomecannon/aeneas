import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeHub } from "./helpers.js";
import { guideFor } from "../src/guides.js";
import { GMAIL_SCOPE } from "../src/imports/gmail.js";

// docs/gmail-setup.md lets people read the Gmail steps before they install; the app's guide is the one they follow.
// The two must say the same thing.
const DOC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "gmail-setup.md");

test("the public Gmail setup page has the app guide's steps, permission and return address", () => {
  const doc = fs.readFileSync(DOC, "utf8");
  const t = makeHub();
  try {
    const guide = guideFor(t.hub, "google", "https://hub.example.ts.net:8787");
    // Every step but the last ("Paste them here", which only makes sense inside the app).
    for (const step of guide.steps.slice(0, -1)) assert.ok(doc.includes(`**${step.title}.**`), `the page lacks the step "${step.title}"`);
    for (const step of guide.steps) for (const link of step.link ? [step.link.url] : []) assert.ok(doc.includes(link), `the page lacks ${link}`);
    assert.ok(doc.includes(GMAIL_SCOPE));
    const ret = guide.steps.flatMap((s) => s.copy ?? []).find((c) => c.label === "Authorized redirect URI")!.value;
    assert.ok(doc.includes(ret.replace("https://hub.example.ts.net:8787", "<hub>")), "the return address");
    assert.ok(doc.includes("every 7 days") && doc.includes("Go to Aeneas"));
  } finally { t.cleanup(); }
});
