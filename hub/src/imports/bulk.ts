import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Unzip, UnzipInflate } from "fflate";
import type { Hub } from "../hub.js";
import type { Entity } from "@everythingapp/shared";
import { StoreError } from "../store.js";
import { gpuBusyNow } from "../gpu.js";
import { dayKey } from "../metrics.js";

/**
 * Bring a past in, once: what someone has in other apps becomes notes, people, tasks and facts here, the way the
 * first owner's history was. One upload (a .zip or a single file) or pasted text is one import job; jobs run one at a
 * time in the background and say how far they are.
 * - ChatGPT export (conversations.json): each conversation is a note in Imported/ChatGPT/<year-month>/.
 * - Google Takeout: Keep notes become notes, Calendar (.ics) history becomes one note per calendar and year (not
 *   events, which would fill the phone's calendar with years of the past), Contacts (.vcf) become people when they
 *   are not here yet, open Google Tasks become tasks.
 * - Notes apps: Markdown and text files (an Obsidian vault, a Notion, Bear or Joplin export, a folder of .txt) keep
 *   their folders; Evernote .enex notebooks become notes; nothing already in the vault is overwritten.
 * - Text: pasted or a single .txt, kept as a note.
 * With "learn", the model then reads the owner's own words (their ChatGPT messages, Keep notes, text) in pieces and
 * keeps new facts about them in Memory. That is long model work the owner asked for: it gives way to a chat, waits
 * while a game has the graphics card, and can be stopped.
 */

export type JobState = "waiting" | "reading" | "learning" | "done" | "failed" | "stopped";
export interface ImportCounts { notes: number; people: number; tasks: number; facts: number; skipped: number }
export interface ImportJob {
  id: string; name: string; kinds: string[]; state: JobState; learn: boolean; created_at: string; finished_at: string | null;
  counts: ImportCounts; learned: { done: number; total: number }; detail: string; error: string | null;
  /** Where the hub was when it last stopped in the middle of this job (a restart, or a crash), and how often there. */
  interrupted?: { at: number; times: number };
  /** Files left out because the import was over the size the hub reads at once. */
  left_out?: number;
}

export const MAX_UPLOAD = 4 * 1024 * 1024 * 1024;
/** One file inside an upload larger than this is skipped (photos, videos and audio are never read anyway). Under
 * the longest string the JavaScript engine holds, so a file that is read can always be parsed. */
const MAX_ENTRY = 500 * 1024 * 1024;
/** What one import reads into memory in all, and how many files: past either, the rest is left out and counted. */
export const MAX_READ_TOTAL = 1024 * 1024 * 1024;
export const MAX_ENTRIES = 200_000;
const CHUNK_CHARS = 6000;

const dirOf = (hub: Hub) => path.join(hub.cfg.dataDir, "imports");
const jobsFile = (hub: Hub) => path.join(dirOf(hub), "jobs.json");

