import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { nowIso, taskFilter, type Entity, type SourceList } from "@everythingapp/shared";
import type { Hub } from "./hub.js";
import { StoreError } from "./store.js";
import { errCode } from "./logsafe.js";

/**
 * Sources: what comes into the app from each device's own Apple Reminders, Calendar and Contacts, chosen once for
 * every device (Settings, Accounts, "From this iPhone"). One setting, kept in `<data>/sources.json`:
 *
 * - Reminders: each list is on or off and Personal or Work, and one list takes the tasks made in the app. A list
 *   that is off is neither read nor written by the apps, and its tasks are hidden everywhere (`taskFilter` in
 *   packages/shared is the rule; `Store.shows` is where the hub applies it). Nothing about those tasks changes on the
 *   hub, so an app from before 1.0.18, which knows nothing of this and still syncs every list both ways, deletes,
 *   finishes and adds nothing in Apple Reminders because of the switch.
 * - Calendars: which Apple Calendar calendars are work, one choice for all devices. One the hub itself keeps in step
 *   from iCloud (calendar-sync.ts) cannot be work: its events would come in twice.
 * - Contacts: the one device that mirrors Apple Contacts.
 *
 * The devices say which lists and calendars they see (`PUT /prefs/sources/seen`), under a key that is the same on
 * every device (`<account kind>:<account name>/<title>`); the hub keeps that catalog, so every device shows the same
 * chooser. A Personal or Work choice that differs from the account's own (Exchange is Work) takes effect only while
 * every iPhone, iPad and Mac on this hub runs 1.0.18 or later: an older app decides the space from the account, and
 * deletes the Apple item of a task it finds in Work while the item's list looks personal. The hub moves a list's
 * tasks when the space in effect changes (`applySpaces`), so a device on an older app that pairs or reports its
 * version finds them back in the account's own space before it reads them.
 */

export const SOURCE_KINDS = ["icloud", "local", "exchange", "caldav", "subscribed", "birthdays", "other"] as const;
export type SourceKind = typeof SOURCE_KINDS[number];
/** The first app version that knows the setting. */
export const SOURCES_MIN_VERSION = "1.0.18";
const APPLE_PLATFORMS = new Set(["iphone", "ipad", "mac"]);
const MAX_ENTRIES = 300;
const MAX_REPORT = 200;

type TaskSpace = "personal" | "work";

interface StoredList {
  key: string; title: string; account: string; kind: SourceKind;
  /** The account's own space, as the devices that see it report: Exchange, or the work email's domain, is Work. */
  work: boolean;
  /** Whether it was on when the hub first heard of it: a list with tasks, or one in iCloud or on the device itself. */
  default_on: boolean;
  /** The owner's choices; absent means the default. */
  on?: boolean;
  space?: TaskSpace;
  /** The space its tasks were last moved to (`applySpaces`); absent means the account's own. */
  applied?: TaskSpace;
  was?: string[];
  devices: string[];
  seen_at: string;
}
interface StoredCalendar {
  key: string; title: string; account: string; kind: SourceKind; color?: string;
  /** The owner's choice; absent means never chosen, which counts as not work. */
  work?: boolean;
  was?: string[];
  devices: string[];
  seen_at: string;
}
interface Stored {
  lists: StoredList[];
  new_tasks: string | null;
  calendars: StoredCalendar[];
  /** Devices whose own work calendar ticks were added to the set, once each. */
  moved: string[];
  contacts: { device: string | null };
}
const EMPTY: Stored = { lists: [], new_tasks: null, calendars: [], moved: [], contacts: { device: null } };

