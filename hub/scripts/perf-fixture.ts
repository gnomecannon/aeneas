/**
 * A perf fixture: a made-up year of one person's data at real size, for timing the hub and the apps against it.
 * About 5,000 tasks, 3,500 notes (a diary note a day), 3,000 events on four calendars, 2,000 captures, 2,300 health
 * logs, 45 renewals, 250 people, and 12,000 kept mails over 90 days, a fifth of them with pictures written into
 * their HTML as the hub keeps them. Every name, address and text is made up (example.com addresses); the same seed
 * gives the same data.
 *
 *   cd hub && npx tsx scripts/perf-fixture.ts <folder>
 *
 * Fills <folder> once (delete it to start over), then serve it on a port of its own with a test token, for example:
 *
 *   EA_NO_DOTENV=1 EA_DATA_DIR=<folder> EA_HOSTS_FILE=<folder>/hosts.json EA_SSH_CONFIG=/dev/null EA_PORT=8792 \
 *     EA_BIND_HOST=127.0.0.1 EA_TOKEN=perf-test-token-not-a-secret-0001 EA_LOG_REQUESTS=1 EA_OLLAMA_URL= \
 *     npx tsx src/main.ts serve
 *
 * EA_PERF_SCALE (default 1) multiplies every count, EA_PERF_MAILS sets the number of mails.
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { createHub } from "../src/hub.js";
import { runSeeds } from "../src/seed.js";
import { MODULES } from "../src/modules.js";
import { keepInbox } from "../src/mail-inbox.js";
import type { InboxMail } from "../src/imports/inbox-source.js";

const dir = process.argv[2] ? path.resolve(process.argv[2]) : "";
if (!dir) { console.error("usage: npx tsx scripts/perf-fixture.ts <folder>"); process.exit(2); }
const marker = path.join(dir, ".perf-fixture");
if (fs.existsSync(marker)) { console.log(`[perf] ${dir} is filled already; delete it to start over`); process.exit(0); }
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(dir, "hosts.json"), "[]");

const SCALE = Number(process.env.EA_PERF_SCALE ?? 1);
const n = (x: number) => Math.max(1, Math.round(x * SCALE));
const MAILS = Number(process.env.EA_PERF_MAILS ?? n(12_000));

// A seeded random source (mulberry32), so every run makes the same year.
let seed = 0x5eed1234;
const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
const chance = (p: number) => rnd() < p;

const DAY = 86_400_000;
const NOW = Date.now();
/** A time `days` from now (negative: past) at a random minute of the waking day. */
const when = (days: number) => { const d = new Date(NOW + days * DAY); d.setHours(int(7, 21), pick([0, 15, 30, 45]), 0, 0); return d; };
const iso = (d: Date) => d.toISOString();
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const GIVEN = ["Jamie", "Alex", "Robin", "Devon", "Sam", "Casey", "Morgan", "Riley", "Jordan", "Quinn", "Avery", "Parker", "Reese", "Skyler", "Drew", "Emery", "Finley", "Hayden", "Kendall", "Rowan", "Sage", "Blake", "Cameron", "Dakota", "Elliot"] as const;
const FAMILY = ["Hale", "Reyes", "Park", "Novak", "Lindqvist", "Okafor", "Brandt", "Moreau", "Tanaka", "Silva", "Kowal", "Ferris", "Ashby", "Quill", "Marsh", "Vance", "Coyle", "Dunmore", "Pruitt", "Wexley"] as const;
const WORDS = "garden filter invoice laptop backup router cable kitchen paint bike tires dentist passport recipe budget pantry garage window lamp drawer shelf printer battery charger monitor keyboard notebook calendar ticket flight hotel rental insurance renewal warranty receipt photos album guitar pedal amp strings piano lesson concert movie series novel library coffee tea grinder kettle oven fridge freezer vacuum mop broom ladder drill screws hinges fence lawn hedge roses tomatoes basil seeds soil compost bucket hose sprinkler heater furnace vent chimney gutter roof attic basement closet laundry dryer washer detergent towels sheets pillow blanket mattress frame desk chair standing posture stretch run walk swim yoga climb hike trail map compass tent stove lantern".split(" ");
const VERBS = ["Buy", "Fix", "Call about", "Clean", "Order", "Return", "Book", "Renew", "Check", "Plan", "Pick up", "Replace", "Sort", "Email about", "Measure", "Paint", "Test", "Back up", "Update", "Cancel"] as const;
const sentence = (min = 6, max = 16) => { const w = Array.from({ length: int(min, max) }, () => pick(WORDS)); w[0] = w[0][0].toUpperCase() + w[0].slice(1); return `${w.join(" ")}.`; };
const para = (s = 3, e = 7) => Array.from({ length: int(s, e) }, () => sentence()).join(" ");
const person = () => `${pick(GIVEN)} ${pick(FAMILY)}`;

