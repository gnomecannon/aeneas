import { mentionedName, mentionNames, type Entity } from "@everythingapp/shared";
import { ftsText, StoreError, type Store } from "./store.js";
import { people } from "./people.js";

/**
 * How items connect, for "Related" on every detail screen and for the assistant: what an item points at (the event a
 * capture was filed as, a fact's person, a task's project), what points at it, and people by name: a person's page
 * lists the plans, diary days, notes and places that mention them, and any other item lists the people it mentions.
 */

/** `lines`: on a person's page, the lines of a note (a diary day above all) that name them. */
export type Related = { id: string; kind: string; title: string; why: string; at: string; lines?: string[] };

const OUT_WHY: Record<string, string> = {
  converted_to: "Filed as", person_id: "About", project_id: "Project", reminder_id: "Reminder", diary_id: "Diary",
  linked_id: "Linked", runbook_id: "Runbook", journal_id: "Change", inventory_id: "Inventory", letter_note_id: "Letter",
};
const IN_WHY: Record<string, string> = {
  converted_to: "Captured", person_id: "About them", project_id: "In this project", reminder_id: "Reminder for it", diary_id: "Captured",
};
/** Kinds whose text can mention someone. */
const MENTION_KINDS = ["event", "capture", "note", "task", "fact", "food_option", "log", "journal", "reminder", "project", "image", "inventory", "film", "game"];

export function titleOf(e: Entity): string {
  const f = e.fields;
  // A diary day reads as one, with its weekday, not as a bare date.
  const day = e.kind === "note" ? /^Diary\/(\d{4})-(\d{2})-(\d{2})\.md$/.exec(String(f.path ?? "")) : null;
  if (day) return `Diary, ${new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]), 12).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", year: "numeric" })}`;
  if (e.kind === "capture") return String(f.text ?? "").split("\n")[0].slice(0, 120);
  for (const k of ["title", "name", "key", "topic", "what", "text"]) if (typeof f[k] === "string" && f[k]) return String(f[k]).slice(0, 120);
  return e.kind;
}

export { mentionNames };
const mentions = mentionedName;

function textOf(e: Entity): string {
  const t = ftsText(e.kind, e.fields);
  return `${t.title}\n${t.text}`;
}

function idsIn(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return [];
}

/**
 * The lines of a note that name someone, list markers dropped, at most four. A diary day listed only by its date hid
 * what was said ("Priya is starting at Northwind") from the person's page and the assistant.
 */
function linesNaming(note: Entity, names: string[]): string[] {
  return String(note.fields.body ?? "").split("\n")
    .map((l) => l.replace(/^\s*[-*]\s*/, "").trim())
    .filter((l) => l && !l.startsWith("#") && mentions(l, names))
    .slice(0, 4)
    .map((l) => l.slice(0, 240));
}

export function relatedItems(store: Store, id: string, limit = 40): Related[] {
  const e = store.get(id);
  if (!e || e.deleted_at) throw new StoreError(404, "not found");
  const out = new Map<string, Related & { rank: number }>();
  const add = (x: Entity | null, why: string, rank: number, lines?: string[]) => {
    if (!x || x.deleted_at || x.id === e.id || out.has(x.id)) return;
    // A work item is marked, so a cloud model is never shown it (the assistant's people tool lists these).
    out.set(x.id, { id: x.id, kind: x.kind, title: titleOf(x), why, at: x.updated_at, rank, ...(lines?.length ? { lines } : {}), ...(x.space === "work" ? { work: true } : {}) });
  };

  for (const [k, v] of Object.entries(e.fields)) {
    if (k !== "converted_to" && !k.endsWith("_id")) continue;
    for (const ref of idsIn(v)) add(store.get(ref), OUT_WHY[k] ?? "Linked", 0);
  }
  const incoming = store.db.prepare("SELECT id FROM entities WHERE deleted_at IS NULL AND id != ? AND instr(fields, ?) > 0 LIMIT 200").all(e.id, e.id) as { id: string }[];
  for (const r of incoming) {
    const x = store.get(r.id);
    if (!x) continue;
    const key = Object.entries(x.fields).find(([, v]) => idsIn(v).includes(e.id))?.[0];
    if (key) add(x, IN_WHY[key] ?? "Links here", 1);
  }

  const everyone = people(store);
  if (e.kind === "person") {
    const names = mentionNames(e, everyone);
    for (const name of names) {
      // Facts naming them show on their page with what the owner told the app about them, not again here.
      for (const hit of store.search(name, { kinds: MENTION_KINDS.filter((k) => k !== "fact"), limit: 100 })) {
        const x = store.get(hit.id);
        if (x && !x.deleted_at && mentions(textOf(x), [name])) add(x, "Mentions them", 2, x.kind === "note" ? linesNaming(x, names) : undefined);
      }
    }
  } else {
    const text = textOf(e);
    for (const p of everyone) if (mentions(text, mentionNames(p, everyone))) add(p, "Mentioned", 0);
  }

  return [...out.values()]
    .sort((a, b) => a.rank - b.rank || b.at.localeCompare(a.at))
    .slice(0, limit)
    .map(({ rank: _rank, ...r }) => r);
}
