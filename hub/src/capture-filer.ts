import { wordsOf } from "./ai/lists.js";
import { withPriority } from "./ai/backends.js";
import { recordImage } from "./gallery.js";
import type { Entity } from "@everythingapp/shared";
import { classifyCapture } from "@everythingapp/shared";
import type { Hub } from "./hub.js";
import type { Store } from "./store.js";
import { convertCapture, filedLabel, filedTitle, KIND_LABEL } from "./capture.js";
import { appendDiary, captureDay, diaryDay } from "./diary.js";
import { titleFrom } from "./ai/sessions.js";
import { noteFolders } from "./note-linker.js";
import { moduleOfKind, type ModuleCheck } from "./modules.js";
import { personalize } from "./profile.js";
import { errCode } from "./logsafe.js";

/**
 * Save and sort, for everything the rules cannot place: the assistant reads the capture and files it with its own
 * tools (a plan on the calendar, a lasting fact in memory, a to-do, a measurement, a place to eat, an idea as a tagged
 * note in the folder it belongs in, a song idea, a film to watch), several at once
 * when several fit, and nothing when it is only a passing thought (the diary already has it). Runs in the background,
 * one capture at a time; a capture that could not be filed after three tries goes back to Unsorted Info.
 */

const MAX_ATTEMPTS = 3;
/**
 * After the first three tries (a few minutes apart), one every 30 minutes for about a day: a capture made while the
 * model was away for a long game is filed when it is back, instead of being left in Unsorted Info for the owner.
 */
const LATE_ATTEMPTS = 50;
const LATE_EVERY_MS = 30 * 60_000;

/**
 * Personal events from two days before the capture's day to a week after it, so the filer changes a plan that is
 * already there (the outing the owner put on the calendar the day before) instead of adding a second event for it.
 */
export function nearbyEvents(store: Store, at: Date): string[] {
  const d0 = new Date(`${captureDay(at)}T12:00:00`);
  const shift = (n: number) => { const d = new Date(d0); d.setDate(d.getDate() + n); return diaryDay(d); };
  const from = shift(-2), to = shift(8);
  return store.list({ kind: "event", space: "personal", limit: 100000 })
    .map((e) => ({ e, start: new Date(String(e.fields.start)), day: e.fields.all_day ? String(e.fields.start).slice(0, 10) : diaryDay(new Date(String(e.fields.start))) }))
    .filter((x) => !Number.isNaN(x.start.getTime()) && x.day >= from && x.day < to)
    // The 20 closest to the capture, then in time order: the earliest 20 were the two days before, and the next
    // day's plan was left out (so the filer added it a second time).
    .sort((a, b) => Math.abs(a.start.getTime() - at.getTime()) - Math.abs(b.start.getTime() - at.getTime()))
    .slice(0, 20)
    .sort((a, b) => a.start.getTime() - b.start.getTime())
    .map(({ e, start, day }) => `"${String(e.fields.title ?? "")}" (id ${e.id}, ${day} ${e.fields.all_day ? "all day" : start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })})`);
}

/**
 * Open tasks that share words with the note (two or more, or one rare word), most shared first: the filer made a second
 * "HDMI cable from Micro Center" next to the open "Pick up HDMI cable at Micro Center".
 */
export function similarTasks(store: Store, text: string): string[] {
  const want = wordsOf(text);
  if (!want.size) return [];
  return store.list({ kind: "task", space: "personal", limit: 100000 })
    .filter((t) => t.fields.status !== "done" && !t.deleted_at)
    .map((t) => ({ t, shared: [...wordsOf(String(t.fields.title ?? ""))].filter((w) => want.has(w)).length }))
    .filter((x) => x.shared >= Math.min(2, want.size))
    .sort((a, b) => b.shared - a.shared)
    .slice(0, 5)
    .map(({ t }) => `"${String(t.fields.title ?? "")}" (id ${t.id})`);
}

