import { z } from "zod";
import { MusicProfileFields } from "./music.js";
import { InvitationFields } from "./invitations.js";

// ---------- enums ----------
export const Kind = z.enum([
  "capture", "note", "task", "reminder", "event", "log",
  "fact", "rule", "runbook", "ledger", "project", "device",
  "watch", "plan_rule", "journal", "snippet",
  "pet_event", "sensor", "reading", "food_option",
  "inventory", "procedure", "music_idea", "quiz",
  "monitor", "incident",
  "checklist", "application", "game", "film", "image", "person",
  "music_profile", "invitation",
]);
export type Kind = z.infer<typeof Kind>;

/**
 * Kinds whose module was taken out of the app: Job search's `application` on 2026-11-25. They stay kinds, so items
 * already saved stay in the database, sync as before and an older app's edit is not refused, but nothing new writes
 * them and nothing shows them: no screen, search, link or assistant tool (CONTRACT.md, Job search). EACore `Kind.gone`
 * holds the same list.
 */
export const GONE_KINDS: readonly string[] = ["application"];

export const Space = z.enum(["personal", "work"]);
export type Space = z.infer<typeof Space>;

export const Source = z.enum(["watch", "iphone", "ipad", "mac", "windows", "android", "web", "shortcut", "voice", "api"]);
export type Source = z.infer<typeof Source>;

export const TaskStatus = z.enum(["inbox", "next", "scheduled", "doing", "done", "parked"]);
/** "witness" was removed on 2026-10-28; reminders still carrying it are read as "reason". */
export const Friction = z.preprocess((v) => (v === "witness" ? "reason" : v), z.enum(["none", "reason"]));
export const LogType = z.enum(["weight", "med", "bp", "caffeine", "sleep", "mood", "activity", "steps", "custom"]);
/** `like`, `dislike` and `gift_idea` (since 2026-11-25) are about another person; the owner's own likes stay `preference`. */
export const FactCategory = z.enum(["identity", "constraint", "preference", "health", "relationship", "host", "project", "gear", "history", "like", "dislike", "gift_idea"]);
export const RuleEnforce = z.enum(["prompt", "filter", "both"]);
export const ProjectStatus = z.enum(["active", "parked", "done"]);
export const Platform = z.enum(["watch", "iphone", "ipad", "mac", "windows", "android", "web"]);
// "auto" lets the hub decide per message (troubleshooting, drafting, planning); the others force a mode.
export const TaskType = z.enum(["auto", "general", "troubleshoot", "draft", "classify", "plan"]);

const iso = z.string().min(10);
/**
 * A moment, stored in UTC ("...Z"): the hub compares these as text, so a time sent with an offset
 * ("2026-11-05T15:00:00-05:00") is turned to UTC on the way in, or it would fire hours early. A date alone
 * ("2026-11-05", allowed for a due date) stays a date.
 */
const instant = z.string().min(10).transform((s) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s) || /Z$/.test(s)) return s;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
});

// ---------- kind fields ----------
export const CaptureFields = z.object({
  text: z.string(),
  source: Source,
  transcript_confidence: z.number().min(0).max(1).optional(),
  attachments: z.array(z.object({ name: z.string(), mime: z.string(), bytes_b64: z.string() })).optional(),
  processed: z.boolean().default(false),
  converted_to: z.array(z.string()).optional(),
  suggested_kind: z.enum(["task", "note", "reminder", "log", "fact", "none"]).optional(),
  sorted_by: z.enum(["auto", "manual"]).optional(),
  /** Save and sort: the assistant files the capture with its tools in the background (`pending`, then `done` or `failed`). */
  filing: z.enum(["pending", "done", "failed"]).optional(),
  /** One line saying what was filed ("Added to calendar: Dinner at Luigi's with Jamie, tonight"). */
  filed: z.string().optional(),
  filing_attempts: z.number().int().optional(),
  /** The day's diary note this capture was written into. */
  diary_id: z.string().optional(),
  /** The assistant chat that filed it (`capture-<id>`): the owner opens it to correct the filing. */
  thread: z.string().optional(),
  /** Saved with Save while the hub was out of reach: the hub sorts it (diary, then filing) once it arrives. */
  sort: z.boolean().optional(),
  /** A spoken capture from a Watch that writes speech down itself: what the Watch heard, beside `text` (the iPhone's own
   *  hearing of the same recording, which is what is saved). The filer reads both. */
  heard_on_watch: z.string().optional(),
});

export const NoteFields = z.object({
  title: z.string(),
  body: z.string().default(""),
  tags: z.array(z.string()).default([]),
  path: z.string().regex(/\.md$/),
  links: z.array(z.string()).optional(),
  suggested_tags: z.array(z.string()).optional(),
  pinned: z.boolean().optional(),
  /** The project whose folder holds the note, set by the nightly sweep. */
  project_id: z.string().optional(),
  /** Titles of the notes the note linker found it relates to; part of `links`, written to the file as `[[links]]`. */
  related: z.array(z.string()).optional(),
  /** The tags in `tags` that the note linker added (the rest are the owner's). */
  ai_tags: z.array(z.string()).optional(),
  /** Tags the note linker added and the owner removed: never added again. */
  tags_rejected: z.array(z.string()).optional(),
  /**
   * The file's other frontmatter properties (aliases, created, cssclasses...), as written: the hub keeps them and
   * writes them back on every rewrite of the file.
   */
  frontmatter_extra: z.string().nullable().optional(),
});

const Repeat = z.string().regex(/^every \d+ (minutes|hours|days|weeks|months|years)( on [a-z0-9,]+)?$/);

/**
 * A task. Reminders are tasks too (since 2026-10-28): `due` is the optional deadline and `remind_at` the optional
 * notification. `repeat` moves both forward when it is done. `friction: "reason"` asks why on every snooze.
 */
export const TaskFields = z.object({
  title: z.string(),
  notes: z.string().optional(),
  status: TaskStatus,
  order: z.number(),
  due: instant.optional(),
  block: z.object({ start: instant, end: instant }).optional(),
  project_id: z.string().optional(),
  done_at: instant.optional(),
  parked_reason: z.string().optional(),
  remind_at: instant.optional(),
  repeat: Repeat.optional(),
  friction: Friction.optional(),
  snoozed_until: instant.optional(),
  snooze_log: z.array(z.object({ at: instant, until: instant, reason: z.string() })).optional(),
  /** Reminder times already notified, so each fires once. */
  fired: z.array(instant).optional(),
  /** The item this task is about (a renewal, a pet event; a job application's follow-up before 2026-11-25). */
  linked_id: z.string().optional(),
  /**
   * The Apple Reminders item it mirrors, written by the iPhone and Mac. `list_key` (since 1.0.18) names its list the
   * same way on every device, as the sources setting does (`taskFilter`).
   */
  apple: z.object({ id: z.string(), list: z.string(), list_title: z.string().optional(), list_key: z.string().max(300).optional() }).optional(),
  /**
   * A snoozed mail this task brings back (the Mail screen's id for it): the task is titled "Snoozed mail", holds none
   * of the mail's words, and reminds at the snooze's end; marking the task done or deleting it brings the mail back
   * to the Inbox at once.
   */
  mail: z.string().optional(),
});

/**
 * An Apple Reminders list as the sources setting knows it (GET /prefs/sources, `lists`). `key` is the same on every
 * device (`<account kind>:<account name>/<list title>`), `was` holds the keys it had before it or its account was
 * renamed, and `on` says whether its tasks show in the app.
 */
export interface SourceList { key: string; title: string; on: boolean; was?: string[] }

/**
 * The one rule for "does this task show", for the hub and the web: a task is hidden only while it is in an Apple
 * Reminders list that is switched off (Settings, Accounts). The task names its list by `apple.list_key`; one linked
 * by an app from before 1.0.18 has only `apple.list_title`, and is hidden when every list of that name is off. A key
 * whose list now has another name is out of date (an older app changed only the title), so the title decides. A list
 * the setting has not heard of hides nothing. Returns the test for a task's fields.
 */
export function taskFilter(lists: SourceList[] | undefined): (fields: Record<string, unknown>) => boolean {
  if (!lists?.some((l) => !l.on)) return () => true;
  const byKey = new Map<string, SourceList>();
  const byOldKey = new Map<string, SourceList>();
  const byTitle = new Map<string, SourceList[]>();
  for (const l of lists) {
    byKey.set(l.key, l);
    for (const k of l.was ?? []) if (!byOldKey.has(k)) byOldKey.set(k, l);
    const named = byTitle.get(l.title);
    if (named) named.push(l); else byTitle.set(l.title, [l]);
  }
  return (fields) => {
    const a = fields.apple as { list_key?: unknown; list_title?: unknown } | null | undefined;
    if (!a || typeof a !== "object") return true;
    const key = typeof a.list_key === "string" ? a.list_key : "";
    const title = typeof a.list_title === "string" ? a.list_title : "";
    if (key) {
      const l = byKey.get(key);
      if (l && (!title || l.title === title)) return l.on;
      const old = l ? undefined : byOldKey.get(key);
      if (old) return old.on;
    }
    if (!title) return true;
    const named = byTitle.get(title);
    return !named || named.some((l) => l.on);
  };
}

