import fs from "node:fs";
import path from "node:path";
import { errCode } from "./logsafe.js";

/**
 * Modules: the parts of the app a person can switch on or off, one setting for every device (Settings, Modules and
 * the Welcome page). The core (Today, Assistant, Capture, Search, Unsorted Info, Tasks, Week, Notes, Memory, People,
 * Lists) is always on. A module that is off is hidden on every device, its background jobs stop, its assistant tools
 * and filing lines are left out, and its hub routes answer 404. Its data is kept: switching it back on shows it again.
 */
export const MODULE_IDS = [
  "voice", "notifications", "apple_reminders", "apple_calendar", "contacts",
  "renewals", "dashboard", "homelab", "projects", "music", "wiki", "images", "quiz",
  "health", "pet", "food", "sensors", "games", "films", "calc", "jobs", "layouts", "mail", "web",
] as const;
export type ModuleId = (typeof MODULE_IDS)[number];

/** What a device asks the person for, once, right after setup or when the module is switched on: never at launch. */
export const PERMISSIONS = ["microphone", "speech", "notifications", "reminders", "calendar", "contacts", "health", "photos", "location"] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** A module that needs more than a sign-in: the person makes their own key or app, with a guide (release rule 3). */
export interface AdvancedSetup {
  /** About how long it takes, in minutes ("2", "10 to 15"). */
  minutes: string;
  /** What they make, as a phrase: "your own Steam key, for playtime". */
  needs: string;
}

export interface ModuleDef {
  id: ModuleId;
  title: string;
  /** One line on what it does, shown next to its switch. */
  summary: string;
  /** A short scene of the module in use, for the info button during setup. */
  example?: string;
  /** The personal data it reads and where from, shown in setup so the choice is an informed one. */
  reads?: string;
  /** What each device asks for while it is on (Apple apps; the web app needs none). */
  permissions?: Permission[];
  /** Set when part of it needs the person's own key or app. */
  setup?: AdvancedSetup;
  /** The Library area it sits in (Assistant: something the assistant may do, not a screen; On your devices: a device feature with no screen of its own). */
  group: "On your devices" | "Plan" | "Homelab" | "Making" | "Body and home" | "Life admin" | "Assistant";
  /** On for a new hub. */
  default: boolean;
  /**
   * A feature that was always on before it became a module: on for a hub whose modules.json predates it, so an
   * update never turns off something the owner used. New hubs get `default` (or the choice made in setup).
   */
  wasCore?: boolean;
  /** Hub routes that answer only while it is on: a path equal to one or under it. */
  prefixes: string[];
  /** Entity kinds that belong to it: the assistant creates none of them while it is off. */
  kinds: string[];
}