process.env.EA_NO_DOTENV = "1";
const cfg = loadConfig({ dataDir: dir, token: "perf-test-token-not-a-secret-0001", aiFake: false, logRequests: false, searxngUrl: "", imageServiceUrl: "", imageServiceToken: "", hostActions: false,
  sshConfigPath: path.join(dir, "no-ssh-config"), hostsFile: path.join(dir, "hosts.json"), vaultDir: path.join(dir, "vault") } as any);
const hub = createHub(cfg);
hub.profile.set({ name: "Jamie", pet: "Biscuit" });
// Every module but the ones that read a device's own calendar, reminders and contacts.
const OWN_DATA = new Set(["apple_calendar", "apple_reminders", "contacts"]);
hub.modules.set(Object.fromEntries(MODULES.map((m) => [m.id, !OWN_DATA.has(m.id)])));
runSeeds(hub.store, cfg);
const s = hub.store;
const t0 = Date.now();
const counts: Record<string, number> = {};
const make = (kind: Parameters<typeof s.create>[0], fields: Record<string, unknown>) => { counts[kind] = (counts[kind] ?? 0) + 1; return s.create(kind, fields); };

// People and what is known about them.
const people: string[] = [];
for (let i = 0; i < n(250); i++) {
  const name = person();
  const [given, family] = name.split(" ");
  const born = new Date(NOW - int(20, 70) * 365 * DAY - int(0, 364) * DAY);
  people.push(make("person", { name, given_name: given, family_name: family, birthday: ymd(born), relationship: pick(["friend", "coworker", "cousin", "neighbor", "climbing friend", "book club"]), emails: [{ label: "home", value: `${given.toLowerCase()}.${family.toLowerCase()}${i}@example.com` }], phones: chance(0.6) ? [{ label: "mobile", value: `+1 555 01${String(i % 100).padStart(2, "0")}` }] : [] }).id);
}
for (let i = 0; i < n(400); i++) {
  const p = chance(0.6) ? pick(people) : undefined;
  make("fact", { category: pick(["preference", "relationship", "history", "gear", "health"] as const), key: `${pick(WORDS)}:${pick(WORDS)}:${i}`, value: sentence(5, 14), source: "user", ...(p ? { person_id: p } : {}) });
}

// Projects, then a year of tasks: most done, the rest open, some on today's plan, some with a reminder.
const projects: string[] = [];
for (let i = 0; i < n(30); i++) projects.push(make("project", { name: `${pick(VERBS)} ${pick(WORDS)} ${pick(WORDS)}`, status: pick(["active", "active", "parked", "done"] as const), definition_of_done: sentence() }).id);
for (let i = 0; i < n(5000); i++) {
  const age = int(0, 365);
  const r = rnd();
  const status = r < 0.75 ? "done" : r < 0.85 ? "next" : r < 0.9 ? "inbox" : r < 0.95 ? "scheduled" : r < 0.98 ? "parked" : "doing";
  const f: Record<string, unknown> = { title: `${pick(VERBS)} ${pick(WORDS)} ${pick(WORDS)}`, status, order: i };
  if (chance(0.3)) f.notes = para(1, 4);
  if (chance(0.3)) f.project_id = pick(projects);
  if (status === "done") f.done_at = iso(when(-age + int(0, Math.min(age, 10))));
  if (status === "parked") f.parked_reason = sentence(3, 8);
  if (status !== "done" && chance(0.25)) f.due = iso(when(int(-5, 40)));
  if (status !== "done" && chance(0.2)) f.remind_at = iso(when(int(0, 30)));
  if (chance(0.04)) f.repeat = pick(["every 1 days", "every 1 weeks", "every 1 months"]);
  if (status === "scheduled" || (status === "next" && chance(0.1))) { const st = when(int(0, 6)); f.block = { start: iso(st), end: iso(new Date(st.getTime() + int(1, 4) * 30 * 60_000)) }; }
  const t = make("task", f);
  // A few edits each, as a real year leaves (the nightly compaction keeps the newest change of each).
  if (status !== "done" && chance(0.3)) s.patch(t.id, { order: i + 0.5 });
}