/** `taskFilter` for one task. */
export function taskShown(fields: Record<string, unknown>, lists: SourceList[] | undefined): boolean {
  return taskFilter(lists)(fields);
}

/**
 * Alerts for tasks that are also in Apple Reminders (GET /modules, `apple_reminder_alerts`, since 1.0.19), one setting
 * for every device. `aeneas`: Aeneas alerts for them (the Apple apps' planned alerts, the hub's announcement, the web
 * and Windows banner). `apple`: the owner's choice for Apple Reminders' own alert, the item's alarm. `apple_alarms`:
 * whether updated devices write alarms now; false only while `apple` is off and no iPhone, iPad or Mac in `waiting`
 * still runs an app older than `needs` (such an app reads an item with no alarm as one with no reminder time).
 */
export interface AppleReminderAlerts {
  aeneas: boolean;
  apple: boolean;
  apple_alarms: boolean;
  waiting: Array<{ id: string; name: string; platform: string; version: string | null }>;
  needs: string;
}

/** A task tied to an Apple Reminders item (`apple.id` set). A task made inside a list waits with an empty id and is not. */
export function inAppleReminders(fields: Record<string, unknown>): boolean {
  const a = fields.apple as { id?: unknown } | null | undefined;
  return !!a && typeof a === "object" && typeof a.id === "string" && a.id !== "";
}

/** Whether Aeneas alerts for a task: always, unless it is in Apple Reminders and Alert from Aeneas is off. None known
 * (a hub from before the setting): always. */
export function aeneasAlerts(fields: Record<string, unknown>, setting: { aeneas: boolean } | null | undefined): boolean {
  return !setting || setting.aeneas || !inAppleReminders(fields);
}

/** Older kind. The hub turns every reminder into a task on start; nothing new is written with it. */
export const ReminderFields = z.object({
  title: z.string(),
  at: iso,
  repeat: Repeat.optional(),
  friction: Friction,
  snoozed_until: iso.optional(),
  snooze_log: z.array(z.object({ at: iso, until: iso, reason: z.string() })).optional(),
  fired: z.array(iso).optional(),
  acknowledged_at: iso.optional(),
  linked_id: z.string().optional(),
});

export const EventFields = z.object({
  title: z.string(),
  start: iso,
  end: iso,
  all_day: z.boolean().optional(),
  source: z.enum(["manual", "m365", "eventkit", "caldav"]).optional(),
  external_id: z.string().optional(),
  location: z.string().optional(),
  apple: z.object({ id: z.string(), calendar: z.string().optional(), from_apple: z.boolean().optional() }).optional(),
  /** The calendar-server event the hub keeps it in step with (calendar sync, `calendars` module). */
  caldav: z.object({ account: z.string(), calendar: z.string(), uid: z.string(), from_caldav: z.boolean().optional() }).optional(),
  /** The calendar it is on, as the app that brought it in names it (`apple:<account>/<calendar>`), for its color. */
  calendar_key: z.string().max(300).optional(),
  /** The owner declined it and it stays on its calendar (Invitations): clients leave it out, as Calendar does. */
  declined: z.boolean().optional(),
});

/**
 * The calendar an event is on, the key its color is kept under (Theme, Calendar colors): what the app that brought it
 * in wrote, else the iCloud calendar the hub keeps it in step with, else the Apple calendar an older app named, else
 * the work calendar for Microsoft 365 events. Null: made in the app and on no calendar (drawn in the theme's accent).
 */
export function eventCalendarKey(f: Record<string, unknown>): string | null {
  if (typeof f.calendar_key === "string" && f.calendar_key) return f.calendar_key;
  const caldav = f.caldav as { calendar?: unknown } | undefined;
  if (caldav && typeof caldav.calendar === "string" && caldav.calendar) return `icloud:${caldav.calendar}`;
  const apple = f.apple as { calendar?: unknown } | undefined;
  if (apple && typeof apple.calendar === "string" && apple.calendar) return `apple:${apple.calendar}`;
  if (f.source === "m365") return "work:m365";
  return null;
}

/** A calendar's color as Theme, Calendar colors keeps it: the owner's choice, else the calendar's own color. */
export interface CalendarColor { key: string; name: string; account?: string; color?: string; chosen?: string; seen_at?: string }
export function calendarColor(key: string | null, calendars: CalendarColor[] | undefined): string | null {
  if (!key) return null;
  const c = calendars?.find((x) => x.key === key);
  return c?.chosen ?? c?.color ?? null;
}

export const LogFields = z.object({
  type: LogType,
  value: z.union([z.number(), z.string()]),
  unit: z.string().optional(),
  /** What a `custom` log measures (`pushups`); the dashboard groups custom logs by it. */
  name: z.string().optional(),
  at: iso,
  note: z.string().optional(),
  checkins: z.array(iso).optional(),
  source: Source.optional(),
});

export const FactFields = z.object({
  category: FactCategory,
  key: z.string(),
  value: z.string(),
  source: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  private: z.boolean().optional(),
  /** A fact about someone in People: their id, or just their name when they are not in contacts. */
  person_id: z.string().optional(),
  person: z.string().optional(),
  /** A gift idea's day it was given (YYYY-MM-DD); none means not given yet. */
  given_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** What a gift idea is for, as said ("birthday"). */
  occasion: z.string().optional(),
});

export const RuleFields = z.object({
  text: z.string(),
  enforce: RuleEnforce,
  pattern: z.string().optional(),
  flags: z.string().optional(),
  replacement: z.string().optional(),
  active: z.boolean().default(true),
});

export const RunbookFields = z.object({
  host: z.string(),
  title: z.string(),
  body: z.string().default(""),
  commands: z.array(z.object({ label: z.string(), host: z.string(), user: z.string(), command: z.string() })).optional(),
  last_verified: iso.optional(),
});

export const LedgerFields = z.object({
  session_id: z.string(),
  topic: z.string(),
  tried: z.array(z.object({ at: iso, what: z.string(), result: z.string() })).default([]),
  ruled_out: z.array(z.string()).default([]),
  confirmed: z.array(z.string()).default([]),
  open: z.boolean().default(true),
});

export const ProjectFields = z.object({
  name: z.string(),
  status: ProjectStatus,
  definition_of_done: z.string(),
  resume_card: z.string().optional(),
  plan_doc_path: z.string().optional(),
  repo: z.string().optional(),
  /** What the tools working on it (Codex, git) last did, pushed by a feed such as deploy/windows/project-feed.ps1. */
  activity: z.record(z.string(), z.unknown()).optional(),
  activity_at: iso.optional(),
  parts: z.array(z.object({ name: z.string(), qty: z.number().default(1), have: z.number().optional(), inventory_id: z.string().optional() })).optional(),
  /** Where the project lives besides Projects: `music` puts it in the Music section with its songs and ideas. */
  area: z.enum(["music"]).optional(),
});

export const WatchCategory = z.enum(["cert", "subscription", "prescription", "insurance", "rma", "warranty", "domain", "other"]);
export const WatchFields = z.object({
  title: z.string(),
  category: WatchCategory,
  due: iso,
  lead_days: z.number().int().min(0).default(7),
  repeat: z.string().regex(/^every \d+ (minutes|hours|days|weeks|months|years)( on [a-z0-9,]+)?$/).optional(),
  probe_url: z.string().url().optional(),
  cost: z.number().optional(),
  url: z.string().optional(),
  notes: z.string().optional(),
  reminder_id: z.string().optional(),
  last_probe: iso.optional(),
  last_probe_error: z.string().optional(),
  renewed_at: iso.optional(),
  /** It renews and pays by itself: no reminder task, and once `due` passes it rolls forward by `repeat` on its own. */
  autopay: z.boolean().optional(),
  /** A cancellation mail took it away; a later charge or notice for the same service brings it back. */
  cancelled_by_mail: z.boolean().optional(),
  /** The title the mail filer last wrote, so a name the owner gives it later is never replaced. */
  mail_title: z.string().optional(),
});

export const PlanRuleType = z.enum(["blackout", "commitment", "preference", "info"]);
export const Weekday = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
export const PlanRuleFields = z.object({
  title: z.string(),
  type: PlanRuleType,
  days: z.array(Weekday).min(1),
  start: z.string().regex(/^([01]\d|2[0-4]):[0-5]\d$/),
  end: z.string().regex(/^([01]\d|2[0-4]):[0-5]\d$/),
  alternating_anchor: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  note: z.string().optional(),
  active: z.boolean().default(true),
});

export const JournalFields = z.object({
  host: z.string(),
  at: iso,
  what: z.string(),
  command: z.string().optional(),
  risk: z.enum(["low", "medium", "high"]),
  rollback: z.string().optional(),
  /** running: an approved command the hub is running now; interrupted: it stopped at its time limit, or the hub
   * stopped or restarted while it ran (a change that restarts the hub or reboots its machine), so it may be half done. */
  outcome: z.enum(["planned", "running", "done", "failed", "interrupted", "reverted"]).default("done"),
  session_id: z.string().optional(),
  runbook_id: z.string().optional(),
  /**
   * `close`: written by a session close, which replaces only these when the session is closed again. `hub`: written by
   * the hub about something that happened on the machine or place (a reading went out of bounds and back), not a change
   * anyone made; History shows it, lists of changes leave it out (since 2026-11-19).
   */
  source: z.enum(["close", "hub"]).optional(),
  /** An approved command that only looked (counted, listed, read): it needed approval but changed nothing, so History leaves it out. */
  lookup: z.boolean().optional(),
});

