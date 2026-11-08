/**
 * Module 7 calculators. The same math the hub runs behind /calc/*, used when the hub is unreachable.
 * Money is worked in integer cents; percentages round half up to the cent.
 */

const sum = (a: number[]) => a.reduce((n, x) => n + x, 0);
/** Dollars to cents, half away from zero after trimming float noise (the hub's toCents). */
const cents = (n: number) => {
  const v = Number((n * 100).toFixed(6));
  return Math.sign(v) * Math.round(Math.abs(v));
};
/** A non-negative cent amount rounded to a whole cent after trimming float noise (the hub's roundC). */
const roundC = (x: number) => Math.round(Number(x.toFixed(6)));
/** pct percent of an amount in cents, rounded half up to the cent. */
const pctOf = (c: number, pct: number) => cents((c * pct) / 10000);
const round = (n: number, places: number) => {
  const f = 10 ** places;
  return Math.round(n * f + (n >= 0 ? 1e-9 : -1e-9)) / f;
};

export interface SplitInput {
  subtotal: number;
  tax_pct?: number;
  tip_pct?: number;
  people: number;
  /** Weights, one per person (for example what each ordered). Equal when absent. */
  shares?: number[];
}
export interface SplitResult {
  subtotal: number;
  tax: number;
  tip: number;
  total: number;
  per_person: number[];
  /** Cents the first person carries beyond their exact share. */
  remainder_cents?: number;
}

/** Tax and tip are both taken on the pre-tax subtotal. The cents left over after splitting go to the first person. */
export function split(i: SplitInput): SplitResult {
  const people = Math.floor(i.people);
  if (!(people >= 1)) throw new Error("people must be at least 1");
  if (!(i.subtotal >= 0)) throw new Error("subtotal must be 0 or more");
  const sub = cents(i.subtotal);
  const tax = pctOf(sub, i.tax_pct ?? 0);
  const tip = pctOf(sub, i.tip_pct ?? 0);
  const total = sub + tax + tip;
  const shares = i.shares?.length ? i.shares : null;
  if (shares && (shares.length !== people || shares.some((x) => !(x >= 0)) || sum(shares) <= 0)) throw new Error("shares need one weight per person");
  const w = shares ?? Array.from({ length: people }, () => 1);
  // Fractional weights are scaled to integers so the allocation stays exact, as the hub does.
  const scale = 10 ** Math.min(6, Math.max(0, ...w.map((x) => (String(x).split(".")[1] ?? "").length)));
  const iw = w.map((x) => Math.round(x * scale));
  const W = sum(iw);
  const parts = iw.map((x) => Math.floor((total * x) / W));
  const first = parts[0];
  parts[0] += total - sum(parts);
  return { subtotal: sub / 100, tax: tax / 100, tip: tip / 100, total: total / 100, per_person: parts.map((c) => c / 100), remainder_cents: parts[0] - first };
}

export interface PayoffInput {
  balance: number;
  apr_pct: number;
  payment?: number;
  months?: number;
}
export interface PayoffRow {
  month: number;
  payment: number;
  interest: number;
  principal: number;
  balance: number;
}
export interface PayoffResult {
  months: number | "never";
  payment: number;
  total_interest: number | null;
  preview: PayoffRow[];
}

const MAX_MONTHS = 1200;

/** Month by month in cents: interest rounds each month, the last payment is only what is left. Never: 12 rows of a growing balance. */
function amortize(bal0: number, rate: number, pay: number): { rows: PayoffRow[]; months: number | null; interest: number } {
  const rows: PayoffRow[] = [];
  let bal = bal0;
  let m = 0;
  let interest = 0;
  while (bal > 0 && m < MAX_MONTHS) {
    m++;
    const int = roundC(bal * rate);
    if (pay <= int) {
      for (let k = m; rows.length < 12; k++) {
        const i = roundC(bal * rate);
        bal += i - pay;
        rows.push({ month: k, payment: pay / 100, interest: i / 100, principal: (pay - i) / 100, balance: bal / 100 });
      }
      return { rows, months: null, interest };
    }
    const p = Math.min(pay, bal + int);
    bal = bal + int - p;
    interest += int;
    if (rows.length < 12) rows.push({ month: m, payment: p / 100, interest: int / 100, principal: (p - int) / 100, balance: bal / 100 });
  }
  return { rows, months: bal > 0 ? null : m, interest };
}

