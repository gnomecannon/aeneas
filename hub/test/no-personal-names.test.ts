import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The code works for any owner: no first owner's name, the names of people around them, their machines, network
 * addresses, tailnet or accounts in the hub, the web app, the Apple apps or the shared package. The model hears the
 * owner's name from the profile (`{{owner}}`, hub/src/profile.ts), people see "you", and machine names and addresses
 * are settings (hub/.env.example).
 *
 * What counts as personal is the public-release scanner's list (tools/public-release/scan.mjs), so the names are
 * written in one place, and that place stays out of the public copy. Where it is missing (the public copy) this skips.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCANNER = path.join(ROOT, "tools", "public-release", "scan.mjs");


/** Lines that must keep a match, by file and the text on the line, with the reason. None today. */
const ALLOWED: { file: string; text: string; why: string }[] = [];

type Pattern = { what: string; re: RegExp };
async function patterns(): Promise<Pattern[] | null> {
  if (!fs.existsSync(SCANNER)) return null;
  const mod = (await import(pathToFileURL(SCANNER).href)) as { PATTERNS?: Pattern[] };
  return mod.PATTERNS ?? null;
}
const personal = (pats: Pattern[], line: string) => {
  return pats.some((p) => p.re.test(line));
};

function scanned(): string[] | null {
  try {
    const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "hub/src", "web/src", "apple", "packages"], { cwd: ROOT, encoding: "utf8", timeout: 20_000 });
    return out.split("\n").filter((f) => f && !f.includes("node_modules/") && (!f.startsWith("apple/") || f.endsWith(".swift")));
  } catch { return null; }
}

test("no personal names, machines or addresses in the hub, web, Apple or shared sources", async (t) => {
  const pats = await patterns();
  if (!pats) { t.skip("the scanner's list is not in this copy"); return; }
  const files = scanned();
  if (!files) { t.skip("not a git checkout"); return; }
  assert.ok(files.length > 100, "the sources were listed");
  const found: string[] = [];
  for (const f of files) {
    let text: string;
    try { text = fs.readFileSync(path.join(ROOT, f), "utf8"); } catch { continue; }
    if (text.includes("\u0000")) continue;
    text.split("\n").forEach((line, i) => {
      if (!personal(pats, line)) return;
      if (ALLOWED.some((a) => a.file === f && line.includes(a.text))) return;
      found.push(`${f}:${i + 1}: ${line.trim().slice(0, 160)}`);
    });
  }
  assert.deepEqual(found, [], `say "the owner" or {{owner}}, or move the value to a setting:\n${found.join("\n")}`);
});

test("the scanner's list leaves the sample names and addresses alone", async (t) => {
  const pats = await patterns();
  if (!pats) { t.skip("the scanner's list is not in this copy"); return; }
  assert.ok(pats.length > 0, "the scanner has patterns");
  for (const s of ["the owner", "{{owner}}", "Robin said", "with Jen", "Jennifer", "Lizard", "desk-pc", "mini-pc", "desk-pc.example.ts.net", "10.4.5.1", "10.0.0.16", "100.90.0.5", "100.64.0.10", "192.168.1.20"]) {
    assert.ok(!personal(pats, s), s);
  }
});