export const MODULES: ModuleDef[] = [
  { id: "voice", title: "Voice", summary: "Speak a capture or a question on iPhone, iPad, Mac and Watch instead of typing.", example: "Walking the dog, you hold the Watch up and say \"remember to call the vet Thursday\". It lands in Capture as text, and the assistant files it.", reads: "The microphone, only from when you tap the mic until you tap it again. Speech becomes text on the device itself where it can; a device that cannot uses Apple's speech service, and says so before the first time.", permissions: ["microphone", "speech"], group: "On your devices", default: true, wasCore: true, prefixes: [], kinds: [] },
  { id: "notifications", title: "Reminder alerts", summary: "Reminders and the morning summary show up on your devices at their time.", example: "At 8 in the morning your phone shows today's plan, and at 3 it nudges you about the renewal you set a reminder for.", reads: "Nothing: it only shows alerts.", permissions: ["notifications"], group: "On your devices", default: true, wasCore: true, prefixes: [], kinds: [] },
  { id: "apple_reminders", title: "Apple Reminders", summary: "Your tasks also show in Apple Reminders, and what you change there comes back.", example: "You tick off \"buy filters\" in Apple Reminders on your Mac, and it's done in Aeneas too.", reads: "The Reminders lists on your iPhone, iPad or Mac.", permissions: ["reminders"], group: "On your devices", default: false, wasCore: true, prefixes: [], kinds: [] },
  { id: "apple_calendar", title: "Apple Calendar", summary: "Events from the calendars you pick, so the planner works around them, and your plan back in Calendar.", example: "You have a dentist appointment at 2. When you ask for a plan for the afternoon, the assistant works around it.", reads: "Event titles and times from the calendars you pick on your iPhone, iPad or Mac.", permissions: ["calendar"], group: "On your devices", default: false, wasCore: true, prefixes: [], kinds: [] },
  { id: "contacts", title: "Contacts", summary: "Names, birthdays and details from your contacts, kept with People.", example: "You ask \"when is Sam's birthday?\" and the assistant knows, because it came in from your contacts.", reads: "Your contacts on your iPhone, iPad or Mac.", permissions: ["contacts"], group: "On your devices", default: false, wasCore: true, prefixes: [], kinds: [] },
  { id: "renewals", title: "Renewals and bills", summary: "Things to renew or that charge you (domains, memberships, subscriptions), with a reminder before each.", example: "Your domain renews on March 3 for $15. You get a reminder a week before, and the assistant can tell you what you pay each year.", group: "Plan", default: true, prefixes: ["/watches", "/finance"], kinds: ["watch"] },
  { id: "dashboard", title: "Dashboard", summary: "Charts of anything you track, on one board shared by your devices.", example: "You log your weight and sleep. One board shows both as charts, on your phone and your computer.", group: "Plan", default: false, prefixes: ["/prefs/dashboard"], kinds: [] },
  { id: "homelab", title: "Homelab", summary: "Monitors for your machines and services, fix notes, a change journal, snippets, and commands the assistant runs on the machines you add: commands that only read run at once, anything that changes a machine waits for your approval.", example: "You ask \"why is the NAS slow?\" The assistant checks disk use and load on it right away, then asks before restarting anything.", reads: "The state of the machines you add, and the output of commands you approve. Logins come from your password manager and are never shown to the model.", group: "Homelab", default: false, prefixes: ["/ops", "/monitors", "/incidents", "/hosts", "/ai/hosts", "/snippets", "/runbooks", "/preflight", "/ledgers", "/connections/password-manager"], kinds: ["runbook", "journal", "snippet", "monitor", "incident"] },
  { id: "projects", title: "Projects", summary: "Projects with a plan, parts against your inventory, and step-by-step procedures.", example: "Building a guitar pedal: the plan, the parts list checked against what you have in your drawers, and the soldering steps in order.", group: "Making", default: false, prefixes: ["/projects", "/procedures"], kinds: ["project", "procedure", "inventory"] },
  { id: "music", title: "Music", summary: "Riffs, progressions, lyrics and song ideas.", example: "A melody pops into your head. You hum it into your phone, and it's saved with the chords you were thinking of.", reads: "The microphone, only while you record a hum.", permissions: ["microphone"], group: "Making", default: false, prefixes: ["/music"], kinds: ["music_idea"] },
  { id: "wiki", title: "Project wiki", summary: "A read-only copy of a Confluence space or a repository's docs that the assistant can search.", example: "Your team's docs live in Confluence. You ask \"how do we rotate the API keys?\" and the assistant answers from them.", reads: "The Confluence spaces or repository folders you pick.", setup: { minutes: "10", needs: "your own Atlassian app, for Confluence, and the hub reached through Tailscale (Atlassian returns only to an https name)" }, group: "Making", default: false, prefixes: ["/wiki", "/connections/atlassian"], kinds: [] },
  { id: "images", title: "Images", summary: "Make pictures with your image server and keep them in a gallery.", example: "You ask for \"a cozy cabin in snow, watercolor\" and the picture appears in your gallery, made on your own image server.", reads: "Only the pictures you pick. Pictures you save go to your photo library.", permissions: ["photos"], group: "Making", default: false, prefixes: ["/images"], kinds: ["image"] },
  { id: "quiz", title: "Recall quiz", summary: "A short daily quiz on what you saved, to keep it in memory.", example: "Each morning, three quick questions about things you saved last week, so they stick.", group: "Making", default: false, prefixes: ["/quiz"], kinds: ["quiz"] },
  { id: "health", title: "Health", summary: "Weight, sleep, blood pressure, medication and other logs, with Apple Health on iPhone.", example: "You ask \"has my sleep been worse since I started the new medication?\" and get an answer from your own logs.", reads: "The Apple Health types you allow on your iPhone (weight, sleep, heart rate, steps and others).", permissions: ["health"], group: "Body and home", default: false, prefixes: ["/health", "/imports/health"], kinds: [] },
  { id: "pet", title: "Pet", summary: "Your pet's walks, meals, vet visits and handoffs.", example: "You walk the dog at 7. Your partner sees it was done and doesn't walk her again.", group: "Body and home", default: false, prefixes: ["/pets"], kinds: ["pet_event"] },
  { id: "food", title: "Food", summary: "Places and meals to pick from when you cannot decide.", example: "Neither of you can decide on dinner. It picks from your saved places and meals, skipping what you had this week.", group: "Body and home", default: false, prefixes: ["/food"], kinds: ["food_option"] },
  { id: "sensors", title: "Sensors", summary: "Readings from home sensors and your machines (temperature, disk space) with alerts.", example: "The garage freezer's sensor reads 15 \u00b0F too warm and your phone alerts you before the food spoils.", reads: "Readings your sensor boards send to the hub, and disk and temperature readings from the machines you add under Homelab, Machines (the hub signs in to each one over SSH every 10 minutes).", group: "Body and home", default: false, prefixes: ["/sensors"], kinds: ["sensor", "reading"] },
  { id: "games", title: "Games", summary: "Your game library (Steam) and a pick for what to play.", example: "You have an hour free. It suggests a game from your Steam library you haven't touched in a while.", reads: "Your Steam games and playtime, from your Steam profile.", setup: { minutes: "2", needs: "your own Steam key, for playtime" }, group: "Life admin", default: false, prefixes: ["/games", "/library/games", "/connections/steam"], kinds: ["game"] },
  { id: "films", title: "Films", summary: "Films you watched and want to watch (Letterboxd).", example: "You ask \"what was that film I wanted to see with the lighthouse?\" and it finds it in your watchlist.", reads: "Your public Letterboxd diary.", group: "Life admin", default: false, prefixes: ["/library/films", "/connections/letterboxd"], kinds: ["film"] },
  { id: "calc", title: "Calculators", summary: "Take-home pay, loan payoff, bill splits and unit conversions.", example: "You're weighing a raise: it shows the take-home pay after taxes, and how fast it pays off your car loan.", reads: "Your approximate location, only if you allow it, to fill in your state's meals tax. The iPhone, iPad and Mac find it on the device and send it, rounded, only to your hub. In a browser and the Windows app, the browser finds it, which can ask Google's or Microsoft's location service.", permissions: ["location"], group: "Life admin", default: false, prefixes: ["/calc"], kinds: [] },
  { id: "jobs", title: "Job search", summary: "Job applications by stage, with cover letters drafted in your voice.", example: "You track five applications by stage, and the assistant drafts a cover letter that sounds like you.", group: "Life admin", default: false, prefixes: ["/applications", "/library/applications"], kinds: ["application"] },
  { id: "layouts", title: "Layout sketches", summary: "Move, resize or take away parts of a picture of any screen to show how you want it laid out.", example: "You want the Today screen rearranged. You drag and resize parts of a screenshot to show it, instead of describing it.", group: "Making", default: false, prefixes: ["/layouts"], kinds: [] },
  { id: "mail", title: "Mail receipts", summary: "Receipts, renewal notices and vet mail from Gmail, filed as renewals and pet visits.", example: "A renewal notice arrives in Gmail. It's filed as a renewal with its date and price, without you touching it.", reads: "Gmail messages that look like receipts, renewals or vet mail, read by your own model. The mail itself is not kept.", setup: { minutes: "10 to 15", needs: "your own Google app, and the hub reached through Tailscale (Google returns only to an https name)" }, group: "Life admin", default: false, wasCore: true, prefixes: ["/connections/google"], kinds: [] },
  { id: "web", title: "Web lookups", summary: "The assistant searches the web and reads pages to answer what it does not know.", example: "You ask \"what time does the hardware store close today?\" The assistant looks it up through Tor and answers.", reads: "Searches go to DuckDuckGo, Brave, Mwmbl and Wikipedia through your hub's own search server, and the hub fetches the pages it reads, all only through Tor: the engines and sites see the words searched and a Tor address, never your home one. If Tor is not set up on the hub, lookups stay off. Captures are never searched.", group: "Assistant", default: false, wasCore: true, prefixes: [], kinds: [] },
];

