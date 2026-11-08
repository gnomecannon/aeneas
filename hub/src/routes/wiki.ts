import { Hono } from "hono";
import type { Hub } from "../hub.js";
import { readJsonObject } from "../http.js";
import { applyWikiFeed, wikiIndex, wikiMedia, wikiPage, wikiSearch, type WikiFeedBody } from "../wiki.js";

/** Game design wiki: the mirrored repo docs and Confluence pages, read-only. */
export function wikiRoutes() {
  const r = new Hono<{ Variables: { hub: Hub } }>();
  r.get("/wiki", (c) => c.json(wikiIndex(c.get("hub"))));
  r.get("/wiki/page", (c) => c.json(wikiPage(c.get("hub"), c.req.query("id") ?? "")));
  r.get("/wiki/search", (c) => c.json(wikiSearch(c.get("hub"), c.req.query("q") ?? "", Number(c.req.query("limit") ?? 30) || 30)));
  r.get("/wiki/media/:page/:file", (c) => {
    const m = wikiMedia(c.get("hub"), c.req.param("page"), decodeURIComponent(c.req.param("file")));
    return c.body(m.bytes, 200, { "content-type": m.type, "cache-control": "private, max-age=86400", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" });
  });
  r.post("/wiki/feed", async (c) => c.json(applyWikiFeed(c.get("hub"), await readJsonObject<WikiFeedBody & Record<string, unknown>>(c))));
  return r;
}
