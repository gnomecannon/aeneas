/**
 * Capture filing evaluation: realistic quick captures go through the real filer (capture-filer.ts), the real
 * assistant and the model the hub is configured with, each on its own throwaway hub, and the result is checked
 * against where the capture should have gone. Nothing touches the live hub, Apple Calendar or Contacts.
 *
 * On the hub machine, with the hub's environment:
 *   cd ~/everythingapp/hub && set -a && . ~/.config/everythingapp/hub.env && set +a && npx tsx scripts/eval-filing.ts [case ...]
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
import { fileCapture } from "../src/capture-filer.js";
import { appendDiary, captureDay, diaryDay } from "../src/diary.js";

const TOKEN = "eval-token-0123456789-0123456789";
const DAY = 86400000;

interface Case {
  id: string;
  text: string;
  /** Minutes before now the capture was written, or a clock time today ("00:18"). */
  at?: number | string;
  /** Items already there before the capture (a plan on the calendar). */
  setup?: (hub: Hub, day: (n: number) => string) => void;
  /** Returns a failure reason or null. `made` is everything the filing created or changed, `day(n)` the diary day plus n. */
  check: (x: { hub: Hub; made: Entity[]; day: (n: number) => string; at: Date; filed: string }) => string | null;
}

const of = (made: Entity[], kind: string) => made.filter((e) => e.kind === kind);
const title = (e: Entity) => String(e.fields.title ?? e.fields.name ?? e.fields.key ?? "");
const startDay = (e: Entity) => (e.fields.all_day ? String(e.fields.start).slice(0, 10) : diaryDay(new Date(String(e.fields.start))));

/** An all-day event on `want` whose title matches every pattern. */
function allDayEvent(made: Entity[], want: string, ...words: RegExp[]): string | null {
  const ev = of(made, "event");
  if (!ev.length) return "no calendar event";
  const hit = ev.find((e) => words.every((w) => w.test(title(e))));
  if (!hit) return `event title missing ${words.map(String).join(" ")}: ${ev.map(title).join(" | ")}`;
  if (!hit.fields.all_day) return `timed event, wanted all day (${String(hit.fields.start)})`;
  return startDay(hit) === want ? null : `event on ${startDay(hit)}, wanted ${want}`;
}

const nothingFiled = (made: Entity[]) => {
  const bad = made.filter((e) => ["event", "task", "fact", "person"].includes(e.kind));
  return bad.length ? `filed a passing thought as ${bad.map((e) => `${e.kind} "${title(e)}"`).join(", ")}` : null;
};

const nextWeekday = (from: Date, wd: number) => { const d = new Date(from); d.setDate(d.getDate() + (((wd - d.getDay() + 7) % 7) || 7)); return d; };

