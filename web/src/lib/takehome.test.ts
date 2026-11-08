import { describe, expect, it } from "vitest";
import { readTakeHome, takeHome } from "./calc";

// The same hand-worked examples as hub/test/takehome.test.ts and EACore TakeHomeTests, so the three agree to the cent.

describe("takeHome", () => {
  it("single, biweekly, 5% 401k, health and 5% state", () => {
    const r = takeHome({ salary: 85000, frequency: "biweekly", filing: "single", k401_pct: 5, health: 100, state_pct: 5 });
    // Taxable 85,000 - 4,250 - 2,600 - 16,100 = 62,050: 5,800 + 22% of 11,650 = 8,363. FICA wages keep the 401k: 82,400.
    expect(r.per_year).toEqual({ gross: 85000, federal: 8363, social_security: 5108.8, medicare: 1194.8, additional_medicare: 0, state: 3907.5, k401: 4250, health: 2600, pretax: 6850, net: 59575.9 });
    expect(r.per_paycheck).toEqual({ gross: 3269.23, federal: 321.65, social_security: 196.49, medicare: 45.95, additional_medicare: 0, state: 150.29, k401: 163.46, health: 100, pretax: 263.46, net: 2291.39 });
    expect(r.bonus).toBeNull();
    expect(r.notes).toEqual([]);
  });

  it("married, monthly, over the wage base, with a bonus at 22%", () => {
    const r = takeHome({ salary: 260000, bonus: 50000, frequency: "monthly", filing: "married", k401_amount: 2000 });
    expect(r.per_year).toEqual({ gross: 260000, federal: 34260, social_security: 11439, medicare: 4310, additional_medicare: 540, state: 0, k401: 24000, health: 0, pretax: 24000, net: 185991 });
    expect(r.per_paycheck.net).toBe(15499.25);
    expect(r.bonus).toEqual({ gross: 50000, federal: 11000, federal_rate: 22, social_security: 0, medicare: 1175, additional_medicare: 450, state: 0, net: 37825 });
    expect(r.year_net_with_bonus).toBe(223816);
    expect(r.notes[0]).toMatch(/stops after paycheck 9 of 12/);
    for (const n of r.notes) expect(n).not.toMatch(/[–—]/);
  });

  it("head of household, weekly; a bonus that crosses the wage base", () => {
    const r = takeHome({ salary: 50000, frequency: "weekly", filing: "head" });
    expect(r.per_year.federal).toBe(2748);
    expect(r.per_year.net).toBe(43427);
    expect(r.per_paycheck.gross).toBe(961.54);
    expect(r.per_paycheck.net).toBe(835.13);
    const b = takeHome({ salary: 180000, bonus: 10000, frequency: "semimonthly", filing: "single", state_pct: 5 }).bonus;
    expect(b).toEqual({ gross: 10000, federal: 2200, federal_rate: 22, social_security: 279, medicare: 145, additional_medicare: 0, state: 500, net: 6876 });
  });

  it("refuses deductions larger than the pay", () => {
    expect(() => takeHome({ salary: 26000, frequency: "biweekly", filing: "single", k401_amount: 900, health: 200 })).toThrow();
    expect(() => takeHome({ salary: 0, frequency: "biweekly", filing: "single" })).toThrow();
  });

  it("reads the hub's answer and falls back on what is missing", () => {
    const local = takeHome({ salary: 85000, frequency: "biweekly", filing: "single" });
    expect(readTakeHome({}, local)).toBe(local);
    const hub = readTakeHome({ per_year: { ...local.per_year, net: 1 }, per_paycheck: { net: 2 }, notes: ["x"] }, local);
    expect(hub.per_year.net).toBe(1);
    expect(hub.per_paycheck.net).toBe(2);
    expect(hub.per_paycheck.gross).toBe(local.per_paycheck.gross);
    expect(hub.notes).toEqual(["x"]);
  });
});
