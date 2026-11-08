import type { Entity } from "@everythingapp/shared";
import type { Hub } from "./hub.js";
import { StoreError } from "./store.js";
import { factValue } from "./health.js";

/**
 * Module 4, food. A rule-based picker over `food_option` rows. Scoring is deterministic: the same options and
 * facts give the same pick, and `why` says in one line what carried it.
 */

const DAY_MS = 24 * 3600_000;
const MEALS = new Set(["lunch", "dinner", "snack"]);
const MODES = new Set(["delivery", "restaurant", "grab", "home"]);
/** Texture words a `diet:textures` fact can name. Only the ones present in the fact are applied. */
const TEXTURE_WORDS = ["avocado", "banana", "coconut", "eggplant", "mushroom", "okra", "olive", "oyster", "raisin", "squash", "tomato", "zucchini"];
export const RECENT_DAYS = 3;

export interface PickRequest { meal?: unknown; mode?: unknown; budget?: unknown; exclude?: unknown }
export interface PickResult { pick: Entity | null; why: string; runner_up: Entity | null; constraints_used: string[] }

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x).toLowerCase()) : []);
const mentions = (o: Entity, word: string) => [...strs(o.fields.tags), ...strs(o.fields.items), String(o.fields.name ?? "").toLowerCase()].some((s) => s.includes(word));
const hasTag = (o: Entity, tag: string) => strs(o.fields.tags).includes(tag);

/** The texture words the `diet:textures` fact names, in list order. */
export function texturesFrom(text: string | null): string[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  return TEXTURE_WORDS.filter((w) => lower.includes(w));
}

interface Scored { option: Entity; score: number; why: string }

/**
 * Local calendar days since the last pick: last night's dinner is "yesterday" at today's lunch. Whole 24 hour blocks
 * used to be counted, so a dinner picked at 8 PM still read "picked today" at noon the next day.
 */
function daysSincePick(o: Entity, now: Date): number | null {
  const t = new Date(String(o.fields.last_picked ?? ""));
  if (!Number.isFinite(t.getTime())) return null;
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  // Rounded: a day across a daylight saving change is 23 or 25 hours.
  return Math.max(0, Math.round((day(now) - day(t)) / DAY_MS));
}

function score(o: Entity, doctor: boolean, now: Date): Scored {
  let s = 0;
  const why: string[] = [];
  if (hasTag(o, "protein")) { s += 2; why.push("protein"); }
  if (hasTag(o, "plant")) { s += doctor ? 3 : 1; why.push("plant"); }
  const days = daysSincePick(o, now);
  if (days === null) { s += 2; why.push("never picked"); }
  else if (days < RECENT_DAYS) { s -= 4; why.push(`picked ${days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`}`); }
  else { s += Math.min(days, 30) / 10; why.push(`not picked in ${days} days`); }
  if (doctor) {
    if (hasTag(o, "sweet-sauce")) { s -= 3; why.push("sweet sauce"); } else why.push("no sweet sauce");
    if (hasTag(o, "fried")) { s -= 2; why.push("fried"); }
    if (hasTag(o, "tomato")) { s -= 1; why.push("tomato"); }
  }
  const rating = typeof o.fields.rating === "number" ? o.fields.rating : 3;
  s += rating / 10;
  return { option: o, score: Math.round(s * 1000) / 1000, why: why.join(", ") };
}

export function pickFood(hub: Hub, body: PickRequest, now: Date = new Date()): PickResult {
  const meal = typeof body.meal === "string" ? body.meal : "";
  if (!MEALS.has(meal)) throw new StoreError(422, "meal must be lunch, dinner or snack");
  const mode = body.mode === undefined || body.mode === null ? undefined : String(body.mode);
  if (mode !== undefined && !MODES.has(mode)) throw new StoreError(422, "mode must be delivery, restaurant, grab or home");
  const budget = body.budget === undefined || body.budget === null ? undefined : Number(body.budget);
  if (budget !== undefined && (!Number.isFinite(budget) || budget < 0)) throw new StoreError(422, "budget must be a number");
  const exclude = new Set(Array.isArray(body.exclude) ? body.exclude.map(String) : []);

  const textures = texturesFrom(factValue(hub, "diet:textures"));
  const doctor = factValue(hub, "health:doctor_rules") !== null;
  const noCook = factValue(hub, "diet:no_cook") !== null;
  const used: string[] = ["avoid"];
  if (textures.length) used.push(`textures: ${textures.join(", ")}`);
  if (doctor) used.push("doctor rules");
  if (noCook && mode !== "home") used.push("no cook");
  if (mode) used.push(`mode ${mode}`);
  if (budget !== undefined) used.push(`budget ${budget}`);
  if (exclude.size) used.push(`exclude ${exclude.size}`);
  used.push(`recency ${RECENT_DAYS} days`);

  const all = hub.store.list({ kind: "food_option", limit: 10000 });
  const eligible = all.filter((o) => {
    if (o.fields.avoid === true || exclude.has(o.id)) return false;
    if (mode ? o.fields.kind !== mode : noCook && o.fields.kind === "home") return false;
    if (textures.some((w) => mentions(o, w))) return false;
    if (budget !== undefined && typeof o.fields.cost === "number" && o.fields.cost > budget) return false;
    return true;
  });
  if (!eligible.length) {
    const kinds = mode ? mode : noCook ? "delivery, restaurant or grab" : "any kind";
    const parts = [`Nothing eligible for ${meal}.`, `Add a food_option of kind ${kinds} without avoid`];
    if (textures.length) parts.push(`and without ${textures.join(", ")}`);
    if (budget !== undefined) parts.push(`costing ${budget} or less`);
    if (exclude.size) parts.push(`(${exclude.size} excluded)`);
    return { pick: null, why: parts.join(" ") + ".", runner_up: null, constraints_used: used };
  }
  const ranked = eligible.map((o) => score(o, doctor, now))
    .sort((a, b) => b.score - a.score || String(a.option.fields.name).localeCompare(String(b.option.fields.name)));
  return { pick: ranked[0].option, why: ranked[0].why, runner_up: ranked[1]?.option ?? null, constraints_used: used };
}

/** The user went with it: `last_picked` now, `times_picked` plus one. */
export function markPicked(hub: Hub, body: { id?: unknown }, now: Date = new Date()): Entity {
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) throw new StoreError(422, "id required");
  const o = hub.store.get(id);
  if (!o || o.kind !== "food_option" || o.deleted_at) throw new StoreError(404, "food option not found");
  const times = typeof o.fields.times_picked === "number" ? o.fields.times_picked : 0;
  return hub.store.patch(id, { last_picked: now.toISOString(), times_picked: times + 1 });
}