function readJobs(hub: Hub): ImportJob[] {
  try { return JSON.parse(fs.readFileSync(jobsFile(hub), "utf8")) as ImportJob[]; } catch { return []; }
}
function writeJobs(hub: Hub, jobs: ImportJob[]): void {
  fs.mkdirSync(dirOf(hub), { recursive: true, mode: 0o700 });
  const tmp = `${jobsFile(hub)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(jobs, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, jobsFile(hub));
}
function saveJob(hub: Hub, job: ImportJob): void {
  writeJobs(hub, [job, ...readJobs(hub).filter((j) => j.id !== job.id)].slice(0, 50));
}

export function listImports(hub: Hub): ImportJob[] {
  return readJobs(hub);
}

const newJob = (name: string, learn: boolean): ImportJob => ({
  id: randomUUID(), name, kinds: [], state: "waiting", learn, created_at: new Date().toISOString(), finished_at: null,
  counts: { notes: 0, people: 0, tasks: 0, facts: 0, skipped: 0 }, learned: { done: 0, total: 0 }, detail: "Waiting to start", error: null,
});

/** An uploaded file, streamed to disk (an export can be gigabytes), then queued. */
export async function uploadImport(hub: Hub, name: string, body: ReadableStream<Uint8Array> | null, learn: boolean): Promise<ImportJob> {
  const clean = path.basename(name || "upload").replace(/[^\w.\- ()]+/g, "_").slice(0, 120) || "upload";
  if (!body) throw new StoreError(400, "no file");
  const job = newJob(clean, learn);
  const dir = path.join(dirOf(hub), job.id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let size = 0;
  const counted = Readable.fromWeb(body as never).on("data", (b: Buffer) => { size += b.length; if (size > MAX_UPLOAD) counted.destroy(new Error("over 4 GB")); });
  try {
    await pipeline(counted, fs.createWriteStream(path.join(dir, clean), { mode: 0o600 }));
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new StoreError(413, `the upload stopped: ${(e as Error).message}`);
  }
  if (!size) { fs.rmSync(dir, { recursive: true, force: true }); throw new StoreError(400, "the file is empty"); }
  saveJob(hub, job);
  kick(hub);
  return job;
}

/** Pasted text: kept as a note, and read for facts when asked. */
export function textImport(hub: Hub, body: { title?: unknown; text?: unknown; learn?: unknown }): ImportJob {
  const text = typeof body.text === "string" ? body.text : "";
  if (!text.trim()) throw new StoreError(422, "text is empty");
  if (text.length > 20_000_000) throw new StoreError(413, "the text is over 20 MB: upload it as a file");
  const title = (typeof body.title === "string" && body.title.trim()) || `Pasted ${dayKey(new Date())}`;
  const job = newJob(`${title.slice(0, 100)}.txt`, body.learn === true);
  const dir = path.join(dirOf(hub), job.id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, job.name.replace(/[^\w.\- ()]+/g, "_")), text, { mode: 0o600 });
  saveJob(hub, job);
  kick(hub);
  return job;
}

const stopRequested = new Set<string>();
export function stopImport(hub: Hub, id: string): ImportJob {
  const job = readJobs(hub).find((j) => j.id === id);
  if (!job) throw new StoreError(404, "no such import");
  if (job.state === "waiting") { job.state = "stopped"; job.detail = "Stopped before it started"; job.finished_at = new Date().toISOString(); saveJob(hub, job); return job; }
  if (job.state === "reading" || job.state === "learning") stopRequested.add(id);
  return job;
}

// ---------- the job runner ----------

let running = false;

/** Start the next waiting job (and resume one a restart interrupted). */
export function kick(hub: Hub): void {
  if (running) return;
  const jobs = readJobs(hub);
  const next = jobs.slice().reverse().find((j) => j.state === "reading" || j.state === "learning") ?? jobs.slice().reverse().find((j) => j.state === "waiting");
  if (!next) return;
  // Only one job runs at a time, so one found reading or learning was cut off by a restart. Stopped twice at the
  // same place means that place stops the hub (a file too big for memory): leave it out instead of looping.
  if (next.state === "reading" || next.state === "learning") {
    const at = next.state === "reading" ? -1 : next.learned.done;
    next.interrupted = next.interrupted?.at === at ? { at, times: next.interrupted.times + 1 } : { at, times: 1 };
    if (next.interrupted.times >= 2 && next.state === "reading") {
      next.state = "failed";
      next.error = "The hub stopped twice while reading this file, so it was left out to keep the hub running. Try it in smaller parts (one Takeout product at a time, or the vault in pieces).";
      next.finished_at = new Date().toISOString();
      fs.rmSync(path.join(dirOf(hub), next.id), { recursive: true, force: true });
      saveJob(hub, next);
      setTimeout(() => kick(hub), 50);
      return;
    }
    if (next.interrupted.times >= 2) { next.learned.done++; next.interrupted = undefined; }
    saveJob(hub, next);
  }
  running = true;
  void runJob(hub, next).catch((e) => {
    next.state = "failed"; next.error = e instanceof Error ? e.message : String(e); next.finished_at = new Date().toISOString(); saveJob(hub, next);
  }).finally(() => { running = false; stopRequested.delete(next.id); setTimeout(() => kick(hub), 50); });
}

/** Wait for runImports tests and callers: resolves when no job is running. */
export async function importsIdle(timeoutMs = 60_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (running && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
}

interface Entry { name: string; data: Uint8Array }

/** What in an upload is worth reading, by name. Everything else (photos, audio, html copies) is skipped unread. */
function wanted(name: string): boolean {
  const n = name.toLowerCase();
  if (n.includes("__macosx/") || path.basename(n).startsWith(".")) return false;
  if (/(^|\/)conversations(-\d+)?\.json$/.test(n)) return true;
  if (/(^|\/)keep\/[^/]+\.json$/.test(n)) return true;
  if (/(^|\/)tasks\/[^/]*\.json$/.test(n)) return true;
  return /\.(md|markdown|txt|ics|vcf|enex)$/.test(n);
}

export async function readEntries(file: string, counts: { leftOut: number } = { leftOut: 0 }, limits = { total: MAX_READ_TOTAL, entries: MAX_ENTRIES }): Promise<Entry[]> {
  const head = Buffer.alloc(4);
  const fd = fs.openSync(file, "r");
  fs.readSync(fd, head, 0, 4, 0);
  fs.closeSync(fd);
  if (head.readUInt32LE(0) !== 0x04034b50) {
    if (fs.statSync(file).size > MAX_ENTRY) throw new Error("the file is too large to read");
    return [{ name: path.basename(file).replace(/^[0-9a-f-]{36}_/, ""), data: fs.readFileSync(file) }];
  }
  const out: Entry[] = [];
  // Kept bytes so far, counted as they arrive (a zip can claim small sizes and unpack huge).
  let total = 0;
  await new Promise<void>((resolve, reject) => {
    const uz = new Unzip((f) => {
      if (!wanted(f.name) || (f.originalSize ?? 0) > MAX_ENTRY) return;
      if (out.length >= limits.entries || total >= limits.total) { counts.leftOut++; return; }
      const parts: Uint8Array[] = [];
      let size = 0;
      let dropped = false;
      f.ondata = (err, chunk, final) => {
        if (err) { reject(err); return; }
        size += chunk.length;
        if (!dropped && (size > MAX_ENTRY || total + chunk.length > limits.total)) {
          // Too big after all: let go of what was kept and count the file as left out.
          dropped = true; total -= size - chunk.length; parts.length = 0; counts.leftOut++;
        }
        if (!dropped) { parts.push(chunk); total += chunk.length; }
        if (final && !dropped) out.push({ name: f.name, data: Buffer.concat(parts) });
      };
      f.start();
    });
    uz.register(UnzipInflate);
    const rs = fs.createReadStream(file, { highWaterMark: 1 << 20 });
    rs.on("data", (b) => { try { uz.push(b as Buffer); } catch (e) { rs.destroy(); reject(e); } });
    rs.on("end", () => { try { uz.push(new Uint8Array(0), true); resolve(); } catch (e) { reject(e); } });
    rs.on("error", reject);
  });
  return out;
}

const decoder = new TextDecoder("utf-8");
const text = (e: Entry) => decoder.decode(e.data).replace(/^﻿/, "");

/** A file or folder name that every system and the vault accept. */
export function safeName(s: string, fallback = "Untitled"): string {
  const t = s.replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "").slice(0, 80).trim();
  return t || fallback;
}

/** A vault path from an imported one, each part made safe. */
function cleanRel(rel: string): string {
  return rel.split("/").filter(Boolean).map((p, i, a) => (i === a.length - 1 ? `${safeName(p.replace(/\.md$/i, ""))}.md` : safeName(p, "Folder"))).join("/");
}

/** A note file's text below its front matter, as the import wrote it (the linker rewrites only the front matter). */
const bodyOf = (file: string) => file.replace(/^---\n[\s\S]*?\n---\n/, "").trim();

/**
 * Write a note unless the same note is there already (an import run again). Another note with the same title (two
 * ChatGPT chats called "New chat" in one month, two Keep notes called "Groceries") goes beside it as "Title 2.md".
 * Returns whether it was written.
 */
function writeNote(hub: Hub, rel: string, title: string, body: string, tags: string[], when?: number): boolean {
  const first = cleanRel(rel);
  const want = body.trim();
  let safeRel = first;
  for (let n = 2; ; n++) {
    const there = hub.vault.read(safeRel);
    if (there === null) break;
    if (bodyOf(there) === want) return false;
    if (n > 500) return false;
    safeRel = first.replace(/\.md$/, ` ${n}.md`);
  }
  const fm = tags.length ? `---\ntitle: ${JSON.stringify(title)}\ntags: [${tags.join(", ")}]\n---\n` : `---\ntitle: ${JSON.stringify(title)}\n---\n`;
  hub.vault.write(safeRel, `${fm}${want}\n`, when);
  return true;
}

// ---------- readers ----------

interface Learnable { source: string; at: string | null; text: string }
interface Reader { kind: string; read(hub: Hub, entries: Entry[], job: ImportJob, learn: Learnable[]): void }

interface GptNode { message?: { author?: { role?: string }; content?: { content_type?: string; parts?: unknown[] }; create_time?: number | null } | null; parent?: string | null }
interface GptConversation { title?: string; create_time?: number; update_time?: number; current_node?: string; mapping?: Record<string, GptNode> }

/** The turns of one ChatGPT conversation in order, along the branch it ended on. */
export function gptTurns(c: GptConversation): { role: "user" | "assistant"; text: string }[] {
  const out: { role: "user" | "assistant"; text: string }[] = [];
  const map = c.mapping ?? {};
  let id = c.current_node ?? Object.keys(map).find((k) => !Object.values(map).some((n) => n.parent === k));
  const seen = new Set<string>();
  while (id && map[id] && !seen.has(id)) {
    seen.add(id);
    const m = map[id].message;
    const role = m?.author?.role;
    const parts = (m?.content?.parts ?? []).filter((p): p is string => typeof p === "string").join("\n").trim();
    if ((role === "user" || role === "assistant") && parts && (m?.content?.content_type ?? "text") === "text") out.unshift({ role, text: parts });
    id = map[id].parent ?? undefined;
  }
  return out;
}

const chatgpt: Reader = {
  kind: "ChatGPT",
  read(hub, entries, job, learn) {
    for (const e of entries.filter((x) => /(^|\/)conversations(-\d+)?\.json$/i.test(x.name))) {
      let convs: GptConversation[];
      try { convs = JSON.parse(text(e)) as GptConversation[]; } catch { job.counts.skipped++; continue; }
      if (!Array.isArray(convs)) continue;
      for (const c of convs) {
        const turns = gptTurns(c);
        if (!turns.length) { job.counts.skipped++; continue; }
        const at = c.create_time ? new Date(c.create_time * 1000) : null;
        const title = safeName(c.title ?? turns[0].text.slice(0, 60), "Conversation");
        const month = at ? dayKey(at).slice(0, 7) : "undated";
        const body = [`# ${title}`, at ? `_ChatGPT, ${dayKey(at)}_` : "_ChatGPT_", "", ...turns.map((t) => `**${t.role === "user" ? "Me" : "ChatGPT"}:** ${t.text}\n`)].join("\n");
        if (writeNote(hub, `Imported/ChatGPT/${month}/${title}.md`, title, body, ["imported", "chatgpt"], at?.getTime())) job.counts.notes++;
        else job.counts.skipped++;
        const mine = turns.filter((t) => t.role === "user").map((t) => t.text).join("\n\n");
        if (mine.trim()) learn.push({ source: `ChatGPT conversation "${title}"`, at: at ? dayKey(at) : null, text: mine });
      }
    }
  },
};

