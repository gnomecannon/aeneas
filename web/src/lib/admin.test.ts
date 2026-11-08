import { describe, expect, it } from "vitest";
import type { Entity } from "@everythingapp/shared";
import { monthlyOf, payoff, split, subscriptions, unitPrices, readSplit, readSubs } from "./calc";
import { checklistProgress, friendsOf, groupBoard, guardNames, instantiateFields, STATES, stateCode, statesGrid, toggleItem } from "./admin";

const ent = (kind: Entity["kind"], fields: Record<string, unknown>, id = Math.random().toString(36).slice(2), updated_at = "2026-10-01T00:00:00.000Z"): Entity => ({
  id,
  kind,
  space: "personal",
  created_at: updated_at,
  updated_at,
  deleted_at: null,
  fields,
  field_ts: {},
});

describe("split", () => {
  it("adds a 6.25% meals tax and tip on the subtotal and splits evenly", () => {
    expect(split({ subtotal: 84, tax_pct: 6.25, tip_pct: 20, people: 3 })).toEqual({ subtotal: 84, tax: 5.25, tip: 16.8, total: 106.05, per_person: [35.35, 35.35, 35.35], remainder_cents: 0 });
  });

  it("matches the hub reference: 87.40, 6.25 tax, 20 tip, 3 people", () => {
    expect(split({ subtotal: 87.4, tax_pct: 6.25, tip_pct: 20, people: 3 })).toEqual({ subtotal: 87.4, tax: 5.46, tip: 17.48, total: 110.34, per_person: [36.78, 36.78, 36.78], remainder_cents: 0 });
  });

  it("gives the leftover cents to the first person", () => {
    const r = split({ subtotal: 100, tax_pct: 6.25, tip_pct: 18, people: 3 });
    expect(r.total).toBe(124.25);
    expect(r.per_person).toEqual([41.43, 41.41, 41.41]);
    expect(r.remainder_cents).toBe(2);
    expect(Math.round(r.per_person.reduce((a, b) => a + b, 0) * 100)).toBe(12425);
  });

  it("rounds tax half up to the cent", () => {
    // 19.99 * 6.25% = 1.249375 -> 1.25; 19.99 * 15% = 2.9985 -> 3.00
    expect(split({ subtotal: 19.99, tax_pct: 6.25, tip_pct: 15, people: 1 })).toMatchObject({ subtotal: 19.99, tax: 1.25, tip: 3, total: 24.24, per_person: [24.24] });
  });

  it("splits by uneven shares with the remainder to the first person", () => {
    expect(split({ subtotal: 100.01, people: 3, shares: [2, 1, 1] }).per_person).toEqual([50.01, 25, 25]);
    const r = split({ subtotal: 60, tax_pct: 6.25, tip_pct: 20, people: 3, shares: [30, 20, 10] });
    expect(r.total).toBe(75.75);
    expect(r.per_person).toEqual([37.88, 25.25, 12.62]);
  });

  it("rejects bad input", () => {
    expect(() => split({ subtotal: 10, people: 0 })).toThrow();
    expect(() => split({ subtotal: 10, people: 2, shares: [1] })).toThrow();
  });
});

