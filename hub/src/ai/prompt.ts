import type { Entity } from "@everythingapp/shared";
import type { Store } from "../store.js";
import type { AiMessage } from "./backends.js";
import type { TouchedItem } from "./sessions.js";
import { hostMemory, hostsIn, knownHosts, renderHostMemory, type HostMemory } from "../memory.js";
import { taskLists } from "./lists.js";

export interface MemoryOpts { cloud: boolean; allowWork: boolean }

export interface Memory { facts: Entity[]; rules: Entity[]; ledger: Entity | null; project: Entity | null; hosts: HostMemory[]; lists: string[]; checklists: string[] }

/** Facts and rules that would be injected for the given egress policy. */
export function loadMemory(store: Store, opts: MemoryOpts, sessionId?: string, messages: AiMessage[] = []): Memory {
  const facts = store.list({ kind: "fact" })
    .filter((f) => !(opts.cloud && f.fields.private === true))
    .filter((f) => opts.allowWork || f.space !== "work")
    .sort((a, b) => String(a.fields.category).localeCompare(String(b.fields.category)) || String(a.fields.key).localeCompare(String(b.fields.key)));
  // Every list in the system prompt is in a fixed order (oldest first, or by name), never by last change: the prompt
  // is read from the model server's cache only as far as it matches the last one, so ticking a grocery item or editing
  // a rule must not reshuffle it.
  const byAge = (a: Entity, b: Entity) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
  const byName = (a: string, b: string) => a.localeCompare(b);
  const rules = store.list({ kind: "rule" }).filter((r) => r.fields.active !== false).sort(byAge);
  let ledger: Entity | null = null;
  if (sessionId) {
    ledger = store.list({ kind: "ledger", where: { session_id: sessionId } }).find((l) => l.fields.open !== false) ?? null;
  }
  let project: Entity | null = null;
  const text = messages.map((m) => m.content).join("\n");
  const ids = new Set((text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? []).map((s) => s.toLowerCase()));
  for (const id of ids) {
    const e = store.get(id);
    if (e && e.kind === "project" && !e.deleted_at) { project = e; break; }
  }
  // Module 2: runbook head and recent journal for every known host the conversation names.
  const hosts = hostMemory(store, hostsIn(text, knownHosts(store)));
  // Personal lists only, like the facts: work names stay out unless the chat may see work.
  const checklists = store.list({ kind: "checklist" }).filter((c) => (opts.allowWork || c.space !== "work") && c.fields.template !== true && c.fields.archived !== true).map((c) => String(c.fields.title ?? "")).filter(Boolean).sort(byName);
  return { facts, rules, ledger, project, hosts, lists: [...taskLists(store, "personal").sort(byName), ...(opts.allowWork ? taskLists(store, "work").sort(byName) : [])], checklists };
}

/**
 * The system prompt the pipeline sends, built from memory rows. It holds only what stays the same from one message
 * to the next and from one chat to the next (rules, facts, list names, the project), so the model server reuses it
 * and the tool list after it from cache instead of reading them again. What changes each turn, the mode included,
 * goes in `turnContext`.
 */
export function buildSystemPrompt(mem: Memory, taskType: string): string {
  const parts: string[] = [];
  parts.push("You are the assistant inside Aeneas, a single-user personal system. Answer directly, concretely and briefly. Stop when the answer is done: no vague closing offers (\"Say the word if...\", \"If you'd like, I can...\", \"Tell me if you meant...\"). At most one closing question, and only for a concrete next step you would take (\"Log Allegra too?\"); never ask for details you do not need (\"Got the brand too?\") or whether to change what you just gave. Do not remark on the hour or tell {{owner}} to sleep or rest unless they ask.");
  const promptRules = mem.rules.filter((r) => r.fields.enforce === "prompt" || r.fields.enforce === "both");
  if (promptRules.length) {
    parts.push("Standing rules (always follow):\n" + promptRules.map((r) => `- ${r.fields.text}`).join("\n"));
  }
  if (mem.facts.length) {
    parts.push("Facts about the user (do not re-ask these):\n" + mem.facts.map((f) => `- [${f.fields.category}] ${f.fields.key}: ${f.fields.value}`).join("\n"));
  }
  // The names of the owner's lists, so "my shopping list" is found: they change rarely, so this part stays cached.
  if (mem.lists.length || mem.checklists.length) {
    parts.push([
      mem.lists.length ? `{{owner}}'s Apple Reminders lists (shopping and to-do lists; read with list_items kind=task list=..., add with create_task list=...): ${mem.lists.join(", ")}.` : "",
      mem.checklists.length ? `Checklists in the app (read with get_item, add a line with update_item and the whole items list): ${mem.checklists.join(", ")}.` : "",
      "Use the one whose name {{owner}} means; \"my\" list is the one named for {{owner}} when several match (\"my shopping list\" is {{owner}}'s shopping list).",
    ].filter(Boolean).join(" "));
  }
  if (mem.project) {
    const p = mem.project.fields as { name: string; definition_of_done?: string; resume_card?: string };
    parts.push(`Project ${p.name}:\nDefinition of done: ${p.definition_of_done ?? ""}` + (p.resume_card ? `\nResume card:\n${p.resume_card}` : ""));
  }
  // Draft runs without tools, so its line can sit here; the modes that use tools get theirs in `turnContext`, keeping
  // this prompt the same in every mode.
  if (taskType === "draft") parts.push("Draft the requested text in the user's own voice. Output only the draft.");
  return parts.join("\n\n");
}

