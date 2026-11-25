/**
 * The bottom bar of the phone layout (the iPhone, and the web, Windows and Android apps in a narrow window): which
 * screens it holds, in two rows, and how many across. One setting for every device: `bar` in the feel setting
 * (CONTRACT.md, Feel). The hub checks it with `readBar`; the web client draws and edits it with the rest. The Apple
 * apps carry the same rules in EACore `Bar.swift`, and tests on both sides keep the two and the contract the same.
 */

/** Every screen a place can hold, by id. `status` is a screen of the web, Windows and Android apps only. */
export const BAR_SCREENS = [
  "today", "assistant", "capture", "library", "search",
  "inbox", "tasks", "week", "renewals", "dashboard",
  "notes", "memory", "people", "reference",
  "ops", "sensors",
  "projects", "procedures", "music", "wiki", "images", "quiz",
  "health", "logs", "pet", "food",
  "mail", "lists", "games", "films", "listening", "calc",
  "status",
] as const;

/**
 * Screens taken out of the app, by id: Layout sketches (`layouts`) and Job applications (`career`, its id in the Apple
 * apps; no bar ever offered it, as it was a page in Lists) on 2026-11-25. Read from a setting, such an id leaves it and
 * its place is free. Any other id a build does not know is kept: a newer app may have put it there.
 */
export const BAR_GONE: readonly string[] = ["layouts", "career"];

/** How many screens a row holds. Fewer means larger icons with more room. */
export const BAR_COUNTS = [3, 4, 5] as const;
export type BarCount = (typeof BAR_COUNTS)[number];

/** The one screen that always has a place: every other screen, and Settings, is reached from it. */
export const BAR_LIBRARY = "library";

export type BarRow = "first" | "second";

export interface Bar {
  count: BarCount;
  /** The row that always shows: at most `count` screen ids. */
  first: string[];
  /** The row a drag up on the bar reveals: at most `count` screen ids. Empty: nothing to reveal. */
  second: string[];
}

/** The bar as it was before it could be changed, with the screens most people open next in the second row. */
export const DEFAULT_BAR: Bar = {
  count: 5,
  first: ["today", "assistant", "capture", "library", "search"],
  second: ["tasks", "week", "notes", "memory", "people"],
};

/** A fresh copy of the default, safe to change. */
export function defaultBar(): Bar {
  return { count: DEFAULT_BAR.count, first: [...DEFAULT_BAR.first], second: [...DEFAULT_BAR.second] };
}

/** A screen id as the setting takes it: a letter, then letters, digits, `_` or `-`, 40 at most. It need not be one this build knows. */
export function isBarId(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(v);
}

/**
 * The setting from an unknown value (a request, a file, a cached copy), or null when it breaks a rule: `count` is 3, 4
 * or 5; each row is a list of at most `count` screen ids; an id has one place across both rows. An id this build does
 * not know is kept: a newer app may have put it there, and it is only skipped when the bar is drawn. A screen taken
 * out (`BAR_GONE`) leaves the setting, and the screens after it in its row move up.
 */
export function readBar(raw: unknown): Bar | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!(BAR_COUNTS as readonly unknown[]).includes(r.count)) return null;
  const count = r.count as BarCount;
  const rows: string[][] = [];
  for (const row of [r.first, r.second]) {
    if (!Array.isArray(row) || row.length > count || !row.every(isBarId)) return null;
    rows.push([...row]);
  }
  const all = [...rows[0], ...rows[1]];
  if (new Set(all).size !== all.length) return null;
  const kept = (row: string[]) => row.filter((id) => !BAR_GONE.includes(id));
  return { count, first: kept(rows[0]), second: kept(rows[1]) };
}

/** The setting from an unknown value, the default when it is absent or breaks a rule. */
export function barOrDefault(raw: unknown): Bar {
  return readBar(raw) ?? defaultBar();
}

export function sameBar(a: Bar, b: Bar): boolean {
  return a.count === b.count && a.first.join() === b.first.join() && a.second.join() === b.second.join();
}

/** A row with Library in its last place: the next free one, else in place of the screen in place `count`. */
function libraryLast(row: string[], count: number): string[] {
  return row.length < count ? [...row, BAR_LIBRARY] : [...row.slice(0, count - 1), BAR_LIBRARY];
}

/** The setting with Library in it: unchanged when a row has it, else Library takes the last place of the first row. */
export function barWithLibrary(bar: Bar): Bar {
  if (bar.first.includes(BAR_LIBRARY) || bar.second.includes(BAR_LIBRARY)) return bar;
  return { count: bar.count, first: libraryLast(bar.first, bar.count), second: [...bar.second] };
}

export interface BarLayout {
  count: BarCount;
  first: string[];
  second: string[];
}

