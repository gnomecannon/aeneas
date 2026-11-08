import fs from "node:fs";
import { pendingReminders } from "./reminders.js";
import type { Entity } from "@everythingapp/shared";
import type { Hub } from "./hub.js";
import { VERSION } from "./hub.js";
import { listBackups } from "./backup.js";
import { plannerStatus } from "./planner.js";
import { homeStatus } from "./sensors.js";
import { creativeStatus } from "./quiz.js";
import { opsStatus } from "./monitors.js";
import { adminStatus } from "./admin.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const HEALTH_TYPES = new Set(["weight", "med", "bp", "caffeine", "mood", "sleep"]);

/** Local calendar day (process TZ is EA_TZ) as YYYY-MM-DD. */
export function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** `end` is clipped to now for today; `dayEnd` is the real midnight, for things planned later today. */
interface DayWindow { day: string; start: Date; nine: Date; end: Date; dayEnd: Date }

function windows(days: number, now: Date): DayWindow[] {
  const out: DayWindow[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i, 0, 0, 0, 0);
    const nine = new Date(start.getFullYear(), start.getMonth(), start.getDate(), 9, 0, 0, 0);
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1, 0, 0, 0, 0);
    out.push({ day: dayKey(start), start, nine, end: end > now ? now : end, dayEnd: end });
  }
  return out;
}

export interface ProofRow {
  day: string;
  captures_created: number;
  captures_auto_sorted: number;
  tasks_done: number;
  reminders_fired: number;
  reminders_acked: number;
  reminders_snoozed: number;
  logs_created: number;
  notes_edited: number;
  ai_calls: number;
  /** Weight, med, bp, caffeine, mood and sleep logs dated that day. */
  health_logs: number;
  /** Task blocks starting that day (any status, deleted tasks excluded). */
  blocks_scheduled: number;
  /** Tasks done that day that held a block starting that day. */
  blocks_completed: number;
  /** Homelab incidents opened that day. */
  incidents_opened: number;
  /** True when a task was provably in next or doing at 09:00 local; null when the history does not say. */
  now_at_0900: boolean | null;
  /** Tasks in next or doing at the end of the day (now, for today), the fallback when now_at_0900 is null. */
  next_or_doing_eod: number;
}

export interface ProofReport {
  days: number;
  from: string;
  to: string;
  rows: ProofRow[];
  totals: Omit<ProofRow, "day" | "now_at_0900" | "next_or_doing_eod"> & { days_with_now_at_0900: number; days_now_unknown: number };
  friction: {
    captures_stale: { id: string; text: string; created_at: string; age_h: number }[];
    reminders_snoozed_3plus: { id: string; title: string; snoozes: number }[];
    tasks_parked_7d: { id: string; title: string; parked_since: string; days: number }[];
  };
}

function inWin(iso: string | undefined, w: { start: Date; end: Date }): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return t >= w.start.getTime() && t < w.end.getTime();
}

