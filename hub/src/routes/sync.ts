import { Hono } from "hono";
import { assertWorkAllowed } from "../work.js";
import { PushRequest } from "@everythingapp/shared";
import { readJsonObject } from "../http.js";
import { StoreError } from "../store.js";
import type { Hub } from "../hub.js";
import { errCode } from "../logsafe.js";

/** Errors of the database or the disk, which pass: SQLite busy or locked, the disk full, an I/O error. */
function transient(e: unknown): boolean {
  if (e instanceof StoreError) return false;
  const code = String((e as { code?: unknown })?.code ?? "");
  return /^SQLITE_(BUSY|LOCKED|FULL|IOERR|CANTOPEN|READONLY|PROTOCOL)/.test(code) || code === "ENOSPC" || code === "EIO";
}

export function syncRoutes() {
  const r = new Hono<{ Variables: { hub: Hub; device_id?: string } }>();

  r.get("/sync/changes", (c) => {
    const hub = c.get("hub");
    const deviceId = c.req.query("device_id");
    if (deviceId) { c.set("device_id", deviceId); hub.devices.touch(deviceId); }
    const since = parseInt(c.req.query("since") ?? "0", 10);
    if (!Number.isFinite(since) || since < 0) throw new StoreError(400, "since must be a non-negative integer");
    const kinds = (c.req.query("kinds") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const space = c.req.query("space") || undefined;
    if (space && space !== "personal" && space !== "work") throw new StoreError(400, "space must be personal or work");
    // A cursor past the hub's latest seq (the hub was restored from an older copy, or the device synced with
    // another hub) would get nothing until the hub caught up: the device starts over from the beginning instead.
    const reset = since > hub.store.seq();
    // Readings are high volume; they ride the feed only when asked for by kind.
    const page = hub.store.changes(reset ? 0 : since, { kinds, excludeKinds: ["reading"], space, limit: 500 });
    return c.json(reset ? { ...page, reset: true } : page);
  });

  r.post("/sync/push", async (c) => {
    const hub = c.get("hub");
    const body = PushRequest.parse(await readJsonObject(c));
    if (body.device_id) c.set("device_id", body.device_id);
    const applied: { id: string; seq: number }[] = [];
    const rejected: { id: string; reason: string }[] = [];
    for (const patch of body.patches) {
      try {
        assertWorkAllowed(hub, patch.space ?? hub.store.get(patch.id)?.space);
        // A device's own copy of a capture the hub already has (its reply to POST /capture was lost after the hub
        // saved and filed it) brings nothing new: its processed false, being newer, put a filed capture back in
        // Unsorted Info, where a tap on File it filed it twice. Only fields the hub's copy never had (a photo) go in: a
        // field the hub cleared on purpose (the photo of a work: capture, moved out of the personal space) has a stamp
        // and stays cleared.
        const had = patch.kind === "capture" && patch.create ? hub.store.get(patch.id) : null;
        if (had && !had.deleted_at) {
          const missing = Object.fromEntries(Object.entries(patch.fields).filter(([k]) => had.fields[k] === undefined && had.field_ts[k] === undefined && !["processed", "sort", "suggested_kind", "filing", "filed"].includes(k)));
          if (!Object.keys(missing).length) { applied.push({ id: patch.id, seq: hub.store.seq() }); continue; }
          const res = hub.store.apply({ ...patch, create: false, fields: missing });
          applied.push({ id: patch.id, seq: res.seq });
          continue;
        }
        const res = hub.store.apply(patch);
        applied.push({ id: patch.id, seq: res.seq });
      } catch (e) {
        // The database busy, full or failing is not this edit's fault: the push stops with 503 and the device keeps
        // every edit not applied yet to send again. Listed as rejected, the device would have thrown it away.
        if (transient(e)) {
          console.error(`[sync] push stopped: ${errCode(e)}`);
          return c.json({ error: "the hub could not save right now; your edits are kept and sent again", applied, seq: hub.store.seq() }, 503);
        }
        const reason = e instanceof StoreError ? `${e.message}${e.detail ? ": " + JSON.stringify(e.detail).slice(0, 300) : ""}` : (e as Error).message;
        rejected.push({ id: patch.id, reason });
      }
    }
    hub.devices.touch(body.device_id);
    return c.json({ applied, rejected, seq: hub.store.seq() });
  });

  return r;
}
