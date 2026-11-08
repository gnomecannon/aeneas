import type { Entity } from "@everythingapp/shared";
import { withPriority } from "./ai/backends.js";
import type { Hub } from "./hub.js";
import { StoreError } from "./store.js";
import { scheduleDaily } from "./schedule.js";
import { diaryDay } from "./diary.js";
import { personalize } from "./profile.js";
import { errCode } from "./logsafe.js";

/**
 * Module 4, home. Microcontrollers post readings; the hub keeps one `sensor` row per name with the latest
 * value and a state (`ok | low | high | stale`) and emits a `sensor` notify once per state change. Readings
 * are ordinary entities but are read through SQL by sensor and time, never listed whole, and are purged
 * nightly past EA_READING_KEEP_DAYS.
 */

const DAY_MS = 24 * 3600_000;
const MINUTE_MS = 60_000;
export const SERIES_MAX_POINTS = 288;
const NAME_RE = /^[a-z0-9_.-]+$/i;

export interface Point { at: string; value: number }
export type SensorState = "ok" | "low" | "high" | "stale";

export function sensorByName(hub: Hub, name: string): Entity | null {
  return hub.store.list({ kind: "sensor", limit: 10000 }).find((s) => s.fields.name === name) ?? null;
}

/** Where a value sits against the sensor's thresholds. */
export function stateFor(s: Entity, value: number): SensorState {
  const min = typeof s.fields.min === "number" ? s.fields.min : undefined;
  const max = typeof s.fields.max === "number" ? s.fields.max : undefined;
  if (min !== undefined && value < min) return "low";
  if (max !== undefined && value > max) return "high";
  return "ok";
}

function emitState(hub: Hub, s: Entity, state: SensorState, value: number | null, at: string): void {
  if (s.fields.alert === false) return;
  const name = String(s.fields.name);
  const unit = String(s.fields.unit ?? "");
  const shown = value === null ? "no reading" : `${value}${unit ? " " + unit : ""}`;
  hub.bus.emit("notify", { id: `sensor:${name}:${state}:${at}`, kind: "sensor", title: `${name} ${state}: ${shown}`, at, name, value, unit, state });
}

/**
 * Store one reading and move the sensor with it. The sensor row is created on first contact. A reading older
 * than `last_at` is stored but does not move the state. State changes notify once each: into low or high,
 * back to ok (from low, high or stale).
 */
export function recordReading(hub: Hub, name: string, body: { value?: unknown; at?: unknown; unit?: unknown }, now: Date = new Date()): Entity {
  if (!NAME_RE.test(name)) throw new StoreError(422, "sensor name must be letters, digits, _ . or -");
  // The sensors key may travel in plain HTTP on the home network: names and counts are bounded, so a stray board or
  // anyone who sees the key cannot fill every device with sensors.
  if (name.length > 80) throw new StoreError(422, "sensor name must be at most 80 characters");
  const value = typeof body.value === "number" ? body.value : parseFloat(String(body.value ?? ""));
  if (!Number.isFinite(value)) throw new StoreError(422, "value must be a number");
  const atDate = body.at === undefined || body.at === null || body.at === "" ? now : new Date(String(body.at));
  if (Number.isNaN(atDate.getTime())) throw new StoreError(422, "at must be an ISO datetime");
  // A reading dated far ahead (a bad clock, or on purpose: 9999) would hold the sensor's state for good, since a
  // reading older than the last is not used; more than a day ahead or a year back is refused.
  if (atDate.getTime() > now.getTime() + DAY_MS) throw new StoreError(422, "at is more than a day in the future");
  if (atDate.getTime() < now.getTime() - 366 * DAY_MS) throw new StoreError(422, "at is more than a year in the past");
  const at = atDate.toISOString();
  const unit = typeof body.unit === "string" && body.unit.trim() ? body.unit.trim() : undefined;

  let sensor = sensorByName(hub, name);
  if (!sensor) {
    if (hub.store.list({ kind: "sensor", limit: 10000 }).length >= 500) throw new StoreError(422, "there are 500 sensors already; remove some first");
    sensor = hub.store.create("sensor", { name, unit: unit ?? "" });
  }
  const reading = hub.store.create("reading", { sensor: name, value, at, ...(unit ? { unit } : {}) });

  const lastAt = typeof sensor.fields.last_at === "string" ? sensor.fields.last_at : "";
  if (at < lastAt) return reading;
  const prev = sensor.fields.state as SensorState | undefined;
  const state = stateFor(sensor, value);
  const diff: Record<string, unknown> = { last_at: at, last_value: value };
  if (state !== prev) diff.state = state;
  if (unit && !sensor.fields.unit) diff.unit = unit;
  // last_at and last_value change with every reading: written quietly. Only a new state (or unit) wakes clients.
  if (diff.state !== undefined || diff.unit !== undefined) hub.store.patch(sensor.id, diff);
  else hub.store.patchSilent(sensor.id, diff);
  // A first reading that is already out of range (a new pool already DEGRADED, a disk already at 97%) says so too:
  // with no change after it, it would never have been said at all.
  if (state !== prev && (prev !== undefined || state !== "ok")) emitState(hub, sensor, state, value, at);
  return reading;
}