describe("payoff", () => {
  it("matches the hub reference: 4200 at 28.99 percent paying 200", () => {
    const r = payoff({ balance: 4200, apr_pct: 28.99, payment: 200 });
    expect(r.months).toBe(30);
    expect(r.total_interest).toBe(1731.57);
    expect(r.preview[0]).toMatchObject({ month: 1, interest: 101.47, principal: 98.53 });
  });

  it("payment wins when both are given", () => {
    expect(payoff({ balance: 4200, apr_pct: 28.99, payment: 200, months: 12 }).months).toBe(30);
  });

  it("months and total interest for a fixed payment", () => {
    const r = payoff({ balance: 5000, apr_pct: 18, payment: 200 });
    expect(r.months).toBe(32);
    expect(r.total_interest).toBe(1313.97);
    expect(r.preview).toHaveLength(12);
    expect(r.preview[0]).toEqual({ month: 1, payment: 200, interest: 75, principal: 125, balance: 4875 });
    expect(r.preview[1]).toEqual({ month: 2, payment: 200, interest: 73.13, principal: 126.87, balance: 4748.13 });
  });

  it("the payment for a number of months, last payment absorbing the rounding", () => {
    const r = payoff({ balance: 1000, apr_pct: 12, months: 12 });
    expect(r.payment).toBe(88.85);
    expect(r.months).toBe(12);
    expect(r.total_interest).toBe(66.19);
    expect(r.preview[11].payment).toBe(88.84);
    expect(r.preview[11].balance).toBe(0);
  });

  it("never when the payment does not cover the interest", () => {
    const r = payoff({ balance: 5000, apr_pct: 24, payment: 100 });
    expect(r.months).toBe("never");
    expect(r.total_interest).toBeNull();
    expect(r.preview[0].balance).toBe(5000);
    const worse = payoff({ balance: 5000, apr_pct: 24, payment: 50 });
    expect(worse.months).toBe("never");
    expect(worse.preview[11].balance).toBeGreaterThan(5000);
  });

  it("zero APR", () => {
    expect(payoff({ balance: 1000, apr_pct: 0, payment: 300 })).toMatchObject({ months: 4, total_interest: 0 });
    expect(payoff({ balance: 1000, apr_pct: 0, months: 3 }).payment).toBe(333.34);
  });
});

describe("unit price", () => {

  it("cheapest per unit first", () => {
    const r = unitPrices([
      { name: "big", price: 7.99, qty: 2, unit: "lb" },
      { name: "small", price: 2.49, qty: 8, unit: "oz" },
      { name: "none", price: 1, qty: 0, unit: "oz" },
    ]);
    expect(r.map((x) => x.name)).toEqual(["big", "small"]);
    expect(r[0]).toMatchObject({ base: "oz", per_unit: 0.2497 });
    expect(r[1].per_unit).toBe(0.3113);
    expect(() => unitPrices([{ name: "a", price: 1, qty: 1, unit: "oz" }, { name: "b", price: 1, qty: 1, unit: "each" }])).toThrow();
  });
});

describe("subscriptions", () => {
  it("monthly equivalents and totals", () => {
    expect(monthlyOf(110, "every 1 years")).toBe(9.17);
    expect(monthlyOf(9, "every 1 months")).toBe(9);
    expect(monthlyOf(9, undefined)).toBeNull();
    const r = subscriptions([
      ent("watch", { title: "Music streaming", category: "subscription", cost: 110, repeat: "every 1 years" }),
      ent("watch", { title: "Cloud backup", category: "subscription", cost: 9, repeat: "every 1 months" }),
      ent("watch", { title: "Car insurance", category: "insurance", cost: 640, repeat: "every 1 years" }),
    ]);
    expect(r.items.map((x) => x.title)).toEqual(["Music streaming", "Cloud backup"]);
    expect(r.monthly_total).toBe(18.17);
    expect(r.yearly_total).toBe(218);
    expect(subscriptions([ent("watch", { title: "No cost", category: "subscription", repeat: "every 1 months" })]).skipped).toEqual([expect.objectContaining({ title: "No cost", reason: "no cost" })]);
  });

  it("reads the hub shapes", () => {
    expect(readSubs({ subscriptions: [{ id: "a", fields: { title: "X", cost: 12, repeat: "every 1 years" }, monthly: 1 }], monthly_total: 1, yearly_total: 12 })?.items[0]).toMatchObject({ title: "X", monthly: 1 });
    const fb = split({ subtotal: 10, people: 2 });
    expect(readSplit({ people: [{ total: 6 }, { total: 4 }] }, fb).per_person).toEqual([6, 4]);
  });
});

