import { Hono } from "hono";
import type { Hub } from "../hub.js";
import { readJsonObject } from "../http.js";
import { parseLocalDate, parseMinHours, scheduleTask, todayView, unscheduleTask, weekModel } from "../planner.js";
import { linkedReminder, renewWatch } from "../watches.js";
import { StoreError } from "../store.js";
import { calendarFeed } from "../calendar.js";

/** Module 1: the week and today views, block scheduling, and watch renewals. */
export function plannerRoutes() {
  const r = new Hono<{ Variables: { hub: Hub } }>();

  // Subscribe from any calendar app with ?key=<calendar key> (GET /feeds; calendar apps cannot send a header).
  r.get("/calendar.ics", (c) => {
    // A subscription made before the calendar key holds the hub token in its address: say so, so it can be remade.
    if (c.req.query("token")) console.warn("[calendar] the feed was read with the hub token; subscribe again with the link in Settings, Connections, Calendar");
    return c.body(calendarFeed(c.get("hub")), 200, { "content-type": "text/calendar; charset=utf-8", "cache-control": "no-store" });
  });

  r.get("/planner/week", (c) => {
    const hub = c.get("hub");
    const raw = c.req.query("start");
    const start = raw ? parseLocalDate(raw) : undefined;
    return c.json(weekModel(hub, start, parseMinHours(c.req.query("min_hours"))));
  });

  r.post("/planner/schedule", async (c) => {
    const hub = c.get("hub");
    const body = await readJsonObject(c);
    const task = scheduleTask(hub, body);
    return c.json(hub.store.get(task.id) ?? task);
  });

  r.post("/planner/unschedule", async (c) => {
    const hub = c.get("hub");
    const body = await readJsonObject(c);
    const task = unscheduleTask(hub, body);
    return c.json(hub.store.get(task.id) ?? task);
  });

  r.get("/planner/today", (c) => c.json(todayView(c.get("hub"), new Date(), parseMinHours(c.req.query("min_hours")))));

  r.post("/watches/:id/renewed", (c) => {
    const hub = c.get("hub");
    return c.json(renewWatch(hub.store, c.req.param("id")));
  });

  r.get("/watches/:id/reminder", (c) => {
    const hub = c.get("hub");
    const w = hub.store.get(c.req.param("id"));
    if (!w || w.kind !== "watch" || w.deleted_at) throw new StoreError(404, "watch not found");
    return c.json(linkedReminder(hub.store, w));
  });

  return r;
}
