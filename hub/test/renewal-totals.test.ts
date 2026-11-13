import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub } from "./helpers.js";

// The top of Renewals, and the assistant's "how much do my renewals cost": every renewal with a cost and a repeat.

test("renewal totals: every category counts, monthly and yearly, by category; what is left out is named", async () => {
  const t = makeHub();
  try {
    const mk = (title: string, category: string, cost: number | undefined, repeat: string | undefined, extra: Record<string, unknown> = {}) =>
      t.hub.store.create("watch", { title, category, due: "2026-12-01", ...(cost !== undefined ? { cost } : {}), ...(repeat ? { repeat } : {}), ...extra });
    mk("Music service", "subscription", 11.99, "every 1 months", { autopay: true });
    mk("Car insurance", "insurance", 600, "every 6 months");
    mk("example.org", "domain", 15, "every 1 years");
    mk("TLS certificate", "cert", undefined, "every 3 months");
    mk("Monitor arm", "warranty", 120, undefined);
    mk("Old streaming", "subscription", 9.99, "every 1 months", { cancelled_by_mail: true });

    const res = await t.api("/finance/renewals");
    assert.equal(res.status, 200);
    const r = await res.json() as { monthly_total: number; yearly_total: number; count: number; by_category: { category: string; count: number; monthly: number; yearly: number }[]; left_out: { title: string; reason: string }[] };
    // 11.99 a month, 600 every 6 months (100 a month), 15 a year (1.25 a month).
    assert.equal(r.count, 3);
    assert.equal(r.monthly_total, 113.24);
    assert.equal(r.yearly_total, 1358.88);
    assert.deepEqual(r.by_category.map((c) => [c.category, c.monthly, c.yearly]), [["insurance", 100, 1200], ["subscription", 11.99, 143.88], ["domain", 1.25, 15]]);
    assert.deepEqual(r.left_out.map(({ title, reason }) => ({ title, reason })), [{ title: "Monitor arm", reason: "it does not repeat" }], "a cost that does not repeat is named; one cancelled by mail or with no cost is not a cost");
  } finally { t.cleanup(); }
});