/**
 * Given a payment: months to payoff and total interest, or "never" when the payment does not cover the interest.
 * Given months: the payment, rounded up to the cent (and raised a cent at a time until it pays off in time). Payment wins when
 * both are given. Interest accrues monthly at apr / 12 and rounds to the cent. The preview is the first 12 months. Same as the hub.
 */
export function payoff(i: PayoffInput): PayoffResult {
  if (!(i.balance > 0)) throw new Error("balance must be more than 0");
  if (!(i.apr_pct >= 0)) throw new Error("APR must be 0 or more");
  const bal0 = cents(i.balance);
  const rate = i.apr_pct / 100 / 12;
  if (i.payment != null && i.payment > 0) {
    const pay = cents(i.payment);
    const r = amortize(bal0, rate, pay);
    if (r.months === null) return { months: "never", payment: pay / 100, total_interest: null, preview: r.rows };
    return { months: r.months, payment: pay / 100, total_interest: r.interest / 100, preview: r.rows };
  }
  if (!(i.months != null && Number.isInteger(i.months) && i.months >= 1 && i.months <= MAX_MONTHS)) throw new Error("give a payment or a whole number of months");
  const n = i.months;
  const exact = rate === 0 ? bal0 / n : (bal0 * rate) / (1 - (1 + rate) ** -n);
  let pay = Math.ceil(Number(exact.toFixed(6)));
  let r = amortize(bal0, rate, pay);
  while (r.months === null || r.months > n) r = amortize(bal0, rate, ++pay);
  return { months: r.months, payment: pay / 100, total_interest: r.interest / 100, preview: r.rows };
}

export interface UnitItem {
  name: string;
  price: number;
  qty: number;
  unit: string;
}
export interface UnitRow extends UnitItem {
  /** Price per base unit (oz for mass, fl oz for volume, each for counts, else the unit as typed). */
  per_unit: number;
  base: string;
}

const OZ_G = 28.349523125;
const FLOZ_ML = 29.5735295625;
const UNITS: Record<string, [string, number]> = {
  oz: ["oz", 1], ounce: ["oz", 1], ounces: ["oz", 1], lb: ["oz", 16], lbs: ["oz", 16], pound: ["oz", 16], pounds: ["oz", 16],
  g: ["oz", 1 / OZ_G], gram: ["oz", 1 / OZ_G], grams: ["oz", 1 / OZ_G], kg: ["oz", 1000 / OZ_G], mg: ["oz", 0.001 / OZ_G],
  "fl oz": ["fl oz", 1], floz: ["fl oz", 1], "fl. oz": ["fl oz", 1], ml: ["fl oz", 1 / FLOZ_ML], l: ["fl oz", 1000 / FLOZ_ML], liter: ["fl oz", 1000 / FLOZ_ML], litre: ["fl oz", 1000 / FLOZ_ML],
  gal: ["fl oz", 128], gallon: ["fl oz", 128], qt: ["fl oz", 32], quart: ["fl oz", 32], pt: ["fl oz", 16], pint: ["fl oz", 16], cup: ["fl oz", 8],
  each: ["each", 1], ea: ["each", 1], ct: ["each", 1], count: ["each", 1], pc: ["each", 1], pcs: ["each", 1], piece: ["each", 1], pieces: ["each", 1],
};

