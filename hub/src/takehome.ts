import { StoreError } from "./store.js";

/**
 * Take-home pay (Module 7 calculators). Stateless: salary, bonus and pre-tax deductions in, paycheck and year out.
 * web/src/lib/calc.ts and apple EACore `Calc.takeHome` run the same math; change all three together.
 *
 * Tax year 2026 figures:
 * - Brackets and standard deductions: IRS Rev. Proc. 2025-32, section 4.01 (tables 1 to 3) and 4.14,
 *   https://www.irs.gov/pub/irs-drop/rp-25-32.pdf (news release IR-2025-103).
 * - Social Security wage base $184,500: SSA 2026 COLA fact sheet, https://www.ssa.gov/news/en/cola/factsheets/2026.html
 * - Social Security 6.2%, Medicare 1.45%, Additional Medicare 0.9% withheld on wages over $200,000 in the year whatever the
 *   filing status, and the 22% supplemental rate (37% on supplemental wages over $1,000,000): IRS Publication 15 (Circular E).
 *
 * Federal income tax is the year's tax on wages after pre-tax deductions and the standard deduction, spread evenly over the
 * paychecks. That is close to what the W-4 percentage method withholds for someone with no other income or credits, not a
 * figure for the return. A married couple owes Additional Medicare only above $250,000 together; the return settles that.
 */

export const TAX_YEAR = 2026;
export const FREQUENCIES = { weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12 } as const;
export type Frequency = keyof typeof FREQUENCIES;
export const FILINGS = ["single", "married", "head"] as const;
export type Filing = (typeof FILINGS)[number];

/** Standard deduction in dollars (Rev. Proc. 2025-32 section 4.14). */
export const STANDARD_DEDUCTION: Record<Filing, number> = { single: 16100, married: 32200, head: 24150 };
/** Top of each bracket in dollars and its rate; the last bracket has no top (Rev. Proc. 2025-32 section 4.01). */
export const BRACKETS: Record<Filing, Array<[number, number]>> = {
  married: [[24800, 0.10], [100800, 0.12], [211400, 0.22], [403550, 0.24], [512450, 0.32], [768700, 0.35], [Infinity, 0.37]],
  head: [[17700, 0.10], [67450, 0.12], [105700, 0.22], [201750, 0.24], [256200, 0.32], [640600, 0.35], [Infinity, 0.37]],
  single: [[12400, 0.10], [50400, 0.12], [105700, 0.22], [201775, 0.24], [256225, 0.32], [640600, 0.35], [Infinity, 0.37]],
};
export const SS_WAGE_BASE = 184500;
export const SS_RATE = 0.062;
export const MEDICARE_RATE = 0.0145;
export const ADDITIONAL_MEDICARE_RATE = 0.009;
export const ADDITIONAL_MEDICARE_THRESHOLD = 200000;
export const SUPPLEMENTAL_RATE = 0.22;
export const SUPPLEMENTAL_TOP_RATE = 0.37;
export const SUPPLEMENTAL_TOP_OVER = 1000000;

/** Round half up to a whole cent after trimming float noise (amounts here are never negative). */
const roundC = (x: number) => Math.round(Number(x.toFixed(6)));
const cents = (dollars: number) => roundC(dollars * 100);
const dollars = (c: number) => c / 100;

/** Tax in cents on taxable income in cents, by the bracket table. */
export function bracketTax(taxable: number, filing: Filing): number {
  let tax = 0, low = 0;
  for (const [top, rate] of BRACKETS[filing]) {
    const hi = top * 100;
    if (taxable <= low) break;
    tax += (Math.min(taxable, hi) - low) * rate;
    low = hi;
  }
  return roundC(tax);
}

