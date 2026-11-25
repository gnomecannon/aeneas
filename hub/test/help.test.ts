import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeHub } from "./helpers.js";
import { ctxFor } from "./ai-helpers.js";
import { runTool, TOOLS } from "../src/ai/tools.js";
import { docSections, HELP_DOCS, moduleSections, searchHelp, splitMarkdown } from "../src/help.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("help: every doc it reads exists and is published (none is on the private list)", () => {
  // The private list is itself private: the public repository has no copy, and holds only published docs anyway.
  const listFile = path.join(ROOT, "tools/public-release/private-paths.txt");
  const priv = fs.existsSync(listFile) ? fs.readFileSync(listFile, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")) : [];
  for (const d of HELP_DOCS) {
    assert.ok(fs.existsSync(path.join(ROOT, d)), `${d} is missing`);
    assert.ok(!priv.some((p) => d === p || (p.endsWith("/") && d.startsWith(p))), `${d} is private`);
  }
  const docs = new Set(docSections(ROOT).map((s) => s.doc));
  assert.equal(docs.size, HELP_DOCS.length);
  assert.ok(!docs.has("docs/00-owner-notes.md"));
});

test("help: Markdown splits into sections under their headings, ignoring # inside code blocks", () => {
  const s = splitMarkdown("x.md", "# Guide\n\nIntro.\n\n## Calendars\n\n### Into Aeneas\nRead on Apple.\n\n```bash\n# not a heading\n```\n## Mail\nOn the hub.");
  assert.deepEqual(s.map((x) => x.heading), ["Guide", "Guide > Calendars > Into Aeneas", "Guide > Mail"]);
  assert.equal(s[0].docTitle, "Guide");
  assert.match(s[1].text, /# not a heading/);
});

test("help: questions find the right section, the module list says what is on, and an off-topic question finds nothing", () => {
  const sub = searchHelp("what does subscribe in calendar app do", { root: ROOT });
  assert.match(sub.sections[0].heading, /Your plan out to any calendar app/);
  const ical = searchHelp("how do I get my iCloud calendar into the week view", { root: ROOT });
  assert.ok(ical.sections.slice(0, 2).some((s) => /Your iCloud calendars, on the hub/.test(s.heading)), JSON.stringify(ical.sections.map((s) => s.heading)));
  const pair = searchHelp("pair a new phone", { root: ROOT });
  assert.match(pair.sections[0].heading, /Add another device/);
  const mods = moduleSections([{ id: "music", on: true }, { id: "mail", on: false }]);
  const music = mods.find((m) => m.heading === "Modules > Song ideas")!.text;
  const mail = mods.find((m) => m.heading === "Modules > Receipts and renewals")!.text;
  assert.match(music, /This hub has it switched on \(Settings, Modules\)\./);
  assert.match(mail, /This hub has it switched off \(Settings, Modules\)\./);
  assert.match(mail, /In Settings, Modules it sits under Mail, with a switch of its own\./);
  // Accounts are added in Settings, Accounts (since 2026-11-24), which switches their modules on; keys in App keys.
  assert.match(mail, /Add the account in Settings, Accounts, Add account, which switches this on for you\./);
  assert.match(mods.find((m) => m.heading === "Modules > Games")!.text, /The guide is in Settings, Connections, App keys\./);
  const add = searchHelp("how do I add my gmail account", { root: ROOT });
  assert.ok(add.sections.slice(0, 3).some((s) => /> Accounts$/.test(s.heading)), JSON.stringify(add.sections.map((s) => s.heading)));
  for (const s of docSections(ROOT).filter((x) => x.doc === "docs/using-aeneas.md")) assert.doesNotMatch(s.text, /Internet Accounts|Calendar and work/, s.heading);
  for (const t of [music, mail]) assert.doesNotMatch(t, /\b(on|off) (on|off)\b/, t);
  assert.equal(searchHelp("zzqx florble", { root: ROOT }).sections.length, 0);
  const whole = searchHelp("calendar", { root: ROOT, section: "Mail" });
  assert.equal(whole.sections.length, 1);
  assert.match(whole.sections[0].heading, /> Mail$/);
  const total = sub.sections.reduce((n, s) => n + s.text.length, 0);
  assert.ok(total <= 7000);
});

test("app_help is a core tool the assistant can call, and answers from the docs with this hub's modules", async () => {
  const t = makeHub();
  try {
    assert.ok(TOOLS.some((x) => x.name === "app_help" && !x.writes));
    const a = async (method: string, p: string) => {
      const res = await t.app.request(p, { method, headers: { authorization: `Bearer ${t.hub.cfg.token}` } });
      return { status: res.status, data: await res.json().catch(() => null) };
    };
    const r = await runTool(a, { name: "app_help", arguments: { query: "how does Hum Song work" } }, ctxFor(t, "help-1"));
    assert.equal(r.ok, true, r.text);
    const out = JSON.parse(r.text) as { sections: { heading: string; text: string }[] };
    assert.ok(out.sections.some((s) => /Hum Song/.test(s.heading)));
    assert.ok(out.sections.some((s) => /Modules > Song ideas/.test(s.heading) && /This hub has it switched (on|off) \(Settings, Modules\)\./.test(s.text)));
  } finally { t.cleanup(); }
});