/** Price per base unit, cheapest first, converting lb, g, kg, ml, l, gal and the like as the hub does. Mixed dimensions are an error. */
export function unitPrices(items: UnitItem[]): UnitRow[] {
  const rows = items
    .filter((x) => x.qty > 0 && x.price >= 0)
    .map((x) => {
      const unit = (x.unit || "each").trim().toLowerCase().replace(/\s+/g, " ");
      const [base, factor] = UNITS[unit] ?? UNITS[unit.replace(/s$/, "")] ?? [unit, 1];
      const raw = x.price / (x.qty * factor);
      return { ...x, unit, base, raw, per_unit: Math.round(Number((raw * 10000).toFixed(6))) / 10000 };
    });
  if (new Set(rows.map((r) => r.base)).size > 1) throw new Error("items use units that cannot be compared");
  return rows.sort((a, b) => a.raw - b.raw || a.name.localeCompare(b.name)).map(({ raw: _raw, ...r }) => (void _raw, r));
}

/** Periods per year for "every N days|weeks|months|years"; null otherwise. */
function perYear(repeat?: string): number | null {
  const m = /^every (\d+) (days|weeks|months|years)/.exec(repeat ?? "");
  const n = m ? Number(m[1]) : 0;
  if (!m || n <= 0) return null;
  return m[2] === "days" ? 365.25 / n : m[2] === "weeks" ? 365.25 / 7 / n : m[2] === "months" ? 12 / n : 1 / n;
}

/** Monthly equivalent of a cost repeating like "every 1 years"; null when the repeat is missing or not understood. */
export function monthlyOf(cost: number, repeat?: string): number | null {
  const per = perYear(repeat);
  return per === null ? null : cents((cost * per) / 12) / 100;
}

export interface SubRow {
  id?: string;
  title: string;
  cost: number;
  repeat: string;
  monthly: number;
  yearly: number;
}
export interface SubsResult {
  items: SubRow[];
  monthly_total: number;
  yearly_total: number;
  skipped: Array<{ id?: string; title: string; reason: string }>;
}

export function subscriptions(watches: Array<{ id?: string; fields: Record<string, unknown> }>): SubsResult {
  const items: SubRow[] = [];
  const skipped: SubsResult["skipped"] = [];
  for (const w of watches) {
    const f = w.fields;
    if (f.category !== "subscription") continue;
    const title = String(f.title ?? "");
    if (typeof f.cost !== "number") {
      skipped.push({ id: w.id, title, reason: "no cost" });
      continue;
    }
    const repeat = typeof f.repeat === "string" ? f.repeat : "";
    const per = perYear(repeat);
    if (per === null) {
      skipped.push({ id: w.id, title, reason: repeat ? `repeat ${repeat} is not in days, weeks, months or years` : "no repeat" });
      continue;
    }
    const yearly = f.cost * per;
    items.push({ id: w.id, title, cost: f.cost, repeat, monthly: cents(yearly / 12) / 100, yearly: cents(yearly) / 100 });
  }
  items.sort((a, b) => b.monthly - a.monthly || a.title.localeCompare(b.title));
  return { items, monthly_total: sum(items.map((x) => cents(x.monthly))) / 100, yearly_total: sum(items.map((x) => cents(x.yearly))) / 100, skipped };
}

// ---------- take-home pay ----------
// Tax year 2026, the hub's figures (hub/src/takehome.ts has the sources): IRS Rev. Proc. 2025-32 brackets and standard
// deductions, SSA wage base $184,500, IRS Publication 15 rates. Year figures first; per paycheck is the year spread evenly.

export const TAX_YEAR = 2026;
export const FREQUENCIES = { weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12 } as const;
export type Frequency = keyof typeof FREQUENCIES;
export type Filing = "single" | "married" | "head";
const STANDARD_DEDUCTION: Record<Filing, number> = { single: 16100, married: 32200, head: 24150 };
const BRACKETS: Record<Filing, Array<[number, number]>> = {
  married: [[24800, 0.1], [100800, 0.12], [211400, 0.22], [403550, 0.24], [512450, 0.32], [768700, 0.35], [Infinity, 0.37]],
  head: [[17700, 0.1], [67450, 0.12], [105700, 0.22], [201750, 0.24], [256200, 0.32], [640600, 0.35], [Infinity, 0.37]],
  single: [[12400, 0.1], [50400, 0.12], [105700, 0.22], [201775, 0.24], [256225, 0.32], [640600, 0.35], [Infinity, 0.37]],
};
const SS_BASE = 184500_00;
const ADDL_OVER = 200000_00;
const SUPP_TOP = 1000000_00;

