/**
 * Choosing tasks by the Apple Reminders list they are in: which lists fill Today's To do card (`todo_lists` in Today's
 * setting, today.ts) and which lists a group on the Tasks screen shows (`groups` in the sources setting). A choice is a
 * list of list keys as the sources setting names them (`<kind>:<account>/<title>`), and `none` for the tasks in no list
 * (made in Aeneas and never added to Reminders). The hub checks both with these rules and the web client draws by
 * them; the Apple apps carry the same rules in EACore `TaskLists.swift`, and tests on both sides keep them the same.
 */

/** The choice for tasks in no Reminders list. No list key is this word: a key holds `:` and `/`. */
export const NO_LIST = "none";
/** How many lists one choice may name: as many as the sources setting keeps. */
export const MAX_CHOSEN_LISTS = 300;

/** A Reminders list as a choice reads it: its key, its title, and the keys it had before it was renamed. */
export interface ChoosableList { key: string; title: string; was?: string[] }

/** One entry of a choice: `none`, or a list key of 3 to 300 characters. */
export function isListChoice(v: unknown): v is string {
  return typeof v === "string" && v.length >= 3 && v.length <= 300;
}

/** A choice from an unknown value, or null when it breaks a rule: a list of at most 300 entries, each named once. */
export function readListChoices(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_CHOSEN_LISTS || !raw.every(isListChoice) || new Set(raw).size !== raw.length) return null;
  return [...raw];
}

/** Whether a list is in a choice: by its key, or by a key it had before it or its account was renamed. */
export function listChosen(chosen: readonly string[], list: ChoosableList): boolean {
  return chosen.includes(list.key) || (list.was ?? []).some((k) => chosen.includes(k));
}

/**
 * A choice with a list added or taken out. Taking it out takes its older keys too; adding it adds its key once.
 * Entries for lists not named stay, so lists this device does not show keep their place in the choice.
 */
export function withListChosen(chosen: readonly string[], list: ChoosableList, on: boolean): string[] {
  const old = new Set([list.key, ...(list.was ?? [])]);
  const rest = chosen.filter((k) => !old.has(k));
  return on && rest.length < MAX_CHOSEN_LISTS ? [...rest, list.key] : rest;
}

/** `none` added to a choice or taken out. */
export function withNoListChosen(chosen: readonly string[], on: boolean): string[] {
  const rest = chosen.filter((k) => k !== NO_LIST);
  return on && rest.length < MAX_CHOSEN_LISTS ? [...rest, NO_LIST] : rest;
}

/**
 * The test for "is this task in one of the lists chosen", for a task's fields. A task names its list by
 * `apple.list_key`; one linked by an app from before 1.0.18 has only `apple.list_title`, and is in the choice when any
 * list of that name is. A key whose list now has another name is out of date (an older app changed only the title), so
 * the title decides, as for hidden tasks (`taskFilter`). A key from before a rename finds its list by `was`; a key the
 * setting has not heard of counts when the choice names it. A task with neither is in no list: in the choice when it
 * names `none`.
 */
export function taskInLists(chosen: readonly string[], lists: readonly ChoosableList[] | undefined): (fields: Record<string, unknown>) => boolean {
  const picked = new Set(chosen);
  const none = picked.has(NO_LIST);
  const isPicked = (l: ChoosableList) => picked.has(l.key) || (l.was ?? []).some((k) => picked.has(k));
  const byKey = new Map<string, ChoosableList>();
  const byOldKey = new Map<string, ChoosableList>();
  const byTitle = new Map<string, ChoosableList[]>();
  for (const l of lists ?? []) {
    byKey.set(l.key, l);
    for (const k of l.was ?? []) if (!byOldKey.has(k)) byOldKey.set(k, l);
    const named = byTitle.get(l.title);
    if (named) named.push(l); else byTitle.set(l.title, [l]);
  }
  return (fields) => {
    const a = fields.apple as { list_key?: unknown; list_title?: unknown } | null | undefined;
    const key = a && typeof a === "object" && typeof a.list_key === "string" ? a.list_key : "";
    const title = a && typeof a === "object" && typeof a.list_title === "string" ? a.list_title : "";
    if (!key && !title) return none;
    if (key) {
      const l = byKey.get(key);
      if (l && (!title || l.title === title)) return isPicked(l);
      const old = l ? undefined : byOldKey.get(key);
      if (old) return isPicked(old);
      if (!l && picked.has(key)) return true;
    }
    if (!title) return false;
    return (byTitle.get(title) ?? []).some(isPicked);
  };
}

