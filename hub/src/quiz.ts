import { nowIso } from "@everythingapp/shared";
import { withPriority } from "./ai/backends.js";
import type { Entity } from "@everythingapp/shared";
import type { Hub } from "./hub.js";
import { Store, StoreError } from "./store.js";
import { dayKey } from "./metrics.js";
import { scheduleDaily } from "./schedule.js";
import { projectsActive } from "./projects.js";
import { proceduresOpen } from "./procedures.js";
import { musicIdeasCount } from "./music.js";
import type { AiMessage } from "./ai/backends.js";
import { errCode } from "./logsafe.js";

/**
 * Module 5, recall. At EA_QUIZ_TIME the model turns today's assistant sessions into up to five question,
 * answer and hint triples about what the user learned. No sessions or no model means no quiz that day.
 */

export const QUIZ_MAX = 5;
export const QUIZ_SYSTEM = [
  "You write a short recall quiz from today's assistant sessions. Reply with strict JSON only, no prose, no code fence.",
  'Shape: {"items": [{"q": string, "a": string, "hint": string, "topic": string}]}.',
  `At most ${QUIZ_MAX} items. Ask only about facts, commands, concepts and decisions the user learned or worked out in the sessions.`,
  "Never ask about the user themselves: not their habits, health, schedule, feelings or personal details.",
  "Each answer is one short line. Each hint points at the answer without giving it. Topic is one to three words.",
  "No dashes as punctuation, no emoji.",
].join(" ");

export interface QuizItem { q: string; a: string; hint: string; topic: string; asked_at?: string; result?: "right" | "wrong" | "revealed" }
interface SessionRow { session_id: string; task_type: string; created_at: string; last_at: string; messages: string }