export interface PayLines { gross: number; federal: number; social_security: number; medicare: number; additional_medicare: number; state: number; k401: number; health: number; pretax: number; net: number }
export interface BonusLines { gross: number; federal: number; federal_rate: number; social_security: number; medicare: number; additional_medicare: number; state: number; net: number }
export interface TakeHome {
  tax_year: number; frequency: Frequency; periods: number; filing: Filing;
  per_paycheck: PayLines; per_year: PayLines; bonus: BonusLines | null;
  /** Salary and bonus after everything, for the year. */
  year_net_with_bonus: number;
  figures: { standard_deduction: number; ss_wage_base: number; additional_medicare_over: number; supplemental_rate: number };
  /** Plain sentences worth showing, such as Social Security stopping before the year ends. */
  notes: string[];
}

function num(v: unknown, name: string, opts: { min?: number; max?: number; positive?: boolean } = {}): number {
  const x = typeof v === "string" && v.trim() ? Number(v) : v;
  if (typeof x !== "number" || !Number.isFinite(x)) throw new StoreError(422, `${name} must be a number`);
  if (opts.positive && x <= 0) throw new StoreError(422, `${name} must be above 0`);
  if (opts.min !== undefined && x < opts.min) throw new StoreError(422, `${name} must be ${opts.min} or more`);
  if (opts.max !== undefined && x > opts.max) throw new StoreError(422, `${name} must be ${opts.max} or less`);
  return x;
}
const given = (v: unknown) => v !== undefined && v !== null && v !== "";

/**
 * Body: `{ salary, bonus?, frequency, filing, k401_pct? | k401_amount?, health?, state_pct? }`. `k401_amount` and `health` are per
 * paycheck; `k401_pct` is a percent of each paycheck's gross (it wins when both are sent). The 401k comes off income tax and
 * state wages but not Social Security or Medicare; health and HSA (a cafeteria plan) come off all of them. State tax is a flat
 * percent of wages after pre-tax deductions. Year figures are worked first; per paycheck is the year divided evenly, so a
 * paycheck after the Social Security wage base is reached is larger than the one shown. The bonus has no 401k taken from it.
 */