/**
 * What a device draws. A screen it cannot show now (`has` says which it can: one it has no screen for, or one whose
 * module is off) is skipped, never taken out of the setting. When nothing of the first row is left, the second row is
 * drawn in its place. When neither row has Library, it is drawn in the last place of the first row.
 */
export function barLayout(bar: Bar, has: (id: string) => boolean): BarLayout {
  const keep = (id: string) => id === BAR_LIBRARY || has(id);
  let first = bar.first.slice(0, bar.count).filter(keep);
  let second = bar.second.slice(0, bar.count).filter(keep);
  if (!first.length) [first, second] = [second, []];
  if (!first.includes(BAR_LIBRARY) && !second.includes(BAR_LIBRARY)) first = libraryLast(first, bar.count);
  return { count: bar.count, first, second };
}

/** Every screen the layout draws, the first row then the second. */
export function barTabs(layout: BarLayout): string[] {
  return [...layout.first, ...layout.second];
}

/**
 * Another count. Each row is cut to it: the screens past it leave the bar. Library cut off that way takes the last
 * place of its own row instead, so it keeps a place.
 */
export function barWithCount(bar: Bar, count: BarCount): Bar {
  const cut = (row: string[]) => {
    const kept = row.slice(0, count);
    if (row.includes(BAR_LIBRARY) && !kept.includes(BAR_LIBRARY)) kept[count - 1] = BAR_LIBRARY;
    return kept;
  };
  return barWithLibrary({ count, first: cut(bar.first), second: cut(bar.second) });
}

/** Where an id has its place, or null. */
export function barWhere(bar: Bar, id: string): { row: BarRow; index: number } | null {
  for (const row of ["first", "second"] as const) {
    const index = bar[row].indexOf(id);
    if (index >= 0) return { row, index };
  }
  return null;
}

/** The id in a place of the bar as the editor shows it (with Library), or null for a free place. */
export function barAt(bar: Bar, row: BarRow, index: number): string | null {
  return barWithLibrary(bar)[row][index] ?? null;
}

/**
 * Whether `id` may be chosen for a place (0 to `count` - 1). Library's place takes only a screen that has a place,
 * which swaps with it, so Library always keeps one. A screen moved out of the first row into a free place of the
 * second must leave the first row a screen.
 */
export function barCanPick(bar: Bar, row: BarRow, index: number, id: string): boolean {
  const b = barWithLibrary(bar);
  if (!isBarId(id) || !Number.isInteger(index) || index < 0 || index >= b.count) return false;
  const there = b[row][index] ?? null;
  if (there === id) return true;
  const from = barWhere(b, id);
  if (there === BAR_LIBRARY && !from) return false;
  if (there === null && from?.row === "first" && row === "second" && b.first.length === 1) return false;
  return true;
}

/**
 * Choose a screen for a place. One that already has a place swaps with what was there; into a free place it moves,
 * and the row it left closes up. One with no place takes the place, and what was there leaves the bar. A free place
 * is the next one after the row's last. A choice that is not allowed (`barCanPick`) changes nothing.
 */
export function barPick(bar: Bar, row: BarRow, index: number, id: string): Bar {
  const b = barWithLibrary(bar);
  if (!barCanPick(b, row, index, id)) return b;
  const there = b[row][index] ?? null;
  if (there === id) return b;
  const next: Bar = { count: b.count, first: [...b.first], second: [...b.second] };
  const from = barWhere(next, id);
  if (from && there !== null) {
    next[from.row][from.index] = there;
    next[row][index] = id;
  } else if (from) {
    next[from.row].splice(from.index, 1);
    next[row].push(id);
  } else if (there !== null) {
    next[row][index] = id;
  } else {
    next[row].push(id);
  }
  return next;
}

/** Whether a place can be emptied: one of the second row that holds a screen other than Library. */
export function barCanEmpty(bar: Bar, row: BarRow, index: number): boolean {
  const there = barAt(bar, row, index);
  return row === "second" && there !== null && there !== BAR_LIBRARY;
}

/** Empty a place of the second row: the screens after it move up. */
export function barEmpty(bar: Bar, index: number): Bar {
  const b = barWithLibrary(bar);
  if (!barCanEmpty(b, "second", index)) return b;
  const second = [...b.second];
  second.splice(index, 1);
  return { count: b.count, first: [...b.first], second };
}

/**
 * The count chosen in the editor. `before` is the bar as it was before this run of count changes, so going back to a
 * larger count while the page is open brings back what the smaller one cut.
 */
export function barCountChange(bar: Bar, count: BarCount, before: Bar | null): Bar {
  const from = before ?? bar;
  return from.count === count ? from : barWithCount(from, count);
}
