import { parseRepeat } from "@everythingapp/shared";
import type { Entity } from "@everythingapp/shared";
import type { Hub } from "./hub.js";
import type { Store } from "./store.js";
import { StoreError } from "./store.js";
import { dayKey } from "./metrics.js";
import { linkedTask, syncLinkedTask } from "./reminders.js";

/**
 * Module 7, life admin: checklists (templates are copied, never ticked), the job pipeline with one linked
 * follow-up reminder per application, cover letters that may not invent employers, a deterministic game
 * picker, four stateless calculators with exact cent rounding, and subscription totals from watches.
 */

const DAY_MS = 24 * 3600_000;
const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();

// ---------- checklists ----------

interface Item { text: string; done_at?: string; note?: string }

function getKind(store: Store, id: string, kind: string, label: string): Entity {
  const e = store.get(id);
  if (!e || e.kind !== kind || e.deleted_at) throw new StoreError(404, `${label} not found`);
  return e;
}

const itemsOf = (c: Entity): Item[] => (Array.isArray(c.fields.items) ? (c.fields.items as Item[]) : []);

/** A fresh copy of a template: every `done_at` cleared, notes kept, `from_template` set. */
export function instantiateChecklist(store: Store, id: string, body: { title?: unknown } = {}, now: Date = new Date()): Entity {
  const t = getKind(store, id, "checklist", "checklist");
  if (t.fields.template !== true) throw new StoreError(422, "only a template can be instantiated");
  const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : `${String(t.fields.title)} ${dayKey(now)}`;
  const items = itemsOf(t).map((i) => (i.note ? { text: i.text, note: i.note } : { text: i.text }));
  return store.create("checklist", {
    title, kind: t.fields.kind ?? "generic", items, template: false, from_template: t.id,
    tags: Array.isArray(t.fields.tags) ? t.fields.tags : [],
  }, t.space);
}

/** Flip `done_at` on one item. Templates are never ticked. */
export function toggleChecklistItem(store: Store, id: string, body: { index?: unknown }, now: Date = new Date()): Entity {
  const c = getKind(store, id, "checklist", "checklist");
  if (c.fields.template === true) throw new StoreError(409, "templates are copied, never ticked; instantiate it first");
  const items = itemsOf(c);
  const index = Number(body.index);
  if (!Number.isInteger(index) || index < 0 || index >= items.length) throw new StoreError(422, `index must be an integer from 0 to ${items.length - 1}`);
  const next = items.map((it, i) => {
    if (i !== index) return it;
    const { done_at, ...rest } = it;
    return done_at ? rest : { ...rest, done_at: now.toISOString() };
  });
  return store.patch(id, { items: next });
}

// ---------- applications ----------

export const STAGES = ["saved", "applied", "screen", "interview", "offer", "rejected", "withdrawn", "accepted"] as const;
const CLOSED_STAGES = new Set(["rejected", "withdrawn", "accepted"]);
export const isActiveApplication = (a: Entity) => !CLOSED_STAGES.has(String(a.fields.stage));

export function applicationReminder(store: Store, app: Entity): Entity | null {
  return linkedTask(store, app);
}

/**
 * One task per open application reminding at `next_at`, `Follow up: <company> <role>`, friction `none`. Deleted (and
 * `reminder_id` cleared) when `next_at` goes away, the stage closes, or the application is deleted.
 */
export function syncApplicationReminder(store: Store, app: Entity): Entity | null {
  if (app.kind !== "application") return null;
  const at = typeof app.fields.next_at === "string" ? new Date(app.fields.next_at) : null;
  if (app.deleted_at || !at || Number.isNaN(at.getTime()) || !isActiveApplication(app)) {
    return syncLinkedTask(store, app, null, app.deleted_at ?? undefined);
  }
  const title = `Follow up: ${String(app.fields.company ?? "")} ${String(app.fields.role ?? "")}`.trim();
  return syncLinkedTask(store, app, { title, remind_at: at.toISOString(), friction: "none" });
}