export function filingPrompt(text: string, at: Date, hint?: string, events: string[] = [], tasks: string[] = [], folders: string[] = [], names?: { owner: string; pet: string }, on: ModuleCheck = () => true): string {
  // The hub's own words are written about `{{owner}}` and `{{pet}}` and sent about the owner and their pet; what the owner
  // wrote, their events, tasks and folders go in as they are.
  const T = (s: string) => (names ? personalize(s, names.owner, names.pet) : s);
  const when = at.toLocaleString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
  // The owner's day when writing it (before 4 AM is still the day before), and the days around it, spelled out:
  // the model resolves relative days itself badly (it put "yesterday" on the day it was written).
  const d0 = captureDay(at);
  const near = (n: number) => { const d = new Date(`${d0}T12:00:00`); d.setDate(d.getDate() + n); return `${d.toLocaleDateString("en-US", { weekday: "long" })} ${diaryDay(d)}`; };
  return [
    `${T("[Capture to file] {{owner}} wrote this quick note to self on")} ${when}: "${text.trim()}"`,
    `Their day then was ${near(0)} (before 4 AM still counts as the day before), so yesterday was ${near(-1)}, the day before ${near(-2)}, tomorrow ${near(1)}.`,
    T("It is already saved in that day's diary; never edit the diary. File it where it belongs, with your tools, without asking anything and without chatting:"),
    T("a plan with a day or part of a day becomes a calendar event (follow the Plans rule; name who is involved); a time given, even a bare hour (\"Saturday at 7\"), makes it a timed event starting then (a bare hour is PM unless it reads as morning), never all day;"),
    T("something {{owner}} already did with a day or with people (went somewhere, saw someone, an outing, a show, a meal out) becomes an all-day calendar event on the day it happened (Halloween, last night, yesterday; otherwise that diary day), its title the whole outing in a few words (what they did, with whom, and what came after: \"Apple picking with Jamie and Devon, then Thai food and 2 movies\"), since an event has no notes;"),
    T("a lasting fact about {{owner}}, a pet, a place or a preference goes to memory with remember (only what the note says, never guesses);"),
    T("something about another person goes to them: look them up with people, then remember with person= for likes, habits and history, or save_person for contact details (address, phone, email, birthday, anniversary or another date);"),
    T("something to do becomes a task, with a reminder time only when one is stated, and a deadline {{owner}} names (by Friday, before March) as its due date exactly (before March means the last day of February), never earlier, and no advice in its notes; a day or part of a day for it (tomorrow, Friday morning) is its due date (YYYY-MM-DD) with no reminder time;"),
    T("something to buy goes on a shopping list among {{owner}}'s Reminders lists (create_task with list=, {{owner}}'s own unless someone else's is named), keeping where to get it in the title (\"HDMI cable from Micro Center\");"),
    T("a measurement or something done (ate, took, slept, walked) becomes a log;"),
    on("food") && T("a restaurant or meal place goes on the food list (create_item kind=food_option) when it clearly fits, and its notes always name who recommended it or who {{owner}} went with (\"Rafael recommended it\");"),
    T("an idea for something to make (a story, film, book, sketch or skit, game, app, invention, business) becomes a note with save_note: a title of 2 to 8 words naming what happens or what it is (\"The lighthouse that knocks back\"), never the whole sentence and never its kind (idea, story, skit), the whole capture as its body, tags idea plus its form (story, film, book, sketch, game, app, invention, business), in the one of {{owner}}'s note folders whose subject it clearly has (a comedy skit in a comedy sketches folder), the broader folder above it when its genre is not clear (Writing, not a guessed Writing/Horror), never Inbox when one fits;"),
    on("music") && T("a riff, chord progression, lyric or song idea goes to music (create_item kind=music_idea with type riff, progression, lyric or song and status idea);"),
    on("films") && T("a film {{owner}} wants to watch goes on the film watchlist (create_item kind=film with watchlist true and watched false)."),
    folders.length ? `${T("{{owner}}'s note folders:")} ${folders.join("; ")}.` : "",
    events.length ? `Already on the calendar around then: ${events.join("; ")}. When the note is about one of these (the same plan or outing), change only that event's title with update_item (the whole outing and who came; keep its times) and add no other event for it.` : "",
    tasks.length ? `Open tasks like it: ${tasks.join("; ")}. When the note is about one of these, add no other task: leave it, or change that one (a due date, a list) with update_task or update_item.` : "",
    T("Do every one that fits. If it is only a passing thought or feeling, do nothing more. Never invent times, names or details."),
    ...(hint ? [`A simple phrase rule read it as: ${hint}. Use that only if it is right.`] : []),
    T("Then answer with one short line that says what you filed, or \"Diary only\"."),
  ].filter(Boolean).join(" ");
}

