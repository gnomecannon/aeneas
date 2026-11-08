import tls from "node:tls";
import { nextOccurrence } from "@everythingapp/shared";
import type { Entity } from "@everythingapp/shared";
import type { Hub } from "./hub.js";
import type { Store } from "./store.js";
import { StoreError } from "./store.js";
import { ackReminder, linkedTask, syncLinkedTask } from "./reminders.js";
import { scheduleDaily } from "./schedule.js";
import { localDateOf } from "./planner.js";
import { dayKey } from "./metrics.js";
import { errCode } from "./logsafe.js";

/**
 * Watches: renewals and expiries. Every active watch that needs the owner owns exactly one linked reminder,
 * `Renew: <title>`, planned `lead_days` before `due` at 09:00 local with friction `reason`. A watch on autopay
 * (`autopay: true`) renews by itself, so it has no reminder (it would only clutter Reminders) and its `due` rolls
 * forward by `repeat` once it passes. The reminder is made only in the two weeks before it fires (`reminderWindow`):
 * a renewal months away lives in Renewals, not in the owner's Reminders. It follows the watch on every write (an
 * after-write hook) and once a day at 04:00, which also makes it when it comes into the window, and watches with a
 * `probe_url` are probed over TLS then so `due` tracks the certificate's expiry.
 */

/** How long before it fires a renewal's reminder is made (and so reaches Apple Reminders). Tests may widen it. */
export const reminderWindow = { days: 14 };

export const PROBE_TIMEOUT_MS = 5000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** `trusted`: the chain verifies and the certificate is for that host name (what a browser would accept). */
export type TlsProbe = (url: string) => Promise<{ valid_to: string; trusted?: boolean; trust_error?: string }>;

/** Where the linked reminder fires: `due` minus `lead_days`, at 09:00 local. */
export function reminderTimeFor(due: string, leadDays: number): string {
  const d = localDateOf(due);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - leadDays, 9, 0, 0, 0).toISOString();
}

function leadOf(w: Entity): number {
  const n = Number(w.fields.lead_days);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 7;
}

/** The task a watch owns (its renewal reminder). Deleted tasks do not count. */
export function linkedReminder(store: Store, watch: Entity): Entity | null {
  return linkedTask(store, watch);
}

/**
 * Make the watch's task match the watch: `Renew: <title>`, reminding `lead_days` before `due` at 09:00 with the
 * deadline at `due`. Creates it when missing, re-plans it when `due` or `lead_days` moved (reopening and clearing
 * any snooze so the new plan fires), deletes it when the watch is deleted. Returns the task, or null when the watch is gone.
 */
export function syncWatchReminder(store: Store, watch: Entity, now: Date = new Date()): Entity | null {
  if (watch.kind !== "watch") return null;
  if (watch.deleted_at) return syncLinkedTask(store, watch, null, watch.deleted_at);
  if (watch.fields.autopay === true) return syncLinkedTask(store, watch, null);
  if (typeof watch.fields.due !== "string" || Number.isNaN(localDateOf(watch.fields.due).getTime())) return linkedReminder(store, watch);
  const due = localDateOf(watch.fields.due);
  const remindAt = reminderTimeFor(watch.fields.due, leadOf(watch));
  // Not yet: a reminder months away would sit in Reminders the whole time. The daily job makes it when it is near.
  if (Date.parse(remindAt) - now.getTime() > reminderWindow.days * 86400_000) return syncLinkedTask(store, watch, null);
  return syncLinkedTask(store, watch, {
    title: `Renew: ${String(watch.fields.title ?? "")}`,
    remind_at: remindAt,
    due: new Date(due.getFullYear(), due.getMonth(), due.getDate(), 9, 0, 0, 0).toISOString(),
    friction: "reason",
  });
}

/**
 * The user renewed it. With `repeat`, `due` rolls one step forward from the old due and the reminder is
 * re-planned by the hook; without, the reminder is acknowledged. `renewed_at` is set either way.
 */
export function renewWatch(store: Store, id: string, now: Date = new Date()): Entity {
  const w = store.get(id);
  if (!w || w.kind !== "watch" || w.deleted_at) throw new StoreError(404, "watch not found");
  const f = w.fields as { due: string; repeat?: string; renewed_at?: string };
  const nowStr = now.toISOString();
  // Renewed already in the last three days (the button, then the assistant hearing "I renewed it"): one renewal,
  // so the due date moves one period, not two.
  if (f.renewed_at && now.getTime() - Date.parse(f.renewed_at) < 3 * 86400_000) return w;
  if (f.repeat) {
    const next = rollDue(f.due, f.repeat);
    if (next) {
      store.patch(id, { due: next, renewed_at: nowStr });
      return store.get(id)!;
    }
  }
  store.patch(id, { renewed_at: nowStr });
  const after = store.get(id)!;
  const rem = linkedReminder(store, after);
  if (rem && rem.fields.status !== "done") ackReminder(store, rem.id, now);
  return store.get(id)!;
}

/** One repeat step forward from `due`. A date-only due stays date-only (local calendar), a datetime stays a datetime. */
export function rollDue(due: string, repeat: string): string | null {
  const base = localDateOf(due);
  if (Number.isNaN(base.getTime())) return null;
  const next = nextOccurrence(base.toISOString(), repeat, base);
  if (!next) return null;
  return DATE_ONLY.test(due) ? dayKey(new Date(next)) : next;
}