/** The per-day evidence for a proof run: what got captured, sorted, done, fired, logged and asked. */
export function proofReport(hub: Hub, days: number, now: Date = new Date()): ProofReport {
  const wins = windows(days, now);
  const captures = hub.store.list({ kind: "capture", limit: 100000 });
  const tasks = hub.store.list({ kind: "task", limit: 100000 });
  // Reminders are tasks with a reminder time (or that had one: fired or snoozed).
  const reminders = tasks.filter((t) => t.fields.remind_at || t.fields.fired || t.fields.snooze_log);
  const logs = hub.store.list({ kind: "log", limit: 100000 });
  const notes = hub.store.list({ kind: "note", limit: 100000 });
  const incidents = hub.store.list({ kind: "incident", limit: 100000 });
  const aiRows = hub.chatDb.prepare("SELECT at FROM ai_calls WHERE at >= ?").all(wins[0].start.toISOString()) as { at: string }[];
  const statusTs = (t: Entity) => t.field_ts.status ?? t.created_at;
  const blockStart = (t: Entity) => (t.fields.block as { start?: string } | undefined)?.start;
  const doneIn = (t: Entity, w: DayWindow) => t.fields.status === "done" && inWin(String(t.fields.done_at ?? t.field_ts.status ?? ""), w);
  const liveAt = (t: Entity, at: Date) => (t.fields.status === "next" || t.fields.status === "doing") && new Date(statusTs(t)).getTime() <= at.getTime() && new Date(t.created_at).getTime() <= at.getTime();

  const rows: ProofRow[] = wins.map((w) => {
    const nineKnown = w.nine <= now;
    const provable = nineKnown && tasks.some((t) => liveAt(t, w.nine));
    return {
      day: w.day,
      captures_created: captures.filter((c) => inWin(c.created_at, w)).length,
      captures_auto_sorted: captures.filter((c) => c.fields.processed === true && c.fields.sorted_by === "auto" && inWin(c.field_ts.processed, w)).length,
      tasks_done: tasks.filter((t) => doneIn(t, w)).length,
      reminders_fired: reminders.reduce((n, r) => n + ((r.fields.fired as string[] | undefined) ?? []).filter((at) => inWin(at, w)).length, 0),
      reminders_acked: reminders.filter((r) => inWin(r.field_ts.done_at ?? r.field_ts.acknowledged_at, w)).length,
      reminders_snoozed: reminders.reduce((n, r) => n + ((r.fields.snooze_log as { at: string }[] | undefined) ?? []).filter((s) => inWin(s.at, w)).length, 0),
      logs_created: logs.filter((l) => inWin(l.created_at, w)).length,
      notes_edited: notes.filter((n) => inWin(n.field_ts.body, w) || inWin(n.field_ts.title, w)).length,
      ai_calls: aiRows.filter((a) => inWin(a.at, w)).length,
      health_logs: logs.filter((l) => HEALTH_TYPES.has(String(l.fields.type)) && inWin(String(l.fields.at ?? l.created_at), w)).length,
      blocks_scheduled: tasks.filter((t) => inWin(blockStart(t), { start: w.start, end: w.dayEnd })).length,
      blocks_completed: tasks.filter((t) => doneIn(t, w) && inWin(blockStart(t), { start: w.start, end: w.dayEnd })).length,
      incidents_opened: incidents.filter((i) => inWin(String(i.fields.opened_at ?? ""), w)).length,
      now_at_0900: provable ? true : null,
      next_or_doing_eod: tasks.filter((t) => liveAt(t, w.end)).length,
    };
  });

  const totals: ProofReport["totals"] = {
    captures_created: 0, captures_auto_sorted: 0, tasks_done: 0, reminders_fired: 0, reminders_acked: 0, reminders_snoozed: 0,
    logs_created: 0, notes_edited: 0, ai_calls: 0, health_logs: 0, blocks_scheduled: 0, blocks_completed: 0, incidents_opened: 0, days_with_now_at_0900: 0, days_now_unknown: 0,
  };
  for (const r of rows) {
    totals.captures_created += r.captures_created; totals.captures_auto_sorted += r.captures_auto_sorted; totals.tasks_done += r.tasks_done;
    totals.reminders_fired += r.reminders_fired; totals.reminders_acked += r.reminders_acked; totals.reminders_snoozed += r.reminders_snoozed;
    totals.logs_created += r.logs_created; totals.notes_edited += r.notes_edited; totals.ai_calls += r.ai_calls; totals.health_logs += r.health_logs;
    totals.blocks_scheduled += r.blocks_scheduled; totals.blocks_completed += r.blocks_completed; totals.incidents_opened += r.incidents_opened;
    if (r.now_at_0900 === true) totals.days_with_now_at_0900++; else if (r.now_at_0900 === null) totals.days_now_unknown++;
  }

  const nowMs = now.getTime();
  const friction: ProofReport["friction"] = {
    captures_stale: captures
      .filter((c) => c.fields.processed !== true && nowMs - new Date(c.created_at).getTime() > DAY_MS)
      .map((c) => ({ id: c.id, text: String(c.fields.text ?? "").split("\n")[0].slice(0, 80), created_at: c.created_at, age_h: Math.round((nowMs - new Date(c.created_at).getTime()) / 3600000) }))
      .sort((a, b) => a.created_at.localeCompare(b.created_at)),
    reminders_snoozed_3plus: reminders
      .map((r) => ({ id: r.id, title: String(r.fields.title ?? ""), snoozes: ((r.fields.snooze_log as unknown[] | undefined) ?? []).length }))
      .filter((r) => r.snoozes >= 3)
      .sort((a, b) => b.snoozes - a.snoozes),
    tasks_parked_7d: tasks
      .filter((t) => t.fields.status === "parked" && nowMs - new Date(statusTs(t)).getTime() > 7 * DAY_MS)
      .map((t) => ({ id: t.id, title: String(t.fields.title ?? ""), parked_since: statusTs(t), days: Math.floor((nowMs - new Date(statusTs(t)).getTime()) / DAY_MS) }))
      .sort((a, b) => b.days - a.days),
  };

  return { days, from: wins[0].day, to: wins[wins.length - 1].day, rows, totals, friction };
}