interface KeepNote { title?: string; textContent?: string; listContent?: { text?: string; isChecked?: boolean }[]; labels?: { name?: string }[]; isTrashed?: boolean; userEditedTimestampUsec?: number; createdTimestampUsec?: number }

const keep: Reader = {
  kind: "Google Keep",
  read(hub, entries, job, learn) {
    for (const e of entries.filter((x) => /(^|\/)keep\/[^/]+\.json$/i.test(x.name))) {
      let n: KeepNote;
      try { n = JSON.parse(text(e)) as KeepNote; } catch { job.counts.skipped++; continue; }
      if (n.isTrashed) continue;
      const list = (n.listContent ?? []).map((i) => `- [${i.isChecked ? "x" : " "}] ${i.text ?? ""}`).join("\n");
      const body = [n.textContent ?? "", list].filter((s) => s.trim()).join("\n\n");
      if (!body.trim() && !n.title) continue;
      const title = safeName(n.title || body.split("\n")[0].slice(0, 60), "Keep note");
      const when = n.userEditedTimestampUsec ? Math.round(n.userEditedTimestampUsec / 1000) : undefined;
      const tags = ["imported", "keep", ...(n.labels ?? []).map((l) => safeName(l.name ?? "", "").toLowerCase().replace(/\s+/g, "-")).filter(Boolean)];
      if (writeNote(hub, `Imported/Google Keep/${title}.md`, title, body, tags, when)) job.counts.notes++;
      else job.counts.skipped++;
      learn.push({ source: `Keep note "${title}"`, at: when ? dayKey(new Date(when)) : null, text: `${n.title ?? ""}\n${body}` });
    }
  },
};

