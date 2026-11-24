import fs from "node:fs";
import path from "node:path";
import { HUB_DIR } from "./config.js";
import type { ModuleView } from "./modules.js";
import { MODULES, moduleDef } from "./modules.js";
import { questionWords } from "./reference/assistant.js";
import { fold } from "./reference/search.js";

/**
 * The app's own documentation, for the assistant (`app_help` in ai/tools.ts): how Aeneas works and how to do things in
 * it, answered from the docs that ship with every hub (each install is a clone of the public repository) and from the
 * module list, which is always current. Only the files named here are read: the private repository has notes that
 * never leave it, and a test checks that none of these is on the private list.
 */
export const HELP_DOCS = [
  "docs/using-aeneas.md",
  "README.md",
  "docs/before-you-install.md",
  "docs/connections.md",
  "docs/running-your-hub.md",
  "docs/multi-person.md",
  "docs/helpers.md",
  "docs/privacy-network.md",
  "docs/06-threat-model.md",
] as const;

const ROOT = path.resolve(HUB_DIR, "..");

export interface HelpSection {
  /** The file, as named in HELP_DOCS, or "modules" for the module list. */
  doc: string;
  /** The document's own title (its first heading). */
  docTitle: string;
  /** The heading and the headings above it: "Running your hub > Back up and restore > Restore". */
  heading: string;
  text: string;
}

/** A Markdown file as its sections: each heading with the text under it until the next heading of any level. */
export function splitMarkdown(doc: string, md: string): HelpSection[] {
  const out: HelpSection[] = [];
  const trail: string[] = [];
  let docTitle = doc;
  let cur: { heading: string; lines: string[] } | null = null;
  let fence = false;
  const flush = () => {
    if (!cur) return;
    const text = cur.lines.join("\n").trim();
    if (text) out.push({ doc, docTitle, heading: cur.heading, text });
  };
  for (const line of md.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h = fence ? null : /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      flush();
      const level = h[1].length;
      if (level === 1 && !out.length && docTitle === doc) docTitle = h[2];
      trail.length = level - 1;
      trail[level - 1] = h[2];
      cur = { heading: trail.filter(Boolean).join(" > "), lines: [] };
    } else {
      if (!cur) cur = { heading: docTitle, lines: [] };
      cur.lines.push(line);
    }
  }
  flush();
  return out;
}

/** Modules an account brings in: set up in Settings, Accounts (since 2026-11-24), the rest in Settings, Connections. */
const ACCOUNT_MODULES = new Set(["mail", "mail_inbox", "calendars"]);

/** The module list as sections, with whether each module is on for this hub when that is known. */
export function moduleSections(modules?: Pick<ModuleView, "id" | "on">[]): HelpSection[] {
  const on = new Map((modules ?? []).map((m) => [m.id, m.on]));
  const core = "Modules > The core (always on)";
  return [
    {
      doc: "modules", docTitle: "Modules", heading: core,
      text: "Today, Assistant, Capture, Search, Unsorted Info, Tasks, Week, Notes, Memory, People and Lists are always on. Every other part is a module: switch it on or off in Settings, Modules (one setting for every device). A module that is off is hidden on every device, its background work stops and the assistant leaves it out; its data is kept, and switching it back on shows it again.",
    },
    ...MODULES.map((m) => ({
      doc: "modules", docTitle: "Modules", heading: `Modules > ${m.title}`,
      text: [
        `${m.summary}${on.has(m.id) ? ` This hub has it switched ${on.get(m.id) ? "on" : "off"} (Settings, Modules).` : ""}`,
        m.example && `For example: ${m.example}`,
        m.reads && `What it reads: ${m.reads}`,
        m.permissions?.length && `What each Apple device asks for while it is on: ${m.permissions.join(", ")}.`,
        m.setup && `Setup takes about ${m.setup.minutes} minutes: ${m.setup.needs}. ${ACCOUNT_MODULES.has(m.id) ? "Add the account in Settings, Accounts, Add account, which switches this on for you." : "The guide is in Settings, Connections, App keys."}`,
        `Listed under ${m.group}.`,
        m.under && `In Settings, Modules it sits under ${moduleDef(m.under).title}, with a switch of its own.`,
      ].filter(Boolean).join("\n"),
    })),
  ];
}