describe("states grid", () => {
  it("maps all fifty names to codes", () => {
    expect(STATES).toHaveLength(50);
    const items = STATES.map(([, n]) => ({ text: n }));
    const grid = statesGrid(items);
    expect(grid).toHaveLength(50);
    expect(new Set(grid.map((c) => c.code)).size).toBe(50);
    expect(grid.find((c) => c.name === "Massachusetts")?.code).toBe("MA");
    expect(grid.find((c) => c.name === "West Virginia")?.code).toBe("WV");
  });

  it("tolerates case, list markers and codes, and drops non-states", () => {
    expect(stateCode("  new hampshire ")).toBe("NH");
    expect(stateCode("- [x] Rhode Island")).toBe("RI");
    expect(stateCode("vt")).toBe("VT");
    expect(stateCode("District of Columbia")).toBeNull();
    const grid = statesGrid([{ text: "Maine", done_at: "2026-01-01T00:00:00Z" }, { text: "Puerto Rico" }, { text: "Ohio" }]);
    expect(grid).toEqual([
      { index: 0, code: "ME", name: "Maine", done: true },
      { index: 2, code: "OH", name: "Ohio", done: false },
    ]);
  });
});

describe("checklists", () => {
  it("toggle flips one done_at and progress counts it", () => {
    const items = [{ text: "a" }, { text: "b", done_at: "2026-01-01T00:00:00Z" }];
    const t = toggleItem(items, 0, "2026-10-23T00:00:00Z");
    expect(t[0].done_at).toBe("2026-10-23T00:00:00Z");
    expect(toggleItem(t, 1, "x")[1]).toEqual({ text: "b" });
    expect(checklistProgress({ items: t })).toEqual({ done: 2, total: 2 });
  });

  it("instantiate clears every done_at and links the template", () => {
    const tpl = ent("checklist", { title: "Day hike", kind: "packing", template: true, items: [{ text: "Water", done_at: "x" }, { text: "Map", note: "paper" }] }, "tpl-1");
    expect(instantiateFields(tpl, "Hike Saturday")).toEqual({ title: "Hike Saturday", kind: "packing", items: [{ text: "Water" }, { text: "Map", note: "paper" }], template: false, from_template: "tpl-1", tags: [] });
  });
});

describe("career board", () => {
  it("groups by stage in pipeline order with counts and follow-ups", () => {
    const a = ent("application", { company: "A", role: "r", stage: "applied", next_at: "2026-11-02T15:00:00Z" }, "a");
    const b = ent("application", { company: "B", role: "r", stage: "applied", next_at: "2026-10-28T15:00:00Z" }, "b");
    const c = ent("application", { company: "C", role: "r", stage: "applied" }, "c", "2026-10-20T00:00:00Z");
    const d = ent("application", { company: "D", role: "r", stage: "interview" }, "d");
    const e = ent("application", { company: "E", role: "r", stage: "rejected", next_at: "2026-10-24T00:00:00Z" }, "e");
    const board = groupBoard([a, c, e, b, d]);
    expect(board.columns.map((col) => col.stage)).toEqual(["saved", "applied", "screen", "interview", "offer", "rejected", "withdrawn", "accepted"]);
    expect(board.columns.map((col) => col.count)).toEqual([0, 3, 0, 1, 0, 1, 0, 0]);
    expect(board.columns[1].items.map((x) => x.id)).toEqual(["b", "a", "c"]);
    expect(board.followUps.map((x) => x.id)).toEqual(["b", "a"]);
    expect(board.active).toBe(4);
  });
});

describe("games and guard", () => {
  it("friends from owned_by with the owner first", () => {
    expect(friendsOf([ent("game", { name: "x", owned_by: ["Rob", "Alex"] }), ent("game", { name: "y", owned_by: ["Kim", " Dev "] })], "Alex")).toEqual(["Alex", "Dev", "Kim", "Rob"]);
    expect(friendsOf([], "Alex")).toEqual(["Alex"]);
    expect(friendsOf([], "Me")).toEqual(["Me"]);
  });

  it("guard names from any detail shape", () => {
    expect(guardNames(["Initech"])).toEqual(["Initech"]);
    expect(guardNames({ invented: ["Globex", "Initech"], backend: "adapter" })).toEqual(["Globex", "Initech"]);
    expect(guardNames("nope")).toEqual([]);
  });
});