/** Unfolded lines of an iCalendar or vCard file. */
function unfold(s: string): string[] {
  return s.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");
}
const icsText = (v: string) => v.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim();

/** Events in an .ics file: day, title and place. */
export function parseIcs(s: string): { calendar: string; events: { day: string; title: string; location: string }[] } {
  let calendar = "";
  const events: { day: string; title: string; location: string }[] = [];
  let cur: { day: string; title: string; location: string } | null = null;
  for (const line of unfold(s)) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const key = line.slice(0, i).split(";")[0].toUpperCase();
    const val = line.slice(i + 1);
    if (key === "X-WR-CALNAME" && !cur) calendar = icsText(val);
    else if (key === "BEGIN" && val.trim() === "VEVENT") cur = { day: "", title: "", location: "" };
    else if (key === "END" && val.trim() === "VEVENT") { if (cur?.day && cur.title) events.push(cur); cur = null; }
    else if (cur && key === "SUMMARY") cur.title = icsText(val);
    else if (cur && key === "LOCATION") cur.location = icsText(val);
    else if (cur && key === "DTSTART") { const m = /^(\d{4})(\d{2})(\d{2})/.exec(val.trim()); if (m) cur.day = `${m[1]}-${m[2]}-${m[3]}`; }
  }
  return { calendar, events: events.sort((a, b) => a.day.localeCompare(b.day)) };
}