export const SnippetFields = z.object({
  title: z.string(),
  os: z.enum(["linux", "windows", "macos", "any"]),
  language: z.string(),
  body: z.string(),
  params: z.array(z.object({ name: z.string(), default: z.string().optional(), description: z.string().optional() })).default([]),
  tags: z.array(z.string()).default([]),
  host: z.string().optional(),
  source_session: z.string().optional(),
  last_used: iso.optional(),
});

export const PetEventFields = z.object({
  pet: z.string(),
  type: z.enum(["vet", "med", "incident", "custody", "weight", "food", "note"]),
  at: iso,
  note: z.string().optional(),
  cost: z.number().optional(),
  next_due: iso.nullable().optional(),
  reminder_id: z.string().optional(),
  /** custody only: where the pet went at this handoff. */
  with: z.enum(["me", "other"]).optional(),
  /** custody only: days until the next handoff, 14 by default. */
  cycle_days: z.number().int().min(1).max(90).optional(),
});

export const SensorFields = z.object({
  name: z.string().regex(/^[a-z0-9_.-]+$/i),
  unit: z.string(),
  location: z.string().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  alert: z.boolean().default(true),
  stale_minutes: z.number().int().positive().default(180),
  last_at: iso.optional(),
  last_value: z.number().optional(),
  state: z.enum(["ok", "low", "high", "stale"]).optional(),
});

export const ReadingFields = z.object({
  sensor: z.string(),
  value: z.number(),
  at: iso,
  unit: z.string().optional(),
});

export const FoodOptionFields = z.object({
  name: z.string(),
  kind: z.enum(["delivery", "restaurant", "grab", "home"]),
  items: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  avoid: z.boolean().default(false),
  rating: z.number().int().min(1).max(5).optional(),
  cost: z.number().optional(),
  last_picked: iso.optional(),
  times_picked: z.number().int().optional(),
  /** Who recommended it, who the owner went with, what to remember about it. */
  notes: z.string().optional(),
});

export const InventoryFields = z.object({
  name: z.string(),
  category: z.enum(["component", "gear", "material", "tool", "other"]),
  qty: z.number().default(1),
  unit: z.string().optional(),
  location: z.string().optional(),
  tags: z.array(z.string()).default([]),
  project_id: z.string().optional(),
  notes: z.string().optional(),
});

export const ProcedureFields = z.object({
  title: z.string(),
  steps: z.array(z.object({ text: z.string(), command: z.string().optional(), host: z.string().optional(), user: z.string().optional(), done_at: iso.optional() })).min(1),
  current: z.number().int().min(0).default(0),
  started_at: iso.optional(),
  done_at: iso.optional(),
  source_session: z.string().optional(),
  project_id: z.string().optional(),
});

const HumNote = z.object({ p: z.number().int().min(0).max(127), s: z.number().min(0), d: z.number().min(0), v: z.number().int().min(1).max(127) });

export const MusicIdeaFields = z.object({
  title: z.string(),
  type: z.enum(["riff", "progression", "lyric", "song", "template", "setting", "reference"]),
  body: z.string().default(""),
  key: z.string().optional(),
  bpm: z.number().optional(),
  time_sig: z.string().optional(),
  tuning: z.string().optional(),
  status: z.enum(["idea", "wip", "done"]).default("idea"),
  tags: z.array(z.string()).default([]),
  project_id: z.string().optional(),
  audio_ref: z.string().optional(),
  /** The id a client gave the take it sent (`client_id`), so the same take sent again is this idea. */
  hum_client_id: z.string().optional(),
  /** The tempo given with a hum, kept so a hearing interrupted by a restart is done again the same way. */
  hum_bpm_given: z.number().optional(),
  /**
   * Which of a hum's two hearings the owner keeps: the melody, the rhythm or both (since 2026-11-17). Absent: both
   * when both have notes, else the one that has.
   */
  hum_use: z.enum(["melody", "rhythm", "both"]).optional(),
  /**
   * Notes heard in a hum (hub hum.ts): each `p` MIDI pitch (36 kick, 38 snare, 42 hat in the rhythm), `s` start and
   * `d` length in seconds from the first note of either hearing, `v` velocity. Since 2026-11-17 every hum is heard
   * both ways, as `melody` and `rhythm` (either may be empty); `mode` and `notes` repeat one of them for apps from
   * before then. `state` is listening until the hub has heard it. `GET /music/<id>/midi` makes the .mid file.
   */
  midi: z.object({
    source: z.enum(["hum"]).default("hum"),
    mode: z.enum(["melody", "rhythm"]),
    state: z.enum(["listening", "done", "failed"]),
    error: z.string().optional(),
    seconds: z.number().optional(),
    /** The hearing these notes came from: a result that comes back after a newer hearing started is dropped. */
    job: z.string().optional(),
    notes: z.array(HumNote).max(5000).default([]),
    melody: z.array(HumNote).max(5000).optional(),
    rhythm: z.array(HumNote).max(5000).optional(),
  }).optional(),
});

export const QuizFields = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  items: z.array(z.object({ q: z.string(), a: z.string(), hint: z.string().default(""), topic: z.string().default(""), asked_at: iso.optional(), result: z.enum(["right", "wrong", "revealed"]).optional() })).min(1),
  source_sessions: z.array(z.string()).default([]),
  completed_at: iso.optional(),
});

export const MonitorFields = z.object({
  name: z.string(),
  host: z.string().optional(),
  type: z.enum(["ping", "tcp", "http", "tls", "dns", "backup"]),
  target: z.string(),
  expect: z.string().optional(),
  interval_s: z.number().int().positive().default(60),
  timeout_s: z.number().int().positive().default(5),
  fails_before_down: z.number().int().positive().default(3),
  enabled: z.boolean().default(true),
  state: z.enum(["up", "down", "unknown"]).optional(),
  last_check: iso.optional(),
  last_ok: iso.optional(),
  last_latency_ms: z.number().optional(),
  last_error: z.string().optional(),
  last_detail: z.string().optional(),
  consecutive_fails: z.number().int().optional(),
  /** Down while its machine was unreachable: the machine's incident it joined instead of opening one, hub-managed. */
  joined_incident: z.string().optional(),
  /** The last check that reached the thing checked, failed or not (a skipped check of a machine away does not), hub-managed. */
  last_reached: iso.optional(),
  /** backup: each job of the machine (backup, verify, restore) as last read, hub-managed. */
  jobs: z.array(z.object({
    job: z.enum(["backup", "verify", "restore"]),
    state: z.enum(["ok", "failed", "stale", "never", "missing"]),
    running: z.boolean().optional(),
    last_good: iso.optional(),
    last_run: iso.optional(),
    max_hours: z.number(),
    error: z.string().optional(),
  })).optional(),
});

export const IncidentFields = z.object({
  monitor_id: z.string(),
  name: z.string(),
  opened_at: iso,
  closed_at: iso.optional(),
  acknowledged_at: iso.optional(),
  ack_note: z.string().optional(),
  last_error: z.string().optional(),
  checks_failed: z.number().int().default(0),
  journal_id: z.string().optional(),
  /** When the hub last said it again (every 6 hours until acknowledged), kept across restarts. */
  renotified_at: iso.optional(),
  /** A machine that stopped answering: the other monitors on it that went down with it (names), hub-managed. */
  also_down: z.array(z.string()).optional(),
  /** Closed into its machine's incident when the machine stopped answering soon after it opened, hub-managed. */
  merged_into: z.string().optional(),
});

export const ChecklistFields = z.object({
  title: z.string(),
  kind: z.enum(["packing", "states", "generic"]).default("generic"),
  items: z.array(z.object({ text: z.string(), done_at: iso.optional(), note: z.string().optional() })),
  template: z.boolean().default(false),
  from_template: z.string().optional(),
  tags: z.array(z.string()).default([]),
  archived: z.boolean().optional(),
});

/** Older kind (GONE_KINDS): Job search was taken out on 2026-11-25. Its fields, for reading old data. */
export const ApplicationFields = z.object({
  company: z.string(),
  role: z.string(),
  stage: z.enum(["saved", "applied", "screen", "interview", "offer", "rejected", "withdrawn", "accepted"]),
  applied_at: iso.optional(),
  next_step: z.string().optional(),
  next_at: iso.optional(),
  reminder_id: z.string().optional(),
  salary: z.string().optional(),
  remote: z.enum(["remote", "hybrid", "onsite"]).optional(),
  url: z.string().optional(),
  notes: z.string().optional(),
  letter_note_id: z.string().optional(),
  /** Where it came from when synced from elsewhere; absent when typed in. */
  source: z.string().optional(),
});