const CASES: Case[] = [
  { id: "late-night-outing", text: "Went apple picking with Jamie, Devon, Rafael, and Priya, then had Thai food and watched 2 movies", at: "00:18",
    check: ({ made, day }) => allDayEvent(made, day(0), /apple/i, /jamie/i) },
  { id: "planned-outing", text: "Went apple picking with Jamie, Devon, Rafael, and Priya, then had Thai food and watched 2 movies", at: "22:40",
    setup: (hub, day) => { hub.store.create("event", { title: "Apple picking and movie night with Devon", start: new Date(`${day(0)}T11:30:00`).toISOString(), end: new Date(`${day(0)}T23:29:00`).toISOString() }); },
    check: ({ hub, day }) => {
      const ev = hub.store.list({ kind: "event" }).filter((e) => /apple/i.test(title(e)) && startDay(e) === day(0));
      if (ev.length !== 1) return `${ev.length} apple picking events: ${ev.map(title).join(" | ")}`;
      if (!/jamie/i.test(title(ev[0]))) return `planned event not updated: ${title(ev[0])}`;
      return new Date(String(ev[0].fields.start)).getHours() === 11 && !ev[0].fields.all_day ? null : `planned times changed: ${String(ev[0].fields.start)}${ev[0].fields.all_day ? " all day" : ""}`;
    } },
  { id: "yesterday", text: "Yesterday I went bouldering with Devon at the climbing gym",
    check: ({ made, day }) => allDayEvent(made, day(-1), /boulder/i, /devon/i) },
  { id: "last-night", text: "Last night saw Dune Part Three with Rafael at the Alamo",
    check: ({ made, day }) => allDayEvent(made, day(-1), /dune/i) },
  { id: "plan-tonight", text: "Dinner at Luigi's with Jamie tonight",
    check: ({ made, day }) => allDayEvent(made, day(0), /luigi/i, /jamie/i) },
  { id: "plan-timed", text: "Dentist Tuesday at 3pm",
    check: ({ made, at }) => {
      const ev = of(made, "event").find((e) => /dentist/i.test(title(e)));
      if (!ev) return "no dentist event";
      const s = new Date(String(ev.fields.start));
      const want = nextWeekday(at, 2);
      // Written on a Tuesday before 3 PM, "Tuesday at 3pm" may be today as well as next week.
      const today = at.getDay() === 2 && at.getHours() < 15 && diaryDay(s) === diaryDay(at);
      return !ev.fields.all_day && (diaryDay(s) === diaryDay(want) || today) && s.getHours() === 15 ? null : `dentist at ${String(ev.fields.start)}, wanted ${diaryDay(want)} 15:00`;
    } },
  { id: "today-outing", text: "Had lunch at Chipotle with Priya",
    check: ({ made, day }) => allDayEvent(made, day(0), /chipotle/i, /priya/i) },
  { id: "task", text: "pick up hdmi cable from micro center",
    check: ({ made }) => of(made, "task").some((t) => /hdmi/i.test(title(t))) ? (of(made, "event").length ? "also made an event" : null) : "no hdmi task" },
  { id: "task-due", text: "Need to renew my passport before March",
    check: ({ made }) => {
      const t = of(made, "task").find((x) => /passport/i.test(title(x)));
      if (!t) return "no passport task";
      if (!(t.fields.due && /-(02-2[89]|03-01)/.test(String(t.fields.due)))) return `due is ${String(t.fields.due ?? "missing")}`;
      return /ahead|early|weeks/i.test(String(t.fields.notes ?? "")) ? `advice in notes: ${String(t.fields.notes)}` : null;
    } },
  { id: "reminder", text: "Remind me to call mom tomorrow at 9am",
    check: ({ made, at }) => {
      const t = of(made, "task").find((x) => /mom/i.test(title(x)));
      if (!t) return "no call mom task";
      const r = new Date(String(t.fields.remind_at ?? ""));
      const want = new Date(at.getTime() + DAY); want.setHours(9, 0, 0, 0);
      return Math.abs(r.getTime() - want.getTime()) < 60_000 ? null : `remind_at ${String(t.fields.remind_at ?? "missing")}`;
    } },
  { id: "weight", text: "Today I weigh 116.4",
    check: ({ made }) => of(made, "log").some((l) => l.fields.type === "weight" && Number(l.fields.value) === 116.4) ? null : "no weight log" },
  { id: "med", text: "Took my claritin",
    check: ({ made }) => of(made, "log").some((l) => /claritin/i.test(JSON.stringify(l.fields))) ? null : "no claritin log" },
  { id: "dog-walk", text: "Walked Pepper for 40 minutes",
    check: ({ made }) => made.some((e) => (e.kind === "pet_event" || e.kind === "log") && /walk|40/i.test(JSON.stringify(e.fields))) ? null : "no walk recorded" },
  { id: "person-like", text: "Jamie loves dark chocolate",
    check: ({ made, hub }) => {
      const jamie = hub.store.list({ kind: "person" }).find((p) => p.fields.name === "Jamie");
      const f = of(made, "fact").find((x) => /chocolate/i.test(String(x.fields.value)));
      if (!f) return "no fact";
      return f.fields.person_id === jamie?.id ? null : `fact not linked to Jamie (person ${String(f.fields.person ?? "none")})`;
    } },
  { id: "person-birthday", text: "Devon's birthday is March 14",
    check: ({ hub }) => {
      const s = hub.store.list({ kind: "person" }).find((p) => /devon/i.test(String(p.fields.name)));
      const all = hub.store.list({ kind: "person" }).filter((p) => /devon/i.test(String(p.fields.name)));
      if (all.length > 1) return "made a second Devon";
      return /03-14$/.test(String(s?.fields.birthday ?? "")) ? null : `birthday is ${String(s?.fields.birthday ?? "missing")}`;
    } },
  { id: "preference", text: "I prefer aisle seats on flights",
    check: ({ made }) => of(made, "fact").some((f) => /aisle/i.test(String(f.fields.value))) ? null : "no aisle fact" },
  { id: "recommendation", text: "Rafael recommended the ramen place on Elm St",
    check: ({ made }) => {
      // Saved somewhere that names both the place and Rafael, so it shows on Rafael's page.
      const hit = made.find((e) => /ramen/i.test(JSON.stringify(e.fields)) && /rafael/i.test(JSON.stringify(e.fields)));
      return hit ? null : `nothing names both: ${made.map((e) => `${e.kind} ${JSON.stringify(e.fields).slice(0, 80)}`).join(" | ") || "nothing"}`;
    } },
  { id: "shopping", text: "dish soap for my shopping list",
    check: ({ made }) => {
      const t = made.find((e) => e.kind === "task" && /dish soap/i.test(title(e)));
      const list = (t?.fields.apple as { list_title?: string } | undefined)?.list_title;
      return list === "Alex Shopping" ? null : t ? `in ${list ?? "no list"}` : `no task (made ${made.map((e) => e.kind).join(", ") || "nothing"})`;
    } },
  { id: "vague-time", text: "call the bank tomorrow morning",
    check: ({ made, day }) => {
      const t = made.find((e) => e.kind === "task" && /bank/i.test(title(e)));
      if (!t) return `no bank task (made ${made.map((e) => e.kind).join(", ") || "nothing"})`;
      const when = String(t.fields.remind_at ?? t.fields.due ?? "");
      return when.startsWith(day(1)) || diaryDay(new Date(when)) === day(1) ? null : `remind_at/due ${when || "missing"}`;
    } },
  { id: "buy-item", text: "buy dog food",
    check: ({ made }) => {
      const t = made.find((e) => e.kind === "task" && /dog food/i.test(title(e)));
      if (!t) return `no task (made ${made.map((e) => e.kind).join(", ") || "nothing"})`;
      return (t.fields.apple as { list_title?: string } | undefined)?.list_title === "Alex Shopping" ? null : "not on the shopping list";
    } },
  { id: "party", text: "Rafael's birthday party Saturday at 7",
    check: ({ made, at }) => {
      const ev = made.find((e) => e.kind === "event" && /rafael/i.test(title(e)));
      if (!ev) return `no event (made ${made.map((e) => `${e.kind} ${title(e)}`).join(", ") || "nothing"})`;
      const s = new Date(String(ev.fields.start));
      return s.getDay() === 6 && s.getHours() === 19 && !ev.fields.all_day ? null : `party at ${String(ev.fields.start)}`;
    } },
  { id: "existing-task", text: "still need to grab that HDMI cable at Micro Center",
    setup: (hub) => { hub.store.create("task", { title: "Pick up HDMI cable at Micro Center", status: "next", order: 1 }); },
    check: ({ hub }) => {
      const open = hub.store.list({ kind: "task" }).filter((t) => /hdmi/i.test(title(t)) && t.fields.status !== "done");
      return open.length === 1 ? null : `${open.length} open HDMI tasks: ${open.map(title).join(" | ")}`;
    } },
  { id: "passing-thought", text: "Feeling kind of tired and blah today",
    check: ({ made }) => nothingFiled(made) },
  { id: "skit-idea", text: "A comedy skit where a church choir is slowly replaced by vacuum cleaners, one at a time, and the priest never notices",
    setup: noteFolders,
    check: ({ made }) => idea(made, /^Writing\/Sketches\//, "sketch") },
  { id: "story-idea", text: "A story idea about a lighthouse keeper whose light only works when nobody is watching",
    setup: noteFolders,
    check: ({ made }) => idea(made, /^Writing\//, "story") },
  { id: "song-idea", text: "Song idea: slow verse in D minor about rain on a tin roof",
    setup: noteFolders,
    check: ({ made }) => (of(made, "music_idea").length ? null : `no music idea (made ${made.map((e) => `${e.kind} ${title(e)}`).join(", ") || "nothing"})`) },
  { id: "film-to-watch", text: "I want to watch Heat, the Michael Mann movie",
    check: ({ made }) => {
      const f = of(made, "film").find((e) => /heat/i.test(title(e)));
      if (!f) return `no film (made ${made.map((e) => `${e.kind} ${title(e)}`).join(", ") || "nothing"})`;
      return f.fields.watchlist === true && f.fields.watched === false ? null : `film not on the watchlist: ${JSON.stringify(f.fields)}`;
    } },
];

/** Alex's note folders, so the filer has somewhere to put an idea. */
function noteFolders(hub: Hub) {
  for (const p of ["Writing/Sketches/Silent auction.md", "Writing/Stories/Night ferry.md", "Writing/Screenplays/Drift.md",
    "Music/Song Ideas/Garden song.md", "Programming/App Ideas/Lamp timer.md", "Inventions/Umbrella light.md", "Food/Recipe Ideas/Soup night.md"]) {
    hub.store.create("note", { title: p.split("/").at(-1)!.replace(/\.md$/, ""), body: "An earlier note.", tags: [], path: p });
  }
}

/** One new note in a folder matching `folder`, tagged idea and `form`, with a short title of its own. */
function idea(made: Entity[], folder: RegExp, form: string): string | null {
  const notes = of(made, "note").filter((n) => !String(n.fields.path).startsWith("Diary/"));
  if (notes.length !== 1) return `${notes.length} notes (made ${made.map((e) => `${e.kind} ${title(e)}`).join(", ") || "nothing"})`;
  const n = notes[0];
  const tags = ((n.fields.tags as string[] | undefined) ?? []).map((t) => t.toLowerCase());
  if (!folder.test(String(n.fields.path))) return `note in ${String(n.fields.path)}`;
  if (!tags.includes("idea") || !tags.includes(form)) return `tags ${tags.join(", ") || "none"}`;
  return title(n).length <= 60 ? null : `long title "${title(n)}"`;
}

function freshHub() {
  process.env.EA_NO_DOTENV = "1";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-eval-filing-"));
  const cfg = loadConfig({ dataDir: dir, token: TOKEN, aiFake: false, logRequests: false, searxngUrl: "", imageServiceUrl: "", imageServiceToken: "",
    sshConfigPath: path.join(dir, "no-ssh-config"), hostsFile: path.join(dir, "hosts.json"), vaultDir: path.join(dir, "vault") } as any);
  const hub = createHub(cfg);
  // The owner of the made-up world: "my" list is the one named for them.
  hub.profile.set({ name: "Alex" });
  createApp(hub); // wires the tools
  runSeeds(hub.store, cfg);
  hub.store.create("person", { name: "Jamie", relationship: "partner" });
  hub.store.create("person", { name: "Devon Hale", given_name: "Devon", family_name: "Hale" });
  hub.store.create("person", { name: "Rafael Reyes", given_name: "Rafael", family_name: "Reyes", nickname: "Rafael (Tall)" });
  hub.store.create("person", { name: "Priya" });
  // Apple Reminders lists as an iPhone syncs them.
  hub.store.create("task", { title: "Paper towels", status: "next", order: 1, apple: { id: "R1", list: "L1", list_title: "Alex Shopping" } });
  hub.store.create("task", { title: "Candles", status: "next", order: 2, apple: { id: "R2", list: "L2", list_title: "Jamie Shopping" } });
  return { hub, dir };
}

/**
 * When the capture was written: a clock time on its most recent past occurrence, or minutes ago. Without either, a
 * run in the small hours writes it at 9 PM the evening before: "tonight" and "tomorrow" written at 1 AM are ambiguous.
 */
function captureAt(spec: Case["at"]): Date {
  if (spec === undefined && new Date().getHours() < 6) spec = "21:00";
  if (typeof spec === "string") {
    const [h, m] = spec.split(":").map(Number);
    const d = new Date(); d.setHours(h, m, 0, 0);
    if (d.getTime() > Date.now()) d.setDate(d.getDate() - 1);
    return d;
  }
  return new Date(Date.now() - (spec ?? 3) * 60_000);
}

async function main() {
  const only = process.argv.slice(2);
  const cases = only.length ? CASES.filter((c) => only.includes(c.id)) : CASES;
  let pass = 0;
  const fails: string[] = [];
  let total = 0;
  for (const c of cases) {
    const { hub, dir } = freshHub();
    const at = captureAt(c.at);
    const d0 = captureDay(at);
    const day = (n: number) => diaryDay(new Date(new Date(`${d0}T12:00:00`).getTime() + n * DAY));
    c.setup?.(hub, day);
    const before = new Set(hub.store.list({ limit: 100000 } as any).map((e) => `${e.id}@${e.updated_at}`));
    const beforeIds = new Set(hub.store.list({ limit: 100000 } as any).map((e) => e.id));
    const cap = hub.store.create("capture", { text: c.text, source: "iphone", processed: true, sorted_by: "auto", filing: "pending" });
    hub.db.prepare("UPDATE entities SET created_at = ? WHERE id = ?").run(at.toISOString(), cap.id);
    const diary = appendDiary(hub.store, c.text, at);
    hub.store.patch(cap.id, { diary_id: diary.id });
    const diaryBefore = JSON.stringify([diary.fields.path, diary.fields.title, diary.fields.body]);
    const t0 = Date.now();
    let err = "";
    try { await fileCapture(hub, cap.id); } catch (e) { err = (e as Error).message; }
    const ms = Date.now() - t0;
    total += ms;
    const done = hub.store.get(cap.id)!;
    const made = hub.store.list({ limit: 100000 } as any).filter((e) => !before.has(`${e.id}@${e.updated_at}`) && e.id !== cap.id && e.id !== diary.id && !e.deleted_at);
    const after = hub.store.get(diary.id)!;
    const diaryEdited = JSON.stringify([after.fields.path, after.fields.title, after.fields.body]) !== diaryBefore;
    const filed = String(done.fields.filed ?? "");
    const vague = /: (updated)?(;|$)/.test(filed) ? `vague filed label "${filed}"` : null;
    // Tasks that were there before and have nothing to do with the capture stay as they were.
    const words = c.text.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    const touched = made.filter((e) => e.kind === "task" && beforeIds.has(e.id) && !words.some((w) => title(e).toLowerCase().includes(w)));
    const unrelated = touched.length ? `changed unrelated ${touched.map((e) => `"${title(e)}" ${JSON.stringify(e.fields).slice(0, 160)}`).join(", ")}` : null;
    const problem = err || (done.fields.filing !== "done" ? `filing ${String(done.fields.filing)}` : null) || (diaryEdited ? "edited the diary" : null) || c.check({ hub, made, day, at, filed }) || vague || unrelated;
    if (problem) fails.push(c.id); else pass++;
    const thread = hub.ai.sessions.get(`capture-${cap.id}`);
    const tools = (thread?.messages.at(-1)?.actions ?? []).map((x) => x.tool);
    console.error(JSON.stringify({ case: c.id, ok: !problem, ms, problem: problem || undefined, filed, tools, made: made.map((e) => `${e.kind}: ${title(e)}${e.kind === "event" ? ` @ ${String(e.fields.start)}${e.fields.all_day ? " all day" : ""}` : ""}`), ...(problem ? { fields: made.map((e) => e.fields) } : {}) }));
    hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`filing eval: pass ${pass}/${cases.length}, avg ${(total / cases.length / 1000).toFixed(1)}s, fails: ${fails.join(", ") || "none"}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