const calendarHistory: Reader = {
  kind: "Calendar history",
  read(hub, entries, job) {
    for (const e of entries.filter((x) => /\.ics$/i.test(x.name))) {
      const { calendar, events } = parseIcs(text(e));
      if (!events.length) continue;
      const name = safeName(calendar || path.basename(e.name, ".ics"), "Calendar");
      const years = new Map<string, typeof events>();
      for (const ev of events) years.set(ev.day.slice(0, 4), [...(years.get(ev.day.slice(0, 4)) ?? []), ev]);
      for (const [year, evs] of years) {
        const title = `${name} ${year}`;
        const body = [`# ${title}`, "", ...evs.map((ev) => `- ${ev.day} ${ev.title}${ev.location ? ` (${ev.location})` : ""}`)].join("\n");
        if (writeNote(hub, `Imported/Calendar/${title}.md`, title, body, ["imported", "calendar"])) job.counts.notes++;
        else job.counts.skipped++;
      }
    }
  },
};

/** People in a .vcf file. */
export function parseVcf(s: string): { name: string; given?: string; family?: string; nickname?: string; org?: string; title?: string; birthday?: string; phones: string[]; emails: string[] }[] {
  const out: ReturnType<typeof parseVcf> = [];
  let cur: ReturnType<typeof parseVcf>[number] | null = null;
  for (const line of unfold(s)) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const key = line.slice(0, i).split(";")[0].replace(/^item\d+\./i, "").toUpperCase();
    const val = icsText(line.slice(i + 1));
    if (key === "BEGIN" && /vcard/i.test(val)) cur = { name: "", phones: [], emails: [] };
    else if (key === "END" && /vcard/i.test(val)) { if (cur?.name || cur?.given || cur?.family) out.push({ ...cur, name: cur.name || [cur.given, cur.family].filter(Boolean).join(" ") }); cur = null; }
    else if (!cur) continue;
    else if (key === "FN") cur.name = val;
    else if (key === "N") { const [family, given] = line.slice(i + 1).split(";"); cur.family = icsText(family ?? "") || undefined; cur.given = icsText(given ?? "") || undefined; }
    else if (key === "NICKNAME") cur.nickname = val || undefined;
    else if (key === "ORG") cur.org = val.replace(/;+$/, "").replace(/;/g, ", ") || undefined;
    else if (key === "TITLE") cur.title = val || undefined;
    else if (key === "BDAY") { const m = /^(\d{4}|--)-?(\d{2})-?(\d{2})/.exec(val); if (m) cur.birthday = m[1] === "--" ? `--${m[2]}-${m[3]}` : `${m[1]}-${m[2]}-${m[3]}`; }
    else if (key === "TEL" && val) cur.phones.push(val);
    else if (key === "EMAIL" && val) cur.emails.push(val.toLowerCase());
  }
  return out;
}