// Notes: a diary note a day, and the rest in folders with tags.
for (let d = 0; d < n(365); d++) {
  const day = new Date(NOW - d * DAY);
  const lines = Array.from({ length: int(3, 14) }, () => `- ${String(int(7, 22)).padStart(2, "0")}:${pick(["05", "20", "35", "50"])} ${sentence(4, 14)}`);
  make("note", { title: ymd(day), body: lines.join("\n"), tags: ["diary"], path: `Diary/${ymd(day)}.md` });
}
const FOLDERS = ["Projects", "Reference", "Ideas", "Work", "Home", "Recipes", "Travel", "Health", "Reading", "Music"];
for (let i = 0; i < n(3150); i++) {
  const folder = pick(FOLDERS);
  const title = `${pick(WORDS)} ${pick(WORDS)} ${i}`;
  const body = Array.from({ length: int(1, 12) }, () => (chance(0.3) ? `## ${sentence(2, 5)}\n` : "") + para()).join("\n\n");
  make("note", { title, body, tags: Array.from({ length: int(0, 4) }, () => pick(WORDS)), path: `${folder}/${title}.md` });
}

// Events on four calendars over the past eleven months and the next two.
const CALS = ["apple:iCloud/Home", "apple:iCloud/Work", "icloud:Family", "apple:Other/Birthdays"];
for (let i = 0; i < n(3000); i++) {
  const st = when(int(-330, 60));
  const allDay = chance(0.1);
  const start = allDay ? new Date(`${ymd(st)}T00:00:00`) : st;
  const end = allDay ? new Date(start.getTime() + DAY) : new Date(st.getTime() + int(1, 6) * 30 * 60_000);
  make("event", { title: `${pick(["Lunch with", "Call with", "Dinner with", "Meeting:", "Coffee with", "Class:"])} ${pick(GIVEN)}`, start: iso(start), end: iso(end), all_day: allDay, calendar_key: pick(CALS), ...(chance(0.3) ? { location: `${int(10, 999)} ${pick(FAMILY)} Street` } : {}), source: "eventkit", apple: { id: `perf-${i}`, calendar: "Home", from_apple: true } });
}

// Captures, nearly all sorted.
for (let i = 0; i < n(2000); i++) {
  const done = i > n(20);
  make("capture", { text: sentence(4, 30), source: pick(["watch", "iphone", "mac", "web"] as const), processed: done, ...(done ? { filing: "done", filed: `Added to tasks: ${sentence(3, 6)}` } : {}) });
}

// Health logs for a year: steps and sleep daily, weight most days, mood, blood pressure, medication and caffeine.
for (let d = 0; d < n(365); d++) {
  const at = (h: number) => { const x = new Date(NOW - d * DAY - DAY / 2); x.setHours(h, int(0, 59), 0, 0); return iso(x); };
  make("log", { type: "steps", value: int(2000, 16000), unit: "steps", at: at(21), source: "iphone" });
  make("log", { type: "sleep", value: Math.round((5 + rnd() * 4) * 10) / 10, unit: "h", at: at(7), source: "iphone" });
  if (chance(0.6)) make("log", { type: "weight", value: Math.round((150 + rnd() * 10) * 10) / 10, unit: "lb", at: at(7), source: "iphone" });
  if (chance(0.8)) make("log", { type: "mood", value: int(1, 5), at: at(20), source: "watch" });
  if (chance(0.3)) make("log", { type: "bp", value: `${int(110, 135)}/${int(70, 88)}`, unit: "mmHg", at: at(8), source: "iphone" });
  if (chance(0.9)) make("log", { type: "med", value: "Vitamin D", at: at(8), source: "web" });
  if (chance(0.7)) make("log", { type: "caffeine", value: int(1, 3), unit: "cups", at: at(9), source: "web" });
}

// Renewals, pet events, games, films, applications.
for (let i = 0; i < n(45); i++) make("watch", { title: `${pick(["Domain", "Streaming", "Cloud storage", "Gym", "Insurance", "Password manager", "VPN"])} ${i}`, category: pick(["subscription", "domain", "insurance", "warranty"] as const), due: iso(when(int(1, 360))), lead_days: 7, repeat: "every 1 years", cost: int(5, 200) });
for (let i = 0; i < n(700); i++) make("pet_event", { pet: "Biscuit", type: pick(["food", "food", "note", "med"] as const), at: iso(when(-int(0, 365))), note: sentence(3, 8) });
for (let i = 0; i < n(250); i++) make("game", { name: `${pick(WORDS)} ${pick(WORDS)} ${i}`, steam_appid: 100000 + i, playtime_min: int(0, 6000), source: "steam" });
for (let i = 0; i < n(150); i++) make("film", { title: `The ${pick(WORDS)} ${pick(WORDS)}`, year: int(1960, 2026), watched_on: [ymd(when(-int(0, 365)))], rating: int(1, 10) / 2, source: "letterboxd" });
for (let i = 0; i < n(25); i++) make("application", { company: `${pick(FAMILY)} Labs`, role: pick(["Engineer", "Designer", "Analyst"]), stage: pick(["applied", "screen", "interview", "offer", "rejected"] as const) });