/** One-page health view of the running hub. */
export function statusReport(hub: Hub, now: Date = new Date()): Record<string, unknown> {
  const sizeOf = (p: string) => { try { return fs.statSync(p).size; } catch { return 0; } };
  const byKind: Record<string, number> = {};
  for (const r of hub.db.prepare("SELECT kind, COUNT(*) AS n FROM entities WHERE deleted_at IS NULL GROUP BY kind").all() as { kind: string; n: number }[]) byKind[r.kind] = r.n;
  const backups = listBackups(hub.cfg.backupDir);
  const since = new Date(now.getTime() - DAY_MS).toISOString();
  const ai = hub.chatDb.prepare("SELECT COUNT(*) AS calls, AVG(CASE WHEN ok = 1 THEN ms END) AS avg_ms FROM ai_calls WHERE at >= ?").get(since) as { calls: number; avg_ms: number | null };
  const lastCall = hub.chatDb.prepare("SELECT at, backend FROM ai_calls ORDER BY id DESC LIMIT 1").get() as { at: string; backend: string } | undefined;
  const nowIso = now.toISOString();
  const pending = pendingReminders(hub.store).map(({ t, eff }) => ({ r: t, eff }));
  const upcoming = pending.find((p) => p.eff >= nowIso) ?? pending[0] ?? null;
  const fired24h = hub.store.list({ kind: "task", limit: 100000 }).reduce((n, r) => n + ((r.fields.fired as string[] | undefined) ?? []).filter((at) => at >= since).length, 0);
  return {
    version: VERSION,
    started_at: hub.startedAt,
    uptime_s: Math.max(0, Math.round((now.getTime() - new Date(hub.startedAt).getTime()) / 1000)),
    db: { path: hub.cfg.dbPath, bytes: sizeOf(hub.cfg.dbPath) + sizeOf(`${hub.cfg.dbPath}-wal`), seq: hub.store.seq(), entities_by_kind: byKind },
    devices: hub.devices.list(),
    backups: { dir: hub.cfg.backupDir, latest_file: backups[0]?.file ?? null, latest_at: backups[0]?.at ?? null, count: backups.length },
    ai: {
      backends_configured: hub.ai.configuredBackends(),
      calls_24h: ai.calls,
      last_call_at: lastCall?.at ?? null,
      last_backend: lastCall?.backend ?? null,
      avg_latency_ms_24h: ai.avg_ms === null ? null : Math.round(ai.avg_ms),
    },
    reminders: { due_next: upcoming?.r ?? null, fired_24h: fired24h },
    planner: plannerStatus(hub, now),
    memory: {
      runbooks: byKind.runbook ?? 0,
      journal_entries: byKind.journal ?? 0,
      snippets: byKind.snippet ?? 0,
      open_ledgers: hub.store.list({ kind: "ledger", limit: 100000 }).filter((l) => l.fields.open !== false).length,
    },
    home: homeStatus(hub, now),
    creative: creativeStatus(hub, now),
    ops: opsStatus(hub),
    admin: adminStatus(hub.store),
    captures_unprocessed: hub.store.list({ kind: "capture", limit: 100000 }).filter((c) => c.fields.processed !== true).length,
  };
}
