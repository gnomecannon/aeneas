/**
 * Assistant evaluation: everyday questions and requests go through the real assistant, its tools and the model the
 * hub is configured with, each case on its own throwaway hub holding a made-up but realistic month (people, plans,
 * diary days, tasks, weight and sleep logs, Pepper, shopping lists, a checklist, a renewal, a monitor that is down). Each case
 * checks what changed and what the reply says. Nothing touches the live hub.
 *
 * On the hub machine, with the hub's environment:
 *   cd ~/everythingapp/hub && set -a && . ~/.config/everythingapp/hub.env && set +a && npx tsx scripts/eval-assistant.ts [case ...]
 *
 * Output: one JSON line per case on stderr, a summary on stdout.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Entity } from "@everythingapp/shared";
import { loadConfig } from "../src/config.js";
import { createHub, type Hub } from "../src/hub.js";
import { createApp } from "../src/app.js";
import { runSeeds } from "../src/seed.js";
import { diaryDay } from "../src/diary.js";
import { at, ymd, seedWorld } from "./sample-world.js";
import type { ChatOutput } from "../src/ai/index.js";
import { weekendStart } from "../src/ai/prompt.js";

const TOKEN = "eval-token-0123456789-0123456789";
const DAY = 86400000;

const weekday = (n: number) => at(n).toLocaleDateString("en-US", { weekday: "long" });
/** Day n from today as a reply may write it: November 27, Nov 27, 2026-11-27 or 11/27. */
function dayRe(n: number): string {
  const d = at(n);
  const m = d.toLocaleDateString("en-US", { month: "long" });
  return `(${m}|${m.slice(0, 3)})\\.?\\s+${d.getDate()}(st|nd|rd|th)?\\b|${ymd(n)}|\\b${d.getMonth() + 1}/${d.getDate()}\\b`;
}

interface World { hub: Hub; ids: Record<string, string> }

interface Turn { said: string; out: ChatOutput; tools: string[] }

interface Case {
  id: string;
  /** One message, or a conversation sent in order. */
  say: string | string[];
  /** Asked from the Apple Watch (its chats are "watch-..."). */
  watch?: boolean;
  setup?: (w: World) => void;
  /** Returns a failure reason or null. `turns` holds every reply, `made` everything created or changed. */
  check: (x: World & { turns: Turn[]; reply: string; tools: string[]; made: Entity[] }) => string | null;
}