const contacts: Reader = {
  kind: "Contacts",
  read(hub, entries, job) {
    const people = hub.store.list({ kind: "person", limit: 100000 });
    const names = new Set(people.map((p) => String(p.fields.name ?? "").trim().toLowerCase()));
    const emails = new Set(people.flatMap((p) => ((p.fields.emails as { value?: string }[] | undefined) ?? []).map((x) => String(x.value ?? "").toLowerCase())));
    const digits = (s: string) => s.replace(/\D/g, "").slice(-10);
    const phones = new Set(people.flatMap((p) => ((p.fields.phones as { value?: string }[] | undefined) ?? []).map((x) => digits(String(x.value ?? "")))).filter((d) => d.length >= 7));
    for (const e of entries.filter((x) => /\.vcf$/i.test(x.name))) {
      for (const c of parseVcf(text(e))) {
        const known = names.has(c.name.toLowerCase()) || c.emails.some((m) => emails.has(m)) || c.phones.some((p) => phones.has(digits(p)));
        if (known) { job.counts.skipped++; continue; }
        hub.store.create("person", {
          name: c.name, ...(c.given ? { given_name: c.given } : {}), ...(c.family ? { family_name: c.family } : {}), ...(c.nickname ? { nickname: c.nickname } : {}),
          ...(c.org ? { organization: c.org } : {}), ...(c.title ? { job_title: c.title } : {}), ...(c.birthday ? { birthday: c.birthday } : {}),
          phones: c.phones.map((value) => ({ value })), emails: c.emails.map((value) => ({ value })), dates: [], addresses: [],
        });
        names.add(c.name.toLowerCase());
        c.emails.forEach((m) => emails.add(m));
        job.counts.people++;
      }
    }
  },
};

interface GTaskList { title?: string; items?: { title?: string; notes?: string; status?: string; due?: string }[] }

const googleTasks: Reader = {
  kind: "Google Tasks",
  read(hub, entries, job) {
    const open = new Set(hub.store.list({ kind: "task", limit: 100000 }).filter((t) => t.fields.status !== "done").map((t) => String(t.fields.title ?? "").trim().toLowerCase()));
    for (const e of entries.filter((x) => /(^|\/)tasks\/[^/]*\.json$/i.test(x.name))) {
      let lists: GTaskList[];
      try { const j = JSON.parse(text(e)) as { items?: GTaskList[] }; lists = j.items ?? []; } catch { job.counts.skipped++; continue; }
      for (const l of lists) {
        for (const t of l.items ?? []) {
          const title = (t.title ?? "").trim();
          if (!title || t.status === "completed") continue;
          if (open.has(title.toLowerCase())) { job.counts.skipped++; continue; }
          // Google keeps only the date ("2026-11-10T00:00:00.000Z" means Nov 10 wherever the owner is): it stays a date,
          // not midnight UTC, which is the evening before in New York.
          const due = t.due && /^\d{4}-\d{2}-\d{2}/.test(t.due) && !Number.isNaN(Date.parse(t.due)) ? t.due.slice(0, 10) : undefined;
          hub.store.create("task", { title, status: "inbox", order: Date.now() + job.counts.tasks, ...(t.notes ? { notes: t.notes } : {}), ...(due ? { due } : {}) });
          open.add(title.toLowerCase());
          job.counts.tasks++;
        }
      }
    }
  },
};

/** The folder all the files share (an exported vault's own folder), dropped from their paths. */
function commonTop(names: string[]): string {
  const tops = new Set(names.map((n) => (n.includes("/") ? n.split("/")[0] : "")));
  return tops.size === 1 && [...tops][0] ? `${[...tops][0]}/` : "";
}

const notesFiles: Reader = {
  kind: "Notes",
  read(hub, entries, job, learn) {
    const files = entries.filter((x) => /\.(md|markdown|txt)$/i.test(x.name) && !/(^|\/)keep\//i.test(x.name));
    const top = commonTop(files.map((f) => f.name));
    const single = files.length === 1;
    for (const f of files) {
      // Notion names files "Page 0123abcd...": the id goes.
      const rel = f.name.slice(top.length).replace(/ [0-9a-f]{32}(?=\.|\/)/gi, "").replace(/\.(markdown|txt)$/i, ".md");
      const body = text(f);
      if (!body.trim()) continue;
      const title = path.basename(rel, ".md");
      const target = single ? `Imported/Text/${title}.md` : rel;
      // Markdown keeps its own front matter (an Obsidian note's tags and links); text gets a title.
      let ok: boolean;
      if (/\.(md|markdown)$/i.test(f.name) && !single) {
        const p = cleanRel(target);
        ok = hub.vault.read(p) === null;
        if (ok) hub.vault.write(p, body);
      } else ok = writeNote(hub, target, title, body, ["imported"]);
      if (ok) job.counts.notes++;
      else job.counts.skipped++;
      learn.push({ source: `note "${title}"`, at: null, text: body });
    }
  },
};

/** Evernote's ENML to plain text with line breaks. */
function enmlText(s: string): string {
  return s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(div|p|li|h\d)>/gi, "\n").replace(/<li[^>]*>/gi, "- ").replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\n{3,}/g, "\n\n").trim();
}