export interface TakeHomeInput {
  salary: number;
  bonus?: number;
  frequency: Frequency;
  filing: Filing;
  /** Percent of each paycheck's gross; wins over k401_amount. */
  k401_pct?: number;
  /** Per paycheck. */
  k401_amount?: number;
  /** Health and HSA per paycheck (a cafeteria plan: off Social Security and Medicare too). */
  health?: number;
  state_pct?: number;
}
export interface PayLines {
  gross: number;
  federal: number;
  social_security: number;
  medicare: number;
  additional_medicare: number;
  state: number;
  k401: number;
  health: number;
  pretax: number;
  net: number;
}
export interface BonusLines {
  gross: number;
  federal: number;
  federal_rate: number;
  social_security: number;
  medicare: number;
  additional_medicare: number;
  state: number;
  net: number;
}
export interface TakeHomeResult {
  tax_year: number;
  periods: number;
  per_paycheck: PayLines;
  per_year: PayLines;
  bonus: BonusLines | null;
  year_net_with_bonus: number;
  notes: string[];
}

/** Tax in cents on taxable income in cents. */
function bracketTax(taxable: number, filing: Filing): number {
  let tax = 0;
  let low = 0;
  for (const [top, rate] of BRACKETS[filing]) {
    if (taxable <= low) break;
    tax += (Math.min(taxable, top * 100) - low) * rate;
    low = top * 100;
  }
  return roundC(tax);
}

