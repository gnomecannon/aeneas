import { Hono } from "hono";
import type { Hub } from "../hub.js";
import { readJsonObject } from "../http.js";
import { healthSummary, parseDays, setInjectionDay } from "../health.js";
import { petSummary } from "../pets.js";
import { listSensors, proposeSensorFix, recordReading, sensorCsv } from "../sensors.js";
import { markPicked, pickFood } from "../food.js";

/** Module 4: body (health summary, injection day), animals (pet summary), home (sensors) and food. */
export function homeRoutes() {
  const r = new Hono<{ Variables: { hub: Hub } }>();

  r.get("/health/summary", (c) => c.json(healthSummary(c.get("hub"), parseDays(c.req.query("days"), 30))));

  r.post("/health/injection-day", async (c) => {
    const hub = c.get("hub");
    const { reminder, created } = setInjectionDay(hub, await readJsonObject(c));
    return c.json(hub.store.get(reminder.id) ?? reminder, created ? 201 : 200);
  });

  // "_" is the owner's pet (profile), for the assistant's tool.
  r.get("/pets/:pet/summary", (c) => { const hub = c.get("hub"); const p = c.req.param("pet"); return c.json(petSummary(hub, p === "_" ? hub.profile.get().pet || "pet" : p)); });

  r.post("/sensors/:name/readings", async (c) => {
    const hub = c.get("hub");
    return c.json(recordReading(hub, c.req.param("name"), await readJsonObject(c)), 201);
  });

  r.get("/sensors", (c) => c.json(listSensors(c.get("hub"))));

  /** Tapping an alert: the assistant proposes a fix in a chat, to approve or cancel there. */
  r.post("/sensors/:name/propose", (c) => c.json(proposeSensorFix(c.get("hub"), c.req.param("name"))));

  r.get("/sensors/:name/csv", (c) => {
    const text = sensorCsv(c.get("hub"), c.req.param("name"), parseDays(c.req.query("days"), 30));
    return c.body(text, 200, { "content-type": "text/csv; charset=utf-8" });
  });

  r.post("/food/pick", async (c) => c.json(pickFood(c.get("hub"), await readJsonObject(c))));

  r.post("/food/picked", async (c) => {
    const hub = c.get("hub");
    const o = markPicked(hub, await readJsonObject(c));
    return c.json(hub.store.get(o.id) ?? o);
  });

  return r;
}