export const GameFields = z.object({
  name: z.string(),
  min_players: z.number().int().min(1).default(1),
  max_players: z.number().int().min(1).default(4),
  coop: z.boolean().default(true),
  genres: z.array(z.string()).default([]),
  owned_by: z.array(z.string()).default([]),
  session_hours: z.number().optional(),
  last_played: iso.optional(),
  rating: z.number().int().min(1).max(5).optional(),
  notes: z.string().optional(),
  /** Steam library: the app id, total and last-two-weeks minutes played; `source` "steam" when it came from there. */
  steam_appid: z.number().int().optional(),
  playtime_min: z.number().int().min(0).optional(),
  playtime_2w_min: z.number().int().min(0).optional(),
  source: z.enum(["manual", "steam"]).optional(),
});

/** A film from Letterboxd (export and diary feed): when it was watched, the rating (half stars, 0.5 to 5), a like. */
export const FilmFields = z.object({
  title: z.string(),
  year: z.number().int().optional(),
  watched_on: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).default([]),
  last_watched: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  watched: z.boolean().default(true),
  watchlist: z.boolean().optional(),
  rating: z.number().min(0.5).max(5).optional(),
  liked: z.boolean().optional(),
  review: z.string().optional(),
  tags: z.array(z.string()).default([]),
  url: z.string().optional(),
  tmdb_id: z.number().int().optional(),
  source: z.enum(["manual", "letterboxd"]).optional(),
});

export const DeviceFields = z.object({
  name: z.string(),
  platform: Platform,
  last_seen: iso.optional(),
  push_token: z.string().optional(),
  /** What this device's build understands, for changes old builds would undo: "contacts-merge" (repeated numbers and merged duplicates in Contacts). */
  features: z.array(z.string()).optional(),
  /** The app and version it runs, from its X-EA-App header (CONTRACT, App updates). Set by the hub. */
  app: z.object({
    kind: z.enum(["windows", "android", "web", "ios", "ipados", "macos", "watchos"]),
    version: z.string(),
    build: z.string().optional(),
  }).optional(),
  /** An app update the owner asked for, until the device runs that version (or says Not now: declined_at). Set by the hub. */
  app_update: z.object({
    requested_at: iso,
    version: z.string(),
    by: z.string().optional(),
    declined_at: iso.optional(),
  }).nullable().optional(),
});

/**
 * A picture in the Image Gallery. The bytes live in the hub's image store (`GET /ai/images/:image_id`); this is the
 * synced record. `source` sorts it into the gallery's two bins: Generated, and Saved (everything else).
 */
export const ImageFields = z.object({
  image_id: z.string().regex(/^[0-9a-f]{32}$/),
  source: z.enum(["generated", "attached", "uploaded", "downloaded", "photos"]),
  title: z.string().optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  mime: z.string().optional(),
  bytes: z.number().int().optional(),
  /** Generated: what was asked, the caption the model actually got, and how it was made. */
  prompt: z.string().optional(),
  caption: z.string().optional(),
  job_id: z.string().optional(),
  workflow: z.string().optional(),
  worker: z.string().optional(),
  seed: z.number().int().optional(),
  /** Attached: the chat it came from. */
  session_id: z.string().optional(),
  /** Set when a copy was saved to the iPhone's Photos, so it is saved once. */
  saved_to_photos: z.boolean().optional(),
});

const Labeled = z.object({ label: z.string().optional(), value: z.string() });
/**
 * Someone the owner knows, mirrored both ways with Apple Contacts by the one device that syncs contacts (`apple`).
 * What the owner knows about them lives in memory as facts with `person_id`.
 */
export const PersonFields = z.object({
  name: z.string(),
  given_name: z.string().optional(),
  family_name: z.string().optional(),
  nickname: z.string().optional(),
  organization: z.string().optional(),
  job_title: z.string().optional(),
  /** YYYY-MM-DD, or --MM-DD when the year is unknown. */
  birthday: z.string().optional(),
  /** Other dates on the card: anniversaries and any labeled date, same format as birthday. */
  dates: z.array(z.object({ label: z.string().optional(), date: z.string() })).default([]),
  phones: z.array(Labeled).default([]),
  emails: z.array(Labeled).default([]),
  addresses: z.array(z.object({ label: z.string().optional(), street: z.string().optional(), city: z.string().optional(), state: z.string().optional(), postal_code: z.string().optional(), country: z.string().optional() })).default([]),
  /** How the owner knows them ("girlfriend", "friend from D&D"). App-only. */
  relationship: z.string().optional(),
  /** The Apple Contacts card and the device that owns the link; `me` marks the owner's own card (My Card). */
  apple: z.object({ id: z.string(), device: z.string().optional(), me: z.boolean().optional() }).optional(),
  /** Set on a deleted duplicate: the person it was merged into. The syncing device then removes its card once that person's card holds everything on it. */
  merged_into: z.string().optional(),
});

export const FieldsByKind = {
  capture: CaptureFields, note: NoteFields, task: TaskFields, reminder: ReminderFields,
  event: EventFields, log: LogFields, fact: FactFields, rule: RuleFields,
  runbook: RunbookFields, ledger: LedgerFields, project: ProjectFields, device: DeviceFields,
  watch: WatchFields, plan_rule: PlanRuleFields, journal: JournalFields, snippet: SnippetFields,
  pet_event: PetEventFields, sensor: SensorFields, reading: ReadingFields, food_option: FoodOptionFields,
  inventory: InventoryFields, procedure: ProcedureFields, music_idea: MusicIdeaFields, quiz: QuizFields,
  monitor: MonitorFields, incident: IncidentFields,
  checklist: ChecklistFields, application: ApplicationFields, game: GameFields, film: FilmFields, image: ImageFields, person: PersonFields,
  music_profile: MusicProfileFields,
  invitation: InvitationFields,
} as const;

// ---------- envelope ----------
export const Entity = z.object({
  id: z.guid(),
  kind: Kind,
  space: Space.default("personal"),
  created_at: iso,
  updated_at: iso,
  deleted_at: iso.nullable().default(null),
  fields: z.record(z.string(), z.any()),
  field_ts: z.record(z.string(), iso).default({}),
});
export type Entity = z.infer<typeof Entity>;

export const Patch = z.object({
  id: z.guid(),
  kind: Kind,
  space: Space.optional(),
  ts: iso,
  fields: z.record(z.string(), z.any()),
  create: z.boolean().optional(),
});
export type Patch = z.infer<typeof Patch>;

export const Change = z.object({ seq: z.number().int(), entity: Entity });
export type Change = z.infer<typeof Change>;

export const PushRequest = z.object({ device_id: z.string(), patches: z.array(Patch).max(500) });
export const PushResponse = z.object({
  applied: z.array(z.object({ id: z.string(), seq: z.number() })),
  rejected: z.array(z.object({ id: z.string(), reason: z.string() })),
  seq: z.number(),
});
export const ChangesResponse = z.object({ changes: z.array(Change), seq: z.number(), more: z.boolean() });

export const CaptureRequest = z.object({
  text: z.string().min(1),
  source: Source,
  attachments: CaptureFields.shape.attachments,
  auto: z.boolean().optional(),
  /** The id the device gave the capture: the same capture sent again (its reply was lost) is the one the hub has. */
  id: z.guid().optional(),
  /** What the Watch itself heard of a spoken capture whose `text` the iPhone wrote down: a second hearing for the filer. */
  heard_on_watch: z.string().max(8000).optional(),
});

export const ChatMessage = z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string() });
/** Base64 image (JPEG, PNG, GIF or WebP), optionally as a data: URL. */
export const ChatImage = z.string().min(16).max(12_000_000);
/**
 * Two ways to send a turn:
 * - `message` (plus optional `images`): the hub keeps the conversation, so the same chat continues on any device.
 * - `messages`: the client sends the whole history (older clients, tests).
 * `approve_action_id` approves a host command the assistant proposed; `message` may be empty then.
 */
export const ChatRequest = z.object({
  session_id: z.string().min(1).max(200),
  messages: z.array(ChatMessage).min(1).optional(),
  message: z.string().max(100_000).optional(),
  images: z.array(ChatImage).max(4).optional(),
  approve_action_id: z.string().optional(),
  task_type: TaskType.default("auto"),
  space: Space.optional(),
  allow_cloud: z.boolean().optional(),
  allow_work: z.boolean().optional(),
  /** What the sending device can do for the assistant: `photos` when the iPhone app has full photo library access on. */
  device: z.object({ photos: z.boolean().optional() }).optional(),
}).refine((r) => !!r.messages?.length || (r.message !== undefined && r.message.trim() !== "") || !!r.images?.length || !!r.approve_action_id, { message: "send message, images, messages or approve_action_id" });
export const ChatResponse = z.object({
  reply: z.string(),
  model: z.string(),
  backend: z.enum(["ollama", "anthropic", "adapter"]),
  redactions: z.number(),
  rules_applied: z.array(z.string()),
  ledger_id: z.string().optional(),
});

export const Dashboard = z.object({
  now: Entity.nullable(),
  next: z.array(Entity),
  reminders_today: z.array(Entity),
  logs_7d: z.record(z.string(), z.array(z.object({ at: iso, value: z.union([z.number(), z.string()]) }))),
  captures_unprocessed: z.number(),
  projects_active: z.array(Entity),
});

// ---------- helpers ----------
export function nowIso(): string { return new Date().toISOString(); }