/** An autopay watch's `due` once it has passed: rolled by `repeat` to the first day from `now` on. Null when it has not passed. */
export function autopayDue(due: string, repeat: string, now: Date = new Date()): string | null {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const base = localDateOf(due);
  if (Number.isNaN(base.getTime()) || base.getTime() >= today.getTime()) return null;
  // Counted from the original due, so a charge on the 31st stays on the month's last day (Nov 30, Dec 31) instead
  // of moving to the 1st for good.
  const next = nextOccurrence(base.toISOString(), repeat, new Date(today.getTime() - 1));
  if (!next) return null;
  return DATE_ONLY.test(due) ? dayKey(new Date(next)) : next;
}

/** Read the expiry of the TLS certificate the host at `url` presents. Never validates the chain; expired certs still answer. */
export function probeTls(url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<{ valid_to: string; trusted: boolean; trust_error?: string }> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try { u = new URL(url); } catch { reject(new Error("invalid probe_url")); return; }
    if (u.protocol !== "https:") { reject(new Error("probe_url must be https")); return; }
    const port = u.port ? parseInt(u.port, 10) : 443;
    let done = false;
    const finish = (err: Error | null, valid_to?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const trusted = socket.authorized === true;
      const why = socket.authorizationError;
      socket.destroy();
      if (err) reject(err); else resolve({ valid_to: valid_to!, trusted, ...(trusted ? {} : { trust_error: String(why ?? "not trusted") }) });
    };
    // The handshake completes for any certificate so its expiry can be read; `authorized` then says whether the
    // chain verifies and the name matches (node checks both before it sets it).
    const socket = tls.connect({ host: u.hostname, port, servername: u.hostname, rejectUnauthorized: false }, () => {
      const cert = socket.getPeerCertificate();
      const raw = cert && typeof cert.valid_to === "string" ? cert.valid_to : "";
      const d = new Date(raw);
      if (!raw || Number.isNaN(d.getTime())) finish(new Error("no certificate expiry in the handshake"));
      else finish(null, d.toISOString());
    });
    const timer = setTimeout(() => finish(new Error(`timeout after ${timeoutMs} ms`)), timeoutMs);
    socket.on("error", (e) => finish(e));
  });
}

export interface WatchDailyResult { watches: number; reminders_synced: number; probed: number; probe_errors: number }

/** Probe one watch and write the outcome. Never throws. Returns true when the probe succeeded. */
export async function probeWatch(hub: Hub, watch: Entity): Promise<boolean> {
  const url = typeof watch.fields.probe_url === "string" ? watch.fields.probe_url : "";
  if (!url) return false;
  const at = new Date().toISOString();
  try {
    const r = await hub.tlsProbe(url);
    if (Number.isNaN(new Date(r.valid_to).getTime())) throw new Error("probe returned no date");
    // A fallback certificate (self-signed, or for another name) is not the one that renews: its date is not this due.
    if (r.trusted === false) throw new Error(`certificate not trusted: ${r.trust_error ?? "unknown"}`);
    hub.store.patch(watch.id, { due: r.valid_to, last_probe: at, last_probe_error: null });
    return true;
  } catch (e) {
    try { hub.store.patch(watch.id, { last_probe: at, last_probe_error: String((e as Error).message ?? e).slice(0, 300) }); } catch (e2) {
      console.error(`[watches] ${watch.id}: ${errCode(e2)}`);
    }
    return false;
  }
}

/** The daily job: every active watch gets its reminder checked and, with a `probe_url`, its certificate read. */
export async function watchDaily(hub: Hub): Promise<WatchDailyResult> {
  const out: WatchDailyResult = { watches: 0, reminders_synced: 0, probed: 0, probe_errors: 0 };
  for (const w of hub.store.list({ kind: "watch", limit: 100000 })) {
    out.watches++;
    if (typeof w.fields.probe_url === "string" && w.fields.probe_url) {
      out.probed++;
      if (!(await probeWatch(hub, w))) out.probe_errors++;
    }
    // Autopay renewed it: the next charge is one period on.
    if (w.fields.autopay === true && typeof w.fields.repeat === "string" && typeof w.fields.due === "string") {
      const next = autopayDue(w.fields.due, w.fields.repeat);
      if (next) { try { hub.store.patch(w.id, { due: next }); } catch (e) { console.error(`[watches] ${w.id}: ${errCode(e)}`); } }
    }
    try {
      const before = hub.store.seq();
      syncWatchReminder(hub.store, hub.store.get(w.id) ?? w);
      if (hub.store.seq() !== before) out.reminders_synced++;
    } catch (e) { console.error(`[watches] reminder for ${w.id}: ${errCode(e)}`); }
  }
  console.log(`[watches] ${out.watches} watches, ${out.reminders_synced} reminders re-planned, ${out.probed} probed, ${out.probe_errors} probe errors`);
  return out;
}

/** After-write hook: a watch write keeps its reminder in step. Errors are logged by the store. */
export function installWatchHooks(hub: Hub): void {
  hub.store.afterWrite((entity) => {
    // While Renewals is off its reminders stay set aside (hub.ts); they are made again when it comes back on.
    if (entity.kind === "watch" && hub.modules.on("renewals")) syncWatchReminder(hub.store, entity);
  });
}

/** Once a day at 04:00 local. */
export function startWatchJob(hub: Hub): () => void {
  return scheduleDaily("watches", 4, 0, () => { if (hub.modules.on("renewals")) void watchDaily(hub).catch((e) => console.error(`[watches] daily failed: ${errCode(e)}`)); });
}