let cache: { key: string; sections: HelpSection[] } | null = null;

/** Every section of the shipped docs, read again when a file changes (a hub update). */
export function docSections(root = ROOT): HelpSection[] {
  const files = HELP_DOCS.map((d) => {
    const p = path.join(root, d);
    try { return { d, p, m: fs.statSync(p).mtimeMs }; } catch { return null; }
  }).filter((f): f is { d: (typeof HELP_DOCS)[number]; p: string; m: number } => !!f);
  const key = `${root}|${files.map((f) => `${f.d}:${f.m}`).join(",")}`;
  if (cache?.key === key) return cache.sections;
  const sections = files.flatMap((f) => {
    try { return splitMarkdown(f.d, fs.readFileSync(f.p, "utf8")); } catch { return []; }
  });
  cache = { key, sections };
  return sections;
}

/** Words in nearly every question about the app, which tell no section apart ("how does Hum Song work"). */
const HELP_STOP = new Set(["aeneas", "app", "apps", "work", "works", "working", "use", "using", "way", "thing", "things"]);

const tokens = (s: string) => fold(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
function hits(toks: string[], w: string): number {
  let n = 0;
  for (const t of toks) if (t === w || (t.startsWith(w) && t.length - w.length <= 2)) n++;
  return n;
}

/** How well a section answers: words in its heading count most, then up to three times in its text. */
export function scoreSection(s: HelpSection, words: string[]): number {
  const head = tokens(s.heading);
  const body = tokens(s.text);
  return words.reduce((sum, w) => sum + (hits(head, w) ? 5 : 0) + Math.min(hits(body, w), 3), 0);
}

export interface HelpAnswer {
  sections: { source: string; heading: string; text: string }[];
  note?: string;
}

/**
 * The sections that best answer a question, best first, within `budget` characters: the best one whole (up to half
 * the budget), the rest shortened. `section` names one heading to read whole instead.
 */
export function searchHelp(question: string, opts: { section?: string; modules?: Pick<ModuleView, "id" | "on">[]; root?: string; budget?: number } = {}): HelpAnswer {
  const all = [...docSections(opts.root), ...moduleSections(opts.modules)];
  const budget = opts.budget ?? 7000;
  const show = (s: HelpSection, max: number) => ({ source: s.doc === "modules" ? "Settings, Modules" : `${s.docTitle} (${s.doc})`, heading: s.heading, text: s.text.length > max ? `${s.text.slice(0, max).trimEnd()} …` : s.text });
  if (opts.section?.trim()) {
    const n = fold(opts.section);
    const hit = all.find((s) => fold(s.heading) === n) ?? all.find((s) => fold(s.heading).endsWith(n)) ?? all.find((s) => fold(s.heading).includes(n));
    if (hit) return { sections: [show(hit, budget)] };
  }
  const words = questionWords(question).filter((w) => !HELP_STOP.has(w));
  if (!words.length) return { sections: [], note: "ask with a few words about what to do, like add a calendar" };
  // The how-to guide wins a tie: it is written to answer these questions.
  const ranked = all.map((s) => ({ s, n: scoreSection(s, words) })).filter((r) => r.n > 0).map((r) => ({ ...r, n: r.n + (r.s.doc === HELP_DOCS[0] ? 1 : 0) })).sort((a, b) => b.n - a.n).slice(0, 5);
  if (!ranked.length) return { sections: [], note: "the docs say nothing about this; say so rather than guess" };
  const out: HelpAnswer["sections"] = [];
  let left = budget;
  for (const [i, r] of ranked.entries()) {
    const max = Math.min(i === 0 ? Math.floor(budget / 2) : 1200, left - 200);
    if (max < 300) break;
    const shown = show(r.s, max);
    out.push(shown);
    left -= shown.text.length + shown.heading.length + 60;
  }
  return { sections: out, ...(docSections(opts.root).length ? {} : { note: "this hub has no copy of the docs, only the module list" }) };
}