/** Readings of one sensor since `since`, oldest first, straight from SQL. */
export function readingsSince(hub: Hub, name: string, since: Date): Point[] {
  const rows = hub.db.prepare(
    "SELECT json_extract(fields, '$.at') AS at, json_extract(fields, '$.value') AS value FROM entities WHERE kind = 'reading' AND deleted_at IS NULL AND json_extract(fields, '$.sensor') = ? AND json_extract(fields, '$.at') >= ? ORDER BY at ASC",
  ).all(name, since.toISOString()) as { at: string; value: number }[];
  return rows.filter((r) => typeof r.at === "string" && Number.isFinite(Number(r.value))).map((r) => ({ at: r.at, value: Number(r.value) }));
}

/** At most `max` points: equal-count buckets, mean value, the bucket's last timestamp. */
export function downsample(points: Point[], max = SERIES_MAX_POINTS): Point[] {
  if (points.length <= max) return points;
  const out: Point[] = [];
  for (let b = 0; b < max; b++) {
    const start = Math.floor((b * points.length) / max);
    const end = Math.floor(((b + 1) * points.length) / max);
    if (end <= start) continue;
    let sum = 0;
    for (let i = start; i < end; i++) sum += points[i].value;
    out.push({ at: points[end - 1].at, value: Math.round((sum / (end - start)) * 1000) / 1000 });
  }
  return out;
}

export function listSensors(hub: Hub, now: Date = new Date()): (Entity & { series_24h: Point[] })[] {
  const since = new Date(now.getTime() - DAY_MS);
  return hub.store.list({ kind: "sensor", limit: 10000 })
    .sort((a, b) => String(a.fields.name).localeCompare(String(b.fields.name)))
    .map((s) => Object.assign({}, s, { series_24h: downsample(readingsSince(hub, String(s.fields.name), since)) }));
}

export function sensorCsv(hub: Hub, name: string, days: number, now: Date = new Date()): string {
  const s = sensorByName(hub, name);
  if (!s) throw new StoreError(404, "sensor not found");
  const unit = String(s.fields.unit ?? "");
  const csv = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = ["at,value,unit"];
  for (const p of readingsSince(hub, name, new Date(now.getTime() - days * DAY_MS))) lines.push(`${p.at},${p.value},${csv(unit)}`);
  return lines.join("\n") + "\n";
}

/** The minute tick: a sensor with no reading for `stale_minutes` goes `stale`, with one notify. */
export function sensorTick(hub: Hub, now: Date = new Date()): string[] {
  const stale: string[] = [];
  for (const s of hub.store.list({ kind: "sensor", limit: 10000 })) {
    if (typeof s.fields.last_at !== "string" || s.fields.state === "stale") continue;
    const minutes = typeof s.fields.stale_minutes === "number" && s.fields.stale_minutes > 0 ? s.fields.stale_minutes : 180;
    const last = new Date(s.fields.last_at).getTime();
    if (!Number.isFinite(last) || now.getTime() - last < minutes * MINUTE_MS) continue;
    hub.store.patch(s.id, { state: "stale" });
    emitState(hub, s, "stale", null, now.toISOString());
    stale.push(String(s.fields.name));
  }
  return stale;
}

/** Hard delete readings older than the retention window. Returns the number removed. */
export function purgeReadings(hub: Hub, keepDays: number = hub.cfg.readingKeepDays, now: Date = new Date()): number {
  const cutoff = new Date(now.getTime() - Math.max(1, keepDays) * DAY_MS).toISOString();
  const ids = (hub.db.prepare("SELECT id FROM entities WHERE kind = 'reading' AND json_extract(fields, '$.at') < ?").all(cutoff) as { id: string }[]).map((r) => r.id);
  const n = hub.store.purge(ids);
  if (n) console.log(`[sensors] purged ${n} readings older than ${keepDays} days`);
  return n;
}

