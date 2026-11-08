import type { Entity } from "@everythingapp/shared";
import type { Store } from "../store.js";

/** Apple Reminders lists as the assistant sees them: tasks carry their list's name in `apple.list_title`. */

/** The Apple Reminders list a task is in, by name. */
export const listOf = (t: Entity): string | null => {
  const a = t.fields.apple as { list_title?: unknown } | undefined;
  return typeof a?.list_title === "string" && a.list_title ? a.list_title : null;
};

/** Reminders list names in a space, most used first. */
export function taskLists(store: Store, space: "personal" | "work" = "personal"): string[] {
  const n = new Map<string, number>();
  for (const t of store.list({ kind: "task", space, limit: 100000 })) { const l = listOf(t); if (l) n.set(l, (n.get(l) ?? 0) + 1); }
  return [...n].sort((x, y) => y[1] - x[1]).map(([l]) => l);
}

/**
 * A list by a loose name: case, "list", possessives and plurals do not matter ("grocery list" is Groceries), and the
 * words given may be part of the name ("Jamie's shopping" is Jamie Shopping). "my" picks the list named for the owner
 * among several (for an owner named Alex, "my shopping list" is Alex Shopping, not Jamie Shopping). Null when it is not
 * clear which.
 */
export function matchList(name: string, lists: string[], owner = ""): string | null {
  const words = (s: string) => s.toLowerCase().replace(/['’]s\b/g, "").replace(/[^a-z0-9 ]/g, " ").split(/\s+/)
    .filter((w) => w && w !== "list" && w !== "the").map((w) => w.replace(/ies$/, "y").replace(/(?<!s)s$/, ""));
  const exact = lists.find((l) => l.toLowerCase() === name.trim().toLowerCase());
  if (exact) return exact;
  const want = words(name);
  const mine = want.includes("my");
  const asked = want.filter((w) => w !== "my");
  const same = lists.find((l) => words(l).join(" ") === asked.join(" "));
  if (same) return same;
  const holding = lists.filter((l) => asked.length && asked.every((w) => words(l).includes(w)));
  if (holding.length === 1) return holding[0];
  const ownerWords = words(owner);
  if (mine && ownerWords.length) { const own = holding.filter((l) => ownerWords.every((w) => words(l).includes(w))); if (own.length === 1) return own[0]; }
  return null;
}


/** Words that say little about which task a note is about. */
const COMMON = new Set(["need", "needs", "still", "that", "this", "with", "from", "have", "grab", "pick", "get", "got", "buy", "some", "more", "about", "remember", "should", "must", "call", "make", "take", "the", "and", "for", "into", "onto", "tomorrow", "today", "tonight", "week"]);
export const wordsOf = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !COMMON.has(w)).map((w) => w.replace(/s$/, "")));

/**
 * An open task that is the same as a new title: every word of the shorter one is in the other, and that is two words or
 * more unless both are one word ("HDMI cable from Micro Center" is "Pick up HDMI cable at Micro Center", "USB-C cable
 * from Micro Center" is not). The filer added the first beside the second.
 */
export function sameOpenTask(store: Store, title: string, space: "personal" | "work" = "personal"): Entity | null {
  const want = wordsOf(title);
  if (!want.size) return null;
  for (const t of store.list({ kind: "task", space, limit: 100000 })) {
    if (t.deleted_at || t.fields.status === "done") continue;
    const have = wordsOf(String(t.fields.title ?? ""));
    if (!have.size) continue;
    const shared = [...have].filter((w) => want.has(w)).length;
    if (shared === Math.min(want.size, have.size) && (shared >= 2 || want.size === have.size)) return t;
  }
  return null;
}