const evernote: Reader = {
  kind: "Evernote",
  read(hub, entries, job, learn) {
    for (const e of entries.filter((x) => /\.enex$/i.test(x.name))) {
      const book = safeName(path.basename(e.name, ".enex"), "Evernote");
      for (const m of text(e).matchAll(/<note>([\s\S]*?)<\/note>/g)) {
        const title = safeName(/<title>([\s\S]*?)<\/title>/.exec(m[1])?.[1] ?? "", "Evernote note");
        const content = /<content>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/content>/.exec(m[1])?.[1] ?? "";
        const body = enmlText(content);
        const created = /<created>(\d{8})T/.exec(m[1])?.[1];
        const tags = ["imported", "evernote", ...[...m[1].matchAll(/<tag>([\s\S]*?)<\/tag>/g)].map((t) => safeName(t[1], "").toLowerCase().replace(/\s+/g, "-")).filter(Boolean)];
        if (writeNote(hub, `Imported/Evernote/${book}/${title}.md`, title, `# ${title}\n\n${body}`, tags, created ? Date.parse(`${created.slice(0, 4)}-${created.slice(4, 6)}-${created.slice(6, 8)}`) : undefined)) job.counts.notes++;
        else job.counts.skipped++;
        learn.push({ source: `Evernote note "${title}"`, at: null, text: body });
      }
    }
  },
};

const READERS: Reader[] = [chatgpt, keep, googleTasks, contacts, calendarHistory, evernote, notesFiles];

// ---------- learning facts ----------

const LEARN_SYSTEM = [
  "You read something {{owner}} wrote (their messages to another assistant, their notes) and pick out lasting facts about {{owner}}, so their personal assistant knows them. Answer with JSON only:",
  "{\"facts\": [{\"category\": one of identity, constraint, preference, health, relationship, project, gear, history, \"key\": short_snake_case, \"value\": one or two sentences, \"person\": the other person's name when the fact is about someone else, else omit}]}",
  "Only what the text plainly says about {{owner}}'s life, people, pets, health, work, projects, gear, habits, likes and limits. Never guesses, never facts about the world, never what the other assistant said, never passing moods or one-off tasks.",
  "Reuse a key from the list of keys already known when the fact is the same subject, and leave out what is already known. At most 8 facts; none is fine: {\"facts\": []}.",
].join("\n");

