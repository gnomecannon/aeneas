import { Hono } from "hono";
import type { Hub } from "../hub.js";
import { readJsonObject } from "../http.js";
import { StoreError } from "../store.js";
import { MAX_PICTURE_BYTES } from "../layouts.js";

/** Layout sketches (module `layouts`): pictures of screens with parts moved, to show how a screen should look. */
export function layoutRoutes() {
  const r = new Hono<{ Variables: { hub: Hub } }>();

  /** The raw picture as the body (PNG, JPEG or WebP, 20 MB at most). */
  r.post("/layouts/pictures", async (c) => {
    const buf = Buffer.from(await c.req.arrayBuffer());
    if (buf.length > MAX_PICTURE_BYTES) throw new StoreError(413, "the picture is over 20 MB");
    return c.json(c.get("hub").layouts.savePicture(buf), 201);
  });
  r.get("/layouts/pictures/:id", (c) => {
    const img = c.get("hub").layouts.pictures.read(c.req.param("id"));
    if (!img) throw new StoreError(404, "picture not found");
    return c.body(new Uint8Array(img.data), 200, { "content-type": img.mime, "cache-control": "private, max-age=31536000, immutable" });
  });

  r.get("/layouts", (c) => c.json({ layouts: c.get("hub").layouts.list() }));
  r.post("/layouts", async (c) => c.json(c.get("hub").layouts.create(await readJsonObject(c)), 201));
  r.get("/layouts/:id", (c) => {
    const l = c.get("hub").layouts.get(c.req.param("id"));
    if (!l) throw new StoreError(404, "layout not found");
    return c.json(l);
  });
  r.put("/layouts/:id", async (c) => c.json(c.get("hub").layouts.update(c.req.param("id"), await readJsonObject(c))));
  r.delete("/layouts/:id", (c) => {
    c.get("hub").layouts.remove(c.req.param("id"));
    return c.json({ ok: true });
  });
  return r;
}