/** The hub's /calc/takehome, to the cent. */
export function takeHome(i: TakeHomeInput): TakeHomeResult {
  if (!(i.salary > 0)) throw new Error("salary must be above 0");
  const P = FREQUENCIES[i.frequency];
  if (!P) throw new Error("pick how often you are paid");
  const salary = cents(i.salary);
  const bonus = i.bonus && i.bonus > 0 ? cents(i.bonus) : 0;
  const statePct = i.state_pct ?? 0;
  if (!(statePct >= 0 && statePct <= 20)) throw new Error("state tax must be 0 to 20 percent");
  const health = i.health && i.health > 0 ? cents(i.health) * P : 0;
  let k401 = 0;
  if (i.k401_pct != null) {
    if (!(i.k401_pct >= 0 && i.k401_pct <= 100)) throw new Error("401k percent must be 0 to 100");
    k401 = roundC((salary * i.k401_pct) / 100);
  } else if (i.k401_amount && i.k401_amount > 0) k401 = cents(i.k401_amount) * P;
  if (k401 + health > salary) throw new Error("pre-tax deductions are more than the pay");

  const incomeWages = salary - k401 - health;
  const ficaWages = salary - health;
  const federal = bracketTax(Math.max(0, incomeWages - STANDARD_DEDUCTION[i.filing] * 100), i.filing);
  const ss = roundC(Math.min(ficaWages, SS_BASE) * 0.062);
  const addl = roundC(Math.max(0, ficaWages - ADDL_OVER) * 0.009);
  const medicare = roundC(ficaWages * 0.0145) + addl;
  const state = roundC((incomeWages * statePct) / 100);
  const yearNet = salary - federal - ss - medicare - state - k401 - health;
  const each = (c: number) => roundC(c / P);
  const per = { gross: each(salary), federal: each(federal), social_security: each(ss), medicare: each(medicare), additional_medicare: each(addl), state: each(state), k401: each(k401), health: each(health) };
  const perPretax = per.k401 + per.health;
  const perNet = per.gross - per.federal - per.social_security - per.medicare - per.state - perPretax;

  let b: BonusLines | null = null;
  let bonusNet = 0;
  if (bonus > 0) {
    // The salary uses up the wage base and the Additional Medicare threshold first; the bonus pays on what is left.
    const bFed = roundC(Math.min(bonus, SUPP_TOP) * 0.22 + Math.max(0, bonus - SUPP_TOP) * 0.37);
    const bSs = roundC(Math.min(bonus, Math.max(0, SS_BASE - ficaWages)) * 0.062);
    const over = (w: number) => Math.max(0, w - ADDL_OVER);
    const bAddl = roundC((over(ficaWages + bonus) - over(ficaWages)) * 0.009);
    const bMed = roundC(bonus * 0.0145) + bAddl;
    const bState = roundC((bonus * statePct) / 100);
    bonusNet = bonus - bFed - bSs - bMed - bState;
    b = { gross: bonus / 100, federal: bFed / 100, federal_rate: bonus > SUPP_TOP ? 37 : 22, social_security: bSs / 100, medicare: bMed / 100, additional_medicare: bAddl / 100, state: bState / 100, net: bonusNet / 100 };
  }

  const notes: string[] = [];
  if (ficaWages > SS_BASE) notes.push(`Social Security stops after paycheck ${Math.ceil(SS_BASE / (ficaWages / P))} of ${P}, when the year's wages pass $184,500. The paychecks after that are larger than shown.`);
  if (addl > 0) notes.push("Additional Medicare of 0.9% is withheld on wages over $200,000 in the year.");
  if (i.filing === "married" && (addl > 0 || (b && b.additional_medicare > 0))) notes.push("Married filing jointly owes Additional Medicare only over $250,000 together, so some of it can come back on the return.");

  const d = (o: Omit<PayLines, "net">, net: number): PayLines => ({
    gross: o.gross / 100,
    federal: o.federal / 100,
    social_security: o.social_security / 100,
    medicare: o.medicare / 100,
    additional_medicare: o.additional_medicare / 100,
    state: o.state / 100,
    k401: o.k401 / 100,
    health: o.health / 100,
    pretax: o.pretax / 100,
    net: net / 100,
  });
  return {
    tax_year: TAX_YEAR,
    periods: P,
    per_paycheck: d({ ...per, pretax: perPretax }, perNet),
    per_year: d({ gross: salary, federal, social_security: ss, medicare, additional_medicare: addl, state, k401, health, pretax: k401 + health }, yearNet),
    bonus: b,
    year_net_with_bonus: (yearNet + bonusNet) / 100,
    notes,
  };
}

// ---------- hub response readers ----------
// The contract names the inputs and the meaning of the outputs, not every key, so these accept the likely spellings.

type Raw = Record<string, unknown>;
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined);
const pick = (o: Raw, keys: string[]) => keys.map((k) => o[k]).find((v) => v !== undefined);

export function readSplit(raw: unknown, fallback: SplitResult): SplitResult {
  const o = (raw ?? {}) as Raw;
  const arr = pick(o, ["per_person", "people", "totals", "shares"]);
  if (!Array.isArray(arr)) return fallback;
  const per = arr.map((x) => num(x) ?? num((x as Raw)?.total) ?? num((x as Raw)?.amount) ?? 0);
  return {
    subtotal: num(o.subtotal) ?? fallback.subtotal,
    tax: num(o.tax) ?? fallback.tax,
    tip: num(o.tip) ?? fallback.tip,
    total: num(o.total) ?? round(sum(per), 2),
    per_person: per,
    remainder_cents: num(o.remainder_cents) ?? fallback.remainder_cents,
  };
}