export function calcTakeHome(body: Record<string, unknown>): TakeHome {
  const salary = cents(num(body.salary, "salary", { positive: true, max: 100_000_000 }));
  const bonus = given(body.bonus) ? cents(num(body.bonus, "bonus", { min: 0, max: 100_000_000 })) : 0;
  const frequency = String(body.frequency ?? "biweekly") as Frequency;
  if (!Object.hasOwn(FREQUENCIES, frequency)) throw new StoreError(422, `frequency must be one of ${Object.keys(FREQUENCIES).join(", ")}`);
  const filing = String(body.filing ?? "single") as Filing;
  if (!FILINGS.includes(filing)) throw new StoreError(422, `filing must be one of ${FILINGS.join(", ")}`);
  const P = FREQUENCIES[frequency];
  const statePct = given(body.state_pct) ? num(body.state_pct, "state_pct", { min: 0, max: 20 }) : 0;
  const health = given(body.health) ? cents(num(body.health, "health", { min: 0 })) * P : 0;
  let k401 = 0;
  if (given(body.k401_pct)) k401 = roundC((salary * num(body.k401_pct, "k401_pct", { min: 0, max: 100 })) / 100);
  else if (given(body.k401_amount)) k401 = cents(num(body.k401_amount, "k401_amount", { min: 0 })) * P;
  if (k401 + health > salary) throw new StoreError(422, "pre-tax deductions are more than the pay");

  const incomeWages = salary - k401 - health;
  const ficaWages = salary - health;
  const federal = bracketTax(Math.max(0, incomeWages - STANDARD_DEDUCTION[filing] * 100), filing);
  const ss = roundC(Math.min(ficaWages, SS_WAGE_BASE * 100) * SS_RATE);
  const addl = roundC(Math.max(0, ficaWages - ADDITIONAL_MEDICARE_THRESHOLD * 100) * ADDITIONAL_MEDICARE_RATE);
  const medicare = roundC(ficaWages * MEDICARE_RATE) + addl;
  const state = roundC((incomeWages * statePct) / 100);
  const year = { gross: salary, federal, social_security: ss, medicare, additional_medicare: addl, state, k401, health, pretax: k401 + health };
  const yearNet = salary - federal - ss - medicare - state - k401 - health;

  // Each line per paycheck is the year's figure over the paychecks; net is what is left, so the column adds up.
  const each = (c: number) => roundC(c / P);
  const per = { gross: each(salary), federal: each(federal), social_security: each(ss), medicare: each(medicare), additional_medicare: each(addl), state: each(state), k401: each(k401), health: each(health), pretax: 0 };
  per.pretax = per.k401 + per.health;
  const perNet = per.gross - per.federal - per.social_security - per.medicare - per.state - per.pretax;

  let b: BonusLines | null = null;
  let bonusNet = 0;
  if (bonus > 0) {
    const top = SUPPLEMENTAL_TOP_OVER * 100;
    const bFed = roundC(Math.min(bonus, top) * SUPPLEMENTAL_RATE + Math.max(0, bonus - top) * SUPPLEMENTAL_TOP_RATE);
    // The salary uses up the wage base and the Additional Medicare threshold first; the bonus pays on what is left.
    const bSs = roundC(Math.min(bonus, Math.max(0, SS_WAGE_BASE * 100 - ficaWages)) * SS_RATE);
    const over = (w: number) => Math.max(0, w - ADDITIONAL_MEDICARE_THRESHOLD * 100);
    const bAddl = roundC((over(ficaWages + bonus) - over(ficaWages)) * ADDITIONAL_MEDICARE_RATE);
    const bMed = roundC(bonus * MEDICARE_RATE) + bAddl;
    const bState = roundC((bonus * statePct) / 100);
    bonusNet = bonus - bFed - bSs - bMed - bState;
    b = {
      gross: dollars(bonus), federal: dollars(bFed), federal_rate: bonus > top ? SUPPLEMENTAL_TOP_RATE * 100 : SUPPLEMENTAL_RATE * 100,
      social_security: dollars(bSs), medicare: dollars(bMed), additional_medicare: dollars(bAddl), state: dollars(bState), net: dollars(bonusNet),
    };
  }

  const notes: string[] = [];
  if (ficaWages > SS_WAGE_BASE * 100) {
    const n = Math.ceil((SS_WAGE_BASE * 100) / (ficaWages / P));
    notes.push(`Social Security stops after paycheck ${n} of ${P}, when the year's wages pass $${SS_WAGE_BASE.toLocaleString("en-US")}. The paychecks after that are larger than shown.`);
  }
  if (addl > 0) notes.push(`Additional Medicare of 0.9% is withheld on wages over $${ADDITIONAL_MEDICARE_THRESHOLD.toLocaleString("en-US")} in the year.`);
  if (filing === "married" && (addl > 0 || (b && b.additional_medicare > 0))) notes.push("Married filing jointly owes Additional Medicare only over $250,000 together, so some of it can come back on the return.");

  const toD = (o: Omit<PayLines, "net">, net: number): PayLines => ({
    gross: dollars(o.gross), federal: dollars(o.federal), social_security: dollars(o.social_security), medicare: dollars(o.medicare),
    additional_medicare: dollars(o.additional_medicare), state: dollars(o.state), k401: dollars(o.k401), health: dollars(o.health), pretax: dollars(o.pretax), net: dollars(net),
  });
  return {
    tax_year: TAX_YEAR, frequency, periods: P, filing,
    per_paycheck: toD(per, perNet), per_year: toD(year, yearNet), bonus: b,
    year_net_with_bonus: dollars(yearNet + bonusNet),
    figures: { standard_deduction: STANDARD_DEDUCTION[filing], ss_wage_base: SS_WAGE_BASE, additional_medicare_over: ADDITIONAL_MEDICARE_THRESHOLD, supplemental_rate: SUPPLEMENTAL_RATE * 100 },
    notes,
  };
}
