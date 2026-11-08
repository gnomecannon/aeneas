import { Hono } from "hono";
import type { Hub } from "../hub.js";
import { StoreError } from "../store.js";
import { ackIncident, history, opsView, runCheck } from "../monitors.js";

/** Module 6: the ops board, on-demand checks, check history and incident acknowledgement. */
export function opsRoutes() {
  const r = new Hono<{ Variables: { hub: Hub } }>();

  r.get("/ops", (c) => c.json(opsView(c.get("hub"))));

  r.post("/monitors/:id/check", async (c) => c.json(await runCheck(c.get("hub"), c.req.param("id"))));

  r.get("/monitors/:id/history", (c) => {
    const raw = c.req.query("hours") ?? "24";
    const hours = Number(raw);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 168) throw new StoreError(400, "hours must be a number above 0 and at most 168");
    return c.json(history(c.get("hub"), c.req.param("id"), hours));
  });

  r.post("/incidents/:id/ack", async (c) => {
    // The body is optional: no body acknowledges without a note; anything sent must be a JSON object.
    const raw = await c.req.text();
    let body: unknown = {};
    if (raw.trim()) { try { body = JSON.parse(raw); } catch { throw new StoreError(400, "invalid JSON body"); } }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new StoreError(400, "JSON body must be an object");
    return c.json(ackIncident(c.get("hub"), c.req.param("id"), body as { note?: unknown }));
  });

  return r;
}