/** The chat title of a capture's filing thread. */
export function captureTitle(text: string): string {
  return `Capture: ${titleFrom(text)}`;
}

/**
 * Save and sort for one capture, from POST /capture or from a device that saved it while the hub was out of reach
 * (`sort: true`, picked up by the filing job). "work: ..." becomes a task in the sealed work space and the personal
 * capture keeps no work text; everything else goes into the day's diary first (the raw history the assistant recalls
 * from) and is then filed by the assistant in the background, several places when several fit. The phrase rules are
 * only its hint and fallback.
 */
export function sortCapture(hub: Hub, capture: Entity): { capture: Entity; suggested: string; created: Entity[] } {
  const text = String(capture.fields.text ?? "");
  const workPrefix = /^work:\s*/i.exec(text);
  if (workPrefix && !hub.work.enabled) {
    // The work space is off: keep no work text anywhere.
    // A photo with it is work too: it goes with the text.
    return { capture: hub.store.patch(capture.id, { text: "work: not saved, the work space is turned off", processed: true, sort: false, attachments: null }), suggested: "none", created: [] };
  }
  if (workPrefix) {
    const rest = text.slice(workPrefix[0].length).trim();
    const cls = classifyCapture(rest);
    const first = rest.split("\n")[0].trim();
    const fields: Record<string, unknown> = cls.kind === "task" ? { ...cls.fields } : { title: first.slice(0, 160) || "Work task", status: "inbox" };
    if (rest.includes("\n")) fields.notes = rest;
    const task = convertCapture(hub.store, capture, "task", fields, "auto", "work");
    // The work space holds no photos; one taken for work is not left in the personal space either.
    return { capture: hub.store.patch(capture.id, { text: "work: moved to the work space", sort: false, attachments: null }), suggested: "task", created: [task] };
  }
  const diary = appendDiary(hub.store, text, new Date(capture.created_at));
  hub.store.patch(capture.id, { diary_id: diary.id, processed: true, sorted_by: "auto", suggested_kind: "none", filing: "pending", ...(capture.fields.sort ? { sort: false } : {}) });
  void queueFiling(hub, capture.id);
  return { capture: hub.store.get(capture.id)!, suggested: classifyCapture(text).kind, created: [] };
}

let chain: Promise<void> = Promise.resolve();
/** Captures queued or being filed: the retry job queued a slow one again every 2 minutes, past its tries. */
const queued = new Set<string>();

/** Queue a capture for filing (one at a time, so the model is not flooded). A capture already queued is not added. */
export function queueFiling(hub: Hub, captureId: string): Promise<void> {
  if (queued.has(captureId)) return chain;
  queued.add(captureId);
  chain = chain.then(async () => { try { await fileCapture(hub, captureId); } finally { queued.delete(captureId); } }).catch((e) => console.error(`[filer] ${errCode(e)}`));
  return chain;
}