/** Parse the model's JSON without trusting it. Null when no item survives. */
export function parseModelQuiz(raw: string): QuizItem[] | null {
  try {
    const cleaned = raw.replace(/```(?:json)?/g, "").trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    const obj = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
    const items = (Array.isArray(obj.items) ? obj.items : [])
      .filter((i): i is Record<string, unknown> => !!i && typeof i === "object" && typeof (i as any).q === "string" && typeof (i as any).a === "string" && String((i as any).q).trim() !== "" && String((i as any).a).trim() !== "")
      .slice(0, QUIZ_MAX)
      .map((i) => ({
        q: String(i.q).trim().slice(0, 500), a: String(i.a).trim().slice(0, 500),
        hint: typeof i.hint === "string" ? i.hint.trim().slice(0, 300) : "",
        topic: typeof i.topic === "string" ? i.topic.trim().slice(0, 60) : "",
      }));
    return items.length ? items : null;
  } catch {
    return null;
  }
}

/** Sessions touched today (local day), oldest first. */
export function sessionsToday(hub: Hub, now: Date = new Date()): { session_id: string; messages: AiMessage[] }[] {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).toISOString();
  const rows = hub.chatDb.prepare("SELECT * FROM sessions WHERE last_at >= ? ORDER BY last_at ASC").all(start) as SessionRow[];
  return rows
    .filter((r) => !/:(close|resume)$/.test(r.session_id))
    .map((r) => ({ session_id: r.session_id, messages: (JSON.parse(r.messages) as AiMessage[]).filter((m) => m.role === "user" || m.role === "assistant") }))
    .filter((s) => s.messages.length);
}

export function quizFor(store: Store, date: string): Entity | null {
  return store.list({ kind: "quiz", limit: 100000 }).find((q) => q.fields.date === date) ?? null;
}

/** GET /quiz/today. */
export function quizToday(store: Store, now: Date = new Date()): Entity | null {
  return quizFor(store, dayKey(now));
}

/** Builds under way, per hub and day. */
const building = new WeakMap<Hub, Map<string, Promise<Entity | null>>>();

/**
 * Build today's quiz. Returns the existing one when the day already has a quiz, null when there is nothing
 * to ask from (no sessions, no local model, or the model gave no usable item). A second build while one is under way
 * (the nightly job and the owner opening the quiz, two devices at once) waits for it instead of making a second quiz
 * for the day, which it used to.
 */
export function buildQuiz(hub: Hub, now: Date = new Date()): Promise<Entity | null> {
  const date = dayKey(now);
  const mine = building.get(hub) ?? new Map<string, Promise<Entity | null>>();
  building.set(hub, mine);
  const running = mine.get(date);
  if (running) return running;
  const p = makeQuiz(hub, date, now).finally(() => mine.delete(date));
  mine.set(date, p);
  return p;
}

async function makeQuiz(hub: Hub, date: string, now: Date): Promise<Entity | null> {
  const existing = quizFor(hub.store, date);
  if (existing) return existing;
  const sessions = sessionsToday(hub, now);
  if (!sessions.length || !hub.ai.available()) return null;
  const transcript = sessions
    .map((s) => `Session ${s.session_id}:\n${s.messages.map((m) => `${m.role}: ${m.content}`).join("\n")}`)
    .join("\n\n")
    .slice(-16000);
  // The transcripts are whole chats, work chats too: a local model only, like every other background job. The
  // default routing used to send them to a cloud model when one was set up and allowed by default, or the only one.
  const raw = await withPriority("filing", () => hub.ai.completeJson(`quiz:${date}`, QUIZ_SYSTEM, `Date: ${date}\n\n${transcript}`, { allow_cloud: false }));
  const items = raw === null ? null : parseModelQuiz(raw);
  if (!items) return null;
  const again = quizFor(hub.store, date);
  if (again) return again;
  const quiz = hub.store.create("quiz", { date, items, source_sessions: sessions.map((s) => s.session_id) });
  hub.bus.emit("notify", { id: `quiz:${date}`, kind: "quiz", title: `Recall quiz: ${items.length} questions`, at: now.toISOString(), date });
  return quiz;
}

/** The nightly build, only with EA_BACKGROUND_AI=auto; otherwise the quiz is made when the owner opens it (POST /quiz/build). */
export function startQuizJob(hub: Hub): () => void {
  if (hub.cfg.backgroundAi !== "auto") return () => {};
  const [h, m] = hub.cfg.quizTime.split(":").map((x) => parseInt(x, 10));
  return scheduleDaily("quiz", h, m, () => { if (hub.modules.on("quiz")) buildQuiz(hub).catch((e) => console.error(`[quiz] build failed: ${errCode(e)}`)); });
}

const RESULTS = new Set(["right", "wrong", "revealed"]);

/** POST /quiz/:id/answer: record one item's result; the quiz completes when every item has one. */
export function answerQuiz(store: Store, id: string, body: { index?: unknown; result?: unknown }): Entity {
  const q = store.get(id);
  if (!q || q.kind !== "quiz" || q.deleted_at) throw new StoreError(404, "quiz not found");
  const items = (q.fields.items as QuizItem[]).map((i) => ({ ...i }));
  const index = typeof body.index === "number" ? body.index : parseInt(String(body.index ?? ""), 10);
  if (!Number.isInteger(index) || index < 0 || index >= items.length) throw new StoreError(422, "index is out of range");
  if (!RESULTS.has(String(body.result))) throw new StoreError(422, "result must be right, wrong or revealed");
  const now = nowIso();
  items[index] = { ...items[index], result: String(body.result) as QuizItem["result"], asked_at: now };
  const fields: Record<string, unknown> = { items };
  if (items.every((i) => i.result) && !q.fields.completed_at) fields.completed_at = now;
  return store.patch(id, fields);
}

/**
 * Completed quizzes in a row, newest first, up to today. A day with no quiz (no chats that day, or none was made)
 * had nothing to take and is skipped; a quiz left unfinished breaks the streak, except today's, which can still be
 * finished. A day without a quiz used to break it too.
 */
export function quizStreakDays(store: Store, now: Date = new Date()): number {
  const today = dayKey(now);
  const done = new Map<string, boolean>();
  for (const q of store.list({ kind: "quiz", limit: 100000 })) {
    const d = String(q.fields.date);
    if (d <= today) done.set(d, done.get(d) === true || !!q.fields.completed_at);
  }
  let n = 0;
  for (const d of [...done.keys()].sort().reverse()) {
    if (done.get(d)) n++;
    else if (d !== today) break;
  }
  return n;
}

export function creativeStatus(hub: Hub, now: Date = new Date()): { projects_active: number; procedures_open: number; music_ideas: number; quiz_streak_days: number } {
  return { projects_active: projectsActive(hub.store), procedures_open: proceduresOpen(hub.store), music_ideas: musicIdeasCount(hub.store), quiz_streak_days: quizStreakDays(hub.store, now) };
}