/** The clock as the model should read it: local time with its offset and zone. */
export function clockLine(now: Date): string {
  const off = -now.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const pad = (n: number) => String(Math.trunc(Math.abs(n))).padStart(2, "0");
  const local = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}${sign}${pad(off / 60)}:${pad(off % 60)}`;
  const weekday = now.toLocaleDateString("en-US", { weekday: "long" });
  return `Today is ${weekday} ${local.slice(0, 10)}. Current local time: ${local} (${Intl.DateTimeFormat().resolvedOptions().timeZone}). ${lateNight(now)}${pastDays(now)} ${comingDays(now)} ${weekendLine(now)}`;
}

/**
 * Before 4 AM the owner has most likely not slept yet. What they did "today" belongs to the day before (the diary day);
 * plans look past the sleep: "tomorrow" is the calendar day that has just begun, and a "tonight" hour that has passed
 * is that hour this coming evening. Told only "today is the day before", the model put "8 tonight" on the evening gone.
 */
export function lateNight(now: Date): string {
  if (now.getHours() >= 4) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  const name = (d: Date) => `${d.toLocaleDateString("en-US", { weekday: "long" })} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const before = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12);
  // Worded without sleep: told the owner had not slept yet, the model started replies with "it's 3 AM, go to bed".
  return `It is past midnight and before 4 AM. Things {{owner}} did "today" or "tonight" belong to ${name(before)} (the diary day until 4 AM). In plans and reminders, "tomorrow" means ${name(now)}, and a time "tonight" that has passed means that time on the evening of ${name(now)}. `;
}

/** The Saturday that starts "this weekend": today's on a weekend day, else the coming one. */
export function weekendStart(now: Date): Date {
  const back = now.getDay() === 0 ? -1 : now.getDay() === 6 ? 0 : 6 - now.getDay();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + back, 12);
}

/** Which days "this weekend" and "next weekend" are. On a Sunday the model paired today with next Saturday. */
export function weekendLine(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const sat = weekendStart(now);
  const plus = (n: number) => new Date(sat.getFullYear(), sat.getMonth(), sat.getDate() + n, 12);
  return `This weekend is Saturday ${ymd(sat)} and Sunday ${ymd(plus(1))}; next weekend is Saturday ${ymd(plus(7))} and Sunday ${ymd(plus(8))}.`;
}

/** The dates of the last six days by name, for "yesterday" and "on Saturday": the model put "yesterday" on today. */
export function pastDays(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const days: string[] = [];
  for (let i = 1; i <= 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i, 12);
    const name = d.toLocaleDateString("en-US", { weekday: "long" });
    days.push(`${i === 1 ? "yesterday " : ""}${name} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
  }
  return `Past days: ${days.join(", ")}.`;
}

/** The dates of the next seven days by name. The model worked weekdays out itself and put "Sunday" on a Saturday. */
export function comingDays(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const days: string[] = [];
  for (let i = 1; i <= 7; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i, 12);
    const name = d.toLocaleDateString("en-US", { weekday: "long" });
    days.push(`${i === 1 ? "tomorrow " : ""}${name} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
  }
  return `Coming days: ${days.join(", ")}.`;
}

/**
 * What changes every turn: the clock, the troubleshooting ledger and the memory of hosts the chat names. It rides
 * at the top of the owner's newest message, after everything the model server already has cached.
 */
export function turnContext(mem: Memory, taskType: string, now: Date, items: TouchedItem[] = [], device?: string): string {
  const parts: string[] = [clockLine(now)];
  if (device) parts.push(device);
  if (taskType === "troubleshoot") parts.push("This is a troubleshooting session. Suggest one or two steps per reply, in order, and say which host and which user each command runs as.");
  if (taskType === "plan") parts.push("Produce a plan as an ordered list of concrete steps with the next single action first.");
  // Ids of what this chat already saved, so "move it" or "delete that" uses the real item. Here and not in the
  // assistant's own past turns: written there, the model copied the line into replies instead of calling a tool.
  if (items.length) parts.push("Items saved or changed earlier in this chat (use these ids to change them):\n" + items.map((i) => `- ${i.kind} ${i.id}${i.title ? ` "${i.title}"` : ""}${i.deleted ? " (deleted)" : ""}`).join("\n"));
  if (mem.ledger) {
    const l = mem.ledger.fields as { topic?: string; tried?: { at: string; what: string; result: string }[]; ruled_out?: string[]; confirmed?: string[] };
    const lines: string[] = [`Topic: ${l.topic ?? ""}`];
    if (l.tried?.length) lines.push("Already tried:\n" + l.tried.map((t) => `- ${t.what} (result: ${t.result})`).join("\n"));
    if (l.ruled_out?.length) lines.push("Ruled out (never suggest again):\n" + l.ruled_out.map((s) => `- ${s}`).join("\n"));
    if (l.confirmed?.length) lines.push("Confirmed by the user (never re-ask):\n" + l.confirmed.map((s) => `- ${s}`).join("\n"));
    parts.push("Troubleshooting ledger for this session:\n" + lines.join("\n"));
  }
  if (taskType === "troubleshoot" && mem.hosts.length) parts.push("Memory for the hosts named in this conversation (runbook head and recent changes):\n\n" + renderHostMemory(mem.hosts));
  return `[Context from Aeneas, not typed by {{owner}}]\n${parts.join("\n\n")}\n[End of context]`;
}

export const CLASSIFY_SYSTEM = [
  "You classify a short captured text into exactly one kind. Reply with strict JSON only, no prose, no code fence.",
  'Shape: {"kind": "task|note|reminder|log|fact|none", "fields": {...}}.',
  "Fields by kind: task {title}; note {title, body}; reminder {title, at (ISO 8601 if a time is stated)}; log {type (weight|med|bp|caffeine|sleep|mood|activity|custom), value, unit}; fact {category (identity|constraint|preference|health|relationship|host|project|gear|history), key, value}.",
  "Use none when unsure.",
].join(" ");
