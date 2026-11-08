import fs from "node:fs";
import path from "node:path";
import type { Store } from "./store.js";
import { seedRunbooks } from "./memory.js";
import { seedMusicNotes } from "./music.js";
import { seedMonitors } from "./monitors.js";
import { seedChecklists } from "./admin.js";
import type { ModuleCheck, ModuleId } from "./modules.js";

export interface SeedResult { facts: { created: number; kept: number }; rules: { created: number; kept: number }; plan_rules: { created: number; kept: number }; runbooks: { created: number; kept: number }; food_options: { created: number; kept: number }; music_notes: { created: number; kept: number }; snippets: { created: number; kept: number }; monitors: { created: number; kept: number }; checklists: { created: number; kept: number; states_marked: number } }

/**
 * Load deploy/seed/*.json. Facts are matched by (category, key) and rules by text, deleted ones included, and
 * created only when missing: the owner edits memory in the app, so a redeploy must never put the old values back.
 * Plan rules are matched by title and created only when missing: the user edits the Work hours in place.
 * Runbooks are derived from facts keyed `host:<name>`: one `Runbook: <name>` per host, created only when missing.
 * Food options are matched by name and created only when missing, so ratings and pick history survive a redeploy.
 * Music reference notes are matched by title and created only when missing. Monitors are matched by name
 * (deleted ones included) and created only when missing, so edits and deletions survive a redeploy. Checklists
 * are matched by title (deleted ones included) and created only when missing; the states list is marked from the
 * "States visited" note when it is created.
 * Safe to run repeatedly.
 */
/** The starter seed, then the owner's own (when that folder is there), counted together. */
export function runSeeds(store: Store, cfg: { seedDir: string; seedPersonalDir: string; port?: number }, on: ModuleCheck = () => true, only?: ModuleId[]): SeedResult {
  const a = runSeed(store, cfg.seedDir, false, cfg.port, on, only);
  if (!cfg.seedPersonalDir || !fs.existsSync(cfg.seedPersonalDir) || path.resolve(cfg.seedPersonalDir) === path.resolve(cfg.seedDir)) return a;
  const b = runSeed(store, cfg.seedPersonalDir, true, cfg.port, on, only);
  const out = { ...a } as Record<string, Record<string, number>>;
  for (const [k, v] of Object.entries(b) as [string, Record<string, number>][]) {
    out[k] = Object.fromEntries(Object.entries(v).map(([n, x]) => [n, (a as unknown as Record<string, Record<string, number>>)[k][n] + x]));
  }
  return out as unknown as SeedResult;
}

/**
 * Files of a module that is off are skipped; they are read when it is switched on (hub.ts), and then `only` names the
 * modules just switched on, so nothing else is read again (starter items the owner renamed would come back as copies).
 */
export function runSeed(store: Store, seedDir: string, optional = false, port = 8787, onAll: ModuleCheck = () => true, only?: ModuleId[]): SeedResult {
  const on: ModuleCheck = only ? (id) => only.includes(id) : onAll;
  const out: SeedResult = { facts: { created: 0, kept: 0 }, rules: { created: 0, kept: 0 }, plan_rules: { created: 0, kept: 0 }, runbooks: { created: 0, kept: 0 }, food_options: { created: 0, kept: 0 }, music_notes: { created: 0, kept: 0 }, snippets: { created: 0, kept: 0 }, monitors: { created: 0, kept: 0 }, checklists: { created: 0, kept: 0, states_marked: 0 } };
  const OWNER: Record<string, ModuleId> = { "food_options.json": "food", "music_notes.json": "music", "snippets.json": "homelab", "monitors.json": "homelab" };
  const read = (name: string): any[] => {
    if (only ? !(OWNER[name] && only.includes(OWNER[name])) : OWNER[name] && !on(OWNER[name])) return [];
    const p = path.join(seedDir, name);
    if (!fs.existsSync(p)) { if (!optional) console.warn(`[seed] ${p} not found, skipping`); return []; }
    return JSON.parse(fs.readFileSync(p, "utf8"));
  };

  const facts = store.list({ kind: "fact", includeDeleted: true });
  for (const raw of read("facts.json")) {
    const fields = { source: "seed", ...raw };
    const existing = facts.find((f) => f.fields.category === fields.category && f.fields.key === fields.key);
    if (!existing) { store.create("fact", fields); out.facts.created++; continue; }
    out.facts.kept++;
  }

  const rules = store.list({ kind: "rule", includeDeleted: true });
  for (const raw of read("rules.json")) {
    const fields = { active: true, ...raw };
    const existing = rules.find((r) => r.fields.text === fields.text);
    if (!existing) { store.create("rule", fields); out.rules.created++; continue; }
    out.rules.kept++;
  }

  const planRules = store.list({ kind: "plan_rule", includeDeleted: true });
  for (const raw of read("plan_rules.json")) {
    const fields = { active: true, ...raw };
    const existing = planRules.find((r) => r.fields.title === fields.title);
    if (!existing) { store.create("plan_rule", fields); out.plan_rules.created++; continue; }
    out.plan_rules.kept++;
  }

  // Module 2: a runbook per host fact, created once and never rewritten.
  if (on("homelab")) out.runbooks = seedRunbooks(store);

  // Module 4: starter food options, matched by name, created once.
  const foods = store.list({ kind: "food_option", includeDeleted: true });
  for (const raw of read("food_options.json")) {
    const fields = { avoid: false, ...raw };
    const existing = foods.find((f) => String(f.fields.name).toLowerCase() === String(fields.name).toLowerCase());
    if (!existing) { store.create("food_option", fields); out.food_options.created++; continue; }
    out.food_options.kept++;
  }

  // Module 5: two music reference sheets, as notes in Music/Reference, matched by title, created once.
  out.music_notes = !on("music") || (optional && !fs.existsSync(path.join(seedDir, "music_notes.json"))) ? { created: 0, kept: 0 } : seedMusicNotes(store, seedDir);

  // Snippets: a few read-only examples to try Render and Run with, matched by title (deleted ones included), created once.
  const snippets = store.list({ kind: "snippet", includeDeleted: true, limit: 100000 });
  for (const raw of read("snippets.json")) {
    if (snippets.some((s) => String(s.fields.title ?? "").toLowerCase() === String(raw.title ?? "").toLowerCase())) { out.snippets.kept++; continue; }
    store.create("snippet", raw);
    out.snippets.created++;
  }

  // Module 6: homelab monitors, matched by name, created once.
  // `{{port}}` in a monitor's target is the hub's own port (the starter monitor watches the hub itself).
  out.monitors = seedMonitors(store, read("monitors.json").map((m: Record<string, unknown>) => (typeof m.target === "string" ? { ...m, target: m.target.replace("{{port}}", String(port)) } : m)));

  // Module 7: packing templates and the US states list, matched by title, created once.
  out.checklists = seedChecklists(store, read("checklists.json"));
  return out;
}
