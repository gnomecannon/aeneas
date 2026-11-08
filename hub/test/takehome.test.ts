import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub } from "./helpers.js";
import { bracketTax } from "../src/takehome.js";

const post = (json: unknown) => ({ method: "POST", json });

// Every number below was worked by hand from the 2026 tables (Rev. Proc. 2025-32) and the SSA wage base.

test("takehome: bracket tax matches the Rev. Proc. 2025-32 table constants", () => {
  // Each table states the tax at the top of a bracket; these are the "plus" amounts printed there.
  assert.equal(bracketTax(50400_00, "single"), 5800_00);
  assert.equal(bracketTax(640600_00, "single"), 192979_25);
  assert.equal(bracketTax(768700_00, "married"), 206583_50);
  assert.equal(bracketTax(105700_00, "head"), 16155_00);
  assert.equal(bracketTax(640600_00, "head"), 191171_00);
  assert.equal(bracketTax(0, "single"), 0);
});

test("takehome: single, biweekly, 5% 401k and health, 5% state", async () => {
  const t = makeHub();
  try {
    const r = await (await t.api("/calc/takehome", post({ salary: 85000, frequency: "biweekly", filing: "single", k401_pct: 5, health: 100, state_pct: 5 }))).json() as any;
    // Income wages 85,000 - 4,250 - 2,600 = 78,150; taxable 62,050; 5,800 + 22% of 11,650 = 8,363.
    // FICA wages 82,400 (the 401k stays in): SS 5,108.80, Medicare 1,194.80. State 5% of 78,150.
    assert.deepEqual(r.per_year, { gross: 85000, federal: 8363, social_security: 5108.8, medicare: 1194.8, additional_medicare: 0, state: 3907.5, k401: 4250, health: 2600, pretax: 6850, net: 59575.9 });
    assert.deepEqual(r.per_paycheck, { gross: 3269.23, federal: 321.65, social_security: 196.49, medicare: 45.95, additional_medicare: 0, state: 150.29, k401: 163.46, health: 100, pretax: 263.46, net: 2291.39 });
    assert.equal(r.bonus, null);
    assert.equal(r.tax_year, 2026);
    assert.equal(r.periods, 26);
    assert.deepEqual(r.notes, []);
  } finally { t.cleanup(); }
});

test("takehome: married, monthly, over the wage base and the Additional Medicare line, with a bonus", async () => {
  const t = makeHub();
  try {
    const r = await (await t.api("/calc/takehome", post({ salary: 260000, bonus: 50000, frequency: "monthly", filing: "married", k401_amount: 2000 }))).json() as any;
    // Taxable 260,000 - 24,000 - 32,200 = 203,800: 11,600 + 22% of 103,000 = 34,260.
    // SS capped: 184,500 x 6.2% = 11,439. Medicare 3,770 + 0.9% of 60,000 = 540.
    assert.deepEqual(r.per_year, { gross: 260000, federal: 34260, social_security: 11439, medicare: 4310, additional_medicare: 540, state: 0, k401: 24000, health: 0, pretax: 24000, net: 185991 });
    assert.deepEqual(r.per_paycheck, { gross: 21666.67, federal: 2855, social_security: 953.25, medicare: 359.17, additional_medicare: 45, state: 0, k401: 2000, health: 0, pretax: 2000, net: 15499.25 });
    // Bonus: 22% federal, no SS room left, Medicare 725 + 0.9% of all 50,000.
    assert.deepEqual(r.bonus, { gross: 50000, federal: 11000, federal_rate: 22, social_security: 0, medicare: 1175, additional_medicare: 450, state: 0, net: 37825 });
    assert.equal(r.year_net_with_bonus, 223816);
    assert.match(r.notes[0], /stops after paycheck 9 of 12/);
    assert.ok(r.notes.some((n: string) => /250,000/.test(n)));
    for (const n of r.notes) assert.doesNotMatch(n, /[–—]/);
  } finally { t.cleanup(); }
});

test("takehome: head of household, weekly, bonus splits across the wage base", async () => {
  const t = makeHub();
  try {
    let r = await (await t.api("/calc/takehome", post({ salary: 50000, frequency: "weekly", filing: "head" }))).json() as any;
    // Taxable 25,850: 1,770 + 12% of 8,150 = 2,748.
    assert.deepEqual(r.per_year, { gross: 50000, federal: 2748, social_security: 3100, medicare: 725, additional_medicare: 0, state: 0, k401: 0, health: 0, pretax: 0, net: 43427 });
    assert.equal(r.per_paycheck.gross, 961.54);
    assert.equal(r.per_paycheck.net, 835.13);
    // 180,000 salary leaves 4,500 of wage base for the bonus: SS 279; Medicare 145 + 0.9% of the 0 over 200,000 = 145.
    r = await (await t.api("/calc/takehome", post({ salary: 180000, bonus: 10000, frequency: "semimonthly", filing: "single", state_pct: 5 }))).json() as any;
    assert.deepEqual(r.bonus, { gross: 10000, federal: 2200, federal_rate: 22, social_security: 279, medicare: 145, additional_medicare: 0, state: 500, net: 6876 });
    assert.equal(r.periods, 24);
  } finally { t.cleanup(); }
});

test("takehome: refuses bad input", async () => {
  const t = makeHub();
  try {
    assert.equal((await t.api("/calc/takehome", post({ salary: 0 }))).status, 422);
    assert.equal((await t.api("/calc/takehome", post({ salary: 50000, frequency: "daily" }))).status, 422);
    assert.equal((await t.api("/calc/takehome", post({ salary: 50000, filing: "separate" }))).status, 422);
    assert.equal((await t.api("/calc/takehome", post({ salary: 26000, frequency: "biweekly", k401_amount: 900, health: 200 }))).status, 422);
    assert.equal((await t.api("/calc/takehome", post({ salary: 50000, k401_pct: 120 }))).status, 422);
  } finally { t.cleanup(); }
});
