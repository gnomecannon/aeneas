import { Hono } from "hono";
import type { Hub } from "../hub.js";
import { readJsonObject } from "../http.js";
import { StoreError } from "../store.js";
import { MAX_UPLOAD_BYTES, imageInfo, recordGenerated, recordImage } from "../gallery.js";
import { imageCancel, imageCapabilities, imageJob, imageJobs, imagePlan, imageSubmit, uploadReferences, imagesEnabled } from "../imagegen.js";

/**
 * Image generation through the shared image service. Screens send hub image ids as references (`references`);
 * the hub uploads them to the service. Every request passes the service's own validation, the same as the assistant's.
 */
export function imageRoutes() {
  const r = new Hono<{ Variables: { hub: Hub } }>();

  const withRefs = async (hub: Hub, body: Record<string, unknown>) => {
    if (!Array.isArray(body.references)) return body;
    return { ...body, references: await uploadReferences(hub, body.references) };
  };

  r.get("/images/capabilities", async (c) => {
    const hub = c.get("hub");
    if (!imagesEnabled(hub)) return c.json({ enabled: false });
    // `hardware`: the workers a person may pick by hand, with their labels (EA_IMAGE_WORKERS).
    return c.json({ enabled: true, ...(await imageCapabilities(hub)), hardware: hub.cfg.imageWorkers });
  });
  r.post("/images/plan", async (c) => {
    const hub = c.get("hub");
    return c.json(await imagePlan(hub, await withRefs(hub, await readJsonObject(c))));
  });
  r.post("/images/jobs", async (c) => {
    const hub = c.get("hub");
    const key = c.req.header("idempotency-key") ?? undefined;
    return c.json({ jobs: await imageSubmit(hub, await withRefs(hub, await readJsonObject(c)), key) }, 201);
  });
  r.get("/images/jobs", async (c) => c.json({ jobs: await imageJobs(c.get("hub"), Math.min(Number(c.req.query("limit")) || 30, 200)) }));
  r.get("/images/jobs/:id", async (c) => {
    const hub = c.get("hub");
    const job = await imageJob(hub, c.req.param("id"));
    // A finished image joins the gallery the first time anything looks at it (the timer catches the rest).
    const rec = job.status === "succeeded" ? recordGenerated(hub, job) : null;
    return c.json({ ...job, ...(rec ? { gallery_id: rec.id } : {}) });
  });

  /** Add a picture to the gallery's Saved bin: the raw image as the body (25 MB at most), `?source=` and `?name=`. */
  r.post("/images/library", async (c) => {
    const hub = c.get("hub");
    const source = c.req.query("source") ?? "uploaded";
    if (!["uploaded", "downloaded", "photos"].includes(source)) throw new StoreError(422, "source must be uploaded, downloaded or photos");
    const buf = Buffer.from(await c.req.arrayBuffer());
    if (buf.length > MAX_UPLOAD_BYTES) throw new StoreError(413, "image is over 25 MB");
    const id = hub.ai.images.saveBuffer(buf, MAX_UPLOAD_BYTES);
    const name = (c.req.query("name") ?? "").trim().slice(0, 120);
    const rec = recordImage(hub, id, source as "uploaded", name ? { title: name } : {});
    return c.json({ ...rec, info: imageInfo(buf) }, 201);
  });
  r.post("/images/jobs/:id/cancel", async (c) => {
    const id = c.req.param("id");
    if (!/^[0-9a-f]{32}$/.test(id)) throw new StoreError(404, "no such image job");
    return c.json(await imageCancel(c.get("hub"), id));
  });
  return r;
}