const title = (e: Entity) => String(e.fields.title ?? e.fields.name ?? e.fields.key ?? e.fields.value ?? "");
const has = (reply: string, ...pats: RegExp[]) => {
  const miss = pats.filter((p) => !p.test(reply));
  return miss.length ? `reply lacks ${miss.map(String).join(", ")}` : null;
};
const lacks = (reply: string, ...pats: RegExp[]) => {
  const hit = pats.filter((p) => p.test(reply));
  return hit.length ? `reply says ${hit.map(String).join(", ")}` : null;
};
const used = (tools: string[], ...names: string[]) => names.some((n) => tools.includes(n)) ? null : `called ${tools.join(", ") || "no tool"}, wanted one of ${names.join(", ")}`;
const first = (...rs: (string | null)[]) => rs.find((r) => r) ?? null;
/** A sentence that suggests the thing again; one that only refers to what Alex already did or ruled out does not count. */
const suggests = (reply: string, re: RegExp) => {
  const hit = reply.split(/(?<=[.!?])\s+|\n+/).find((x) => re.test(x) && !/\b(you('ve| have)? (already )?(restarted|rebooted|reset|tried|power[- ]cycled)|you restarting|already|tried|after|since|ruled out|not the)\b/i.test(x));
  return hit ? `suggests again: ${hit.trim().slice(0, 120)}` : null;
};
/** A fix note was actually written (a refused attempt does not count). */
const wroteNote = (turns: Turn[]) => turns.some((t) => (t.out.actions ?? []).some((a) => a.tool === "runbook_note" && a.ok));
/** Hour and minute of a stored time, local. */
const hm = (s: unknown) => { const d = new Date(String(s)); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };


const CASES: Case[] = [
  { id: "today", say: "what's on today?",
    check: ({ reply, tools }) => first(used(tools, "get_today", "get_week"), has(reply, /dentist/i, /\b3(:00)?\s*(PM|to|-)/i)) },
  { id: "tomorrow-free", say: `anything going on ${weekday(2)}?`,
    check: ({ reply, tools }) => first(used(tools, "get_week", "get_today", "list_items", "search"), has(reply, /board games|devon/i, /\b7(:00)?\s*(PM|to|-)/i)) },
  { id: "recall-day", say: `what did I do ${weekday(-5)}?`,
    check: ({ reply, tools }) => first(used(tools, "diary"), has(reply, /boulder/i)) },
  { id: "recall-person", say: "when did I last see Priya?",
    check: ({ reply }) => first(has(reply, /chipotle/i), lacks(reply, /don'?t (have|know)|no record/i)) },
  { id: "recall-last", say: "when did I last walk Pepper?",
    check: ({ reply }) => first(has(reply, /yesterday|riverside park/i)) },
  { id: "recall-fact", say: "which drives did I order for the NAS?",
    check: ({ reply }) => has(reply, /ironwolf/i, /12\s?TB/i) },
  { id: "note-content", say: "what's my plan for the NAS upgrade?",
    check: ({ reply }) => has(reply, /RAIDZ2/i, /900/) },
  { id: "next-task", say: "what should I work on next?",
    check: ({ reply }) => first(has(reply, /hdmi/i), lacks(reply, /gutters/i)) },
  { id: "done-task", say: "I picked up the HDMI cable",
    check: ({ hub, ids }) => hub.store.get(ids.hdmi)!.fields.status === "done" ? null : `task is ${String(hub.store.get(ids.hdmi)!.fields.status)}` },
  { id: "add-to-list", say: "add a box of wood screws to the hardware store list",
    check: ({ hub, ids, made }) => {
      const items = (hub.store.get(ids.hardware)!.fields.items as { text: string }[]) ?? [];
      if (!items.some((i) => /screw/i.test(i.text))) return `list items: ${items.map((i) => i.text).join(", ")}${made.length ? `; made ${made.map((e) => `${e.kind} ${title(e)}`).join(", ")}` : ""}`;
      return items.length === 4 ? null : `list now has ${items.length} items: ${items.map((i) => i.text).join(", ")}`;
    } },
  { id: "shopping-add", say: "add oat milk to my shopping list",
    check: ({ made }) => {
      const t = made.find((e) => e.kind === "task" && /oat milk/i.test(title(e)));
      const list = (t?.fields.apple as { list_title?: string } | undefined)?.list_title;
      return list === "Alex Shopping" ? null : `oat milk ${t ? `in ${list ?? "no list"}` : "not added"} (made ${made.map((e) => `${e.kind} ${title(e)}`).join(", ") || "nothing"})`;
    } },
  { id: "shopping-read", say: "what's on Jamie's shopping list?",
    check: ({ reply }) => first(has(reply, /candles/i, /hair ties/i), lacks(reply, /dish soap/i)) },
  { id: "list-read", say: "what's left on my hardware store list?",
    check: ({ reply }) => first(has(reply, /anchors/i, /glue/i), lacks(reply, /(?<!(checked|done|ticked|bought|got)[^\n]*)sandpaper(?![^\n]*(checked|done|ticked|bought|got))/i)) },
  { id: "reminder-tonight", say: new Date().getHours() < 19 ? "remind me to take out the trash at 8 tonight" : "remind me to take out the trash tomorrow at 8pm",
    check: ({ made }) => {
      const t = made.find((e) => e.kind === "task" && /trash/i.test(title(e)));
      if (!t) return `no trash task (made ${made.map((e) => e.kind).join(", ") || "nothing"})`;
      const want = new Date().getHours() < 19 ? ymd(0) : ymd(1);
      return diaryDay(new Date(String(t.fields.remind_at))) === want && hm(t.fields.remind_at) === "20:00" ? null : `remind_at ${String(t.fields.remind_at)}`;
    } },
  { id: "move-event", say: "move my dentist appointment to Thursday, same time",
    check: ({ hub, ids, made }) => {
      const e = hub.store.get(ids.dentist)!;
      const thu = [1, 2, 3, 4, 5, 6, 7].find((n) => at(n).getDay() === 4)!;
      if (made.filter((x) => x.kind === "event" && x.id !== ids.dentist).length) return "made a new event instead of moving";
      return diaryDay(new Date(String(e.fields.start))) === ymd(thu) && hm(e.fields.start) === "15:00" && hm(e.fields.end) === "16:00" ? null : `dentist now ${String(e.fields.start)} to ${String(e.fields.end)}`;
    } },
  { id: "plan-then-fix", say: ["dinner with Rafael on Friday", "actually make it 7pm"],
    check: ({ hub }) => {
      const ev = hub.store.list({ kind: "event" }).filter((e) => /rafael/i.test(title(e)) && !e.deleted_at);
      if (ev.length !== 1) return `${ev.length} dinner events: ${ev.map((e) => `${title(e)} ${String(e.fields.start)}`).join(" | ")}`;
      const fri = [1, 2, 3, 4, 5, 6, 7].find((n) => at(n).getDay() === 5)!;
      const e = ev[0];
      return !e.fields.all_day && diaryDay(new Date(String(e.fields.start))) === ymd(fri) && hm(e.fields.start) === "19:00" ? null : `dinner at ${String(e.fields.start)}${e.fields.all_day ? " all day" : ""}`;
    } },
  { id: "weight-trend", say: "how's my weight trending this month?",
    check: ({ reply }) => first(has(reply, /196\.4/, /down|lost|dropp|decreas/i), lacks(reply, /gain(ed)? weight|went up/i)) },
  { id: "sleep-last-night", say: "how much did I sleep last night?",
    check: ({ reply }) => new Date().getHours() < 4 ? has(reply, /7\.2|7 hours?,? (and )?12/i) : has(reply, /6\.5|6 hours?,? (and )?30|six and a half/i) },
  { id: "meds-today", say: "did I take my meds today?",
    check: ({ reply }) => first(has(reply, /claritin/i), lacks(reply, /no (meds|medication)s? (logged|recorded)|haven'?t (logged|taken) any/i)) },
  { id: "log-coffee", say: "log another coffee",
    check: ({ made, reply }) => {
      const l = made.find((e) => e.kind === "log" && e.fields.type === "caffeine");
      if (!l) return `logged ${made.map((e) => `${e.kind} ${String(e.fields.type ?? "")}`).join(", ") || "nothing"}`;
      return first(Number(l.fields.value) === 1 && l.fields.unit === "cups" ? null : `logged ${String(l.fields.value)} ${String(l.fields.unit ?? "")}`, lacks(reply, /placeholder|how many (mg|milligrams)/i));
    } },
  { id: "birthday", say: "when is Jamie's birthday?",
    check: ({ reply }) => has(reply, new RegExp(dayRe(9), "i")) },
  { id: "phone", say: "what's Devon's number?",
    check: ({ reply }) => has(reply, /555.?0142/) },
  { id: "homelab", say: "is anything down in the homelab?",
    check: ({ reply, tools }) => first(used(tools, "ops_status"), has(reply, /nas01|NAS/i, /SMB|445|timeout|down/i), tools.length <= 3 ? null : `${tools.length} tool calls`) },
  { id: "renewal", say: "when does my domain renew?",
    check: ({ reply }) => has(reply, new RegExp(`${dayRe(20)}|in 20 days|20 days`, "i")) },
  { id: "pepper-due", say: "when is Pepper due at the vet next?",
    check: ({ reply }) => has(reply, new RegExp(`${dayRe(25)}|in 25 days|25 days`, "i")) },
  { id: "weekend", say: "what does my weekend look like?",
    check: ({ reply }) => {
      // The seeded plans: the dentist today, board games in two days. Each must be named only when it is this weekend.
      const sat = diaryDay(weekendStart(new Date()));
      const sun = diaryDay(new Date(weekendStart(new Date()).getTime() + DAY));
      const inside = (n: number) => [sat, sun].includes(ymd(n));
      // Naming a plan just outside the weekend as such is fine.
      const outside = (re: RegExp) => lacks(reply, new RegExp(`^(?!.*(near|outside|before|after|wednesday|tuesday|thursday|monday|friday)).*${re.source}`, "im"));
      return first(inside(0) ? has(reply, /dentist/i) : outside(/dentist/i), inside(2) ? has(reply, /board games/i) : outside(/board games/i));
    } },
  { id: "log-weight", say: "157.8 this morning",
    check: ({ made }) => made.some((e) => e.kind === "log" && e.fields.type === "weight" && Number(e.fields.value) === 157.8) ? null : `logged ${made.map((e) => `${e.kind} ${String(e.fields.type ?? title(e))}`).join(", ") || "nothing"}` },
  { id: "gift-ideas", say: "Jamie's birthday is coming up, any gift ideas?",
    check: ({ reply }) => has(reply, /chocolate|pottery/i) },
  { id: "week-recap", say: "give me a quick recap of my last week",
    check: ({ reply, tools }) => first(used(tools, "diary"), has(reply, /boulder/i, /apple picking|chipotle/i)) },
  // A common frustration: being told again to do what was already tried or ruled out.
  { id: "tried-no-repeat", say: ["my Plex server keeps buffering on the living room TV", "I already restarted Plex and the TV, still buffering"],
    check: ({ reply, turns }) => first(wroteNote(turns) ? "wrote a fix note for an open problem" : null, suggests(reply, /\b(restart|reboot|power[- ]cycle)\w*\s+(the\s+|your\s+)?(plex|tv|television)/i),
      (reply.match(/^\s*\d+[.)]\s/gm) ?? []).length <= 3 ? null : `${(reply.match(/^\s*\d+[.)]\s/gm) ?? []).length} numbered steps`) },
  { id: "ruled-out", say: ["my laptop's wifi drops every few minutes", "it's not the router, everything else in the house stays connected", "ok what next?"],
    check: ({ reply, turns }) => first(wroteNote(turns) ? "wrote a fix note for an open problem" : null, suggests(reply, /\b(restart|reboot|power[- ]cycle|reset)\w*\s+(the\s+|your\s+)?router|router firmware|router('s)? (logs|settings|channel)/i)) },
  { id: "draft-text", say: "write a text to Jamie saying I'm running 20 minutes late for dinner",
    check: ({ reply }) => first(has(reply, /20/), reply.length < 400 ? null : `${reply.length} characters for a text`) },
  { id: "remember-self", say: "I switched to a standing desk at home last week",
    check: ({ made, reply }) => first(made.some((e) => e.kind === "fact" && /standing desk/i.test(String(e.fields.value)) && !e.fields.person_id) ? null : `no fact about Alex (made ${made.map((e) => `${e.kind} ${title(e)}`).join(", ") || "nothing"})`,
      has(reply, /standing desk|saved|noted|remember/i), lacks(reply, /how'?s the|how is the|got the (brand|model)/i)) },
  { id: "follow-up-move", say: ["what time is my dentist appointment?", "move it to 4"],
    check: ({ hub, ids }) => {
      const e = hub.store.get(ids.dentist)!;
      return diaryDay(new Date(String(e.fields.start))) === ymd(0) && hm(e.fields.start) === "16:00" ? null : `dentist now ${String(e.fields.start)}`;
    } },
  { id: "check-in", say: "how am I doing this week?",
    check: ({ reply, tools }) => first(tools.length >= 2 ? null : `only ${tools.join(", ") || "no tools"}`, has(reply, /weigh|lb\b/i, /sleep|slept/i)) },
  { id: "project-next", say: "what was I doing next on Starfall?",
    check: ({ reply }) => has(reply, /save button|level file/i, /tile set/i) },
  { id: "music-idea", say: "riff idea: Am F C G in 6/8 at 112, drop D",
    check: ({ made }) => {
      const m = made.find((e) => e.kind === "music_idea");
      if (!m) return `no music idea (made ${made.map((e) => e.kind).join(", ") || "nothing"})`;
      return Number(m.fields.bpm) === 112 && String(m.fields.time_sig) === "6/8" && /drop d/i.test(String(m.fields.tuning ?? "")) ? null : `fields ${JSON.stringify(m.fields).slice(0, 160)}`;
    } },
  { id: "films-recent", say: "what movies have I watched in the last couple weeks?",
    check: ({ reply }) => first(has(reply, /dune/i, /the thing/i), lacks(reply, /^(?!.*(before|outside|earlier|back)).*weapons/im), has(reply, new RegExp(dayRe(-1), "i"))) },
  { id: "game-pick", say: "pick a game for me, Devon and Rafael tonight",
    check: ({ reply }) => first(has(reply, /deep rock/i), lacks(reply, /^(?!.*not).*\bhades\b/im)) },
  { id: "food-pick", say: "what should I eat tonight?",
    check: ({ reply, tools }) => first(used(tools, "pick_food"), reply.length < 700 ? null : `${reply.length} characters`) },
  { id: "inventory", say: "do I have any DS18B20s?",
    check: ({ reply }) => has(reply, /\b5\b|five/i, /drawer 3/i) },
  { id: "changes-server", say: "what did I change on the server recently?",
    check: ({ reply }) => first(has(reply, /ollama/i, /24576|24k/i), lacks(reply, /^(?!.*(nas|other)).*\bfan\b/im)) },
  { id: "subscriptions", say: "what subscriptions am I paying for and how much a month?",
    check: ({ reply }) => has(reply, /plex/i, /spotify/i, /18\.98/) },
  { id: "phone-update", say: "Devon's new number is 312 555 0199",
    check: ({ hub, ids }) => {
      const p = hub.store.get(ids.devon)!;
      const phones = JSON.stringify(p.fields.phones ?? []);
      return /555.?0199/.test(phones) && !/555.?0142/.test(phones) ? null : `phones ${phones}`;
    } },
  { id: "renewed", say: "I renewed the domain",
    check: ({ hub, ids }) => {
      const w = hub.store.get(ids.domain)!;
      return w.fields.renewed_at || String(w.fields.due) > ymd(20) ? null : `domain still due ${String(w.fields.due)}`;
    } },
  { id: "dashboard-add", say: "put my weight on the dashboard for the last 90 days",
    check: ({ hub, tools }) => first(used(tools, "dashboard"), (hub.dashboard.saved() ?? []).some((x) => /weight/.test(x.metric) && x.range === 90) ? null : `tiles ${JSON.stringify(hub.dashboard.saved())}`) },
  { id: "snooze", say: "snooze the vet reminder for an hour",
    check: ({ hub, ids }) => {
      const t = hub.store.get(ids.vet)!;
      const until = Date.parse(String(t.fields.snoozed_until ?? t.fields.remind_at ?? ""));
      return Math.abs(until - (Date.now() + 3600_000)) < 10 * 60_000 ? null : `snoozed to ${String(t.fields.snoozed_until ?? t.fields.remind_at)}`;
    } },
  { id: "homelab-note", say: "note for later: the nas01 SMB share is /media and it's owned by smbuser",
    check: ({ made }) => made.some((e) => /\/media/.test(JSON.stringify(e.fields)) && (e.kind === "runbook" || e.kind === "note" || e.kind === "fact")) ? null : `made ${made.map((e) => e.kind).join(", ") || "nothing"}` },
  { id: "bp-log", say: "bp 128 over 82",
    check: ({ made }) => made.some((e) => e.kind === "log" && e.fields.type === "bp" && String(e.fields.value) === "128/82") ? null : `logged ${made.map((e) => `${e.kind} ${String(e.fields.type ?? "")} ${String(e.fields.value ?? "")}`).join(", ") || "nothing"}` },
  { id: "mood-log", say: "feeling pretty good today, log my mood",
    check: ({ made }) => made.some((e) => e.kind === "log" && e.fields.type === "mood" && Number(e.fields.value) >= 1) ? null : `logged ${made.map((e) => `${e.kind} ${String(e.fields.type ?? "")} ${String(e.fields.value ?? "")}`).join(", ") || "nothing"}` },
  { id: "activity", say: ["starting on soldering the ESP32 board", "done soldering"],
    check: ({ hub }) => {
      const logs = hub.store.list({ kind: "log" }).filter((l) => l.fields.type === "activity" && /solder/i.test(String(l.fields.value)));
      const end = logs.find((l) => l.fields.note === "end");
      const start = logs.find((l) => l.fields.note !== "end");
      if (!start) return "no start log";
      if (!end) return `no end log (values: ${logs.map((l) => String(l.fields.value)).join(", ")})`;
      return String(end.fields.value) === String(start.fields.value) ? null : `end "${String(end.fields.value)}" does not match start "${String(start.fields.value)}"`;
    } },
  { id: "custody", say: "is Pepper with me right now?",
    check: ({ reply }) => first(has(reply, /\byes\b|with you/i), lacks(reply, /\bnot with you\b|with (his )?other/i)) },
  { id: "caffeine-today", say: "how much coffee have I had today?",
    check: ({ reply }) => has(reply, /\b(1|one)\b/i) },
  { id: "watch-today", say: "what's on today?", watch: true,
    check: ({ reply }) => first(has(reply, /dentist/i), /^\s*([-*•]|\d+[.)])\s/m.test(reply) ? "a list on the Watch" : null, reply.length <= 320 ? null : `${reply.length} characters on the Watch`) },
  { id: "note-append", say: "add to my NAS upgrade plan: order a spare 12TB drive as a cold spare",
    check: ({ hub, ids }) => {
      const body = String(hub.store.get(ids.nas)!.fields.body ?? "");
      return /cold spare/i.test(body) && /RAIDZ2/.test(body) && /Budget: \$900/.test(body) ? null : `body now: ${body.slice(0, 200)}`;
    } },
  { id: "rename-task", say: "rename the HDMI task to: Pick up HDMI 2.1 cable",
    check: ({ hub, ids }) => /HDMI 2\.1/.test(String(hub.store.get(ids.hdmi)!.fields.title)) ? null : `title ${String(hub.store.get(ids.hdmi)!.fields.title)}` },
  { id: "park-task", say: "park the car registration task, I'm waiting on the inspection",
    check: ({ hub, ids }) => {
      const t = hub.store.get(ids.registration)!;
      return t.fields.status === "parked" && /inspection/i.test(String(t.fields.parked_reason ?? "")) ? null : `status ${String(t.fields.status)}, reason ${String(t.fields.parked_reason ?? "none")}`;
    } },
  { id: "partner", say: "who's my partner?",
    check: ({ reply }) => has(reply, /\bJamie\b/) },
  { id: "priya-job", say: "where is Priya working now?",
    check: ({ reply }) => has(reply, /northwind/i) },
  { id: "remember-allergy", say: "Rafael is allergic to shellfish",
    check: ({ hub, ids, made }) => {
      const f = made.find((e) => e.kind === "fact" && /shellfish/i.test(String(e.fields.value)));
      if (!f) return `no fact (made ${made.map((e) => e.kind).join(", ") || "nothing"})`;
      return f.fields.person_id === ids.rafael ? null : `fact not on Rafael (person ${String(f.fields.person ?? "none")})`;
    } },
  { id: "cancel-event", say: "board games at Devon's got cancelled",
    check: ({ hub, ids }) => { const e = hub.store.get(ids.games); return e && !e.deleted_at ? `event still there: ${title(e)}` : null; } },
  { id: "schedule-block", say: "block tomorrow 1 to 4pm for the HDMI pickup",
    check: ({ hub, ids, made }) => {
      // Before 4 AM "tomorrow" may be the calendar day that has just begun or the one after.
      const tomorrow = new Date().getHours() < 4 ? [ymd(0), ymd(1)] : [ymd(1)];
      const t = hub.store.get(ids.hdmi)!;
      const b = t.fields.block as { start?: string; end?: string } | undefined;
      if (b?.start) return tomorrow.includes(diaryDay(new Date(b.start))) && hm(b.start) === "13:00" && hm(b.end) === "16:00" ? null : `block ${b.start} to ${b.end}`;
      return `task not blocked (made ${made.map((e) => `${e.kind} ${title(e)}`).join(", ") || "nothing"})`;
    } },
  { id: "count-diary", say: "how many times did I go bouldering in the last two weeks?",
    check: ({ reply, tools }) => first(used(tools, "diary", "search"), has(reply, /\b(once|one|1)\b/i), lacks(reply, /\b(twice|two times|2 times|three)\b/i)) },
  { id: "quick-note", say: "make a note: the router admin page is at 192.168.1.1",
    check: ({ made }) => made.some((e) => /192\.168\.1\.1/.test(JSON.stringify(e.fields))) ? null : `nothing saved with the address (made ${made.map((e) => e.kind).join(", ") || "nothing"})` },
  { id: "tip", say: "what's a 20% tip on $84.50?",
    check: ({ reply }) => has(reply, /16\.90/) },
  { id: "ideas-by-kind", say: "what skit ideas do I have?",
    check: ({ reply }) => first(has(reply, /robot choir|vacuum/i, /silent auction/i), lacks(reply, /lighthouse/i)) },
  { id: "music-to-project", say: "add a riff to my Songs project: E5 G5 A5 in drop D",
    check: ({ hub, ids }) => {
      const m = hub.store.list({ kind: "music_idea" });
      if (!m.length) return "no music idea";
      return m.some((x) => x.fields.project_id === ids.songs) ? null : `music idea not on Songs (project ${String(m[0].fields.project_id ?? "none")})`;
    } },
  { id: "charges-soon", say: "what subscriptions are charging me this week?",
    check: ({ reply }) => has(reply, /spotify/i, /11\.99/) },
  { id: "delete-made", say: ["add a task to call the landlord about the radiator", "never mind, delete that"],
    check: ({ hub, tools }) => {
      const left = hub.store.list({ kind: "task" }).filter((e) => /landlord/i.test(title(e)));
      if (!tools.includes("delete_item")) return `called ${tools.join(", ")}, no delete`;
      return left.length ? `${left.length} landlord tasks left` : null;
    } },
];

function freshHub(): World & { dir: string } {
  process.env.EA_NO_DOTENV = "1";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-eval-assistant-"));
  const cfg = loadConfig({ dataDir: dir, token: TOKEN, aiFake: false, logRequests: false, searxngUrl: "", imageServiceUrl: "", imageServiceToken: "", hostActions: false,
    sshConfigPath: path.join(dir, "no-ssh-config"), hostsFile: path.join(dir, "hosts.json"), vaultDir: path.join(dir, "vault") } as any);
  const hub = createHub(cfg);
  // The owner of the made-up world: the hub speaks of them by this name, and "my" list is the one named for them.
  hub.profile.set({ name: "Alex" });
  createApp(hub); // wires the tools
  runSeeds(hub.store, cfg);
  return { hub, dir, ids: seedWorld(hub) };
}

async function main() {
  const only = process.argv.slice(2);
  const cases = only.length ? CASES.filter((c) => only.includes(c.id)) : CASES;
  let pass = 0;
  const fails: string[] = [];
  let total = 0;
  for (const c of cases) {
    const w = freshHub();
    c.setup?.(w);
    const before = new Set(w.hub.store.list({ limit: 100000 } as any).map((e) => `${e.id}@${e.updated_at}`));
    const session = `${c.watch ? "watch" : "eval"}-${c.id}-${Date.now()}`;
    const turns: Turn[] = [];
    let err = "";
    const t0 = Date.now();
    for (const said of Array.isArray(c.say) ? c.say : [c.say]) {
      try {
        const out = await w.hub.ai.chat({ session_id: session, message: said, task_type: "auto" });
        turns.push({ said, out, tools: (out.actions ?? []).map((a) => a.tool) });
      } catch (e) { err = (e as Error).message; break; }
    }
    const ms = Date.now() - t0;
    total += ms;
    const made = w.hub.store.list({ limit: 100000 } as any).filter((e) => !before.has(`${e.id}@${e.updated_at}`));
    const reply = turns.at(-1)?.out.reply ?? "";
    const tools = turns.flatMap((t) => t.tools);
    const lastLine = reply.trim().split("\n").filter(Boolean).at(-1) ?? "";
    const style = /[–—]/.test(reply) ? "reply has a dash"
      : /\b(go to bed|get some sleep|get some rest|it'?s (late|\d{1,2}:\d\d ?[ap]m), so)\b/i.test(reply) ? "remarks on the hour"
      : /\b(say the word|if you('d)? (like|prefer)|tell me if you|let me know|feel free|(tweak|adjust|change) (the )?(tone|wording)|add anything|want it shorter)\b/i.test(lastLine) ? `closing offer: ${lastLine.slice(0, 80)}` : null;
    const problem = err || c.check({ ...w, turns, reply, tools, made }) || style;
    if (problem) fails.push(c.id); else pass++;
    console.error(JSON.stringify({ case: c.id, ok: !problem, ms, problem: problem || undefined, tools, reply: problem ? turns.map((t) => t.out.reply) : reply.slice(0, 160) }));
    w.hub.close();
    fs.rmSync(w.dir, { recursive: true, force: true });
  }
  console.log(`assistant eval: pass ${pass}/${cases.length}, avg ${(total / cases.length / 1000).toFixed(1)}s, fails: ${fails.join(", ") || "none"}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