const CATEGORIES = new Set(["identity", "constraint", "preference", "health", "relationship", "project", "gear", "history"]);
const norm = (s: unknown) => String(s ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");

/** The owner's own words, cut into pieces the model reads one at a time (newest first: they say most about now). */
export function learnChunks(items: Learnable[]): string[] {
  const sorted = items.slice().sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")));
  const out: string[] = [];
  let cur = "";
  for (const it of sorted) {
    const piece = `From ${it.source}${it.at ? ` (${it.at})` : ""}:\n${it.text.trim().slice(0, CHUNK_CHARS)}\n\n`;
    if (cur && cur.length + piece.length > CHUNK_CHARS) { out.push(cur); cur = ""; }
    cur += piece;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function knownKeys(hub: Hub): string {
  const facts = hub.store.list({ kind: "fact", limit: 100000 });
  return facts.slice(0, 400).map((f) => `${f.fields.category}:${f.fields.key}${f.fields.person ? ` (${f.fields.person})` : ""}`).join(", ");
}

/** Keep the facts a reading found that are not known yet (same key about the same person). Never changes one. */
export function keepLearned(hub: Hub, raw: string | null, jobId: string): number {
  let facts: { category?: string; key?: string; value?: string; person?: string }[] = [];
  try { facts = ((JSON.parse(String(raw ?? "").replace(/^```(?:json)?|```$/g, "").trim()) as { facts?: typeof facts }).facts ?? []).slice(0, 8); } catch { return 0; }
  const existing = hub.store.list({ kind: "fact", includeDeleted: true, limit: 100000 });
  let made = 0;
  for (const f of facts) {
    const category = String(f.category ?? "").toLowerCase();
    const key = norm(f.key).slice(0, 80);
    const value = String(f.value ?? "").trim().slice(0, 600);
    const person = String(f.person ?? "").trim().slice(0, 80);
    if (!CATEGORIES.has(category) || !key || value.length < 3) continue;
    if (existing.some((e) => norm(e.fields.key) === key && norm(e.fields.person) === norm(person))) continue;
    const created = hub.store.create("fact", { category, key, value, source: `import:${jobId.slice(0, 8)}`, confidence: 0.7, ...(person ? { person } : {}) });
    existing.push(created as Entity);
    made++;
  }
  return made;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runJob(hub: Hub, job: ImportJob): Promise<void> {
  const dir = path.join(dirOf(hub), job.id);
  const learnFile = path.join(dir, "learn.json");
  if (job.state === "waiting" || job.state === "reading") {
    job.state = "reading"; job.detail = "Reading the file"; saveJob(hub, job);
    const file = fs.readdirSync(dir).map((f) => path.join(dir, f)).find((f) => !f.endsWith("learn.json"));
    if (!file) throw new Error("the uploaded file is gone");
    const read = { leftOut: 0 };
    const entries = await readEntries(file, read);
    job.left_out = read.leftOut;
    const learn: Learnable[] = [];
    const before = { ...job.counts };
    for (const r of READERS) {
      if (stopRequested.has(job.id)) break;
      const c = JSON.stringify(job.counts);
      job.detail = `Reading ${r.kind}`;
      r.read(hub, entries, job, learn);
      if (JSON.stringify(job.counts) !== c) job.kinds.push(r.kind);
      saveJob(hub, job);
    }
    if (stopRequested.has(job.id)) {
      job.state = "stopped"; job.detail = "Stopped while reading; what was read is kept"; job.finished_at = new Date().toISOString();
      fs.rmSync(dir, { recursive: true, force: true });
      saveJob(hub, job);
      return;
    }
    // A single text file is a text dump, not a notes folder.
    if (job.kinds.length === 1 && job.kinds[0] === "Notes" && job.counts.notes - before.notes <= 1) job.kinds = ["Text"];
    if (!job.kinds.length && !job.counts.skipped) throw new Error("nothing in it could be read: upload a ChatGPT export, a Google Takeout, a notes folder or vault (zipped), .md, .txt, .enex, .ics or .vcf files");
    fs.writeFileSync(learnFile, JSON.stringify(job.learn ? learnChunks(learn) : []), { mode: 0o600 });
    // The upload is no longer needed: everything kept is in the app now.
    fs.rmSync(file, { force: true });
    job.learned = { done: 0, total: job.learn ? (JSON.parse(fs.readFileSync(learnFile, "utf8")) as string[]).length : 0 };
    job.state = job.learned.total ? "learning" : "done";
  }
  if (job.state === "learning") {
    const chunks = JSON.parse(fs.readFileSync(learnFile, "utf8")) as string[];
    job.learned.total = chunks.length;
    while (job.learned.done < chunks.length) {
      if (stopRequested.has(job.id)) { job.state = "stopped"; job.detail = `Stopped after ${job.learned.done} of ${chunks.length} pieces`; break; }
      const busy = await gpuBusyNow(false);
      if (busy) { job.detail = `Waiting: ${busy}`; saveJob(hub, job); await sleep(60_000); continue; }
      job.detail = `Learning about you: piece ${job.learned.done + 1} of ${chunks.length}`;
      saveJob(hub, job);
      const prompt = `Keys already known: ${knownKeys(hub) || "none"}\n\n${chunks[job.learned.done]}`;
      const { text: answer, stopped } = await hub.ai.backgroundJson(`import:${job.id}`, LEARN_SYSTEM, prompt);
      if (stopped) { job.detail = "Paused for a chat"; saveJob(hub, job); await sleep(20_000); continue; }
      job.counts.facts += keepLearned(hub, answer, job.id);
      job.learned.done++;
    }
    if (job.state === "learning") job.state = "done";
  }
  if (job.state === "done") {
    job.detail = job.left_out ? `Done; ${job.left_out} file${job.left_out === 1 ? " was" : "s were"} left out (one import reads up to 1 GB of text; bring the rest in as another upload)` : "Done";
    fs.rmSync(dir, { recursive: true, force: true });
  }
  job.finished_at = new Date().toISOString();
  saveJob(hub, job);
}
