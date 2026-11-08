import fs from "node:fs";
import path from "node:path";
import type { Entity } from "@everythingapp/shared";
import { Store, StoreError } from "./store.js";
import { slug, uniqueNotePath } from "./capture.js";

/**
 * Module 5, music. One line like `Am F C G 6/8 112bpm drop D` becomes a `music_idea`: chord tokens, a time
 * signature, a tempo and a tuning are recognized and the rest of the words make the title.
 */

const CHORD = /^[A-G](?:#|b)?(?:maj|min|dim|aug|sus|add|m|M|\+|°)?\d{0,2}(?:sus[24]|add\d{1,2}|b5|#5|b9|#9|#11|b13)?(?:\/[A-G](?:#|b)?)?$/;
const TIME_SIG = /^(\d{1,2})\/(2|4|8|16)$/;
const BPM_TOKEN = /^(\d{2,3})bpm$/i;
const TUNING = /\b(drop\s+[a-g](?:#|b)?|[a-g](?:#|b)?\s+standard|standard|dadgad|open\s+[a-g](?:#|b)?|half\s+step\s+down|whole\s+step\s+down)\b/i;

export interface QuickParse { title: string; type: "progression" | "riff"; body: string; key?: string; bpm?: number; time_sig?: string; tuning?: string }

const noteCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

function normalizeTuning(raw: string): string {
  const t = raw.trim().replace(/\s+/g, " ").toLowerCase();
  if (t === "dadgad") return "DADGAD";
  if (t === "standard") return "standard";
  let m = /^drop ([a-g](?:#|b)?)$/.exec(t);
  if (m) return `drop ${noteCase(m[1])}`;
  m = /^open ([a-g](?:#|b)?)$/.exec(t);
  if (m) return `open ${noteCase(m[1])}`;
  m = /^([a-g](?:#|b)?) standard$/.exec(t);
  if (m) return `${noteCase(m[1])} standard`;
  return t;
}

/** The key implied by the first chord: its root plus `m` for a minor chord. */
function keyOf(chord: string): string {
  const m = /^([A-G](?:#|b)?)(m(?!aj)|min|dim)?/.exec(chord);
  if (!m) return chord;
  return m[2] ? `${m[1]}m` : m[1];
}

export function parseQuick(input: string): QuickParse {
  let text = String(input ?? "").replace(/\s+/g, " ").trim();
  if (!text) throw new StoreError(422, "text is required");
  const out: Partial<QuickParse> = {};
  const tuning = TUNING.exec(text);
  if (tuning) { out.tuning = normalizeTuning(tuning[1]); text = (text.slice(0, tuning.index) + " " + text.slice(tuning.index + tuning[0].length)).trim(); }
  // "riff idea:" or "progression:" at the start says what it is; it is not part of the title.
  const label = /^(riff|progression|chords?)?\s*(idea)?\s*:\s*/i.exec(text);
  const saysRiff = !!label && /riff/i.test(label[0]);
  if (label && label[0].trim()) text = text.slice(label[0].length);
  // Punctuation stays off the tokens: "112," is a tempo.
  const words = text.split(" ").map((w) => w.replace(/^[,;]+|[,;.]+$/g, "")).filter(Boolean);
  const chords: string[] = [];
  const title: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = words[i + 1];
    const prev = words[i - 1];
    let m: RegExpExecArray | null;
    if ((m = BPM_TOKEN.exec(w))) { out.bpm = parseInt(m[1], 10); continue; }
    if (/^(bpm|tempo)$/i.test(w) && next && /^\d{2,3}$/.test(next)) { out.bpm = parseInt(next, 10); i++; continue; }
    if (/^\d{2,3}$/.test(w) && next && /^bpm$/i.test(next)) { out.bpm = parseInt(w, 10); i++; continue; }
    // "at 112" or "@112": a tempo in the usual range.
    if (out.bpm === undefined && ((m = /^@(\d{2,3})$/.exec(w)) || (/^\d{2,3}$/.test(w) && prev && /^(at|@)$/i.test(prev)))) {
      const n = parseInt(m ? m[1] : w, 10);
      if (n >= 30 && n <= 300) { out.bpm = n; continue; }
    }
    if ((m = TIME_SIG.exec(w))) { out.time_sig = `${m[1]}/${m[2]}`; continue; }
    if (CHORD.test(w)) { chords.push(w); continue; }
    title.push(w);
  }
  // Joining words left between the parsed parts ("in 6/8 at 112") are not a title.
  const titleWords = title.filter((w) => w && !/^(in|at|@|with|and|tempo)$/i.test(w));
  const type = chords.length && !saysRiff ? "progression" : "riff";
  const body = chords.join(" ");
  const name = titleWords.join(" ") || body || "Untitled idea";
  return { title: name.slice(0, 120), type, body, ...(chords.length ? { key: keyOf(chords[0]) } : {}), ...out };
}

/** POST /music/quick: parse and create. */
export function quickIdea(store: Store, body: { text?: unknown; project_id?: string; tags?: string[] }): Entity {
  const parsed = parseQuick(String(body.text ?? ""));
  return store.create("music_idea", {
    ...parsed, status: "idea", tags: Array.isArray(body.tags) ? body.tags.map(String) : [],
    ...(body.project_id ? { project_id: body.project_id } : {}),
  });
}

/** GET /music?type=&status=: newest first. */
export function listMusic(store: Store, q: { type?: string; status?: string }): Entity[] {
  return store.list({ kind: "music_idea", limit: 100000 })
    .filter((m) => (!q.type || m.fields.type === q.type) && (!q.status || m.fields.status === q.status));
}

/** Where reference sheets live: notes, not the Music section, which is for songs, riffs and projects. */
export const MUSIC_REFERENCE_FOLDER = "Music/Reference";
const REFERENCE_TYPES = new Set(["reference", "template", "setting"]);

function referenceNote(store: Store, title: string, body: string, tags: string[]): Entity | null {
  const notes = store.list({ kind: "note", includeDeleted: true, limit: 100000 });
  const key = title.trim().toLowerCase();
  if (notes.some((n) => String(n.fields.title ?? "").trim().toLowerCase() === key && String(n.fields.path ?? "").startsWith(`${MUSIC_REFERENCE_FOLDER}/`))) return null;
  const all = [...new Set(["music", "reference", ...tags.map((t) => t.toLowerCase())])];
  return store.create("note", { title, body, tags: all, path: uniqueNotePath(store, MUSIC_REFERENCE_FOLDER, slug(title)) });
}

/**
 * Reference sheets, templates and settings kept as music ideas (a gain staging cheat sheet, a DAW session
 * checklist) move to notes in Music/Reference, tagged music and reference, so every note is in one place and the
 * Music section holds only songs, riffs and projects. Runs with the seed and the nightly sweep; idempotent.
 */
export function musicReferencesToNotes(store: Store): number {
  let moved = 0;
  for (const m of store.list({ kind: "music_idea", limit: 100000 })) {
    const f = m.fields;
    if (!REFERENCE_TYPES.has(String(f.type)) || m.deleted_at) continue;
    const details = [f.key ? `Key: ${String(f.key)}` : "", f.bpm ? `Tempo: ${String(f.bpm)} bpm` : "", f.time_sig ? `Time: ${String(f.time_sig)}` : "", f.tuning ? `Tuning: ${String(f.tuning)}` : ""].filter(Boolean);
    const body = [details.join(", "), String(f.body ?? "")].filter(Boolean).join("\n\n");
    const tags = [...(Array.isArray(f.tags) ? f.tags.map(String) : []), ...(f.type === "reference" ? [] : [String(f.type)])];
    referenceNote(store, String(f.title ?? "Music reference"), body, tags);
    store.patch(m.id, { deleted_at: new Date().toISOString() });
    moved++;
  }
  return moved;
}

/** Seed the reference sheets as notes in Music/Reference, matched by title (deleted ones included), created once. */
export function seedMusicNotes(store: Store, seedDir: string): { created: number; kept: number } {
  const out = { created: 0, kept: 0 };
  const p = path.join(seedDir, "music_notes.json");
  if (!fs.existsSync(p)) { console.warn(`[seed] ${p} not found, skipping`); return out; }
  musicReferencesToNotes(store);
  for (const raw of JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>[]) {
    const title = String(raw.title ?? "").trim();
    if (!title) continue;
    if (referenceNote(store, title, String(raw.body ?? ""), Array.isArray(raw.tags) ? raw.tags.map(String) : [])) out.created++;
    else out.kept++;
  }
  return out;
}

export function musicIdeasCount(store: Store): number {
  return store.list({ kind: "music_idea", limit: 100000 }).length;
}
