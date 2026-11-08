import { Hono } from "hono";
import type { Hub } from "../hub.js";
import { readJsonObject } from "../http.js";
import { parseDays } from "../health.js";
import { StoreError } from "../store.js";
import { availableMetrics, dashboardBoard, dashboardPrefs, metricSeries } from "../dashboard.js";

/** The general dashboard: metrics with data, one metric's daily series, the whole board, and the tile choice. */
export function dashboardRoutes() {
  const r = new Hono<{ Variables: { hub: Hub } }>();

  r.get("/dashboard/metrics", (c) => c.json({ metrics: availableMetrics(c.get("hub")) }));

  r.get("/dashboard/series", (c) => {
    const metric = c.req.query("metric") ?? "";
    if (!metric.trim()) throw new StoreError(400, "metric required");
    return c.json(metricSeries(c.get("hub"), metric, parseDays(c.req.query("days"), 30)));
  });

  r.get("/dashboard/board", (c) => c.json(dashboardBoard(c.get("hub"))));

  // The tiles, one setting for every device. Nothing saved yet: defaults from the metrics that have data.
  r.get("/prefs/dashboard", (c) => c.json(dashboardPrefs(c.get("hub"))));
  r.put("/prefs/dashboard", async (c) => {
    const hub = c.get("hub");
    hub.dashboard.set(await readJsonObject(c));
    return c.json(dashboardPrefs(hub));
  });
  r.delete("/prefs/dashboard", (c) => {
    const hub = c.get("hub");
    hub.dashboard.reset();
    return c.json(dashboardPrefs(hub));
  });

  return r;
}