export function installAdminHooks(hub: Hub): void {
  hub.store.afterWrite((entity) => {
    if (entity.kind === "application" && hub.modules.on("jobs")) syncApplicationReminder(hub.store, entity);
  });
}

export interface Board {
  stages: { stage: string; count: number; applications: Entity[] }[];
  total: number;
  active: number;
  follow_ups: { id: string; company: string; role: string; stage: string; next_step: string | null; next_at: string; overdue: boolean }[];
}

/** Every stage in pipeline order (empty ones included), soonest `next_at` first, then most recently touched. */
export function applicationBoard(store: Store, now: Date = new Date()): Board {
  const apps = store.list({ kind: "application", limit: 100000 });
  const nextAt = (a: Entity) => (typeof a.fields.next_at === "string" ? a.fields.next_at : "");
  const order = (a: Entity, b: Entity) => {
    const x = nextAt(a), y = nextAt(b);
    if (x && y && x !== y) return x.localeCompare(y);
    if (!!x !== !!y) return x ? -1 : 1;
    return b.updated_at.localeCompare(a.updated_at);
  };
  const stages = STAGES.map((stage) => {
    const applications = apps.filter((a) => a.fields.stage === stage).sort(order);
    return { stage, count: applications.length, applications };
  });
  const follow_ups = apps.filter((a) => isActiveApplication(a) && nextAt(a))
    .sort((a, b) => nextAt(a).localeCompare(nextAt(b)))
    .map((a) => ({
      id: a.id, company: String(a.fields.company), role: String(a.fields.role), stage: String(a.fields.stage),
      next_step: typeof a.fields.next_step === "string" ? a.fields.next_step : null, next_at: nextAt(a),
      overdue: new Date(nextAt(a)).getTime() < now.getTime(),
    }));
  return { stages, total: apps.length, active: apps.filter(isActiveApplication).length, follow_ups };
}

// ---------- cover letters ----------

/** Words that may follow "at" or "with" capitalized without naming an organization. */
const NOT_ORGS = new Set([
  "i", "a", "an", "the", "my", "our", "your", "their", "his", "her", "its", "this", "that", "these", "those", "me", "you", "us", "them",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
  "first", "least", "most", "best", "home", "work", "length", "scale", "all", "each", "every", "both", "no", "some", "any", "one", "two", "three",
  "regards", "sincerely", "thanks", "thank", "dear", "hello", "hi",
]);

/**
 * Capitalized names that follow "at " or "with " and appear nowhere in the allowed text. Deliberately narrow:
 * a phrase passes when any of its words (three letters or more) appears in the allowed text, so it only flags
 * names the prompt never mentioned.
 */
