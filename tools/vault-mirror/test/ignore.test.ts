import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildMatcher, loadIgnore } from "../src/ignore.ts";

test("default ignore covers folders, curly apostrophes and case", () => {
  const m = buildMatcher([]);
  assert.ok(m.isIgnored("Personal/Recovery Codes/Steam.md"));
  assert.ok(m.isIgnored("Personal/recovery codes.md"));
  assert.ok(m.isIgnored("Work/Passwords for the lab.md"));
  assert.ok(m.isIgnored("Personal/Wallet seed phrase.md"));
  assert.ok(!m.isIgnored("Personal/General Ideas.md"));
  assert.ok(!m.isIgnored("Programming/App Ideas/Weather Bot.md"));
});

test("names of your own come from the vault's .mirrorignore and the file outside the vault", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-ignore-"));
  try {
    const vault = path.join(d, "vault");
    fs.mkdirSync(vault);
    fs.writeFileSync(path.join(vault, ".mirrorignore"), "Taxes/\n");
    const own = path.join(d, "own.txt");
    fs.writeFileSync(own, "# notes that stay on this Mac\nRobin's Spare Keys.md\nMedical/\n");
    const m = await loadIgnore(vault, own);
    assert.ok(m.isIgnored("Personal/Robin’s Spare Keys.md"), "curly apostrophe");
    assert.ok(m.isIgnored("Personal/Medical/Visits.md"));
    assert.ok(m.isIgnored("Taxes/2026.md"));
    assert.ok(!m.isIgnored("Personal/Garden.md"));
    const none = await loadIgnore(vault, path.join(d, "missing.txt"));
    assert.ok(!none.isIgnored("Personal/Medical/Visits.md"), "a missing file means no patterns of your own");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