export interface SourcesView {
  lists: Array<{ key: string; title: string; account: string; kind: SourceKind; on: boolean; space: TaskSpace; work_default: boolean; wants?: TaskSpace; was?: string[]; devices: string[] }>;
  new_tasks: string | null;
  calendars: Array<{ key: string; title: string; account: string; kind: SourceKind; color?: string; work: boolean; hub_kept: boolean; devices: string[] }>;
  contacts: { device: string | null; name: string | null };
  /** iPhones, iPads and Macs that do not run `needs` yet: a Personal or Work choice waits for them. */
  waiting: Array<{ id: string; name: string; platform: string; version: string | null }>;
  needs: string;
}

const Key = z.string().min(3).max(300);
const Title = z.string().trim().min(1).max(160);
const Account = z.string().max(120);
const Kind = z.enum(SOURCE_KINDS);
const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const SeenList = z.object({ key: Key, title: Title, account: Account, kind: Kind, work: z.boolean(), has_tasks: z.boolean().optional(), was: Key.optional() });
const SeenCalendar = z.object({ key: Key, title: Title, account: Account, kind: Kind, color: Hex.optional(), was: Key.optional() });
const Seen = z.object({
  lists: z.array(SeenList).max(MAX_REPORT).optional(),
  calendars: z.array(SeenCalendar).max(MAX_REPORT).optional(),
  ticked: z.array(Key).max(MAX_REPORT).optional(),
});
const Change = z.object({
  lists: z.array(z.object({ key: Key, on: z.boolean().optional(), space: z.enum(["personal", "work"]).nullable().optional() })).max(MAX_ENTRIES).optional(),
  new_tasks: Key.nullable().optional(),
  calendars: z.array(z.object({ key: Key, work: z.boolean() })).max(MAX_ENTRIES).optional(),
  contacts: z.object({ device: z.string().min(1).max(64).nullable() }).optional(),
});

const problems = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");

/** A list never seen with tasks is on when it is in iCloud or on the device itself, and off in any other account. */
export function defaultOn(kind: SourceKind, hasTasks: boolean): boolean {
  return hasTasks || kind === "icloud" || kind === "local";
}

/** a is b or later (three-number versions); false when either is not one. */
export function versionAtLeast(a: string, b: string): boolean {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  if (x.length !== 3 || y.length !== 3 || [...x, ...y].some((n) => !Number.isInteger(n))) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return true;
}

const ownSpace = (l: { work: boolean }): TaskSpace => (l.work ? "work" : "personal");

export class SourcesStore {
  private cache: Stored | null = null;
  private filter: ((fields: Record<string, unknown>) => boolean) | null = null;
  private listeners = new Set<(view: SourcesView) => void>();
  /** The view the devices were last told, as text: an event goes out only when it differs. */
  private told: string | null = null;

  constructor(private file: string) {}