/** Parse a reminder repeat string. Returns null if invalid. */
export function parseRepeat(repeat: string): { n: number; unit: string; on?: string[] } | null {
  const m = /^every (\d+) (minutes|hours|days|weeks|months|years)(?: on ([a-z0-9,]+))?$/.exec(repeat);
  if (!m) return null;
  return { n: parseInt(m[1], 10), unit: m[2], on: m[3]?.split(",") };
}

const daysIn = (y: number, m: number) => new Date(y, m + 1, 0).getDate();

/**
 * Compute the next fire time strictly after `after` for a repeat rule starting at `at`. Months and years keep the
 * day they started on, or the month's last day when it is shorter (Jan 31 goes to Feb 28, then Mar 31; Feb 29 to
 * Feb 28 and back to 29 in a leap year), instead of spilling into the next month for good. "every 2 weeks on
 * mon,thu" fires on those days of every second week, counted from the week it started.
 */
export function nextOccurrence(at: string, repeat: string, after: Date = new Date()): string | null {
  const r = parseRepeat(repeat);
  if (!r) return null;
  const start = new Date(at);
  if (Number.isNaN(start.getTime())) return null;
  const dow = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  // Months: the nth month after the start, on the start's day or the month's last day.
  const monthly = (k: number, wantDay?: number) => {
    const y = start.getFullYear(), m = start.getMonth() + k;
    const day = Math.min(wantDay ?? start.getDate(), daysIn(y, m));
    return new Date(y, m, day, start.getHours(), start.getMinutes(), start.getSeconds(), start.getMilliseconds());
  };
  if (r.unit === "months" || r.unit === "years") {
    const per = r.unit === "years" ? 12 * r.n : r.n;
    const onDay = r.unit === "months" && r.on?.[0]?.startsWith("day") ? parseInt(r.on[0].replace("day", ""), 10) || parseInt(r.on[1] ?? "", 10) : undefined;
    for (let k = 0; k < 10000; k++) {
      const d = monthly(k * per, onDay);
      if (d > after && (k > 0 || onDay === undefined || d >= start)) return d.toISOString();
    }
    return null;
  }
  if (r.unit === "weeks" && r.on) {
    // Day by day, on the named days of the weeks that count (every nth week from the start's week).
    const weekStart = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate() - x.getDay());
    const first = weekStart(start).getTime();
    const d = new Date(start);
    for (let i = 0; i < 100000; i++) {
      const weeks = Math.round((weekStart(d).getTime() - first) / (7 * 86400000));
      if (d > after && weeks % r.n === 0 && r.on.includes(dow[d.getDay()])) return d.toISOString();
      d.setDate(d.getDate() + 1);
    }
    return null;
  }
  const d = new Date(start);
  for (let i = 0; i < 1000000; i++) {
    if (d > after) return d.toISOString();
    switch (r.unit) {
      case "minutes": d.setMinutes(d.getMinutes() + r.n); break;
      case "hours": d.setHours(d.getHours() + r.n); break;
      case "days": d.setDate(d.getDate() + r.n); break;
      case "weeks": d.setDate(d.getDate() + 7 * r.n); break;
    }
  }
  return null;
}

/** A date alone ("2026-11-05") is that day in local time, not UTC midnight (7 PM the evening before in New York). */
export function parseWhen(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(s);
}

const localDayString = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Effective fire time of a reminder considering snooze. */
export function effectiveAt(fields: { at: string; snoozed_until?: string }): string {
  return fields.snoozed_until && fields.snoozed_until > fields.at ? fields.snoozed_until : fields.at;
}

/** When a task notifies next, counting a snooze. Null when it has no reminder or is done. */
export function taskAlertAt(f: { remind_at?: unknown; snoozed_until?: unknown; status?: unknown }): string | null {
  if (typeof f.remind_at !== "string" || !f.remind_at || f.status === "done") return null;
  // In UTC, as every comparison with it is made: one stored with an offset before the hub turned them to UTC still fires on time.
  const utc = (x: string) => { const d = parseWhen(x); return Number.isNaN(d.getTime()) ? x : d.toISOString(); };
  return effectiveAt({ at: utc(f.remind_at), snoozed_until: typeof f.snoozed_until === "string" && f.snoozed_until ? utc(f.snoozed_until) : undefined });
}

/**
 * The patch that completes a task. A repeating one stays open and moves its reminder and deadline to the next
 * occurrence after `now`; anything else is done.
 */
export function completeTaskPatch(f: { repeat?: unknown; remind_at?: unknown; due?: unknown }, now: Date = new Date()): Record<string, unknown> {
  const repeat = typeof f.repeat === "string" ? f.repeat : "";
  const dateOnly = typeof f.due === "string" && /^\d{4}-\d{2}-\d{2}$/.test(f.due);
  const base = typeof f.remind_at === "string" ? f.remind_at : typeof f.due === "string" ? (dateOnly ? parseWhen(f.due).toISOString() : f.due) : "";
  if (repeat && base) {
    // Done before its time (the 9 PM pill taken at 8): this one is done, so the next is the one after it.
    const after = new Date(Math.max(now.getTime(), Date.parse(base)));
    const next = nextOccurrence(base, repeat, after);
    if (next) {
      const out: Record<string, unknown> = { snoozed_until: null, done_at: now.toISOString() };
      if (typeof f.remind_at === "string") out.remind_at = next;
      if (typeof f.due === "string") {
        // The deadline keeps its distance from the reminder; a deadline that is a date alone stays a date.
        const shift = typeof f.remind_at === "string" ? Date.parse(next) - Date.parse(f.remind_at) : 0;
        let moved: Date;
        if (dateOnly) {
          // Whole days, so a reminder that crossed a clock change does not pull the date back an hour into the day before.
          moved = typeof f.remind_at === "string" ? parseWhen(f.due) : new Date(next);
          if (typeof f.remind_at === "string") moved.setDate(moved.getDate() + Math.round(shift / 86400000));
        } else moved = shift ? new Date(Date.parse(f.due) + shift) : typeof f.remind_at === "string" ? new Date(f.due) : new Date(next);
        out.due = dateOnly ? localDayString(moved) : moved.toISOString();
      }
      return out;
    }
  }
  return { status: "done", done_at: now.toISOString(), snoozed_until: null };
}

/**
 * What takes an edit back: each field the edit wrote, as it was before (null for one that was not there). Undo after
 * Done uses it, so a repeating task gets its reminder and deadline back as well as a one-off its status.
 */
export function undoPatch(before: Record<string, unknown>, edit: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.keys(edit).map((k) => [k, before[k] === undefined ? null : before[k]]));
}

/**
 * Not done: a finished task back in Next, at its end. `done_at` goes, so it reads as never finished.
 */
export function reopenTaskPatch(nextOrders: number[]): Record<string, unknown> {
  return { status: "next", order: Math.max(0, ...nextOrders) + 1, done_at: null };
}

/**
 * Undo of a delete. A personal task tied to an Apple Reminders item loses that tie: the iPhone deletes the item of a
 * deleted personal task and forgets it, so the restored task is added to its list again (an item still there, when
 * the iPhone had not run yet, is matched by its record and tied again). A work task keeps its tie, since work items
 * are never deleted in Apple.
 */
export function restoreTaskPatch(t: { space: string; fields: Record<string, unknown> }): Record<string, unknown> {
  const apple = t.fields.apple as Record<string, unknown> | undefined;
  const tied = !!apple && typeof apple.id === "string" && apple.id !== "";
  return { deleted_at: null, ...(tied && t.space !== "work" ? { apple: { ...apple, id: "" } } : {}) };
}

/**
 * A dash in a range reads as "to": between numbers and times ("3:00 to 4:00 PM", "9:00 AM to 5:00 PM"), weekdays
 * ("Mon to Fri") and months. A comma there changed the meaning ("Mon, Fri").
 */
/** Weekday and month names as whole words: "Janet" is not January, "Maybe" is not May. */
const RANGE_WORDS = "Monday|Mon|Tuesday|Tues|Tue|Wednesday|Wed|Thursday|Thurs|Thur|Thu|Friday|Fri|Saturday|Sat|Sunday|Sun|January|Jan|February|Feb|March|Mar|April|Apr|May|June|Jun|July|Jul|August|Aug|September|Sept|Sep|October|Oct|November|Nov|December|Dec";
/** AM or PM as a word of its own or after a digit ("5pm"); "team" does not end in a time. */
const AMPM = "(?:\\b|\\d)[AaPp]\\.?[Mm]\\.?";
const RANGE_AFTER = `(?=\\d|(?:${RANGE_WORDS})\\b)`;
const RANGE_DASH = new RegExp(`(?<=\\d|${AMPM}|\\b(?:${RANGE_WORDS})\\.?)[ \\t]{0,3}[—–][ \\t]{0,3}${RANGE_AFTER}`, "g");
/**
 * The same range written with a spaced hyphen ("9:00 AM - 5:00 PM", "Mon - Fri", "5 - 6"): after a clock time, AM/PM, a
 * day or month name, or between two small numbers. "at 5 - Marcus" and "100 - 20 GB" are not ranges.
 */
