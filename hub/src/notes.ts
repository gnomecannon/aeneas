import type { Entity } from "@everythingapp/shared";
import { Store } from "./store.js";
import { extractWikilinks } from "./vault.js";

/**
 * The knowledge map: links and tags the user never has to type.
 * Links are derived from explicit [[wikilinks]], any mention of another note's title, and the notes the note linker
 * found it relates to (`related`, note-linker.ts).
 * Tags are suggested from the existing vocabulary, the note's folder, and optionally a model.
 */

const STOP = new Set("the a an and or of to in on for with by at from as is are was were be been it this that these those my your our i you we they he she them his her its not no yes do does did have has had will would can could should may might into over under about after before between during through up down out off than then so if but because while where when what which who whom how all any each few more most other some such only own same too very just also".split(" "));

export interface RelatedNote { id: string; title: string; path: string; why: "link" | "backlink" | "similar" }

/** A title, its note, and its pattern; `plain` is the lowercased title when it is plain ASCII, which the lowercased
 * text must hold as is for the pattern to match it (a quick test before the pattern). */
type TitleEntry = { title: string; id: string; re: RegExp; plain: string | null };
type TagEntry = { tag: string; re: RegExp };

const wordRe = (text: string, flags = "") => new RegExp(`(^|[^a-z0-9])${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, flags);

export class KnowledgeMap {
  /**
   * Every note's title pattern, kept between note saves: each save of a note (an autosave every second while typing)
   * read every note and built every title's pattern again to find the titles it mentions. A note made, renamed,
   * deleted or moved to another space drops it (the hook below), and so does a write by another program to the same
   * file (SQLite's data_version, which the hub's own writes leave as it is).
   */
  private kept: { titles: TitleEntry[]; version: number } | null = null;

  constructor(private store: Store) {
    store.afterWrite((e, prev) => {
      if (e.kind !== "note") return;
      if (!prev || prev.fields.title !== e.fields.title || prev.deleted_at !== e.deleted_at || prev.space !== e.space) this.kept = null;
    });
  }

  /** Every note read once, with each title's and tag's pattern, while `batch` runs. */
  private snap: { notes: Entity[]; titles: TitleEntry[]; tags: TagEntry[]; vocab: Map<string, number> } | null = null;

  /**
   * Run `fn` with one read of every note. The nightly sweep asked for every note, and built every title's pattern,
   * once per note, so it grew with the square of the notes. Titles and tags must not change inside (the sweep writes
   * only links, suggestions and projects).
   */
  batch<T>(fn: () => T): T {
    const notes = this.notes();
    const vocab = vocabularyOf(notes);
    this.snap = { notes, titles: titlesOf(notes), tags: tagsOf(vocab), vocab };
    try { return fn(); } finally { this.snap = null; }
  }

  private notes(): Entity[] {
    if (this.snap) return this.snap.notes;
    return this.store.list({ kind: "note", limit: 100000 }).filter((n) => !n.deleted_at && n.space !== "work");
  }

  /** Lowercase title to note, longest titles first so "Proxmox certs" beats "Proxmox". */
  private titleIndex(exclude?: string): TitleEntry[] {
    return this.titles().filter((e) => e.id !== exclude);
  }

  private titles(): TitleEntry[] {
    if (this.snap) return this.snap.titles;
    const version = Number(this.store.db.pragma("data_version", { simple: true }));
    if (!this.kept || this.kept.version !== version) this.kept = { titles: titlesOf(this.notes()), version };
    return this.kept.titles;
  }

  /** Explicit wikilinks, title mentions and the linker's related notes, as titles. Used by the vault hook so links are always current. */
  deriveLinks(noteId: string | undefined, body: string, title = "", related: string[] = []): string[] {
    const out = new Set<string>([...extractWikilinks(body), ...related]);
    const haystack = ` ${(title + "\n" + body).replace(/```[\s\S]*?```/g, " ").replace(/\[\[[^\]]*\]\]/g, " ")} `.toLowerCase();
    for (const { title: t, re, plain } of this.titleIndex(noteId)) {
      if (plain !== null && !haystack.includes(plain)) continue;
      if (re.test(haystack)) out.add(t);
    }
    return [...out];
  }

  resolve(titleOrPath: string): Entity | null {
    const key = titleOrPath.trim().toLowerCase();
    for (const n of this.notes()) {
      const t = String(n.fields.title ?? "").trim().toLowerCase();
      const p = String(n.fields.path ?? "").toLowerCase();
      if (t === key || p === key || p === `${key}.md` || p.endsWith(`/${key}.md`)) return n;
    }
    return null;
  }

  /** Tag vocabulary with usage counts across all notes. */
  vocabulary(): Map<string, number> {
    return this.snap?.vocab ?? vocabularyOf(this.notes());
  }

  /** Rule-based tag suggestions: vocabulary words that appear in the text, plus the folder name. */
  suggestTags(note: Entity): string[] {
    const have = new Set(((note.fields.tags as string[] | undefined) ?? []).map((t) => t.toLowerCase()));
    const text = ` ${String(note.fields.title ?? "")} ${String(note.fields.body ?? "")} `.toLowerCase();
    const out: string[] = [];
    for (const { tag, re } of this.snap?.tags ?? tagsOf(this.vocabulary())) {
      if (have.has(tag.toLowerCase())) continue;
      if (re.test(text)) out.push(tag);
    }
    const folder = String(note.fields.path ?? "").split("/")[0];
    if (folder && !folder.endsWith(".md")) {
      const ft = folder.toLowerCase().replace(/\s+/g, "-");
      if (!have.has(ft) && !out.includes(ft)) out.push(ft);
    }
    return out.slice(0, 8);
  }

  /** Links, backlinks and FTS-similar notes for one note. */
  related(noteId: string): { links: RelatedNote[]; backlinks: RelatedNote[]; similar: RelatedNote[] } {
    const note = this.store.get(noteId);
    if (!note || note.kind !== "note") return { links: [], backlinks: [], similar: [] };
    const title = String(note.fields.title ?? "").trim();
    const mk = (n: Entity, why: RelatedNote["why"]): RelatedNote => ({ id: n.id, title: String(n.fields.title ?? ""), path: String(n.fields.path ?? ""), why });
    const seen = new Set<string>([noteId]);
    const links: RelatedNote[] = [];
    for (const t of (note.fields.links as string[] | undefined) ?? []) {
      const n = this.resolve(t);
      if (n && !seen.has(n.id)) { seen.add(n.id); links.push(mk(n, "link")); }
    }
    const backlinks: RelatedNote[] = [];
    for (const n of this.notes()) {
      if (seen.has(n.id)) continue;
      const ls = ((n.fields.links as string[] | undefined) ?? []).map((x) => x.toLowerCase());
      if (ls.includes(title.toLowerCase())) { seen.add(n.id); backlinks.push(mk(n, "backlink")); }
    }
    const words = [...new Set(title.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)))];
    const similar: RelatedNote[] = [];
    if (words.length) {
      const q = words.map((w) => `"${w}"`).join(" OR ");
      try {
        for (const h of this.store.search(q, { kinds: ["note"], limit: 12 })) {
          if (seen.has(h.id)) continue;
          const n = this.store.get(h.id);
          if (n && !n.deleted_at) { seen.add(n.id); similar.push(mk(n, "similar")); }
          if (similar.length >= 5) break;
        }
      } catch { /* FTS query syntax edge case; similar stays empty */ }
    }
    return { links, backlinks, similar };
  }

  /** Nodes and resolved edges for the map view. */
  graph(): { nodes: Array<{ id: string; title: string; path: string; tags: string[]; folder: string }>; edges: Array<{ from: string; to: string }> } {
    const notes = this.notes();
    const byTitle = new Map<string, string>();
    for (const n of notes) byTitle.set(String(n.fields.title ?? "").trim().toLowerCase(), n.id);
    const edges: Array<{ from: string; to: string }> = [];
    const seen = new Set<string>();
    for (const n of notes) {
      for (const t of (n.fields.links as string[] | undefined) ?? []) {
        const to = byTitle.get(t.trim().toLowerCase());
        if (!to || to === n.id) continue;
        const k = `${n.id}>${to}`;
        if (seen.has(k)) continue;
        seen.add(k);
        edges.push({ from: n.id, to });
      }
    }
    return {
      nodes: notes.map((n) => ({ id: n.id, title: String(n.fields.title ?? ""), path: String(n.fields.path ?? ""), tags: (n.fields.tags as string[] | undefined) ?? [], folder: String(n.fields.path ?? "").split("/").slice(0, -1).join("/") })),
      edges,
    };
  }
}

function vocabularyOf(notes: Entity[]): Map<string, number> {
  const v = new Map<string, number>();
  for (const n of notes) for (const t of (n.fields.tags as string[] | undefined) ?? []) v.set(t, (v.get(t) ?? 0) + 1);
  return v;
}

/** Titles of 4 characters or more, longest first, each with the pattern that finds it as a whole phrase. */
function titlesOf(notes: Entity[]): TitleEntry[] {
  return notes
    .filter((n) => String(n.fields.title ?? "").trim().length >= 4)
    .map((n) => { const title = String(n.fields.title).trim(); const lower = title.toLowerCase(); return { title, id: n.id, re: wordRe(lower, "i"), plain: /^[\x00-\x7f]*$/.test(lower) ? lower : null }; })
    .sort((a, b) => b.title.length - a.title.length);
}

/** Tags by use, most used first, each with the pattern that finds it as words ("home-lab" as "home lab"). */
function tagsOf(vocab: Map<string, number>): TagEntry[] {
  return [...vocab].sort((a, b) => b[1] - a[1]).map(([tag]) => ({ tag, re: wordRe(tag.toLowerCase().replace(/[-_/]+/g, " ")) }));
}