const entitiesMs = Date.now() - t0;

// Mail: 90 days of an Inbox, as a refresh keeps it. Most mail is automated; a fifth carries pictures written in.
const t1 = Date.now();
const account = "imap:jamie@example.com";
const SENDERS = ["Northwind Outfitters", "Contoso Bank", "Fabrikam Shipping", "Tailspin Air", "Wingtip Toys", "Adventure Works", "Litware Weekly", "Proseware News"];
const pixels = (k: number) => "iVBORw0KGgo" + "A".repeat(k * 1024);
const htmlOf = (text: string, pics: number) => `<div style="font-family:sans-serif"><table width="100%">${Array.from({ length: int(5, 40) }, () => `<tr><td style="padding:8px">${sentence(8, 30)}</td></tr>`).join("")}</table>${Array.from({ length: pics }, () => `<img alt="" src="data:image/png;base64,${pixels(int(20, 90))}">`).join("")}<p>${text.slice(0, 2000)}</p></div>`;
let batch: InboxMail[] = [];
for (let i = 0; i < MAILS; i++) {
  const auto = chance(0.75);
  const sender = auto ? pick(SENDERS) : person();
  const address = auto ? `news@${sender.toLowerCase().replace(/\s+/g, "")}.example.com` : `${sender.toLowerCase().replace(/\s+/g, ".")}@example.com`;
  const text = Array.from({ length: int(2, 20) }, () => para(2, 6)).join("\n\n");
  const r = rnd();
  const html = r < 0.35 ? null : htmlOf(text, r < 0.8 ? 0 : int(1, 5));
  batch.push({
    id: `1:${i + 1}:INBOX`, at: new Date(NOW - rnd() * 90 * DAY), message_id: `<perf-${i}@example.com>`, from: { name: sender, address }, reply_to: null,
    subject: auto ? `${pick(["Your order", "Weekly digest", "Statement ready", "Flight update", "New arrivals", "Receipt"])} #${int(1000, 99999)}` : `Re: ${pick(WORDS)} ${pick(WORDS)}`,
    text, automated: auto, unsubscribe: auto && chance(0.8), list_id: auto && chance(0.5) ? `<list.${sender.length}.example.com>` : null,
    html, remote: [], logo: null, refs: auto ? [] : chance(0.4) ? [`<perf-${int(0, Math.max(0, i - 1))}@example.com>`] : [], mine: false,
    cards: [], rcpt: ["jamie@example.com"], attachments: chance(0.1) ? [{ part: "2", name: "statement.pdf", type: "application/pdf", size: int(20_000, 400_000) }] : [],
  });
  if (batch.length === 500) { keepInbox(hub.mailDb, account, { present: null, mails: batch, moved: [] }); batch = []; }
}
if (batch.length) keepInbox(hub.mailDb, account, { present: null, mails: batch, moved: [] });
// A third of the mail is Done (kept 30 days), a few are snoozed or pinned, most has been read.
hub.mailDb.exec(`UPDATE inbox SET state = 'done', done_at = at WHERE abs(random()) % 3 = 0 AND at > '${new Date(NOW - 30 * DAY).toISOString()}'`);
hub.mailDb.exec("UPDATE inbox SET seen = 1 WHERE abs(random()) % 5 != 0");
hub.mailDb.exec("UPDATE inbox SET pinned = 1 WHERE abs(random()) % 100 = 0");
hub.mailDb.exec(`INSERT OR REPLACE INTO mailboxes (account, last_refresh, more) VALUES ('${account}', '${new Date().toISOString()}', 0)`);
// The mailbox is linked, or the hub clears its mail at the next refresh. Its server is a closed port on this machine
// and its password counts as refused, so the hub never signs in on its own.
hub.connections.update((c) => { c.imap = [{ email: "jamie@example.com", password: "not-a-real-password", linked_at: new Date().toISOString(), refused_at: new Date().toISOString(), preset: "imap", host: "127.0.0.1", port: 9, user: "jamie@example.com" }]; });
const mailMs = Date.now() - t1;

s.compactChanges();
hub.db.pragma("wal_checkpoint(TRUNCATE)");
hub.mailDb.pragma("wal_checkpoint(TRUNCATE)");
const size = (f: string) => (fs.existsSync(f) ? Math.round(fs.statSync(f).size / 1e6) : 0);
hub.close();
fs.writeFileSync(marker, new Date().toISOString());
console.log(`[perf] ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")} in ${(entitiesMs / 1000).toFixed(1)} s; ${MAILS} mails in ${(mailMs / 1000).toFixed(1)} s`);
console.log(`[perf] hub.sqlite ${size(cfg.dbPath)} MB, mail.sqlite ${size(path.join(dir, "mail.sqlite"))} MB`);