/** Once a night at 03:20 local. */
export function startReadingPurgeJob(hub: Hub): () => void {
  return scheduleDaily("readings", 3, 20, () => { purgeReadings(hub); });
}

export function homeStatus(hub: Hub, now: Date = new Date()): { sensors: number; sensors_alerting: number; readings_24h: number; pet_events_30d: number; food_options: number } {
  const sensors = hub.store.list({ kind: "sensor", limit: 10000 });
  const since24 = new Date(now.getTime() - DAY_MS).toISOString();
  const since30 = now.getTime() - 30 * DAY_MS;
  const readings = (hub.db.prepare("SELECT COUNT(*) AS n FROM entities WHERE kind = 'reading' AND deleted_at IS NULL AND json_extract(fields, '$.at') >= ?").get(since24) as { n: number }).n;
  return {
    sensors: sensors.length,
    sensors_alerting: sensors.filter((s) => s.fields.state === "low" || s.fields.state === "high" || s.fields.state === "stale").length,
    readings_24h: readings,
    pet_events_30d: hub.store.list({ kind: "pet_event", limit: 100000 }).filter((e) => new Date(String(e.fields.at ?? "")).getTime() >= since30).length,
    food_options: hub.store.list({ kind: "food_option", limit: 10000 }).length,
  };
}

/**
 * Tapping an alert: the assistant looks into a sensor that is out of bounds or stale and proposes one fix. It
 * investigates on the sensor's host with read-only commands (those run at once), then asks to run a single change,
 * which waits in the chat for the owner to approve (Run) or cancel; nothing is changed before that. The chat runs on the
 * hub, so it continues whichever device opens it. One chat per sensor, state and day: tapping again opens the same one.
 */
export function proposeSensorFix(hub: Hub, name: string, now: Date = new Date()): { session_id: string; started: boolean } {
  const s = sensorByName(hub, name);
  if (!s || s.deleted_at) throw new StoreError(404, "sensor not found");
  const state = String(s.fields.state ?? "ok");
  if (state === "ok") throw new StoreError(409, "this sensor is not alerting");
  const sid = `alert-${s.id.slice(0, 8)}-${state}-${diaryDay(now).replace(/-/g, "")}`;
  if (hub.ai.sessions.get(sid)) return { session_id: sid, started: false };
  if (!hub.ai.available()) throw new StoreError(503, "no model is reachable");
  const unit = String(s.fields.unit ?? "");
  const value = typeof s.fields.last_value === "number" ? `${s.fields.last_value}${unit ? ` ${unit}` : ""}` : "no reading";
  const host = String(s.fields.location ?? "").trim();
  const bounds = [typeof s.fields.min === "number" ? `below ${s.fields.min}` : "", typeof s.fields.max === "number" ? `above ${s.fields.max}` : ""].filter(Boolean).join(" or ");
  const recent = readingsSince(hub, name, new Date(now.getTime() - DAY_MS)).slice(-6).map((p) => `${p.value} at ${new Date(p.at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`);
  const what = state === "stale" ? `has sent no reading for over ${Number(s.fields.stale_minutes ?? 180)} minutes (last: ${value})` : `is ${state}: ${value}${bounds ? ` (it alerts ${bounds})` : ""}`;
  const prompt = [
    `[Sensor alert] ${name}${host ? ` on ${host}` : ""} ${what}.${recent.length ? ` Readings in the last day, newest last: ${recent.join(", ")}.` : ""}`,
    `Find the cause first, with read-only commands${host ? ` on ${host}` : ""}.`,
    "Then propose one fix: in two or three sentences say what you found and what the fix changes, and ask to run it as a single host command, which waits for {{owner}} to approve or cancel. Never run anything that changes the host before {{owner}} approves it.",
    "If no command can fix it (hardware, a setting somewhere else, or it is fine as it is and the bounds are wrong), say what to do instead and propose no command.",
  ].join(" ");
  hub.ai.sessions.save(sid, "troubleshoot", []);
  hub.ai.sessions.rename(sid, `Alert: ${name} ${state}`);
  void withPriority("filing", () => hub.ai.chat({ session_id: sid, task_type: "troubleshoot", messages: [{ role: "user", content: personalize(prompt, hub.profile.get().name, hub.profile.get().pet) }], store_as: `${name}${host ? ` on ${host}` : ""} ${what}. Find the cause and propose a fix for me to approve.` }))
    .catch((e) => console.error(`[sensors] fix for ${s.id}: ${errCode(e)}`));
  return { session_id: sid, started: true };
}