  get(): Stored {
    if (this.cache) return this.cache;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<Stored>;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("not an object");
      this.cache = {
        lists: Array.isArray(raw.lists) ? raw.lists : [],
        new_tasks: typeof raw.new_tasks === "string" ? raw.new_tasks : null,
        calendars: Array.isArray(raw.calendars) ? raw.calendars : [],
        moved: Array.isArray(raw.moved) ? raw.moved.filter((x): x is string => typeof x === "string") : [],
        contacts: { device: typeof raw.contacts?.device === "string" ? raw.contacts.device : null },
      };
    } catch (e) {
      // No file is the start. A damaged one is left on disk to mend and reads as nothing chosen, so nothing is hidden.
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") console.error(`[sources] sources.json could not be read (${errCode(e)}); every list counts as on`);
      this.cache = structuredClone(EMPTY);
    }
    return this.cache;
  }

  /** Written to a temp file and renamed over the old one, so a failed write never leaves half a file. */
  write(next: Stored): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
    this.cache = next;
    this.filter = null;
  }

  /** The lists as the rule for hidden tasks reads them. */
  sourceLists(): SourceList[] {
    return this.get().lists.map((l) => ({ key: l.key, title: l.title, on: l.on ?? l.default_on, ...(l.was?.length ? { was: l.was } : {}) }));
  }

  /** Whether a task shows in the app: false while it is in a Reminders list that is switched off. */
  shows(task: Entity): boolean {
    if (task.kind !== "task" || !task.fields.apple) return true;
    this.filter ??= taskFilter(this.sourceLists());
    return this.filter(task.fields);
  }

  onChange(f: (view: SourcesView) => void): () => void {
    this.listeners.add(f);
    return () => { this.listeners.delete(f); };
  }

  /** Tell the devices when the view is not what they were last told (a choice, a list seen, a device updated). */
  tell(view: SourcesView): void {
    const text = JSON.stringify(view);
    if (text === this.told) return;
    this.told = text;
    for (const f of this.listeners) { try { f(view); } catch (e) { console.error(`[sources] a listener failed: ${errCode(e)}`); } }
  }

  // ---- what the devices see ----

  /**
   * One device's report of the lists and calendars it sees. Each is added or brought up to date; the owner's choices
   * stay. A list or calendar the device named before and names no more is no longer one of its own, and one no
   * device has and nobody chose anything for is forgotten. `was` carries a choice over to a renamed list or account.
   * `ticked`: the calendars this device marked as work before the choice was one for all devices, added once.
   */
  seen(hub: Hub, device: string, body: unknown, now: Date = new Date()): void {
    const given = Seen.safeParse(body);
    if (!given.success) throw new StoreError(422, problems(given.error));
    const cur = this.get();
    const next: Stored = structuredClone(cur);
    const at = now.toISOString();

    if (given.data.lists) {
      const fresh = given.data.lists.filter((r) => !next.lists.some((l) => l.key === r.key) && !(r.was && next.lists.some((l) => l.key === r.was)));
      const withTasks = fresh.length ? listsWithTasks(hub) : null;
      const named = new Set<string>();
      for (const r of given.data.lists) {
        named.add(r.key);
        let l = next.lists.find((x) => x.key === r.key);
        if (!l && r.was) {
          // The same list under a new name (it or its account was renamed on the device): its choices move with it.
          l = next.lists.find((x) => x.key === r.was);
          if (l) {
            l.was = [...new Set([l.key, ...(l.was ?? [])])].slice(0, 5);
            if (next.new_tasks === l.key) next.new_tasks = r.key;
            l.key = r.key;
          }
        }
        if (!l) {
          const has = r.has_tasks === true || !!withTasks && (withTasks.keys.has(r.key) || withTasks.titles.has(r.title));
          l = { key: r.key, title: r.title, account: r.account, kind: r.kind, work: r.work, default_on: defaultOn(r.kind, has), devices: [], seen_at: at };
          next.lists.push(l);
        }
        Object.assign(l, { title: r.title, account: r.account, kind: r.kind, work: r.work, seen_at: at });
        if (!l.devices.includes(device)) l.devices.push(device);
      }
      for (const l of next.lists) if (!named.has(l.key)) l.devices = l.devices.filter((d) => d !== device);
      next.lists = next.lists.filter((l) => l.devices.length || l.on !== undefined || l.space !== undefined || l.applied !== undefined || next.new_tasks === l.key);
      trim(next.lists, (l) => l.on !== undefined || l.space !== undefined || l.applied !== undefined);
    }

    if (given.data.calendars) {
      const named = new Set<string>();
      for (const r of given.data.calendars) {
        named.add(r.key);
        let c = next.calendars.find((x) => x.key === r.key);
        if (!c && r.was) {
          c = next.calendars.find((x) => x.key === r.was);
          if (c) { c.was = [...new Set([c.key, ...(c.was ?? [])])].slice(0, 5); c.key = r.key; }
        }
        if (!c) { c = { key: r.key, title: r.title, account: r.account, kind: r.kind, devices: [], seen_at: at }; next.calendars.push(c); }
        Object.assign(c, { title: r.title, account: r.account, kind: r.kind, seen_at: at, ...(r.color ? { color: r.color.toUpperCase() } : {}) });
        if (!c.devices.includes(device)) c.devices.push(device);
      }
      for (const c of next.calendars) if (!named.has(c.key)) c.devices = c.devices.filter((d) => d !== device);
      next.calendars = next.calendars.filter((c) => c.devices.length || c.work !== undefined);
      trim(next.calendars, (c) => c.work !== undefined);
    }

    // The calendars this device had ticked as work before the choice was one for all devices: added once. A calendar
    // the owner already chose either way keeps that choice, and one the hub keeps in step itself is never work.
    if (given.data.ticked && !next.moved.includes(device)) {
      const kept = hubKeptTitles(hub);
      for (const key of given.data.ticked) {
        const c = next.calendars.find((x) => x.key === key);
        if (c && c.work === undefined && !isHubKept(c, kept)) c.work = true;
      }
      next.moved = [...next.moved, device].slice(-200);
    }

    if (JSON.stringify(next) !== JSON.stringify(cur)) this.write(next);
  }

  // ---- the owner's choices ----

  /** Merge the owner's choices: only the lists and calendars named change. Anything invalid refuses the whole body. */
  set(hub: Hub, body: unknown): void {
    const given = Change.safeParse(body);
    if (!given.success) throw new StoreError(422, problems(given.error));
    const next: Stored = structuredClone(this.get());

    for (const ch of given.data.lists ?? []) {
      const l = next.lists.find((x) => x.key === ch.key);
      if (!l) throw new StoreError(422, `lists: no Reminders list with the key ${ch.key.slice(0, 80)}`);
      if (ch.on !== undefined) l.on = ch.on;
      // A list set to Work is not synced while the work space is off, and its tasks could not move there.
      if (ch.space === "work" && !l.work && !hub.work.enabled) throw new StoreError(409, "Turn the work space on first (Settings, Accounts, Work): a list set to Work is not synced while it is off.");
      if (ch.space === null || ch.space === ownSpace(l)) delete l.space; else if (ch.space !== undefined) l.space = ch.space;
    }
    if (given.data.new_tasks !== undefined) next.new_tasks = given.data.new_tasks;
    if (next.new_tasks !== null) {
      const l = next.lists.find((x) => x.key === next.new_tasks);
      const usable = !!l && (l.on ?? l.default_on) && (l.space ?? ownSpace(l)) === "personal";
      // Asked for now: say why not. Made unusable by another change in this body (its list switched off): back to each
      // device's own default list.
      if (!usable && given.data.new_tasks) throw new StoreError(422, l ? "new_tasks: tasks made in Aeneas are personal, so they go to a list that is on and Personal" : "new_tasks: no Reminders list with that key");
      if (!usable) next.new_tasks = null;
    }

    if (given.data.calendars?.length) {
      const kept = hubKeptTitles(hub);
      for (const ch of given.data.calendars) {
        const c = next.calendars.find((x) => x.key === ch.key);
        if (!c) throw new StoreError(422, `calendars: no calendar with the key ${ch.key.slice(0, 80)}`);
        if (ch.work && isHubKept(c, kept)) throw new StoreError(422, `${c.title} is kept in step by your hub, so it cannot be a work calendar. Its events would come in twice.`);
        c.work = ch.work;
      }
    }

    if (given.data.contacts) {
      const id = given.data.contacts.device;
      if (id !== null) {
        const d = hub.store.get(id);
        if (!d || d.kind !== "device" || d.deleted_at || !APPLE_PLATFORMS.has(String(d.fields.platform))) throw new StoreError(422, "contacts: device is an iPhone, iPad or Mac paired with this hub, or null");
      }
      next.contacts = { device: id };
    }
    this.write(next);
  }

  /** Test hook: read the file again and forget what was told, so the next `tell` goes out. */
  reset(): void { this.cache = null; this.filter = null; this.told = null; }
}