const RANGE_HYPHEN = new RegExp(`(?:(?<=\\d:\\d\\d|${AMPM}|\\b(?:${RANGE_WORDS})\\.?)[ \\t]+-[ \\t]+${RANGE_AFTER}|(?<=\\b\\d{1,2})[ \\t]+-[ \\t]+(?=\\d{1,2}\\b))`, "g");
/** Vague closing offers ("Want me to add anything else?", "Say the word if you want it longer."). */
const VAGUE_OFFER = /\b(let me know|say the word|want me to (add|do|change) anything else|anything else (you need|to add)|if you'?d like,? i can)\b/i;

/** Style filter shared by hub (enforce) and clients (display). */
export const DEFAULT_STYLE_PATTERNS: Array<{ name: string; pattern: RegExp; replacement: string }> = [
  // A range between numbers reads as "to": "3:00 to 4:00 PM", not "3:00, 4:00 PM".
  { name: "range-dash", pattern: RANGE_DASH, replacement: " to " },
  // Spaces around a dash are bounded: an unbounded run made every position of a long space run a scan.
  { name: "em-dash", pattern: /[ \t]{0,3}[—–][ \t]{0,3}/g, replacement: ", " },
  { name: "final-fix", pattern: /\bfinal fix\b/gi, replacement: "this change" },
  { name: "opening-platitude", pattern: /^(great|good|excellent|awesome) (question|point|idea)[.!,]?\s*/gim, replacement: "" },
  { name: "closing-filler", pattern: /^\s*(let me know|feel free|hope this helps|if you have any (other )?questions|happy to help|i'?m here to help)[^\n]*\n?/gim, replacement: "" },
];

const SPACED_HYPHEN = /(?<=[\p{L}\p{N})*_.!?'"%])[ \t]+-[ \t]+(?=[\p{L}\p{N}(*_'"$])/gu;

export function applyStyle(text: string, extra: Array<{ name: string; pattern: RegExp; replacement: string }> = []): { text: string; applied: string[] } {
  const applied: string[] = [];
  let out = text;
  for (const p of [...DEFAULT_STYLE_PATTERNS, ...extra]) {
    const before = out;
    out = out.replace(p.pattern, p.replacement);
    if (out !== before) applied.push(p.name);
  }
  // Vague closing offers go sentence by sentence (as one regex over the line it took cubic time on long space runs).
  out = out.split("\n").map((line) => {
    if (!VAGUE_OFFER.test(line)) return line;
    const parts = line.split(/(?<=[.!?])[ \t]+/);
    const kept = parts.filter((x) => !VAGUE_OFFER.test(x));
    if (kept.length === parts.length) return line;
    applied.push(/let me know/i.test(line) ? "let-me-know-sentence" : "vague-offer");
    return kept.join(" ");
  }).join("\n");
  // A spaced hyphen between words is a dash too ("Pick up the cable - it is at Micro Center"). Prose only: code
  // fences and inline code keep theirs, and a list bullet at the start of a line is not between words.
  out = out.split(/(```[\s\S]*?```|`[^`\n]*`)/).map((part, i) => {
    if (i % 2) return part;
    const fixed = part.replace(RANGE_HYPHEN, " to ").replace(SPACED_HYPHEN, ", ");
    if (fixed !== part) applied.push("spaced-hyphen");
    return fixed;
  }).join("");
  // strip emoji inside code fences
  out = out.replace(/```[\s\S]*?```/g, (block) => {
    const cleaned = block.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}✅❌☑☒]/gu, "");
    if (cleaned !== block) applied.push("emoji-in-code");
    return cleaned;
  });
  return { text: out.replace(/\n{3,}/g, "\n\n").trim(), applied: [...new Set(applied)] };
}

/** Redaction shared by hub and clients (clients redact before showing captures to AI preview). */
export const REDACTION_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: "aws-key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "openai-key", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { name: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
  { name: "slack-token", pattern: /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g },
  { name: "github-token", pattern: /\b(ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{16,}\b/g },
  { name: "password-assignment", pattern: /\b(password|passwd|pwd|secret|client_secret)\s*[:=]\s*["']?[^\s"']{4,}["']?/gi },
  { name: "token-assignment", pattern: /\b(token|api[_-]?key|access[_-]?key)\s*[:=]\s*["']?[^\s"']{8,}["']?/gi },
  { name: "bearer", pattern: /\bBearer\s+[A-Za-z0-9._-]{16,}\b/g },
];

export function redact(text: string, extraLiterals: string[] = [], opts: { emails?: boolean } = {}): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const r of REDACTION_PATTERNS) {
    out = out.replace(r.pattern, (m, g1) => { count++; return g1 ? `${g1}=[REDACTED:${r.name}]` : `[REDACTED:${r.name}]`; });
  }
  if (opts.emails) out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, () => { count++; return "[REDACTED:email]"; });
  for (const lit of extraLiterals) {
    if (!lit || lit.length < 4) continue;
    const esc = lit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(esc, "g"), () => { count++; return "[REDACTED:private]"; });
  }
  return { text: out, count };
}

/**
 * A measurement said in plain words, as a log: "today I weigh 116.4", "weighed in at 72 kg", "bp 120 over 80",
 * "slept 7 and a half hours", "8k steps", "took my claritin", "mood 4". Null when the text is not one record.
 * The whole text must be the record (after time words like "today"), so a sentence that only mentions a number stays a note.
 */
export function parseRecord(text: string): Record<string, any> | null {
  let t = text.trim().replace(/[.!]+$/, "").trim();
  const LEAD = /^(?:today|tonight|this (?:morning|evening|afternoon)|just now|just|so|ok(?:ay)?|update)[,:]?\s+/i;
  const TAIL = /[,]?\s+(?:today|tonight|this (?:morning|evening|afternoon)|now|right now|at the (?:doctor|gym))$/i;
  for (let i = 0; i < 3; i++) t = t.replace(LEAD, "").replace(TAIL, "").trim();
  const at = nowIso();
  const num = String.raw`(\d{1,3}(?:[.,]\d+)?)`;
  const unit = String.raw`(?:\s*(lbs?|pounds?|kgs?|kilos?|kilograms?))?`;
  const weight = new RegExp(String.raw`^(?:i\s+)?(?:weigh(?:ed)?(?:\s+in)?(?:\s+at)?|(?:my\s+|current\s+)?weight(?:\s+(?:is|was|of))?:?|(?:the\s+)?scale\s+(?:says|said|reads|read))\s+${num}${unit}$`, "i").exec(t)
    ?? new RegExp(String.raw`^${num}\s*(lbs?|pounds?|kgs?|kilos?|kilograms?)$`, "i").exec(t);
  if (weight) {
    const value = parseFloat(weight[1].replace(",", "."));
    const kg = /^k/i.test(weight[2] ?? "");
    if (value >= (kg ? 20 : 50) && value <= (kg ? 350 : 800)) return { type: "weight", value, unit: kg ? "kg" : "lb", at };
  }
  // The whole text is the reading ("bp 120/80", "my blood pressure was 128 over 82"): one inside a sentence ("Doctor
  // said my bp 140/90 is too high", "Mom's bp 150 95") is not the owner's reading.
  const bp = /^(?:my\s+)?(?:bp|blood pressure)(?:\s+(?:is|was|of))?:?\s*(\d{2,3})\s*(?:\/|over|\s)\s*(\d{2,3})$/i.exec(t);
  if (bp) return { type: "bp", value: `${bp[1]}/${bp[2]}`, at };
  const sleep = /^(?:i\s+)?slept\s+(?:for\s+)?(\d{1,2}(?:\.\d+)?)(\s+and\s+a\s+half)?\s*(?:h|hrs?|hours?)(?:\s+(?:and\s+)?(\d{1,2})\s*(?:m|mins?|minutes?))?(?:\s+(?:last night|tonight))?$/i.exec(t);
  if (sleep) {
    const minutes = Math.round(parseFloat(sleep[1]) * 60 + (sleep[2] ? 30 : 0) + (sleep[3] ? parseInt(sleep[3], 10) : 0));
    if (minutes > 0 && minutes <= 20 * 60) return { type: "sleep", value: minutes, unit: "min", at };
  }
  const steps = /^(?:i\s+)?(?:walked\s+|did\s+|got\s+)?(\d[\d,]*(?:\.\d+)?)\s*(k)?\s+steps$/i.exec(t);
  if (steps) {
    const value = Math.round(parseFloat(steps[1].replace(/,/g, "")) * (steps[2] ? 1000 : 1));
    if (value > 0 && value < 200000) return { type: "steps", value, at };
  }
  const mood = /^(?:my\s+)?(?:mood|feeling)(?:\s+(?:is|was))?:?\s*(-?\d{1,2})(?:\s*\/\s*\d+|\s+out of\s+\d+)?$/i.exec(t);
  if (mood) return { type: "mood", value: parseInt(mood[1], 10), at };
  // "Took my claritin", "took 20 mg adderall", "took ibuprofen": a medication. "Took the trash out" and "took the dog
  // to the vet" are not: the thing taken must be "my <one to three words>" with no "to", "out" and the like in it, or
  // carry a dose or a medicine word.
  const med = /^(?:i\s+)?(?:took|have taken|taken)\s+(my\s+)?(.+)$/i.exec(t);
  if (med) {
    const what = med[2].trim();
    const mine = !!med[1] && what.split(/\s+/).length <= 3 && !/\b(to|out|off|on|for|with|from|into|up|down|over|a|an|the)\b/i.test(what);
    const dose = /\b\d+(?:\.\d+)?\s*(?:mg|mcg|µg|g|ml|units?|iu)\b/i.test(what);
    const word = /\b(pills?|meds?|medications?|medicines?|vitamins?|doses?|tablets?|capsules?|inhaler|insulin|antibiotics?|ibuprofen|acetaminophen|tylenol|advil|aleve|aspirin|melatonin|adderall|vyvanse|ritalin|concerta|zyrtec|claritin|benadryl)\b/i.test(what);
    if (mine || dose || word) return { type: "med", value: what, at };
  }
  return null;
}

/** Rule-based capture classifier used before any model is consulted. */
export function classifyCapture(text: string): { kind: "task" | "note" | "reminder" | "log" | "fact" | "none"; fields: Record<string, any> } {
  const t = text.trim();
  const lower = t.toLowerCase();
  const record = parseRecord(t);
  if (record) return { kind: "log", fields: record };
  if (/^(remind me|reminder:?)/i.test(t) || /\b(remind me|don't let me forget)\b/i.test(lower)) {
    const title = t.replace(/^(remind me( to)?|reminder:?)\s*/i, "").trim();
    return { kind: "reminder", fields: { title, friction: "none" } };
  }
  // Prefixes are whole words ("Taskmaster finale", "Ideally I'd...", "Factorio tonight" are not prefixes).
  const TODO = /^(todo|task|to do)(?=[:\s]|$):?\s*/i;
  const NOTE = /^(note|idea)(?=[:\s]|$):?\s*/i;
  if (TODO.test(t) && t.replace(TODO, "").trim()) {
    // an explicit todo prefix is a decision already made: queue it, no triage step
    return { kind: "task", fields: { title: t.replace(TODO, "").trim(), status: "next" } };
  }
  if (NOTE.test(t) && t.replace(NOTE, "").trim()) {
    // "Note: x" is x; "Idea for a game about bees" keeps its words, which read better as a title.
    const body = /^(note|idea)\s*:/i.test(t) ? t.replace(NOTE, "").trim() : t;
    return { kind: "note", fields: { title: body.split("\n")[0].slice(0, 80), body } };
  }
  // "Remember to call mom" is something to do, not a fact.
  if (/^remember to\s+\S/i.test(t)) return { kind: "task", fields: { title: t.replace(/^remember to\s+/i, "").trim(), status: "inbox" } };
  if (/^(fact|remember)(?=[:\s]|$)/i.test(t) && t.replace(/^(fact|remember( that)?):?\s*/i, "").trim()) {
    return { kind: "fact", fields: { category: "preference", key: lower.slice(0, 40).replace(/\W+/g, "_"), value: t.replace(/^(fact|remember( that)?):?\s*/i, "").trim() } };
  }
  if (t.length < 80 && !/\n/.test(t) && /^(call|email|buy|fix|order|check|send|pay|book|schedule|cancel|renew|install|update|clean|write|finish|start)\b/i.test(t)) {
    return { kind: "task", fields: { title: t, status: "inbox" } };
  }
  return { kind: "none", fields: {} };
}

// ---------- People on Today ----------

type PersonLike = { id: string; deleted_at?: string | null; updated_at?: string; fields: Record<string, unknown> };

/** A date on someone's card coming up: their birthday, an anniversary, or any other labeled date from Contacts. */
export type PersonDate = { id: string; name: string; label: string; date: string; days: number; years?: number };

const shortName = (p: PersonLike) => String(p.fields.nickname || p.fields.given_name || p.fields.name || "");

/** Birthdays and every other date on people's cards within `withinDays` from today (0 = today), soonest first. A date
 * is YYYY-MM-DD, or --MM-DD without a year; Feb 29 is Feb 28 in other years. `date` is the local YYYY-MM-DD it falls
 * on; `years` is the age or the anniversary count when the year is known. */
export function datesSoon(people: PersonLike[], now: Date, withinDays = 14): PersonDate[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const pad = (n: number) => String(n).padStart(2, "0");
  const out: PersonDate[] = [];
  for (const p of people) {
    if (p.deleted_at) continue;
    const entries = [{ label: "birthday", date: p.fields.birthday }, ...(Array.isArray(p.fields.dates) ? p.fields.dates as { label?: unknown; date?: unknown }[] : [])];
    for (const e of entries) {
      const m = /^(\d{4}|-)-?(\d{2})-(\d{2})$/.exec(String(e?.date ?? "").trim());
      if (!m) continue;
      const year = m[1] === "-" ? undefined : Number(m[1]);
      const month = Number(m[2]) - 1, day = Number(m[3]);
      if (month < 0 || month > 11 || day < 1 || day > 31) continue;
      const on = (y: number) => {
        const leapless = month === 1 && day === 29 && new Date(y, 1, 29).getMonth() !== 1;
        return new Date(y, month, leapless ? 28 : day);
      };
      let next = on(today.getFullYear());
      if (next < today) next = on(today.getFullYear() + 1);
      const days = Math.round((next.getTime() - today.getTime()) / 86400000);
      if (days > withinDays) continue;
      const years = year ? next.getFullYear() - year : 0;
      const label = String(e?.label ?? "").trim().toLowerCase();
      out.push({ id: p.id, name: shortName(p), label: label === "other" ? "" : label, date: `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}`, days, ...(years > 0 ? { years } : {}) });
    }
  }
  return out.sort((a, b) => a.days - b.days || a.name.localeCompare(b.name));
}

/** "Kim's birthday Mon (turns 36)", "Jamie's anniversary today (5 years)", "Ana Nov 20" (a date without a label). */
export function datePhrase(d: PersonDate): string {
  const when = d.days === 0 ? "today" : d.days === 1 ? "tomorrow" : d.days < 7
    ? new Date(`${d.date}T12:00:00`).toLocaleDateString("en-US", { weekday: "short" })
    : new Date(`${d.date}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const count = d.years ? (d.label === "birthday" ? ` (turns ${d.years})` : ` (${d.years} year${d.years === 1 ? "" : "s"})`) : "";
  return `${d.label ? `${d.name}'s ${d.label}` : d.name} ${when}${count}`;
}

/** Lowercase words only, for matching names in text. */
export const nameNorm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
const firstName = (p: PersonLike) => nameNorm(p.fields.given_name) || nameNorm(p.fields.name).split(" ")[0];

/** The names that point at a person in text: full name, nickname, and a first name nobody else shares. */
export function mentionNames(person: PersonLike, everyone: PersonLike[]): string[] {
  return mentionNamesWith(person, firstNames(everyone));
}

/** The ids of the live people who go by each first name, for mentionNames. */
type FirstNames = Map<string, Set<string>>;
function firstNames(everyone: PersonLike[]): FirstNames {
  const out: FirstNames = new Map();
  for (const p of everyone) {
    if (p.deleted_at) continue;
    const g = firstName(p);
    const ids = out.get(g);
    if (ids) ids.add(p.id); else out.set(g, new Set([p.id]));
  }
  return out;
}
function mentionNamesWith(person: PersonLike, given: FirstNames): string[] {
  const names = [person.fields.name, person.fields.nickname].map(nameNorm).filter((n) => n.length >= 2);
  const own = firstName(person);
  const sharing = given.get(own);
  if (own.length >= 2 && !(sharing && sharing.size > (sharing.has(person.id) ? 1 : 0))) names.push(own);
  return [...new Set(names)];
}

/** Every live person's mentionNames, by id: the first names counted once, not once for each person. */
export function mentionNamesOf(everyone: PersonLike[]): Map<string, string[]> {
  const given = firstNames(everyone);
  return new Map(everyone.filter((p) => !p.deleted_at).map((p) => [p.id, mentionNamesWith(p, given)]));
}

/** The first of `names` that appears in `text` as whole words (a trailing 's counts). */
export function mentionedName(text: string, names: string[]): string | undefined {
  return mentionedIn(mentionText(text), names);
}

/** Text as mentionedIn reads it: nameNorm'd, with a space at each end. Made once for a text read for many people. */
const mentionText = (text: string) => ` ${nameNorm(text)} `;
/** mentionedName on a mentionText: a name between spaces, or followed by 's. */
function mentionedIn(t: string, names: string[]): string | undefined {
  return names.find((n) => t.includes(` ${n} `) || t.includes(` ${n}'s `));
}

/** What the owner has told the app about someone: facts linked to them (`person_id`), kept with their name before they
 * were in People (`person`), or whose text names them ("Friend group for board games: Devon, Casey, ..."), linked ones first. */
export function factsAbout<T extends PersonLike>(person: PersonLike, everyone: PersonLike[], facts: T[]): T[] {
  const names = mentionNames(person, everyone);
  const linked = linkedTo(person);
  const live = facts.filter((f) => !f.deleted_at);
  return [...live.filter(linked), ...live.filter((f) => !linked(f) && !!mentionedName(String(f.fields.value ?? ""), names))];
}

/** Whether a fact is about this person: linked by `person_id`, or kept with one of their names in `person`. */
function linkedTo(person: PersonLike): (f: PersonLike) => boolean {
  const called = new Set([person.fields.name, person.fields.nickname, person.fields.given_name].map(nameNorm).filter(Boolean));
  return (f) => f.fields.person_id === person.id || (!f.fields.person_id && called.has(nameNorm(f.fields.person)));
}

/** The categories a person's page adds to, by section. */
export type PersonFactCategory = "like" | "dislike" | "gift_idea";
export type PersonFactSection = "likes" | "dislikes" | "gift_ideas" | "health_and_food" | "history" | "other";
/** One section of a person's page: `add` is the category its Add field makes, on the three that always show. */
export type PersonFactGroup<T> = { id: PersonFactSection; title: string; add?: PersonFactCategory; empty?: string; items: T[] };

const SECTIONS: { id: PersonFactSection; title: string; add?: PersonFactCategory; empty?: string; categories: string[] }[] = [
  { id: "likes", title: "Likes", add: "like", empty: "No likes yet", categories: ["like", "preference"] },
  { id: "dislikes", title: "Dislikes", add: "dislike", empty: "No dislikes yet", categories: ["dislike"] },
  { id: "gift_ideas", title: "Gift ideas", add: "gift_idea", empty: "No gift ideas yet", categories: ["gift_idea"] },
  { id: "health_and_food", title: "Health and food", categories: ["health", "constraint"] },
  { id: "history", title: "History", categories: ["history", "relationship"] },
  { id: "other", title: "Other", categories: [] },
];

/**
 * A person's facts (factsAbout's list) in the sections of their page, every section in order, empty ones too: Likes
 * (`like`, and `preference` about them), Dislikes, Gift ideas (not given yet first, newest first, then given ones, the
 * latest given first), Health and food (`health`, `constraint`), History (`history`, `relationship`), Other (the rest).
 * A fact that only names them in its text goes to Other: a like or a gift idea there is someone else's. The order
 * within the other sections is the order given. EACore `PersonFacts.groups` is the same rule.
 */
export function personFactGroups<T extends PersonLike & { created_at?: string }>(person: PersonLike, facts: T[]): PersonFactGroup<T>[] {
  const linked = linkedTo(person);
  const groups = SECTIONS.map(({ categories, ...g }) => ({ ...g, items: [] as T[] }));
  for (const f of facts) {
    if (f.deleted_at) continue;
    const cat = String(f.fields.category ?? "");
    const i = linked(f) ? SECTIONS.findIndex((s) => s.categories.includes(cat)) : -1;
    groups[i >= 0 ? i : SECTIONS.length - 1].items.push(f);
  }
  const given = (f: T) => String(f.fields.given_at ?? "");
  const made = (f: T) => String(f.created_at ?? "");
  groups[2].items.sort((a, b) => (given(a) ? 1 : 0) - (given(b) ? 1 : 0) || given(b).localeCompare(given(a)) || made(b).localeCompare(made(a)));
  return groups;
}

/**
 * The key of a like, dislike or gift idea about someone: `like:`, `dislike:` or `gift:` and the value's first six words,
 * lower case, joined by `_`. Made from the value, so two ideas never share a key (with a key the model picks, a
 * second idea keyed "gift" would take the place of the first) and the same idea said again is the same fact.
 */
export function personFactKey(category: PersonFactCategory, value: string): string {
  const words = String(value ?? "").normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").filter(Boolean).slice(0, 6);
  const prefix = category === "gift_idea" ? "gift" : category;
  return `${prefix}:${words.join("_").slice(0, 60) || "item"}`;
}

/** Someone named in today's plans, with what the owner has told the app about them. */
export type PersonToday = { id: string; name: string; plans: { id: string; title: string; at?: string }[]; notes: string[] };
export type PlanItem = { id: string; title: string; text?: string; at?: string };

/** What today still holds that can name someone, in time order: events not over yet, reminders due, and tasks being
 * done or due today. */
export function plansToday(events: PersonLike[], reminders: PersonLike[], tasks: PersonLike[], now: Date): PlanItem[] {
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const items: PlanItem[] = [
    // All-day events are today's for the whole day (the caller passes today's events).
    ...events.filter((e) => !e.deleted_at && (e.fields.all_day === true || new Date(String(e.fields.end ?? e.fields.start ?? "")) > now))
      .map((e) => ({ id: e.id, title: String(e.fields.title ?? ""), text: String(e.fields.location ?? ""), ...(e.fields.all_day === true ? {} : { at: String(e.fields.start ?? "") }) })),
    ...reminders.filter((r) => !r.deleted_at).map((r) => ({ id: r.id, title: String(r.fields.title ?? ""), at: String(r.fields.snoozed_until ?? r.fields.at ?? "") })),
    ...tasks.filter((t) => !t.deleted_at && t.fields.status !== "done" && (t.fields.status === "doing" || (!!t.fields.due && parseWhen(String(t.fields.due)) < end)))
      .map((t) => ({ id: t.id, title: String(t.fields.title ?? ""), text: String(t.fields.notes ?? "") })),
  ];
  // Untimed items last. Plain comparison: localeCompare puts symbols before digits.
  const key = (x: PlanItem) => x.at ? new Date(x.at).getTime() : Infinity;
  return items.sort((a, b) => key(a) - key(b));
}

const STOP = new Set("about after again also going have just like likes loves only really some that them then there they this tonight today tomorrow with from what when will would your".split(" "));
const words = (s: string, skip: Set<string>) => new Set(nameNorm(s).replace(/'s\b/g, "").split(" ").filter((w) => w.length >= 4 && !STOP.has(w) && !skip.has(w)));

/** The people today's plans name, in the order of their first plan, each with every plan that names them and up to
 * three things the owner told the app about them (facts with their `person_id`, or their name in `person`): those
 * sharing words with their plans first, so dinner at Luigi's brings up what they like at Luigi's, then the newest. */
export function peopleInPlans(people: PersonLike[], facts: PersonLike[], plans: PlanItem[], limit = 6): PersonToday[] {
  const live = people.filter((p) => !p.deleted_at);
  const names = mentionNamesOf(live);
  const found = new Map<string, { p: PersonLike; plans: PlanItem[] }>();
  for (const plan of plans) {
    const text = mentionText(`${plan.title}\n${plan.text ?? ""}`);
    for (const p of live) {
      if (!mentionedIn(text, names.get(p.id) ?? [])) continue;
      const hit = found.get(p.id);
      if (hit) hit.plans.push(plan);
      else if (found.size < limit) found.set(p.id, { p, plans: [plan] });
    }
  }
  return [...found.values()].map(({ p, plans: mine }) => {
    const own = new Set((names.get(p.id) ?? []).flatMap((n) => n.split(" ")));
    const planWords = words(mine.map((x) => `${x.title} ${x.text ?? ""}`).join(" "), own);
    const about = factsAbout(p, live, facts);
    const shared = (f: PersonLike) => [...words(String(f.fields.value ?? ""), own)].filter((w) => planWords.has(w)).length;
    const notes = about
      .map((f) => ({ f, n: shared(f) }))
      .sort((a, b) => b.n - a.n || String(b.f.updated_at ?? "").localeCompare(String(a.f.updated_at ?? "")))
      .slice(0, 3)
      .map(({ f }) => String(f.fields.value ?? "")).filter(Boolean);
    return { id: p.id, name: shortName(p), plans: mine.map((x) => ({ id: x.id, title: x.title, ...(x.at ? { at: x.at } : {}) })), notes };
  });
}

/**
 * A reading as people say it (Tech, since 2026-11-19): the machine's own `core.disk.root.used` on core is "Disk /", a
 * board's `garage_freezer` is "Garage freezer". `thing` is the machine or place the reading is on.
 */
export function readingLabel(sensor: string, thing: string): string {
  const own = !!thing && sensor.toLowerCase().startsWith(`${thing.toLowerCase()}.`);
  const rest = own ? sensor.slice(thing.length + 1) : sensor;
  const nth = (n: string, what: string) => (n === "0" ? what : `${what} ${Number(n) + 1}`);
  let m: RegExpExecArray | null;
  if (rest === "cpu.used") return "CPU";
  if (rest === "memory.used") return "Memory";
  if ((m = /^disk\.(.+)\.used$/.exec(rest))) return m[1] === "root" ? "Disk /" : /^[a-z]$/.test(m[1]) ? `Disk ${m[1].toUpperCase()}:` : `Disk ${m[1]}`;
  if ((m = /^cpu(\d*)\.temp$/.exec(rest))) return `${nth(m[1] || "0", "CPU")} temperature`;
  if ((m = /^nvme(\d+)\.temp$/.exec(rest))) return `NVMe ${Number(m[1]) + 1} temperature`;
  if ((m = /^gpu(\d+)\.temp$/.exec(rest))) return `${nth(m[1], "GPU")} temperature`;
  if ((m = /^gpu(\d+)\.vram$/.exec(rest))) return `${nth(m[1], "GPU")} memory`;
  if ((m = /^zfs\.(.+)\.pool$/.exec(rest))) return `Pool ${m[1]}`;
  if ((m = /^zfs\.(.+)\.healthy$/.exec(rest))) return `Pool ${m[1]} health`;
  const words = rest.replace(/[._]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export { HOST_SCRIPTS } from "./hostscripts.js";
export * from "./bar.js";
export * from "./today.js";
export * from "./taskLists.js";
export * from "./calendars.js";
export * from "./music.js";
export * from "./nextLine.js";
export * from "./invitations.js";
