import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LIST = path.join(ROOT, "tools/public-release/private-paths.txt");

/**
 * Every script a public deploy file runs must itself be public: people.sh ran deploy/install-hub-user.sh, which the
 * public copy left out, so adding a person failed on every public install. The private list exists only in the
 * private repository, so this runs there and is skipped in the public copy.
 */
test("public deploy files only run scripts that are public too", { skip: !fs.existsSync(LIST) && "no private list here (public copy)" }, () => {
  const priv = fs.readFileSync(LIST, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const isPrivate = (p: string) => priv.some((x) => p === x || (x.endsWith("/") && p.startsWith(x)));
  const bad: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) { if (!isPrivate(`${rel}/`)) walk(rel); continue; }
      if (isPrivate(rel) || !/\.(sh|ps1|nsi|mjs|js|ts|service|plist)$/.test(e.name)) continue;
      fs.readFileSync(path.join(ROOT, rel), "utf8").split("\n").forEach((line, i) => {
        for (const m of line.match(/deploy\/[A-Za-z0-9_./-]+\.(?:sh|ps1|nsi|mjs|js)/g) ?? []) if (isPrivate(m)) bad.push(`${rel}:${i + 1} runs ${m}`);
      });
    }
  };
  walk("deploy");
  assert.deepEqual(bad, []);
});