const BY_ID = new Map(MODULES.map((m) => [m.id, m]));
const KIND_MODULE = new Map(MODULES.flatMap((m) => m.kinds.map((k) => [k, m.id] as const)));

export function isModuleId(id: unknown): id is ModuleId { return typeof id === "string" && BY_ID.has(id as ModuleId); }
export function moduleDef(id: ModuleId): ModuleDef { return BY_ID.get(id)!; }
/** The module an entity kind belongs to, or null for a core kind. */
export function moduleOfKind(kind: string): ModuleId | null { return KIND_MODULE.get(kind) ?? null; }

/** The module that owns a hub path, or null for the core. The longest prefix wins. */
export function moduleOfPath(p: string): ModuleId | null {
  let best: { id: ModuleId; len: number } | null = null;
  for (const m of MODULES) {
    for (const pre of m.prefixes) {
      if ((p === pre || p.startsWith(pre + "/")) && (!best || pre.length > best.len)) best = { id: m.id, len: pre.length };
    }
  }
  return best?.id ?? null;
}

export type ModuleCheck = (id: ModuleId) => boolean;
export interface ModuleView { id: ModuleId; title: string; summary: string; example?: string; group: string; on: boolean; reads?: string; permissions?: Permission[]; setup?: AdvancedSetup }

