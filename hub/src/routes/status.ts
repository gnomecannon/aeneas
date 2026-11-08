import { Hono } from "hono";
import { pendingReminders } from "../reminders.js";
import { StoreError } from "../store.js";
import type { Hub } from "../hub.js";
import { proofReport, statusReport } from "../metrics.js";

/** Operator views: hub status, the proof-run metrics, and the reminders due soon. */
export function statusRoutes() {
  const r = new Hono<{ Variables: { hub: Hub } }>();

  r.get("/status", (c) => c.json(statusReport(c.get("hub"))));

  r.get("/metrics/proof", (c) => {
    const raw = c.req.query("days") ?? "14";
    const days = parseInt(raw, 10);
    if (!Number.isFinite(days) || days < 1 || days > 90) throw new StoreError(400, "days must be an integer from 1 to 90");
    return c.json(proofReport(c.get("hub"), days));
  });

  r.get("/reminders/due", (c) => {
    const hub = c.get("hub");
    const raw = c.req.query("within") ?? "60";
    const within = parseInt(raw, 10);
    if (!Number.isFinite(within) || within < 0 || within > 10080) throw new StoreError(400, "within must be minutes from 0 to 10080");
    const now = new Date();
    const until = new Date(now.getTime() + within * 60000).toISOString();
    const reminders = pendingReminders(hub.store).filter(({ eff }) => eff <= until).map(({ t }) => t);
    return c.json({ reminders, now: now.toISOString(), until });
  });

  return r;
}