/** At most MAX_ENTRIES: the longest unseen without a choice go first. */
function trim<T extends { seen_at: string }>(list: T[], chosen: (x: T) => boolean): void {
  while (list.length > MAX_ENTRIES) {
    const drop = list.filter((x) => !chosen(x)).sort((a, b) => a.seen_at.localeCompare(b.seen_at))[0] ?? list[0];
    list.splice(list.indexOf(drop), 1);
  }
}

/** The lists the hub's tasks are in: by key, and by name for tasks linked before lists had keys. */
function listsWithTasks(hub: Hub): { keys: Set<string>; titles: Set<string> } {
  const keys = new Set<string>(), titles = new Set<string>();
  for (const t of hub.store.list({ kind: "task", limit: 1_000_000 })) {
    const a = t.fields.apple as { id?: unknown; list_key?: unknown; list_title?: unknown } | undefined;
    if (!a || typeof a.id !== "string" || !a.id) continue;
    if (typeof a.list_key === "string" && a.list_key) keys.add(a.list_key);
    if (typeof a.list_title === "string" && a.list_title) titles.add(a.list_title);
  }
  return { keys, titles };
}

const plain = (s: string) => s.trim().toLowerCase();

/** The names of the iCloud calendars the hub keeps in step itself (calendar-sync.ts), while that module is on. */
function hubKeptTitles(hub: Hub): Set<string> {
  const out = new Set<string>();
  if (!hub.modules.on("calendars")) return out;
  try {
    for (const a of hub.connections.get().icloud ?? []) {
      if (!a.calendar || a.refused_at) continue;
      for (const c of a.calendar.calendars) if (a.calendar.chosen.includes(c.url)) out.add(plain(c.name));
    }
  } catch { /* connections.json unreadable: nothing counts as kept */ }
  return out;
}