/**
 * `<data>/modules.json`: `{ "<id>": true|false }`. A module missing from the file has its default. The file is written
 * the first time the hub starts: a hub that already holds the owner's things (captures, tasks, events or logs) starts
 * with every module on, so an update never hides what someone used; a new hub starts with the defaults, or with
 * `EA_MODULES` (`all`, or a comma list of ids) when that is set.
 */
export class ModuleStore {
  private cache: Record<string, boolean> | null = null;
  private listeners = new Set<(on: ModuleId[], off: ModuleId[]) => void>();

  constructor(private file: string, private start: { existing: () => boolean; preset: string }) {}

  private read(): Record<string, boolean> {
    if (this.cache) return this.cache;
    let damaged: string | null = null;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, unknown>;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("not an object");
      this.cache = Object.fromEntries(Object.entries(raw).filter(([k, v]) => isModuleId(k) && typeof v === "boolean")) as Record<string, boolean>;
      return this.cache;
    } catch (e) {
      // Only a missing file is a first start. A damaged or unreadable one keeps the owner's choices on disk to mend:
      // it is never overwritten here, and every module counts as on meanwhile so nothing they use disappears.
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") damaged = errCode(e);
    }
    if (damaged) {
      console.error(`[modules] ${this.file} could not be read (${damaged}); every module counts as on until it is fixed or a switch is changed`);
      this.cache = Object.fromEntries(MODULES.map((m) => [m.id, true]));
      return this.cache;
    }
    const preset = this.start.preset.trim().toLowerCase();
    const all = preset === "all" || (!preset && this.start.existing());
    const listed = new Set(preset && preset !== "all" ? preset.split(/[\s,]+/).filter(Boolean) : []);
    const first = Object.fromEntries(MODULES.map((m) => [m.id, all || (preset ? listed.has(m.id) : m.default)]));
    // A folder that cannot be written must not stop the hub (this runs inside job timers): the choice holds in memory.
    try { this.write(first); } catch (e) { console.error(`[modules] could not save ${this.file}: ${errCode(e)}`); this.cache = first; }
    return this.cache!;
  }

  private write(v: Record<string, boolean>): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(v, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.cache = v;
  }

  on(id: ModuleId): boolean {
    const v = this.read()[id];
    if (typeof v === "boolean") return v;
    // Missing from a file written before this module existed: a feature that was always on stays on.
    const def = moduleDef(id);
    return def.wasCore ? true : def.default;
  }

  /** A checker bound to this store, for code that only needs to ask. */
  readonly check: ModuleCheck = (id) => this.on(id);

  list(): ModuleView[] {
    return MODULES.map((m) => ({
      id: m.id, title: m.title, summary: m.summary, example: m.example, group: m.group, on: this.on(m.id),
      ...(m.reads ? { reads: m.reads } : {}), ...(m.permissions ? { permissions: m.permissions } : {}), ...(m.setup ? { setup: m.setup } : {}),
    }));
  }

  /** Switch modules on or off: `{ "<id>": true|false }`. Unknown ids and non-booleans are refused. */
  set(changes: Record<string, unknown>): { on: ModuleId[]; off: ModuleId[] } {
    const next = { ...Object.fromEntries(MODULES.map((m) => [m.id, this.on(m.id)])) } as Record<string, boolean>;
    const on: ModuleId[] = [];
    const off: ModuleId[] = [];
    for (const [k, v] of Object.entries(changes)) {
      if (!isModuleId(k)) throw new Error(`no module named ${k}; known: ${MODULE_IDS.join(", ")}`);
      if (typeof v !== "boolean") throw new Error(`${k} must be true or false`);
      if (next[k] === v) continue;
      next[k] = v;
      (v ? on : off).push(k);
    }
    if (on.length || off.length) {
      this.write(next);
      for (const f of this.listeners) f(on, off);
    }
    return { on, off };
  }

  /** Called after modules change (the seed for ones switched on, a note to connected devices). */
  onChange(f: (on: ModuleId[], off: ModuleId[]) => void): () => void {
    this.listeners.add(f);
    return () => { this.listeners.delete(f); };
  }
}