export function readPayoff(raw: unknown, fallback: PayoffResult): PayoffResult {
  const o = (raw ?? {}) as Raw;
  const months = o.months === "never" || o.never === true ? "never" : num(o.months);
  if (months === undefined) return fallback;
  const rows = pick(o, ["preview", "schedule", "rows", "amortization"]);
  const preview = Array.isArray(rows)
    ? rows.map((r, idx) => {
        const x = r as Raw;
        return { month: num(x.month) ?? idx + 1, payment: num(x.payment) ?? 0, interest: num(x.interest) ?? 0, principal: num(x.principal) ?? 0, balance: num(x.balance) ?? 0 };
      })
    : fallback.preview;
  const ti = pick(o, ["total_interest", "interest_total", "interest"]);
  return { months, payment: num(o.payment) ?? fallback.payment, total_interest: months === "never" ? null : (num(ti) ?? fallback.total_interest), preview };
}

export function readUnit(raw: unknown, fallback: UnitRow[]): UnitRow[] {
  const arr = Array.isArray(raw) ? raw : (raw as Raw)?.items;
  if (!Array.isArray(arr)) return fallback;
  const base = typeof (raw as Raw)?.unit === "string" ? String((raw as Raw).unit) : undefined;
  return arr.map((r) => {
    const x = r as Raw;
    const price = num(x.price) ?? 0;
    const qty = num(x.qty) ?? 1;
    const unit = String(x.unit ?? "");
    return { name: String(x.name ?? ""), price, qty, unit, base: base ?? String(x.base ?? unit), per_unit: num(pick(x, ["per_unit", "unit_price", "price_per_unit"])) ?? round(price / qty, 4) };
  });
}

export function readSubs(raw: unknown): SubsResult | null {
  const o = (raw ?? {}) as Raw;
  const arr = pick(o, ["subscriptions", "items", "watches"]);
  if (!Array.isArray(arr)) return null;
  const items = arr.map((r) => {
    const x = r as Raw;
    const f = ((x.fields as Raw) ?? x) as Raw;
    const cost = num(f.cost) ?? 0;
    const repeat = String(f.repeat ?? "");
    const monthly = num(pick(x, ["monthly", "monthly_equivalent", "monthly_cost"])) ?? monthlyOf(cost, repeat) ?? 0;
    return { id: typeof x.id === "string" ? x.id : undefined, title: String(f.title ?? ""), cost, repeat, monthly, yearly: num(x.yearly) ?? round(monthly * 12, 2) };
  });
  const mt = num(o.monthly_total) ?? round(sum(items.map((x) => x.monthly)), 2);
  const skipped = Array.isArray(o.skipped) ? (o.skipped as Raw[]).map((x) => ({ id: typeof x.id === "string" ? x.id : undefined, title: String(x.title ?? ""), reason: String(x.reason ?? "") })) : [];
  return { items, monthly_total: mt, yearly_total: num(o.yearly_total) ?? round(sum(items.map((x) => x.yearly)), 2), skipped };
}

export function readTakeHome(raw: unknown, fallback: TakeHomeResult): TakeHomeResult {
  const o = (raw ?? {}) as Raw;
  const lines = <T extends object>(x: unknown, fb: T): T | null => {
    const r = x as Raw | null | undefined;
    if (!r || num(r.net) === undefined) return null;
    return Object.fromEntries(Object.entries(fb).map(([k, v]) => [k, num(r[k]) ?? v])) as T;
  };
  const year = lines(o.per_year, fallback.per_year);
  const paycheck = lines(o.per_paycheck, fallback.per_paycheck);
  if (!year || !paycheck) return fallback;
  return {
    tax_year: num(o.tax_year) ?? fallback.tax_year,
    periods: num(o.periods) ?? fallback.periods,
    per_paycheck: paycheck,
    per_year: year,
    bonus: fallback.bonus ? (lines(o.bonus, fallback.bonus) ?? fallback.bonus) : null,
    year_net_with_bonus: num(o.year_net_with_bonus) ?? fallback.year_net_with_bonus,
    notes: Array.isArray(o.notes) ? o.notes.map(String) : fallback.notes,
  };
}

export const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