// ---------- task groups ----------

/**
 * A group on the Tasks screen (gnomecannon/aeneas#26): a name, like School, and the lists in it. Choosing it shows only
 * the tasks of those lists, from Personal and Work alike. It is a view, not a space: it changes nothing about where a
 * task is kept or synced. Kept in the sources setting, one for every device (`groups`).
 */
export interface TaskGroup { id: string; name: string; lists: string[] }

/** How many groups there may be. */
export const MAX_TASK_GROUPS = 20;
/** How long a group's name may be. */
export const TASK_GROUP_NAME_MAX = 40;

/** Why a set of groups is refused, in words the screens show as they are; the same words as EACore `TaskGroups`. */
export const TASK_GROUP_PROBLEMS = {
  shape: "Each group is an id, a name and its lists.",
  tooMany: "There can be 20 groups at most.",
  id: "Each group needs an id of its own.",
  noName: "Give the group a name.",
  longName: "A group's name is 40 characters at most.",
  taken: "Another group has this name.",
  reserved: "Personal and Work are taken. Give the group another name.",
  lists: "A group holds at most 300 lists, each named once.",
} as const;

/** The names the selector already has. */
const RESERVED = ["personal", "work"];
const plain = (s: string) => s.trim().toLowerCase();

/** Whether an id is one a group can have: lowercase letters, digits and `-`, 1 to 40. */
export function isTaskGroupId(v: unknown): v is string {
  return typeof v === "string" && /^[a-z0-9-]{1,40}$/.test(v);
}

/** Why a set of groups breaks a rule, or null when it keeps them. Names are read trimmed. */
export function taskGroupsProblem(raw: unknown): string | null {
  if (!Array.isArray(raw)) return TASK_GROUP_PROBLEMS.shape;
  if (raw.length > MAX_TASK_GROUPS) return TASK_GROUP_PROBLEMS.tooMany;
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const g of raw) {
    if (!g || typeof g !== "object" || Array.isArray(g)) return TASK_GROUP_PROBLEMS.shape;
    const r = g as Record<string, unknown>;
    if (typeof r.name !== "string" || !Array.isArray(r.lists)) return TASK_GROUP_PROBLEMS.shape;
    if (!isTaskGroupId(r.id) || ids.has(r.id)) return TASK_GROUP_PROBLEMS.id;
    ids.add(r.id);
    const name = r.name.trim();
    if (!name) return TASK_GROUP_PROBLEMS.noName;
    if ([...name].length > TASK_GROUP_NAME_MAX) return TASK_GROUP_PROBLEMS.longName;
    if (RESERVED.includes(plain(name))) return TASK_GROUP_PROBLEMS.reserved;
    if (names.has(plain(name))) return TASK_GROUP_PROBLEMS.taken;
    names.add(plain(name));
    if (!readListChoices(r.lists)) return TASK_GROUP_PROBLEMS.lists;
  }
  return null;
}

/** The groups from an unknown value (a request, a file, a cached copy), names trimmed, or null when they break a rule. */
export function readTaskGroups(raw: unknown): TaskGroup[] | null {
  if (taskGroupsProblem(raw) !== null) return null;
  return (raw as Array<Record<string, unknown>>).map((g) => ({ id: g.id as string, name: (g.name as string).trim(), lists: [...(g.lists as string[])] }));
}

/**
 * An id for a new group: its name in lowercase letters and digits (accents dropped, anything else a `-`), at most 30,
 * made unique among `groups` with `-2`, `-3`...; `group` when nothing is left.
 */
export function newTaskGroupId(name: string, groups: readonly TaskGroup[]): string {
  const base = name.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30).replace(/-+$/, "") || "group";
  let id = base;
  for (let n = 2; groups.some((g) => g.id === id); n++) id = `${base}-${n}`;
  return id;
}

/** The groups with `group` in the place of the one with its id, or added at the end. */
export function withTaskGroup(groups: readonly TaskGroup[], group: TaskGroup): TaskGroup[] {
  return groups.some((g) => g.id === group.id) ? groups.map((g) => (g.id === group.id ? group : g)) : [...groups, group];
}

/** The groups without the one with this id. */
export function withoutTaskGroup(groups: readonly TaskGroup[], id: string): TaskGroup[] {
  return groups.filter((g) => g.id !== id);
}
