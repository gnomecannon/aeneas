import { appendDiary } from "../diary.js";
import { queueFiling, sortCapture } from "../capture-filer.js";
import { Hono } from "hono";
import { CaptureRequest, effectiveAt, Kind, LogType, nowIso, Space } from "@everythingapp/shared";
import type { Entity } from "@everythingapp/shared";
import { moduleOfKind } from "../modules.js";
import { StoreError } from "../store.js";
import type { Hub } from "../hub.js";
import { convertCapture } from "../capture.js";
import { relatedItems } from "../related.js";
import { readJsonObject } from "../http.js";
import { ackReminder, pendingReminders, snoozeReminder } from "../reminders.js";
import { assertWorkAllowed, setWorkSpace, workCounts } from "../work.js";
import { feelView } from "../feel.js";
import { entitiesCsv } from "../csv.js";
import { dayKey } from "../metrics.js";
import { inAppUnits } from "../health.js";

const RESERVED_QUERY = new Set(["kind", "space", "limit", "include_deleted", "token", "key"]);

export function entityRoutes() {
  const r = new Hono<{ Variables: { hub: Hub } }>();

  // ---- entities ----
  r.get("/entities", (c) => {
    const hub = c.get("hub");
    const kind = c.req.query("kind") || undefined;
    if (kind && !Kind.safeParse(kind).success) throw new StoreError(400, "unknown kind");
    const space = c.req.query("space") || undefined;
    if (space && !Space.safeParse(space).success) throw new StoreError(400, "space must be personal or work");
    const wanted = parseInt(c.req.query("limit") ?? "", 10);
    const limit = Math.min(wanted > 0 ? wanted : 100, 1000);
    const where: Record<string, string> = {};
    for (const [k, v] of Object.entries(c.req.query())) if (!RESERVED_QUERY.has(k)) where[k] = v;
    const includeDeleted = c.req.query("include_deleted") === "true";
    return c.json(hub.store.list({ kind, space, limit, where, includeDeleted }));
  });

  /** Every item of one kind as a CSV download. Same filters as GET /entities (space, field=value), no limit. */
  r.get("/export/csv/:kind", (c) => {
    const hub = c.get("hub");
    const kind = c.req.param("kind").replace(/\.csv$/i, "");
    if (!Kind.safeParse(kind).success) throw new StoreError(400, "unknown kind");
    const space = c.req.query("space") || undefined;
    if (space && !Space.safeParse(space).success) throw new StoreError(400, "space must be personal or work");
    const where: Record<string, string> = {};
    for (const [k, v] of Object.entries(c.req.query())) if (!RESERVED_QUERY.has(k)) where[k] = v;
    // Oldest first: by the item's own time when it has one (logs, events), else when it was made.
    const when = (e: Entity) => String(e.fields.at ?? e.fields.start ?? e.created_at);
    const rows = hub.store.list({ kind, space, where }).sort((a, b) => when(a).localeCompare(when(b)) || a.created_at.localeCompare(b.created_at));
    const name = `${kind}-${dayKey(new Date())}.csv`;
    return c.body(entitiesCsv(rows), 200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}"` });
  });

  r.get("/entities/:id", (c) => {
    const e = c.get("hub").store.get(c.req.param("id"));
    if (!e) throw new StoreError(404, "entity not found");
    return c.json(e);
  });

  r.get("/entities/:id/related", (c) => c.json({ items: relatedItems(c.get("hub").store, c.req.param("id")) }));

  r.post("/entities", async (c) => {
    const hub = c.get("hub");
    const body = await readJsonObject<{ kind?: string; space?: string; fields?: Record<string, unknown> }>(c);
    const kind = Kind.parse(body.kind);
    const space = body.space ? Space.parse(body.space) : "personal";
    if (!body.fields || typeof body.fields !== "object") throw new StoreError(422, "fields object required");
    assertWorkAllowed(hub, space);
    // re-read: after-write hooks (vault, knowledge map) may have added derived fields
    const made = hub.store.create(kind, body.fields, space);
    return c.json(hub.store.get(made.id) ?? made, 201);
  });

  r.patch("/entities/:id", async (c) => {
    const hub = c.get("hub");
    const body = await readJsonObject<{ fields?: Record<string, unknown> }>(c);
    if (!body.fields || typeof body.fields !== "object") throw new StoreError(422, "fields object required");
    // As on sync: while the work space is off no edit reaches it (a PATCH after an erase brought the item back).
    assertWorkAllowed(hub, hub.store.get(c.req.param("id"))?.space);
    const patched = hub.store.patch(c.req.param("id"), body.fields);
    return c.json(hub.store.get(patched.id) ?? patched);
  });

  r.delete("/entities/:id", (c) => {
    const hub = c.get("hub");
    assertWorkAllowed(hub, hub.store.get(c.req.param("id"))?.space);
    return c.json(hub.store.patch(c.req.param("id"), { deleted_at: nowIso() }));
  });

  // ---- capture ----
  r.post("/capture", async (c) => {
    const hub = c.get("hub");
    const body = CaptureRequest.parse(await readJsonObject(c));
    if (body.id) {
      // Sent again after its reply was lost (the Watch relay, a dropped connection): the capture the hub already has.
      const had = hub.store.get(body.id);
      if (had) {
        if (had.kind !== "capture") throw new StoreError(409, "that id belongs to something else");
        return c.json({ capture: had, suggested_kind: String(had.fields.suggested_kind ?? "none") }, 200);
      }
    }
    const capture = hub.store.create("capture", { text: body.text, source: body.source, ...(body.attachments ? { attachments: body.attachments } : {}), processed: false, suggested_kind: "none" }, "personal", body.id);
    if (!body.auto) return c.json({ capture, suggested_kind: "none" }, 201);
    const sorted = sortCapture(hub, capture);
    return c.json({ capture: sorted.capture, suggested_kind: sorted.suggested, ...(sorted.created.length ? { created: sorted.created } : {}) }, 201);

  });

  /** Have the assistant file a capture now (one that waited in Unsorted Info, or a retry); answers when it is done. */
  r.post("/capture/:id/file", async (c) => {
    const hub = c.get("hub");
    const capture = hub.store.get(c.req.param("id"));
    if (!capture || capture.kind !== "capture") throw new StoreError(404, "capture not found");
    if (!capture.fields.diary_id) hub.store.patch(capture.id, { diary_id: appendDiary(hub.store, String(capture.fields.text ?? ""), new Date(capture.created_at)).id });
    hub.store.patch(capture.id, { filing: "pending", filing_attempts: 0, processed: true, sorted_by: "auto" });
    await queueFiling(hub, capture.id);
    return c.json(hub.store.get(capture.id));
  });

  r.post("/capture/:id/convert", async (c) => {
    const hub = c.get("hub");
    const capture = hub.store.get(c.req.param("id"));
    if (!capture || capture.kind !== "capture") throw new StoreError(404, "capture not found");
    const body = await readJsonObject<{ kind?: string; fields?: Record<string, unknown> }>(c);
    if (!body.kind) throw new StoreError(422, "kind required");
    const created = convertCapture(hub.store, capture, body.kind, body.fields ?? {});
    return c.json(created, 201);
  });

  // ---- reminders ----
  r.post("/reminders/:id/snooze", async (c) => {
    const hub = c.get("hub");
    const body = await readJsonObject<{ until?: string; reason?: string }>(c);
    const updated = await snoozeReminder(hub.store, c.req.param("id"), { until: String(body.until ?? ""), reason: body.reason });
    return c.json(updated);
  });

  // The work space switch. Turning it off erases every work item on every device; the body must confirm that.
  r.get("/space/work", (c) => c.json({ enabled: c.get("hub").work.enabled, ...workCounts(c.get("hub")) }));
  r.put("/space/work", async (c) => {
    const hub = c.get("hub");
    const body = await readJsonObject<{ enabled?: boolean; confirm?: string }>(c);
    if (typeof body.enabled !== "boolean") throw new StoreError(422, "enabled must be true or false");
    if (!body.enabled && body.confirm !== "erase work") throw new StoreError(422, 'turning the work space off erases it: send {"enabled": false, "confirm": "erase work"}');
    return c.json(setWorkSpace(hub, body.enabled));
  });

  // How the app feels on every device: shapes, tap notes, key, scale and synth.
  r.get("/prefs/feel", (c) => c.json(feelView(c.get("hub"))));
  r.put("/prefs/feel", async (c) => {
    const hub = c.get("hub");
    hub.feel.set(await readJsonObject(c));
    return c.json(feelView(hub));
  });
  // Image shapes: the raw PNG or WebP as the body, `?name=` for its label. Shrink to about 256 px before sending.
  r.post("/prefs/feel/images", async (c) => {
    const hub = c.get("hub");
    const type = (c.req.header("content-type") ?? "").split(";")[0].trim().toLowerCase();
    hub.feel.addImage(new Uint8Array(await c.req.arrayBuffer()), type, c.req.query("name") ?? "");
    return c.json(feelView(hub), 201);
  });
  r.get("/prefs/feel/images/:id", (c) => {
    const img = c.get("hub").feel.image(c.req.param("id"));
    return c.body(new Uint8Array(img.bytes), 200, { "content-type": img.type, "cache-control": "private, max-age=86400" });
  });
  r.delete("/prefs/feel/images/:id", (c) => {
    const hub = c.get("hub");
    hub.feel.removeImage(c.req.param("id"));
    return c.json(feelView(hub));
  });

  r.post("/reminders/:id/ack", (c) => {
    const hub = c.get("hub");
    return c.json(ackReminder(hub.store, c.req.param("id")));
  });

  // ---- search ----
  r.get("/search", (c) => {
    const hub = c.get("hub");
    const q = (c.req.query("q") ?? "").trim();
    if (!q) throw new StoreError(400, "q required");
    const kinds = (c.req.query("kinds") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 200);
    // Items of a module that is off stay out of search, as their screens do.
    const shown = (kind: string) => { const m = moduleOfKind(kind); return !m || hub.modules.on(m); };
    // Assistant chats too (kept in the chat database, not as items), unless the search asks for item kinds only.
    const chats = !kinds.length || kinds.includes("chat") ? hub.ai.sessions.search(q, Math.min(limit, 20)) : [];
    return c.json({ hits: hub.store.search(q, { kinds: kinds.filter((k) => k !== "chat"), limit: limit * 2 }).filter((h) => shown(h.kind)).slice(0, limit), chats });
  });

  // ---- logs and dashboard ----
  r.post("/log", async (c) => {
    const hub = c.get("hub");
    const body = await readJsonObject<{ type?: string; value?: unknown; unit?: string; at?: string; note?: string; source?: string }>(c);
    const type = LogType.parse(body.type);
    if (body.value === undefined || body.value === null) throw new StoreError(422, "value required");
    const fields: Record<string, unknown> = { type, value: body.value, at: body.at ?? nowIso() };
    if (body.unit) fields.unit = body.unit;
    if (body.note) fields.note = body.note;
    if (body.source) fields.source = body.source;
    return c.json(hub.store.create("log", inAppUnits(fields)), 201);
  });

  r.get("/dashboard", (c) => {
    const hub = c.get("hub");
    const tasks = hub.store.list({ kind: "task" });
    const byOrder = (a: Entity, b: Entity) => Number(a.fields.order ?? 0) - Number(b.fields.order ?? 0) || a.created_at.localeCompare(b.created_at);
    const doing = tasks.filter((t) => t.fields.status === "doing").sort(byOrder);
    const nextTasks = tasks.filter((t) => t.fields.status === "next").sort(byOrder);
    const now = doing[0] ?? nextTasks[0] ?? null;
    const next = nextTasks.filter((t) => t.id !== now?.id).slice(0, 10);

    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);
    const reminders_today = pendingReminders(hub.store).filter(({ eff }) => eff <= endOfDay.toISOString()).map(({ t }) => t);

    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const logs_7d: Record<string, { at: string; value: number | string }[]> = {};
    for (const l of hub.store.list({ kind: "log" })) {
      const at = String(l.fields.at ?? "");
      if (at < since) continue;
      const type = String(l.fields.type ?? "custom");
      (logs_7d[type] ??= []).push({ at, value: l.fields.value as number | string });
    }
    for (const arr of Object.values(logs_7d)) arr.sort((a, b) => a.at.localeCompare(b.at));

    const captures_unprocessed = hub.store.list({ kind: "capture" }).filter((cp) => cp.fields.processed !== true).length;
    const projects_active = hub.store.list({ kind: "project" }).filter((p) => p.fields.status === "active");
    return c.json({ now, next, reminders_today, logs_7d, captures_unprocessed, projects_active });
  });

  return r;
}