export function inventedOrganizations(draft: string, allowed: string): string[] {
  const corpus = allowed.toLowerCase();
  const out: string[] = [];
  const re = /\b(?:at|with)\s+((?:[A-Z][\w&.'’-]*)(?:\s+(?:[A-Z][\w&.'’-]*|&|of|and))*)/g;
  for (const m of draft.matchAll(re)) {
    const phrase = m[1].replace(/\s+(?:of|and|&)$/, "").replace(/[.'’,-]+$/, "");
    const words = phrase.split(/\s+/).filter((w) => /^[A-Z]/.test(w));
    if (!words.length || NOT_ORGS.has(words[0].toLowerCase())) continue;
    const significant = words.map((w) => w.toLowerCase().replace(/[.'’,-]+$/, "")).filter((w) => w.length >= 3 && !NOT_ORGS.has(w));
    if (!significant.length) continue;
    if (significant.some((w) => corpus.includes(w))) continue;
    if (!out.includes(phrase)) out.push(phrase);
  }
  return out;
}

const safeName = (s: unknown) => String(s ?? "").replace(/[\\/:*?"<>|\0#^[\]]+/g, " ").replace(/\s+/g, " ").trim() || "untitled";

export function coverLetterPath(app: Entity): string {
  return `Career/Cover letters/${safeName(app.fields.company)} - ${safeName(app.fields.role)}.md`;
}

export const COVER_LETTER_RULE = "Never invent employers, job titles, dates, degrees, certifications or skills. Use only what the facts below and the job posting say. When the facts do not cover something the posting asks for, leave it out rather than claim it.";

/** POST /applications/:id/cover-letter. */
export async function draftCoverLetter(hub: Hub, id: string, body: { job_text?: unknown; tone?: unknown; allow_cloud?: unknown }): Promise<{ note: Entity; backend: string }> {
  const app = getKind(hub.store, id, "application", "application");
  if (!hub.ai.available()) throw new StoreError(503, "no model");
  const jobText = typeof body.job_text === "string" ? body.job_text.trim().slice(0, 20000) : "";
  const tone = typeof body.tone === "string" && body.tone.trim() ? body.tone.trim().slice(0, 200) : "plain, direct and specific";
  const facts = hub.store.list({ kind: "fact", limit: 100000 })
    .filter((f) => f.space !== "work" && (f.fields.category === "identity" || f.fields.category === "history"))
    .sort((a, b) => String(a.fields.category).localeCompare(String(b.fields.category)) || String(a.fields.key).localeCompare(String(b.fields.key)));
  const styleRules = hub.store.list({ kind: "rule", limit: 100000 }).filter((r) => r.fields.active !== false && (r.fields.enforce === "both" || r.fields.enforce === "filter"));
  const company = String(app.fields.company);
  const role = String(app.fields.role);
  const system = (cloud: boolean) => {
    const usable = facts.filter((f) => !(cloud && f.fields.private === true));
    return [
      `Write a cover letter in the user's own voice for the ${role} role at ${company}. Output only the letter, no preamble. Tone: ${tone}. Under 350 words.`,
      `Hard rule: ${COVER_LETTER_RULE}`,
      styleRules.length ? "Style rules:\n" + styleRules.map((r) => `- ${r.fields.text}`).join("\n") : "",
      "Facts about the user (identity and history only):\n" + (usable.length ? usable.map((f) => `- ${f.fields.key}: ${f.fields.value}`).join("\n") : "- none recorded"),
    ].filter(Boolean).join("\n\n");
  };
  const user = [`Company: ${company}`, `Role: ${role}`, jobText ? `Job posting:\n${jobText}` : "No job posting was given."].join("\n\n");
  const out = await hub.ai.draft(`cover-letter:${id}`, system, user, { allow_cloud: body.allow_cloud === true });
  if (!out) throw new StoreError(503, "no model");
  const allowed = [company, role, jobText, ...facts.map((f) => `${f.fields.key} ${f.fields.value}`)].join("\n");
  const invented = inventedOrganizations(out.text, allowed);
  if (invented.length) throw new StoreError(422, "draft names employers that are not in the facts or the job text", { invented, backend: out.backend });
  const path = coverLetterPath(app);
  hub.vault.writeOwn(path, { title: `Cover letter: ${company} - ${role}`, tags: ["career", "cover-letter"], body: `${out.text.trim()}\n` });
  const note = hub.store.list({ kind: "note", where: { path } })[0];
  if (!note) throw new StoreError(500, "cover letter note was not written");
  if (app.fields.letter_note_id !== note.id) hub.store.patch(app.id, { letter_note_id: note.id });
  return { note, backend: out.backend };
}

// ---------- games ----------

export interface GamePick { pick: Entity | null; why: string; runner_up: Entity | null; considered: number }

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

function daysAgo(iso: unknown, now: Date): number | null {
  const t = new Date(String(iso ?? "")).getTime();
  return Number.isFinite(t) ? Math.max(0, Math.floor((now.getTime() - t) / DAY_MS)) : null;
}

/**
 * Only games every listed player owns, with the player count inside min and max, `coop` matching when given,
 * and `session_hours` within `hours` when given (unknown lengths pass). Never played first, then least recently
 * played, then higher rating, then name.
 */
export function pickGame(store: Store, body: { players?: unknown; hours?: unknown; coop?: unknown; exclude?: unknown }, now: Date = new Date()): GamePick {
  if (!Array.isArray(body.players) || !body.players.length || body.players.some((p) => typeof p !== "string" || !p.trim())) throw new StoreError(422, "players must be a non-empty array of names");
  const players = (body.players as string[]).map((p) => p.trim());
  const hours = body.hours === undefined || body.hours === null ? undefined : Number(body.hours);
  if (hours !== undefined && (!Number.isFinite(hours) || hours <= 0)) throw new StoreError(422, "hours must be a positive number");
  if (body.coop !== undefined && body.coop !== null && typeof body.coop !== "boolean") throw new StoreError(422, "coop must be a boolean");
  const coop = typeof body.coop === "boolean" ? body.coop : undefined;
  const exclude = new Set(Array.isArray(body.exclude) ? body.exclude.map(String) : []);
  const n = players.length;
  const eligible = store.list({ kind: "game", limit: 100000 }).filter((g) => {
    if (exclude.has(g.id)) return false;
    const owners = new Set((Array.isArray(g.fields.owned_by) ? g.fields.owned_by : []).map(norm));
    if (!players.every((p) => owners.has(norm(p)))) return false;
    if (n < num(g.fields.min_players, 1) || n > num(g.fields.max_players, 4)) return false;
    if (coop !== undefined && (g.fields.coop !== false) !== coop) return false;
    if (hours !== undefined && typeof g.fields.session_hours === "number" && g.fields.session_hours > hours) return false;
    return true;
  });
  const lastT = (g: Entity) => { const t = new Date(String(g.fields.last_played ?? "")).getTime(); return Number.isFinite(t) ? t : -Infinity; };
  const ranked = eligible.sort((a, b) => lastT(a) - lastT(b) || num(b.fields.rating, 0) - num(a.fields.rating, 0) || String(a.fields.name).localeCompare(String(b.fields.name)));
  if (!ranked.length) {
    const parts = [`No game fits ${n} player${n === 1 ? "" : "s"} owned by ${players.join(", ")}`];
    if (coop !== undefined) parts.push(coop ? "coop" : "competitive");
    if (hours !== undefined) parts.push(`${hours} h or shorter`);
    if (exclude.size) parts.push(`${exclude.size} excluded`);
    return { pick: null, why: parts.join(", ") + ". Add owners to a game's owned_by or relax the filters.", runner_up: null, considered: 0 };
  }
  const g = ranked[0];
  const why: string[] = [`owned by ${players.join(", ")}`, `fits ${n} (${num(g.fields.min_players, 1)} to ${num(g.fields.max_players, 4)})`, g.fields.coop === false ? "competitive" : "coop"];
  if (typeof g.fields.session_hours === "number") why.push(`about ${g.fields.session_hours} h`);
  const d = daysAgo(g.fields.last_played, now);
  why.push(d === null ? "never played" : d === 0 ? "played today" : `last played ${d} day${d === 1 ? "" : "s"} ago`);
  if (typeof g.fields.rating === "number") why.push(`rated ${g.fields.rating}`);
  const w = why.join(", ");
  return { pick: g, why: w.charAt(0).toUpperCase() + w.slice(1), runner_up: ranked[1] ?? null, considered: ranked.length };
}

export function markPlayed(store: Store, id: string, body: { at?: unknown } = {}, now: Date = new Date()): Entity {
  getKind(store, id, "game", "game");
  const at = typeof body.at === "string" && !Number.isNaN(new Date(body.at).getTime()) ? new Date(body.at).toISOString() : now.toISOString();
  return store.patch(id, { last_played: at });
}

// ---------- calculators ----------

/** Round half away from zero to whole cents, after trimming float noise. */
export function toCents(x: number): number {
  const v = Number((x * 100).toFixed(6));
  return Math.sign(v) * Math.round(Math.abs(v));
}
const dollars = (cents: number) => cents / 100;
/** Round a non-negative cent amount to a whole cent, after trimming float noise. */
const roundC = (x: number) => Math.round(Number(x.toFixed(6)));

function money(v: unknown, name: string, opts: { min?: number; positive?: boolean } = {}): number {
  const x = typeof v === "string" && v.trim() ? Number(v) : v;
  if (typeof x !== "number" || !Number.isFinite(x)) throw new StoreError(422, `${name} must be a number`);
  if (opts.positive && x <= 0) throw new StoreError(422, `${name} must be above 0`);
  if (opts.min !== undefined && x < opts.min) throw new StoreError(422, `${name} must be ${opts.min} or more`);
  return x;
}

/** Split `total` cents by integer weights: floor shares, the leftover cents to the first person. */
export function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  const base = weights.map((w) => Math.floor((total * w) / sum));
  base[0] += total - base.reduce((a, b) => a + b, 0);
  return base;
}

/** Tax and tip are both percentages of the subtotal (tip before tax). */
export function calcSplit(body: { subtotal?: unknown; tax_pct?: unknown; tip_pct?: unknown; people?: unknown; shares?: unknown }) {
  const subtotal = toCents(money(body.subtotal, "subtotal", { min: 0 }));
  const taxPct = body.tax_pct === undefined ? 0 : money(body.tax_pct, "tax_pct", { min: 0 });
  const tipPct = body.tip_pct === undefined ? 0 : money(body.tip_pct, "tip_pct", { min: 0 });
  const people = Number(body.people);
  if (!Number.isInteger(people) || people < 1 || people > 1000) throw new StoreError(422, "people must be an integer from 1 to 1000");
  let weights = Array.from({ length: people }, () => 1);
  if (body.shares !== undefined && body.shares !== null) {
    if (!Array.isArray(body.shares) || body.shares.length !== people || body.shares.some((s) => typeof s !== "number" || !Number.isFinite(s) || s < 0)) throw new StoreError(422, "shares must be one non-negative number per person");
    weights = body.shares as number[];
    if (!weights.some((w) => w > 0)) throw new StoreError(422, "shares must not all be 0");
    // Scale fractional shares to integers so the allocation stays exact.
    const scale = 10 ** Math.min(6, Math.max(0, ...weights.map((w) => (String(w).split(".")[1] ?? "").length)));
    weights = weights.map((w) => Math.round(w * scale));
  }
  const tax = toCents((subtotal * taxPct) / 10000);
  const tip = toCents((subtotal * tipPct) / 10000);
  const total = subtotal + tax + tip;
  const per = allocate(total, weights);
  return {
    subtotal: dollars(subtotal), tax: dollars(tax), tip: dollars(tip), total: dollars(total), people,
    per_person: per.map(dollars), remainder_cents: per[0] - Math.floor((total * weights[0]) / weights.reduce((a, b) => a + b, 0)),
  };
}

export interface AmortRow { month: number; payment: number; interest: number; principal: number; balance: number }
const MAX_MONTHS = 1200;

/** Month by month in cents: interest is rounded each month, the last payment is only what is left. */
function amortize(balance: number, rate: number, payment: number): { rows: AmortRow[]; months: number | null; interest: number; paid: number } {
  const rows: AmortRow[] = [];
  let bal = balance, interestSum = 0, paid = 0, m = 0;
  while (bal > 0 && m < MAX_MONTHS) {
    m++;
    const interest = roundC(bal * rate);
    if (payment <= interest) {
      // Never pays off: show the growing balance for the preview and stop.
      for (let k = m; rows.length < 12; k++) { const i = roundC(bal * rate); bal += i - payment; rows.push({ month: k, payment: dollars(payment), interest: dollars(i), principal: dollars(payment - i), balance: dollars(bal) }); }
      return { rows, months: null, interest: interestSum, paid };
    }
    const pay = Math.min(payment, bal + interest);
    bal = bal + interest - pay;
    interestSum += interest;
    paid += pay;
    if (rows.length < 12) rows.push({ month: m, payment: dollars(pay), interest: dollars(interest), principal: dollars(pay - interest), balance: dollars(bal) });
  }
  return { rows, months: bal > 0 ? null : m, interest: interestSum, paid };
}

/** Given `payment`: months and total interest, or "never". Given `months`: the payment, rounded up to the cent. Payment wins when both are sent. */
export function calcPayoff(body: { balance?: unknown; apr_pct?: unknown; payment?: unknown; months?: unknown }) {
  const balance = toCents(money(body.balance, "balance", { positive: true }));
  const apr = money(body.apr_pct, "apr_pct", { min: 0 });
  const rate = apr / 100 / 12;
  const hasPayment = body.payment !== undefined && body.payment !== null;
  const hasMonths = body.months !== undefined && body.months !== null;
  if (!hasPayment && !hasMonths) throw new StoreError(422, "give payment or months");
  if (hasPayment) {
    const payment = toCents(money(body.payment, "payment", { positive: true }));
    const r = amortize(balance, rate, payment);
    const firstInterest = roundC(balance * rate);
    if (r.months === null) {
      return { mode: "payment", balance: dollars(balance), apr_pct: apr, payment: dollars(payment), months: "never" as const, total_interest: null, total_paid: null,
        why: `The first month's interest is ${dollars(firstInterest).toFixed(2)}, so a payment of ${dollars(payment).toFixed(2)} never reduces the balance.`, schedule: r.rows };
    }
    return { mode: "payment", balance: dollars(balance), apr_pct: apr, payment: dollars(payment), months: r.months, total_interest: dollars(r.interest), total_paid: dollars(r.paid), schedule: r.rows };
  }
  const months = Number(body.months);
  if (!Number.isInteger(months) || months < 1 || months > MAX_MONTHS) throw new StoreError(422, `months must be an integer from 1 to ${MAX_MONTHS}`);
  const exact = rate === 0 ? balance / months : (balance * rate) / (1 - (1 + rate) ** -months);
  let payment = Math.ceil(Number(exact.toFixed(6)));
  let r = amortize(balance, rate, payment);
  while (r.months === null || r.months > months) { payment++; r = amortize(balance, rate, payment); }
  return { mode: "months", balance: dollars(balance), apr_pct: apr, months, payment: dollars(payment), payoff_months: r.months, total_interest: dollars(r.interest), total_paid: dollars(r.paid), schedule: r.rows };
}

/** Unit aliases to a base unit per dimension: ounces for mass, fluid ounces for volume, each for counts. */
const UNITS: Record<string, { base: string; factor: number }> = {
  oz: { base: "oz", factor: 1 }, ounce: { base: "oz", factor: 1 }, ounces: { base: "oz", factor: 1 },
  lb: { base: "oz", factor: 16 }, lbs: { base: "oz", factor: 16 }, pound: { base: "oz", factor: 16 }, pounds: { base: "oz", factor: 16 },
  g: { base: "oz", factor: 1 / 28.349523125 }, gram: { base: "oz", factor: 1 / 28.349523125 }, grams: { base: "oz", factor: 1 / 28.349523125 },
  kg: { base: "oz", factor: 1000 / 28.349523125 }, mg: { base: "oz", factor: 0.001 / 28.349523125 },
  "fl oz": { base: "fl oz", factor: 1 }, floz: { base: "fl oz", factor: 1 }, "fl. oz": { base: "fl oz", factor: 1 },
  ml: { base: "fl oz", factor: 1 / 29.5735295625 }, l: { base: "fl oz", factor: 1000 / 29.5735295625 }, liter: { base: "fl oz", factor: 1000 / 29.5735295625 }, litre: { base: "fl oz", factor: 1000 / 29.5735295625 },
  gal: { base: "fl oz", factor: 128 }, gallon: { base: "fl oz", factor: 128 }, qt: { base: "fl oz", factor: 32 }, quart: { base: "fl oz", factor: 32 }, pt: { base: "fl oz", factor: 16 }, pint: { base: "fl oz", factor: 16 }, cup: { base: "fl oz", factor: 8 },
  each: { base: "each", factor: 1 }, ea: { base: "each", factor: 1 }, ct: { base: "each", factor: 1 }, count: { base: "each", factor: 1 }, pc: { base: "each", factor: 1 }, pcs: { base: "each", factor: 1 }, piece: { base: "each", factor: 1 }, pieces: { base: "each", factor: 1 },
};

export function calcUnit(body: { items?: unknown }) {
  if (!Array.isArray(body.items) || !body.items.length) throw new StoreError(422, "items must be a non-empty array");
  const rows = (body.items as Record<string, unknown>[]).map((it, i) => {
    if (!it || typeof it !== "object") throw new StoreError(422, `items[${i}] must be an object`);
    const price = money(it.price, `items[${i}].price`, { min: 0 });
    const qty = money(it.qty, `items[${i}].qty`, { positive: true });
    const unit = norm(it.unit || "each").replace(/\s+/g, " ");
    const known = UNITS[unit] ?? UNITS[unit.replace(/s$/, "")];
    const base = known?.base ?? unit;
    const baseQty = qty * (known?.factor ?? 1);
    return { name: String(it.name ?? `item ${i + 1}`), price, qty, unit, base, base_qty: Math.round(baseQty * 1000) / 1000, raw: price / baseQty };
  });
  const bases = [...new Set(rows.map((r) => r.base))];
  if (bases.length > 1) throw new StoreError(422, "items use units that cannot be compared", { units: bases });
  rows.sort((a, b) => a.raw - b.raw || a.name.localeCompare(b.name));
  const items = rows.map(({ raw, base: _b, ...r }) => ({ ...r, per_unit: Math.round(Number((raw * 10000).toFixed(6))) / 10000 }));
  const top = rows[0], last = rows[rows.length - 1];
  return {
    unit: bases[0], items, cheapest: items[0].name,
    savings_vs_priciest_pct: rows.length > 1 && last.raw > 0 ? Math.round(((last.raw - top.raw) / last.raw) * 10000) / 100 : 0,
  };
}

// ---------- subscriptions ----------

const DAYS_PER_YEAR = 365.25;

/** Periods per year for a repeat rule in days, weeks, months or years; null for anything else. */
export function perYear(repeat: string): number | null {
  const r = parseRepeat(repeat);
  if (!r || r.n <= 0) return null;
  switch (r.unit) {
    case "days": return DAYS_PER_YEAR / r.n;
    case "weeks": return DAYS_PER_YEAR / 7 / r.n;
    case "months": return 12 / r.n;
    case "years": return 1 / r.n;
    default: return null;
  }
}

export function subscriptions(store: Store) {
  const items: { id: string; title: string; cost: number; repeat: string; monthly: number; yearly: number; due: string; url: string | null }[] = [];
  const skipped: { id: string; title: string; reason: string }[] = [];
  for (const w of store.list({ kind: "watch", limit: 100000 })) {
    if (w.fields.category !== "subscription") continue;
    const title = String(w.fields.title ?? "");
    if (typeof w.fields.cost !== "number") { skipped.push({ id: w.id, title, reason: "no cost" }); continue; }
    const repeat = typeof w.fields.repeat === "string" ? w.fields.repeat : "";
    const per = repeat ? perYear(repeat) : null;
    if (per === null) { skipped.push({ id: w.id, title, reason: repeat ? `repeat ${repeat} is not in days, weeks, months or years` : "no repeat" }); continue; }
    const yearly = w.fields.cost * per;
    items.push({ id: w.id, title, cost: w.fields.cost, repeat, monthly: dollars(toCents(yearly / 12)), yearly: dollars(toCents(yearly)), due: String(w.fields.due ?? ""), url: typeof w.fields.url === "string" ? w.fields.url : null });
  }
  items.sort((a, b) => b.monthly - a.monthly || a.title.localeCompare(b.title));
  const monthly_total = dollars(items.reduce((n, i) => n + toCents(i.monthly), 0));
  const yearly_total = dollars(items.reduce((n, i) => n + toCents(i.yearly), 0));
  return { items, monthly_total, yearly_total, skipped };
}

// ---------- seed and status ----------

export const US_STATES = [
  "Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut", "Delaware", "Florida", "Georgia",
  "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky", "Louisiana", "Maine", "Maryland",
  "Massachusetts", "Michigan", "Minnesota", "Mississippi", "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire", "New Jersey",
  "New Mexico", "New York", "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon", "Pennsylvania", "Rhode Island", "South Carolina",
  "South Dakota", "Tennessee", "Texas", "Utah", "Vermont", "Virginia", "Washington", "West Virginia", "Wisconsin", "Wyoming",
];

/** "States visited", "US states I've visited", "U.S. states visited", "United States visited". */
const STATES_NOTE_TITLE = /^\s*(?:U\.?\s?S\.?\s+|United\s+)?States\s+(?:I['’‘`]?ve\s+)?Visited\s*$/i;

/** The state a line names, matched at the start of the line text (longest name first, so West Virginia beats Virginia). */
function stateIn(text: string): string | null {
  const t = text.replace(/[*_~`]+/g, "").replace(/^\[\[|\]\]$/g, "").trim().toLowerCase();
  const byLength = [...US_STATES].sort((a, b) => b.length - a.length);
  for (const s of byLength) {
    const l = s.toLowerCase();
    if (t === l || (t.startsWith(l) && !/[a-z]/.test(t.charAt(l.length)))) return s;
  }
  return null;
}

/** States a note body lists as `- [x] Name`, as a plain list line (`- Name`, `* Name`, `1. Name`) or as a bare line that is exactly a state. Unchecked boxes do not count. */
export function statesFromNote(body: string): string[] {
  const out = new Set<string>();
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    let m = /^[-*+]\s+\[([ xX])\]\s+(.+)$/.exec(line);
    if (m) { if (m[1].toLowerCase() === "x") { const s = stateIn(m[2]); if (s) out.add(s); } continue; }
    m = /^(?:[-*+]|\d+[.)])\s+(.+)$/.exec(line);
    const s = stateIn(m ? m[1] : line);
    if (s && (m || line.replace(/[*_~`]+/g, "").trim().toLowerCase() === s.toLowerCase())) out.add(s);
  }
  return US_STATES.filter((s) => out.has(s));
}

export function findStatesNote(store: Store): Entity | null {
  return store.list({ kind: "note", limit: 100000 }).find((n) => {
    const title = String(n.fields.title ?? "");
    const base = String(n.fields.path ?? "").split("/").pop()?.replace(/\.md$/, "") ?? "";
    return STATES_NOTE_TITLE.test(title) || STATES_NOTE_TITLE.test(base);
  }) ?? null;
}

/**
 * Checklists from deploy/seed/checklists.json, matched by title (deleted ones included) and created only when
 * missing. A `states` list created here gets every state the "States visited" note lists marked done.
 */
export function seedChecklists(store: Store, rows: any[], now: Date = new Date()): { created: number; kept: number; states_marked: number } {
  const out = { created: 0, kept: 0, states_marked: 0 };
  const existing = store.list({ kind: "checklist", includeDeleted: true });
  for (const raw of rows) {
    if (existing.some((c) => norm(c.fields.title) === norm(raw.title))) { out.kept++; continue; }
    let items: Item[] = (raw.items as (string | Item)[]).map((i) => (typeof i === "string" ? { text: i } : i));
    if (raw.kind === "states") {
      const note = findStatesNote(store);
      const visited = new Set(note ? statesFromNote(String(note.fields.body ?? "")) : []);
      const at = now.toISOString();
      items = items.map((i) => (visited.has(i.text) ? { ...i, done_at: at } : i));
      out.states_marked = items.filter((i) => i.done_at).length;
    }
    store.create("checklist", { template: false, tags: [], ...raw, items });
    out.created++;
  }
  return out;
}

export function adminStatus(store: Store): { checklists_open: number; applications_active: number; games: number } {
  const checklists_open = store.list({ kind: "checklist", limit: 100000 })
    .filter((c) => c.fields.template !== true && c.fields.archived !== true && itemsOf(c).some((i) => !i.done_at)).length;
  return {
    checklists_open,
    applications_active: store.list({ kind: "application", limit: 100000 }).filter(isActiveApplication).length,
    games: store.list({ kind: "game", limit: 100000 }).length,
  };
}