export async function fileCapture(hub: Hub, captureId: string): Promise<Entity | null> {
  const cap = hub.store.get(captureId);
  if (!cap || cap.kind !== "capture" || cap.deleted_at || cap.fields.filing === "done") return cap ?? null;
  if (Number(cap.fields.filing_attempts ?? 0) >= LATE_ATTEMPTS) return cap;
  const attempts = Number(cap.fields.filing_attempts ?? 0) + 1;
  hub.store.patch(captureId, { filing: "pending", filing_attempts: attempts });
  const text = String(cap.fields.text ?? "");
  // A phrase rule for a module that is off (a pet walk with Pet off) is no rule: the model files it as a note or task.
  const read = classifyCapture(text);
  // A record is dated when it was said, not when it is filed (a weight said offline at 21:50, filed after midnight).
  if (typeof read.fields.at === "string") read.fields.at = cap.created_at;
  const owner = moduleOfKind(read.kind);
  const rule: typeof read = owner && !hub.modules.on(owner) ? { ...read, kind: "none", fields: {} } : read;
  const hint = rule.kind === "none" ? undefined : `${rule.kind} ${JSON.stringify(rule.fields)}`;
  // The rule files it when the model cannot, so a clear record (a weight, a dose) is never left waiting.
  const byRule = (why: string, thread?: string) => {
    const made = convertCapture(hub.store, hub.store.get(captureId)!, rule.kind, rule.fields, "auto");
    return hub.store.patch(captureId, { filing: "done", filed: `${filedLabel(made)} (${why})`, ...(thread ? { thread } : {}) });
  };
  try {
    // The chat is kept as the capture and the answer, titled as a capture: the owner opens it to correct a filing, and
    // stored with its filing prompt it was the first chat the Assistant showed, ids and all.
    const thread = `capture-${captureId}`;
    // A photo goes to the model with the words (a receipt, a part, a sign), and into the gallery's Saved pictures, so
    // it is still found once the capture is filed: it used to go nowhere.
    const photos = (Array.isArray(cap.fields.attachments) ? cap.fields.attachments as { mime?: string; bytes_b64?: string; name?: string }[] : [])
      .filter((a) => /^image\//.test(String(a.mime ?? "")) && typeof a.bytes_b64 === "string" && a.bytes_b64.length > 0).slice(0, 4);
    // Only pictures the image store can read go on (a format it does not take must not stop the filing).
    const seen: string[] = [];
    for (const ph of photos) {
      try { recordImage(hub, hub.ai.images.save(ph.bytes_b64!), "attached", { session_id: thread, title: captureTitle(text) || ph.name || "Photo from a capture" }); seen.push(ph.bytes_b64!); }
      catch (e) { console.error(`[filer] photo of ${captureId} not kept: ${errCode(e)}`); }
    }
    const out = await withPriority("filing", () => hub.ai.chat({ session_id: thread, messages: [{ role: "user", content: filingPrompt(text, new Date(cap.created_at), hint, nearbyEvents(hub.store, new Date(cap.created_at)), similarTasks(hub.store, text), noteFolders(hub.store), { owner: hub.profile.get().name, pet: hub.profile.get().pet }, hub.modules.check) }], ...(seen.length ? { images: seen } : {}), store_as: text.trim(), task_type: "general", no_web: true }));
    hub.ai.sessions.rename(thread, captureTitle(text));
    const wrote = (out.actions ?? []).filter((a) => a.ok && a.writes);
    // The store has each item's true kind (a tool result may carry an item's own "kind" field, e.g. a restaurant).
    const items = wrote.flatMap((a) => a.items ?? []).filter((i) => !i.deleted).map((i) => {
      const e = hub.store.get(i.id);
      return e ? { ...i, kind: e.kind, title: filedTitle(e) || i.title || "" } : i;
    });
    const ids = [...new Set(items.map((i) => i.id))];
    // Work items are named only in the work space: their titles in this personal capture outlived an erase.
    const isWork = (id: string) => hub.store.get(id)?.space === "work";
    const work = items.filter((i) => isWork(i.id)).length;
    const byKind = new Map<string, string[]>();
    for (const i of items.filter((x) => !isWork(x.id))) byKind.set(KIND_LABEL[i.kind] ?? i.kind, [...(byKind.get(KIND_LABEL[i.kind] ?? i.kind) ?? []), i.title ?? ""]);
    const listed = [...[...byKind].map(([k, titles]) => `${k}: ${titles.filter(Boolean).join(", ") || "updated"}`), ...(work ? [`Work space: ${work} item${work === 1 ? "" : "s"}`] : [])].join("; ");
    const reply = out.reply.trim().split("\n")[0].slice(0, 200);
    // The assistant said Diary only: a clear record (a weight, a dose) or a command at the start ("remind me to",
    // "todo:", "note:", "remember to") is filed by rule anyway. A phrase that only looks like one ("Check out that
    // sunset", "Start of a cold, ugh", "Jamie said remind me to never eat there") stays in the diary as the assistant said.
    const explicit = /^(remind me\b|reminder\b|todo\b|to-?do\b|task\s*:|note\s*:|idea\s*:|remember\b|fact\s*:)/i.test(text.trim());
    if (!wrote.length && (rule.kind === "log" || (rule.kind !== "none" && explicit))) return byRule("filed by rule", thread);
    const filed = listed || (wrote.length && !work ? reply : wrote.length ? "Filed" : "Diary only");
    const prior = Array.isArray(cap.fields.converted_to) ? cap.fields.converted_to.map(String) : [];
    const first = items[0]?.kind;
    const suggested = ["task", "note", "log", "fact"].includes(String(first)) ? first : "none";
    return hub.store.patch(captureId, { filing: "done", filed, processed: true, sorted_by: "auto", suggested_kind: suggested, converted_to: [...new Set([...prior, ...ids])], thread });
  } catch (e) {
    if (rule.kind !== "none") return byRule("the assistant was unavailable");
    const last = attempts >= MAX_ATTEMPTS;
    console.error(`[filer] capture ${captureId} attempt ${attempts} failed: ${errCode(e)}`);
    // Still in the diary either way; after the third try it shows in Unsorted Info while the job keeps trying.
    return hub.store.patch(captureId, { filing: "failed", ...(last ? { processed: false, filed: "Could not file it automatically" } : {}) });
  }
}

/** Captures filed before 2026-11-02 point at their filing chat when it still exists. Returns how many. */
export function linkCaptureThreads(hub: Hub): number {
  let n = 0;
  for (const c of hub.store.list({ kind: "capture", limit: 100000 })) {
    if (c.fields.thread || c.fields.filing !== "done") continue;
    const id = `capture-${c.id}`;
    if (hub.ai.sessions.get(id)) { hub.store.patch(c.id, { thread: id }); n++; }
  }
  return n;
}

/**
 * Retry filing that failed or was cut short (a hub restart mid-filing), and sort captures a device saved with Save
 * while the hub was out of reach once they arrive.
 */
export function startFilingJob(hub: Hub, everyMs = 120_000): () => void {
  const t = setInterval(() => {
    const now = Date.now();
    for (const c of hub.store.list({ kind: "capture", limit: 100000 })) {
      const f = c.fields;
      if (f.sort === true && !f.processed && !f.filing && !c.deleted_at) { sortCapture(hub, c); continue; }
      const stuck = f.filing === "pending" && now - new Date(c.updated_at).getTime() > 10 * 60_000;
      const tries = Number(f.filing_attempts ?? 0);
      const retry = f.filing === "failed" && tries < LATE_ATTEMPTS && now - new Date(c.updated_at).getTime() > (tries < MAX_ATTEMPTS ? 5 * 60_000 : LATE_EVERY_MS);
      if (stuck || retry) void queueFiling(hub, c.id);
    }
  }, everyMs);
  return () => clearInterval(t);
}
