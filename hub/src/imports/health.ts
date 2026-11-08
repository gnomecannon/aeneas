import { LogType } from "@everythingapp/shared";
import type { Hub } from "../hub.js";
import { StoreError } from "../store.js";
import { stableId } from "./util.js";

/**
 * Apple Health, sent by the iPhone: each sample becomes a `log` whose id comes from the sample's key (Health's own
 * sample id, or "steps:2026-10-28" for a day's total), so sending it again updates it instead of adding a copy.
 * `removed` keys are samples deleted in Health; their logs are deleted too. A workout (`activity` with `end`) is a
 * start log and an "end" log, the way the activity timer records one.
 */

const MAX = 5000;

/** Create, or change only what differs. A log deleted here stays deleted. */
function put(hub: Hub, id: string, fields: Record<string, unknown>): "created" | "updated" | "same" {
  const cur = hub.store.get(id);
  if (!cur) {
    hub.store.create("log", fields, "personal", id);
    return "created";
  }
  if (cur.deleted_at) return "same";
  const changed = Object.fromEntries(Object.entries(fields).filter(([k, v]) => cur.fields[k] !== v));
  if (!Object.keys(changed).length) return "same";
  hub.store.patch(id, changed);
  return "updated";
}

export function importHealth(hub: Hub, body: Record<string, unknown>) {
  const samples = Array.isArray(body.samples) ? body.samples : [];
  const removed = Array.isArray(body.removed) ? body.removed : [];
  if (samples.length + removed.length > MAX) throw new StoreError(413, `at most ${MAX} samples per request`);
  let created = 0;
  let updated = 0;
  let deleted = 0;
  const bad: string[] = [];
  for (const s of samples as Record<string, unknown>[]) {
    const key = typeof s?.key === "string" ? s.key.trim() : "";
    const type = LogType.safeParse(s?.type);
    const value = s?.value;
    const at = typeof s?.at === "string" && !Number.isNaN(Date.parse(s.at)) ? new Date(s.at).toISOString() : null;
    if (!key || !type.success || !at || !(typeof value === "number" ? Number.isFinite(value) : typeof value === "string" && value.trim())) {
      bad.push(key || "?");
      continue;
    }
    const fields: Record<string, unknown> = { type: type.data, value, at, source: "iphone", note: "Apple Health" };
    if (typeof s.unit === "string" && s.unit) fields.unit = s.unit;
    const r = put(hub, stableId(`health:${key}`), fields);
    if (r === "created") created++;
    if (r === "updated") updated++;
    const end = typeof s.end === "string" && !Number.isNaN(Date.parse(s.end)) ? new Date(s.end).toISOString() : null;
    if (type.data === "activity" && end) put(hub, stableId(`health:${key}:end`), { type: "activity", value, at: end, source: "iphone", note: "end" });
  }
  for (const k of removed) {
    if (typeof k !== "string") continue;
    for (const id of [stableId(`health:${k}`), stableId(`health:${k}:end`)]) {
      const cur = hub.store.get(id);
      if (cur && !cur.deleted_at) {
        hub.store.patch(id, { deleted_at: new Date().toISOString() });
        if (cur.fields.note !== "end") deleted++;
      }
    }
  }
  // The first importer (weight and sleep only, note "healthkit") wrote copies of what this one sends; they go.
  let legacy = 0;
  for (const e of hub.store.list({ kind: "log", limit: 1_000_000 })) {
    if (e.fields.note === "healthkit") {
      hub.store.patch(e.id, { deleted_at: new Date().toISOString() });
      legacy++;
    }
  }
  const total = hub.store.list({ kind: "log", limit: 1_000_000 }).filter((e) => e.fields.note === "Apple Health").length;
  hub.connections.update((c) => { c.health = { last_import: new Date().toISOString(), samples: samples.length, total }; });
  return { received: samples.length, created, updated, deleted, legacy_removed: legacy, rejected: bad.length, ...(bad.length ? { rejected_keys: bad.slice(0, 20) } : {}) };
}