/** Matched by account kind and name: a device has no way to say which iCloud address a calendar belongs to. */
const isHubKept = (c: { kind: SourceKind; title: string }, kept: Set<string>) => c.kind === "icloud" && kept.has(plain(c.title));

/** iPhones, iPads and Macs that do not run `min` (1.0.18 for this setting) or later, or never said which version they
 * run. Also what Alert from Apple Reminders waits for (alerts.ts). */
export function waitingDevices(hub: Hub, min: string = SOURCES_MIN_VERSION): SourcesView["waiting"] {
  return hub.devices.list()
    .filter((d) => APPLE_PLATFORMS.has(d.platform) && !(d.app && versionAtLeast(d.app.version, min)))
    .map((d) => ({ id: d.id, name: d.name, platform: d.platform, version: d.app?.version ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** The space a list's tasks are in now: the owner's choice once no device waits for an update, else the account's. */
function spaceInEffect(l: StoredList, waiting: boolean): TaskSpace {
  return l.space && !waiting ? l.space : ownSpace(l);
}

export function sourcesView(hub: Hub): SourcesView {
  const s = hub.sources.get();
  const waiting = waitingDevices(hub);
  const kept = hubKeptTitles(hub);
  const live = new Set(hub.devices.list().map((d) => d.id));
  const byName = <T extends { account: string; title: string; key: string }>(a: T, b: T) => a.account.localeCompare(b.account) || a.title.localeCompare(b.title) || a.key.localeCompare(b.key);
  const mirror = s.contacts.device ? hub.store.get(s.contacts.device) : null;
  const mirrorLive = !!mirror && mirror.kind === "device" && !mirror.deleted_at;
  return {
    lists: s.lists.map((l) => {
      const space = spaceInEffect(l, waiting.length > 0);
      return { key: l.key, title: l.title, account: l.account, kind: l.kind, on: l.on ?? l.default_on, space, work_default: l.work, ...(l.space && l.space !== space ? { wants: l.space } : {}), ...(l.was?.length ? { was: l.was } : {}), devices: l.devices.filter((d) => live.has(d)) };
    }).sort(byName),
    new_tasks: s.new_tasks,
    calendars: s.calendars.map((c) => {
      const hub_kept = isHubKept(c, kept);
      return { key: c.key, title: c.title, account: c.account, kind: c.kind, ...(c.color ? { color: c.color } : {}), work: c.work === true && !hub_kept, hub_kept, devices: c.devices.filter((d) => live.has(d)) };
    }).sort(byName),
    // A mirror device that was removed from the hub mirrors nothing: another device may take over.
    contacts: { device: mirrorLive ? s.contacts.device : null, name: mirrorLive ? String(mirror!.fields.name ?? "") || null : null },
    waiting,
    needs: SOURCES_MIN_VERSION,
  };
}

/** The tasks of a list: by its key (or one it had before a rename), else, for a task linked before lists had keys, by
 * its name when no other list has that name. */
function inList(t: Entity, l: StoredList, all: StoredList[]): boolean {
  const a = t.fields.apple as { list_key?: unknown; list_title?: unknown } | null | undefined;
  if (!a || typeof a !== "object") return false;
  if (typeof a.list_key === "string" && a.list_key) return a.list_key === l.key || (l.was ?? []).includes(a.list_key);
  return a.list_title === l.title && all.filter((x) => x.title === l.title).length === 1;
}

/**
 * Moves each list's tasks when the space in effect for it changed (a choice made, or a device on an older app paired
 * or said its version, which puts every list back in its account's own space): the tasks of the list that are in
 * the space it had move to the one it has now, each keeping its Apple link, as a move made in the app does (the
 * move's stamp is `field_ts.space`). Tasks moved one by one since are left alone. A move to Work waits while the work
 * space is off. Returns how many tasks moved.
 */
export function applySpaces(hub: Hub): number {
  const s = hub.sources.get();
  const waiting = waitingDevices(hub).length > 0;
  const moves = s.lists
    .map((l) => ({ l, from: l.applied ?? ownSpace(l), to: spaceInEffect(l, waiting) }))
    .filter((m) => m.from !== m.to && (m.to === "personal" || hub.work.enabled));
  if (!moves.length) return 0;
  const tasks = hub.store.list({ kind: "task", limit: 1_000_000 });
  let n = 0;
  const done = new Set<string>();
  for (const m of moves) {
    let ok = true;
    for (const t of tasks) {
      if (t.space !== m.from || !inList(t, m.l, s.lists)) continue;
      const last = t.field_ts.space;
      let ts = nowIso();
      if (last && last >= ts) ts = new Date(Date.parse(last) + 1).toISOString();
      try { hub.store.apply({ id: t.id, kind: "task", space: m.to, ts, fields: {} }); n++; }
      catch (e) { ok = false; console.error(`[sources] a task could not move with its list: ${errCode(e)}`); }
    }
    if (ok) done.add(m.l.key);
  }
  if (done.size) {
    const next = structuredClone(hub.sources.get());
    for (const l of next.lists) {
      if (!done.has(l.key)) continue;
      const to = spaceInEffect(l, waiting);
      if (to === ownSpace(l)) delete l.applied; else l.applied = to;
    }
    hub.sources.write(next);
  }
  if (n) console.log(`[sources] ${n} task(s) moved with their list's space`);
  return n;
}

/** After anything the view depends on changed (a choice, a report, a device's version, the hub's own calendars). */
export function tellSources(hub: Hub): void {
  try { hub.sources.tell(sourcesView(hub)); } catch (e) { console.error(`[sources] ${errCode(e)}`); }
}

let applying = false;
/** Move tasks whose list's space changed, then tell the devices. Safe to call from a change handler. */
export function sourcesChanged(hub: Hub): void {
  if (applying) return;
  applying = true;
  try { applySpaces(hub); } catch (e) { console.error(`[sources] ${errCode(e)}`); }
  finally { applying = false; }
  tellSources(hub);
}
