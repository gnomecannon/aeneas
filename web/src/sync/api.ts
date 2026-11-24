import type { Entity, Patch } from "@everythingapp/shared";
import type { Commitment, PlannerDay, PlannerToday, PlannerWeek } from "../lib/planner";
import type { HostSummary, SessionClose } from "../lib/memory";
import type { ProjectSummary } from "../lib/creative";
import type { CheckRow, OpsData } from "../lib/ops";
import type { Feel, FeelView } from "../feel/prefs";
import type { Board, DashboardPrefs, MetricInfo, Series, Tile } from "../lib/dashboard";
import type { WikiHit, WikiIndex, WikiPage } from "../lib/wiki";
import type { BundleDelivery, CustomBundle, FolderMail, FoldNote, SearchHit, UnsubscribeOptions, MailAttachment, MailBlocked, MailMovedTo, MoveTarget, MailDraft, MailDraftRequest, MailGreeting, MailList, MailNotify, MailMessage, MailMoved, MailRefresh, SnoozeTimes, TriageAnswer } from "../lib/mail";
import { listAsSent } from "../lib/mail";
import { directBase, hubFetch, isDirect } from "./direct";
import type { JoinRequest } from "./join";

/** GET /feeds: keys that open one door each (the calendar feed, sensor readings). */
export interface FeedKeysView { calendar: { key: string; path: string }; sensors: { key: string; path: string } }

/** What a device asks for while a module is on (Apple apps; the web app needs none). */
export type ModulePermission = "microphone" | "speech" | "notifications" | "reminders" | "calendar" | "contacts" | "health" | "photos" | "location";

/**
 * A part of the app the owner switches on or off (GET /modules). `group` is its Library area, "Assistant", or "On your
 * devices". `reads` says what personal data it reads; `setup` marks a part that needs the person's own key or app.
 */
export interface ModuleInfo {
  id: string; title: string; summary: string; example?: string; group: string; on: boolean;
  reads?: string; permissions?: ModulePermission[]; setup?: { minutes: string; needs: string };
  /** Where its switch is when not in Settings, Modules: `connections` (Apple Reminders, on the iCloud account). */
  switch_in?: "connections";
  /**
   * The module it is shown under in Settings, Modules, as a sub-option with its own switch (since 2026-11-24:
   * Receipts and renewals under Mail). Shown only: each works with the other off. Absent on older hubs.
   */
  under?: string;
}

/**
 * A kind of alert the owner switches on or off on its own (GET /modules, `alerts`): a reminder, the morning summary,
 * new mail and so on. `module` is the module it belongs to; the entry is left out of lists while that module is off.
 */
export interface AlertInfo { id: string; title: string; summary: string; module?: string; on: boolean }

/** Every device has its own key (`ead1_...`); anything else is the hub's main key. */
export const DEVICE_KEY_PREFIX = "ead1_";
export const isDeviceKey = (k: string | undefined | null): boolean => !!k && k.startsWith(DEVICE_KEY_PREFIX);

/** POST /devices/pairing: a one-time code (10 minutes) and the links that carry it. */
export interface PairingLinks { hub: string; code: string; expires_at: string; app: string; web: string; link?: LinkMethod | null; node?: string | null }
export type LinkMethod = "direct" | "tailscale" | "home";
export interface DirectStatus { state: "off" | "starting" | "online" | "error"; id?: string; relay?: string; relay_by?: string; error?: string; /** After a failed start: when the hub tries again. */ retry_at?: string; connected: number; direct: number }
export interface LinkView {
  method: LinkMethod | null; options: Record<LinkMethod, { available: boolean; how?: string }>; direct: DirectStatus;
  /** The addresses a web browser opens the web app at (each ending `/app/`). Newer hubs (since 2026-11-23). */
  browser?: string[];
  /** A Direct link hub's door for browsers on the tailnet (hub/src/tsdoor.ts). Newer hubs (since 2026-11-23). */
  tailscale_door?: TailscaleDoor;
}
export interface TailscaleDoor { available: boolean; on: boolean; url: string | null; how?: string; error?: string }
/** GET /hub-update: what the hub runs, what is newer (after a check) and how the last update went (hub/src/update.ts). */
export interface HubUpdateRun { state: "starting" | "checking" | "installing" | "restarting" | "rolling_back" | "done" | "up_to_date" | "rolled_back" | "failed"; message: string; from: string | null; to: string | null; at: string }
export interface HubUpdateInfo {
  installed_with_git: boolean; follows_owner?: string; commit: string | null; committed_at: string | null; branch: string; checked_at: string | null; latest: string | null;
  behind: number; changes: { commit: string; title: string; at: string }[]; local_changes: boolean; can_update: boolean; reason?: string;
  last_run: HubUpdateRun | null; running: boolean;
}
/** GET /hubs: other people's hubs on this machine (deploy/people.sh), as the owner's hub sees them. */
export interface PersonHub { name: string; account: string; port: number; color: string; owner: boolean; address: string | null; up: boolean }
export interface HubsList { available: boolean; reason?: "linux_only" | "not_set_up" | "not_owner"; setup_command: string; admin_note: string; hubs: PersonHub[] }
/** Someone who helps this person with their devices (hub/src/helpers.ts; docs/helpers.md). */
export interface Helper { id: string; name: string; state: "offered" | "active" | "stopped"; offered_at: string; accepted_at?: string; stopped_at?: string; stopped_by?: "person" | "helper" }
export interface HelperLogLine { id: string; at: string; helper: string; kind: string; device: string | null; text: string; detail: string | null; outcome: string | null }
export interface HelperComputer { device_id: string; name: string; os: "windows" | "macos" | "linux"; on: boolean; at: string; listening: boolean }
export interface HomeDevice { name: string; ip: string; open: number[]; kind?: string }
export interface HomeScan { at: string; by: string; network?: string; devices: HomeDevice[] }
/** GET /helpers: the person's own view of who helps them. */
export interface HelpersView {
  helpers: Helper[];
  log: HelperLogLine[];
  passwords: { title: string; username: string; device?: string }[];
  computers: HelperComputer[];
  scan: HomeScan | null;
  this_device: { device_id: string; agent: HelperComputer | null } | null;
}
/** GET /helping/people: the machine owner's people, each with whether the owner helps them. */
export interface HelpView {
  account: string; name: string; state: "waiting" | "helping" | "stopped" | "unreachable" | "not_sent"; offered_at: string;
  computers: { device_id: string; name: string; os: string; listening: boolean }[];
  scan: HomeScan | null;
  passwords: { title: string; username: string }[];
}
export interface AgentJob {
  id: string; device_id: string; command: string; os: "windows" | "macos" | "linux"; timeout_s: number; created_at: string;
  /** Run on another device in the home, signed in over SSH from this computer (helper.rs ssh_helper_command). */
  ssh?: { ip: string; port: number; username: string; password: string; host_key?: string };
}

/** GET /hubs/requests/:id: adding a person (or a new code, or stopping a hub) as it goes. */
export interface HubRequest {
  state: "queued" | "working" | "done" | "failed";
  step?: string; error?: string; name?: string; color?: string; address?: string; account?: string; note?: string;
  pairing?: Partial<PairingLinks>;
}
/** GET /devices. */
export interface DeviceRow {
  id: string; name: string; platform: string; last_seen: string | null; paired_at: string | null; own_key: boolean; current: boolean;
  /** What app and version it runs, once it has said (apps from 1.0.5 on); older hubs leave these out. */
  app?: DeviceApp | null;
  app_update?: AppUpdateAsk | null;
  outlook?: UpdateOutlook;
}

/** CONTRACT, App updates. */
export type AppKind = "windows" | "android" | "web" | "ios" | "ipados" | "macos" | "watchos";
export interface DeviceApp { kind: AppKind; version: string; build?: string }
export interface AppUpdateAsk { requested_at: string; version: string; by?: string; declined_at?: string }
/** current, self (installs the hub's copy), store (App Store or TestFlight), reload (a browser), unknown (sends no version). */
export type UpdateOutlook = "current" | "self" | "store" | "reload" | "unknown";
export type AppPlatform = "windows" | "android";
export interface HubAppFile {
  platform: AppPlatform; version: string; state: "missing" | "fetching" | "ready" | "unpublished" | "failed"; file: string;
  size?: number; sha256?: string; signature?: string; error?: string; at?: string;
}
export interface AppUpdatesView {
  version: string;
  repo: string;
  apps: Record<AppPlatform, HubAppFile>;
  devices: (DeviceRow & { outlook: UpdateOutlook })[];
  you: { device_id: string; app: DeviceApp | null; request: AppUpdateAsk | null } | null;
}
/** The services with a guided setup (hub/src/guides.ts). */
export type OwnKeyService = "google" | "atlassian" | "steam" | "icloud";
/**
 * The only routes a guide's fields are ever sent to, whatever path a guide names: a hub (or anything posing as one)
 * cannot have a key or password typed into a guide sent anywhere else.
 */
export const OWN_KEY_SAVE = /^\/connections\/(google\/app|atlassian\/app|steam\/key|icloud)$/;
/** GET /connections/guides/:service: making the person's own key or app, step by step, filled in for this hub. */
export interface OwnKeyGuide {
  service: "google" | "atlassian" | "steam"; title: string; minutes: string; done: boolean; after: string; warning: string | null;
  steps: Array<{
    title: string; text: string; copy?: Array<{ label: string; value: string }>; link?: { label: string; url: string };
    fields?: Array<{ id: string; label: string; secret: boolean; placeholder?: string }>; save?: { method: "PUT"; path: string }; test?: { path: string };
  }>;
}
/** GET /setup/backup: backups and the recovery key that opens them. */
export interface BackupStatus { encrypted: boolean; recipient: string; recovery_saved: boolean; backups: number; disk: { encrypted: boolean | null; detail: string } }

/** Layout sketches (module `layouts`): a picture of a screen with parts moved, resized, taken away or added. */
export interface LayoutRect { x: number; y: number; w: number; h: number }
export interface LayoutPiece { id: string; from: LayoutRect | null; to: LayoutRect | null; label?: string; note?: string }
export type LayoutPlatform = "iphone" | "ipad" | "mac" | "watch" | "windows" | "web" | "other";
export type LayoutStatus = "draft" | "ready" | "done";
export interface Layout {
  id: string; title: string; platform: LayoutPlatform; screen: string; status: LayoutStatus;
  picture_id: string; width: number; height: number; after_id: string | null; note: string;
  pieces: LayoutPiece[]; created_at: string; updated_at: string; deleted_at?: string | null;
}
export type LayoutSummary = Omit<Layout, "pieces" | "deleted_at"> & { pieces_count: number };

export interface HubConfig {
  hubUrl: string;
  token: string;
}

/** A request to the shared image service. Unset fields use its defaults; set ones are requirements (refused, never changed). */
export interface ImageRequest {
  prompt: string; operation?: "generate" | "edit"; references?: string[]; width?: number; height?: number; aspect?: string;
  realism?: "from_prompt" | number; seamless?: "off" | "x" | "y" | "xy"; transparent?: boolean; quality?: "auto" | "fast" | "best";
  /** "auto", or one of the hub's image workers (`hardware` in capabilities). */
  hardware?: string; count?: number; seed?: number; exact_prompt?: boolean;
}
export interface ImagePlan {
  workflow: string; output: { width: number; height: number }; generation?: { width: number; height: number; crop?: unknown };
  prompt_original: string; prompt_expanded: string; prompt_adapted: boolean; routing_reason: string; notes: string[]; seed?: number; queue_reason?: string | null;
}
export interface ImageJob {
  id: string; status: "queued" | "running" | "succeeded" | "failed" | "canceled"; status_label: string; reason: string | null; progress: number | null;
  error: string | null; image_id?: string; plan: ImagePlan; request?: ImageRequest; measured?: { worker?: string; total_seconds?: number } | null;
}
/** An image service worker one may pick by hand, as the hub names it (EA_IMAGE_WORKERS). */
export interface ImageWorker { id: string; label: string }
export interface ImageCapabilities { enabled: boolean; unavailable_features?: Record<string, string>; hardware?: ImageWorker[] }

/** One machine the hub may reach (hosts.json): a name, and optionally an SSH target, OS, local flag and other names. */
export interface HubMachine { name: string; ssh?: string; os?: string; local?: boolean; aliases?: string[] }

export class HubError extends Error {
  status: number;
  detail: unknown;
  constructor(status: number, message: string, detail?: unknown) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

export type FetchLike = typeof fetch;

export function normalizeHubUrl(u: string): string {
  let s = u.trim();
  if (!s) return s;
  // A Direct link hub (iroh://<hub key>?relay=...) stays as it is.
  if (isDirect(s)) return s;
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  return s.replace(/\/+$/, "");
}

/** Linked accounts as the hub reports them (no secrets: the Steam key shows as its last four characters). */
export interface Connections {
  /** `hub_key`: the hub has its own Steam Web API key (members never need one); sign-in works only then. */
  steam: { connected: false; hub_key: boolean } | { connected: true; hub_key: boolean; steam_id: string; persona: string | null; profile_url: string | null; last_sync: string | null; last_error: string | null; games: number };
  letterboxd: { connected: false } | { connected: true; username: string; last_sync: string | null; last_error: string | null; films: number };
  health: { last_import: string | null; samples: number; total: number };
  /** Confluence through Sign in with Atlassian. `app`: the hub has its own Atlassian app; sign-in works only then. Absent on older hubs. */
  atlassian?: AtlassianConnection;
  /** Gmail, read-only, one entry per linked mailbox. `app`: the hub has its own Google app; sign-in works only then. Absent on older hubs. */
  google?: GoogleConnection;
  /** iCloud Mail, read-only, one entry per mailbox linked with an app-specific password (never sent back). Absent on older hubs. */
  icloud?: ICloudConnection;
  /** Other mail accounts for the Mail screen (Gmail or any IMAP server), linked with an app password (never sent back). Absent on older hubs. */
  imap?: ImapConnection;
  /** Internet Accounts: every linked account once, with what it can do and what is on. Absent on older hubs. */
  internet?: InternetAccount[];
  /** LastPass or 1Password through its CLI, for secrets in the assistant's commands. Absent on older hubs. */
  password_manager?: PasswordManagerView;
}

export interface SetupAi { ollama: { url: string; model: string } | null; openai: { url: string; model: string; key_set: boolean } | null; anthropic: { model: string; key_set: boolean } | null }
export interface SetupView { owner: string; named: boolean; ai: SetupAi; model_ready: boolean; password_manager: boolean; note?: string }
export interface SetupDetect {
  platform: string;
  gpus: Array<{ name: string; vram_mib: number; kind: "nvidia" | "apple" | "amd" }>;
  recommended: { model: string; size_gb: number; why: string; license?: string };
  /** System memory and whether no usable graphics card was found (newer hubs). */
  memory_mib?: number;
  cpu_only?: boolean;
  servers: Array<{ kind: "ollama" | "openai"; label: string; url: string; models: string[] }>;
  current: SetupAi;
  /** Where downloaded models go, chosen during setup, and its free space (newer hubs; null when Ollama was already there). */
  models_dir?: { path: string; free_gb: number | null; missing: boolean } | null;
}
export interface ImportJob {
  id: string; name: string; kinds: string[]; state: "waiting" | "reading" | "learning" | "done" | "failed" | "stopped"; learn: boolean;
  created_at: string; finished_at: string | null; counts: { notes: number; people: number; tasks: number; facts: number; skipped: number };
  learned: { done: number; total: number }; detail: string; error: string | null;
}
export interface PullState { model: string; status: string; completed: number; total: number; done: boolean; error: string | null }
export type PasswordManagerProvider = "lastpass" | "1password" | "bitwarden" | "keepass";
export interface KeePassEntry { title: string; username: string; url: string; notes: string; fields: string[] }
/**
 * `access`: "all" (every item except `excluded`: names, Folder/Name, or a folder ending in "/") or "chosen" (only
 * `allowed`). Older hubs send neither, which means chosen.
 */
export interface PasswordManagerView { linked: boolean; provider: PasswordManagerProvider | null; host: string | null; account: string | null; allowed: string[]; access?: "all" | "chosen"; excluded?: string[] }
export interface PasswordManagerStatus { host: string; provider: PasswordManagerProvider | null; installed: Record<PasswordManagerProvider, boolean>; signed_in: boolean; account: string | null; install_hint: string | null }

export interface GoogleConnection {
  app: boolean;
  /** Waiting mail is being read now (after Read now). Absent on older hubs. */
  reading?: boolean;
  /** Local times the waiting mail is read when no game is on the GPU, and why a read is waiting, if it is. */
  times?: string[];
  waiting_for_gpu?: string | null;
  accounts: GmailAccount[];
}

/** iCloud Mail mailboxes: the same counts as Gmail's. Reading state and times are Gmail's (`google`), shared by both. */
export interface ICloudConnection {
  accounts: GmailAccount[];
}
/** Other mail accounts (GET /connections `imap`): where each is and who signs in, never the password. */
export interface ImapAccountView { email: string; preset: "gmail" | "imap"; host: string; port: number; user: string; linked_at: string; last_error: string | null }
export interface ImapConnection {
  accounts: ImapAccountView[];
}
/**
 * One account in Internet Accounts: iCloud, Google signed in with Google (receipts only), Gmail with an app password, or
 * another IMAP server. A feature is null when the account cannot do it; `receipts` holds what receipts came to.
 */
export interface InternetAccount {
  key: string;
  kind: "icloud" | "google" | "gmail" | "imap";
  email: string;
  host?: string;
  port?: number;
  user?: string;
  linked_at: string;
  last_sync: string | null;
  last_error: string | null;
  features: { inbox: boolean | null; receipts: boolean | null; calendars: boolean | null };
  /** The hub writes nothing to it (since 2026-11-24; a Google sign-in can only read). Absent on older hubs. */
  read_only?: boolean;
  receipts?: Pick<GmailAccount, "listed" | "to_read" | "read" | "failed" | "filed">;
}
/** Linking another mail account: Gmail (the hub fills in the server) or any IMAP server over TLS. */
export type ImapLink = { email: string; password: string; user?: string } & ({ preset: "gmail" } | { preset: "imap"; host: string; port?: number });

/** Calendar sync on the hub (Calendar accounts): an iCloud address, its calendars and the one new events go to. */
export interface CalendarAccount {
  email: string;
  /** Receipts and renewals reads this address too. */
  mail: boolean;
  /** Read only: its calendars are read and never written; new events stay in the app. Absent on older hubs. */
  read_only?: boolean;
  calendars: { url: string; name: string; color?: string; writable: boolean; chosen: boolean }[];
  target: string | null;
  last_sync: string | null;
  last_error: string | null;
}
export interface CalendarSyncView { accounts: CalendarAccount[]; active: boolean }

/** A linked mailbox and what its mail came to: messages listed, still to read, and the records filed from them. */
export interface GmailAccount {
  email: string;
  linked_at: string;
  last_sync: string | null;
  last_error: string | null;
  listed: number;
  to_read: number;
  read: number;
  failed: number;
  filed: { renewals: number; pet: number; events: number };
}

/**
 * Confluence. `expired`: Atlassian ended the sign-in (refused its refresh token); the link, its spaces and its pages
 * stay until Reconnect (the same sign-in) or Unlink. Absent on older hubs.
 */
export type AtlassianConnection =
  | { connected: false; app: boolean }
  | { connected: true; app: true; site_name: string; site_url: string; spaces: string[]; last_sync: string | null; last_error: string | null; pages: number; expired?: boolean };

export interface AtlassianSpace {
  key: string;
  name: string;
  type: string;
  mirrored: boolean;
}

export interface ConfluenceSync {
  spaces: number;
  pages: number;
  updated: number;
  removed: number;
  images: number;
}

/** Half a megabyte: the size of each piece of an app installer passed on as it downloads. */
const PIECE = 512 * 1024;

export class HubClient {
  cfg: HubConfig;
  fetchImpl: FetchLike;
  constructor(cfg: HubConfig, fetchImpl: FetchLike = hubFetch as FetchLike) {
    this.cfg = cfg;
    this.fetchImpl = fetchImpl;
  }

  url(path: string): string {
    // A Direct link hub: iroh://<hub key><path>, which hubFetch sends over the app's Direct link.
    return (directBase(this.cfg.hubUrl) ?? normalizeHubUrl(this.cfg.hubUrl)) + path;
  }

  headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.cfg.token}`, ...extra };
  }

  async req<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const res = await this.fetchImpl(this.url(path), {
      method,
      headers: this.headers(body !== undefined ? { "Content-Type": "application/json" } : {}),
      body: body !== undefined ? JSON.stringify(body) : undefined,
      // A hung request must not leave sync stuck "in progress" forever.
      signal: signal ?? (typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(180_000) : undefined),
    });
    if (!res.ok) {
      let msg = `${res.status}`;
      let detail: unknown;
      try {
        const j = await res.json();
        msg = j.error ?? msg;
        // The hub puts some details beside `error` rather than in `detail` (a schedule clash comes as `conflict`).
        const { error: _e, detail: d, ...rest } = (j ?? {}) as Record<string, unknown>;
        detail = d !== undefined ? d : Object.keys(rest).length ? rest : undefined;
      } catch {
        /* no body */
      }
      throw new HubError(res.status, msg, detail);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** `{ ok }` for anyone; the version, sequence and model details only with a valid key, so the key goes along. */
  health(signal?: AbortSignal) {
    const headers = this.cfg.token ? this.headers() : undefined;
    return this.fetchImpl(this.url("/health"), { signal, headers }).then(async (r) => {
      if (!r.ok) throw new HubError(r.status, `health ${r.status}`);
      return (await r.json()) as { ok: boolean; version?: string; time?: string; db_seq?: number; ai?: AiCapabilities; hub?: { name: string | null; color: string | null } };
    });
  }

  register(name: string, platform: string) {
    return this.req<{ device_id: string }>("POST", "/devices/register", { name, platform });
  }

  /** Trade a one-time pairing code for this device's own key (no key needed: the code is the credential). */
  claim(code: string, name: string, platform: string, deviceId?: string) {
    return this.req<{ device_id: string; key: string; name: string; version: string }>("POST", "/devices/claim", { code, name, platform, ...(deviceId ? { device_id: deviceId } : {}) });
  }
  /** A device holding the hub's main key trades it for its own, keeping its id. */
  exchange(name: string, platform: string, deviceId?: string) {
    return this.req<{ device_id: string; key: string; name: string }>("POST", "/devices/exchange", { name, platform, ...(deviceId ? { device_id: deviceId } : {}) });
  }
  devices() {
    return this.req<{ devices: DeviceRow[] }>("GET", "/devices");
  }
  /** Which app and version this is, once a start (PUT /devices/me/app); 404 on hubs before 1.0.5. */
  reportApp(app: DeviceApp) {
    return this.req<{ app: DeviceApp; hub_version: string }>("PUT", "/devices/me/app", app);
  }
  /** The hub's copy of the Windows and Android apps, every device's app and version, and an update asked of this one. */
  appUpdates(signal?: AbortSignal) {
    return this.req<AppUpdatesView>("GET", "/app-updates", undefined, signal);
  }
  /** Has the hub fetch this platform's installer from its release, when it has not yet. */
  prepareApp(platform: AppPlatform) {
    return this.req<HubAppFile>("POST", `/app-updates/${platform}/prepare`);
  }
  /** The installer, as the hub keeps it, handed to `onPiece` as it arrives (never held whole). Returns the bytes read. */
  async appFile(platform: AppPlatform, onPiece: (bytes: Uint8Array) => Promise<void>): Promise<number> {
    const res = await this.fetchImpl(this.url(`/app-updates/${platform}/file`), { headers: this.headers() });
    if (!res.ok) {
      let msg = `${res.status}`;
      try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* not JSON */ }
      throw new HubError(res.status, msg);
    }
    const reader = res.body?.getReader?.();
    if (!reader) {
      const all = new Uint8Array(await res.arrayBuffer());
      for (let i = 0; i < all.length; i += PIECE) await onPiece(all.subarray(i, i + PIECE));
      return all.length;
    }
    // Small network reads are gathered into pieces of about half a megabyte before they go on.
    let held: Uint8Array[] = [];
    let heldBytes = 0;
    let total = 0;
    const pass = async () => {
      if (!heldBytes) return;
      const piece = new Uint8Array(heldBytes);
      let at = 0;
      for (const p of held) { piece.set(p, at); at += p.byteLength; }
      held = []; heldBytes = 0;
      await onPiece(piece);
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      held.push(value);
      heldBytes += value.byteLength;
      total += value.byteLength;
      if (heldBytes >= PIECE) await pass();
    }
    await pass();
    return total;
  }
  /** Ask devices to update (every device when `ids` is left out); each one is answered with what happens. */
  requestAppUpdates(ids?: string[]) {
    return this.req<{ version: string; devices: { id: string; name: string; app: DeviceApp | null; result: UpdateOutlook | "requested" }[] }>("POST", "/app-updates/request", ids ? { devices: ids } : {});
  }
  /** This device's Not now to an update asked of it. */
  declineAppUpdate() {
    return this.req<{ declined: boolean }>("POST", "/app-updates/request/decline");
  }
  /** Remove a device: its key stops working at once. */
  removeDevice(id: string) {
    return this.req<{ removed: string }>("DELETE", `/devices/${encodeURIComponent(id)}`);
  }
  /** Every way to this hub now (GET /link/routes), as the hub sent it: route.ts `parseRoutes` checks it. */
  linkRoutes(signal?: AbortSignal) {
    return this.req<unknown>("GET", "/link/routes", undefined, signal);
  }

  changes(since: number, signal?: AbortSignal, deviceId?: string) {
    const dev = deviceId ? `&device_id=${encodeURIComponent(deviceId)}` : "";
    return this.req<{ changes: Array<{ seq: number; entity: Entity }>; seq: number; more: boolean; reset?: boolean }>(
      "GET",
      `/sync/changes?since=${since}${dev}`,
      undefined,
      signal,
    );
  }

  /** Hub status; 404 on hubs without the route (the caller shows "not available on this hub"). */
  status() {
    return this.req<HubStatus>("GET", "/status");
  }

  proof(days = 14) {
    return this.req<ProofRun>("GET", `/metrics/proof?days=${days}`);
  }

  remindersDue(withinMinutes: number) {
    return this.req<{ reminders: Entity[] }>("GET", `/reminders/due?within=${withinMinutes}`);
  }

  /** Module 1: the day plan with its digest; 404 on hubs without the planner. */
  plannerToday() {
    // Preference and info rules come in their own list; the screens (and the offline model) keep every rule in
    // `commitments` and draw each by its type, so focus windows and a custody week showed only offline.
    return this.req<PlannerToday & { preferences?: Commitment[] }>("GET", "/planner/today").then(withPreferences);
  }

  plannerWeek(start: string, minHours = 3) {
    return this.req<PlannerWeek>("GET", `/planner/week?start=${encodeURIComponent(start)}&min_hours=${minHours}`)
      .then((w) => ({ ...w, days: w.days.map((d) => withPreferences(d as PlannerDay & { preferences?: Commitment[] })) }));
  }

  /** 409 (HubError with `detail` = the conflicting block, event, commitment or blackout) unless `force`. */
  plannerSchedule(task_id: string, start: string, hours = 3, force = false) {
    return this.req<Entity>("POST", "/planner/schedule", { task_id, start, hours, force });
  }

  plannerUnschedule(task_id: string) {
    return this.req<Entity>("POST", "/planner/unschedule", { task_id });
  }

  watchRenewed(id: string) {
    return this.req<Entity>("POST", `/watches/${encodeURIComponent(id)}/renewed`, {});
  }

  /** Module 2: hosts derived from runbooks, journal entries, snippets and `host:` facts. */
  hosts() {
    return this.req<HostSummary[]>("GET", "/hosts");
  }

  /** The assistant's destructive-command check for a command typed by hand (the journal form). */
  preflight(text: string) {
    return this.req<PreflightCheck>("POST", "/preflight", { text });
  }

  runbooks(host?: string) {
    return this.req<Entity[]>("GET", `/runbooks${host ? `?host=${encodeURIComponent(host)}` : ""}`);
  }

  /** 422 (HubError with `detail` = the missing names) when a param without a default is empty. */
  snippetRender(id: string, params: Record<string, string>) {
    return this.req<{ text: string }>("POST", `/snippets/${encodeURIComponent(id)}/render`, { params });
  }

  /** Run a snippet on a host to try it. Read-only snippets run at once; one that changes something is a 409. */
  snippetRun(id: string, params: Record<string, string>, host?: string) {
    return this.req<{ host: string; command: string; exit_code: number | null; output: string }>("POST", `/snippets/${encodeURIComponent(id)}/run`, { params, ...(host ? { host } : {}) });
  }

  sessionClose(id: string, body: { outcome: "fixed" | "abandoned" | "parked"; note?: string; host?: string; project_id?: string }) {
    return this.req<SessionClose>("POST", `/ai/sessions/${encodeURIComponent(id)}/close`, body);
  }

  ledgers(open = true) {
    return this.req<Entity[]>("GET", `/ledgers${open ? "?open=true" : ""}`);
  }

  patchEntity(id: string, fields: Record<string, unknown>) {
    return this.req<Entity>("PATCH", `/entities/${encodeURIComponent(id)}`, { fields });
  }

  log(body: { type: string; value: number | string; unit?: string; at?: string; note?: string }) {
    return this.req<Entity>("POST", "/log", body);
  }

  // ---------- Module 4: body, home and animals ----------
  healthSummary(days = 30) {
    return this.req<HealthSummary>("GET", `/health/summary?days=${days}`);
  }

  injectionDay(body: { name: string; weekday: string; time: string }) {
    return this.req<Entity>("POST", "/health/injection-day", body);
  }

  petSummary(pet: string) {
    return this.req<PetSummary>("GET", `/pets/${encodeURIComponent(pet)}/summary`);
  }

  /** The hub returns sensor entities (settings under `fields`) plus `series_24h`; flatten to one row each. */
  async sensors(): Promise<SensorRow[]> {
    const rows = await this.req<Array<{ id: string; fields: Record<string, unknown>; series_24h: SeriesPoint[] }>>("GET", "/sensors");
    return rows.map((r) => ({ ...(r.fields as Omit<SensorRow, "id" | "series_24h">), id: r.id, series_24h: r.series_24h ?? [] }));
  }

  /** The CSV body as text; the caller turns it into a download. */
  /** Tapping an alert: the hub starts (or reopens) a chat where the assistant proposes a fix to approve or cancel. */
  sensorPropose(name: string) {
    return this.req<{ session_id: string; started: boolean }>("POST", `/sensors/${encodeURIComponent(name)}/propose`, {});
  }

  async sensorCsv(name: string, days = 30): Promise<string> {
    const res = await this.fetchImpl(this.url(`/sensors/${encodeURIComponent(name)}/csv?days=${days}`), { headers: this.headers() });
    if (!res.ok) throw new HubError(res.status, `csv ${res.status}`);
    return res.text();
  }

  foodPick(body: { meal: "lunch" | "dinner" | "snack"; mode?: string; budget?: number; exclude?: string[] }) {
    return this.req<FoodPick>("POST", "/food/pick", body);
  }

  foodPicked(id: string) {
    return this.req<Entity>("POST", "/food/picked", { id });
  }

  // ---------- Module 5: creative and builds ----------
  projectSummary(id: string) {
    return this.req<ProjectSummary>("GET", `/projects/${encodeURIComponent(id)}/summary`);
  }

  /** Upserts the living plan note; log lines are appended, never replaced. Returns the note. */
  projectPlan(id: string, sections: { goal?: string; current?: string; next?: string; parts?: string; log_line?: string }) {
    return this.req<Entity>("POST", `/projects/${encodeURIComponent(id)}/plan`, { sections });
  }

  procedureFromText(body: { text: string; title?: string; host?: string; project_id?: string }) {
    return this.req<Entity>("POST", "/procedures/from-text", body);
  }

  /** `step`: the index of the step on screen; the hub ignores a request for a step it has already moved past. */
  procedureAdvance(id: string, body: { done?: true; back?: true; step?: number }) {
    return this.req<Entity>("POST", `/procedures/${encodeURIComponent(id)}/advance`, body);
  }

  procedureReset(id: string) {
    return this.req<Entity>("POST", `/procedures/${encodeURIComponent(id)}/reset`, {});
  }

  music(type?: string, status?: string) {
    const q = [type ? `type=${encodeURIComponent(type)}` : "", status ? `status=${encodeURIComponent(status)}` : ""].filter(Boolean).join("&");
    return this.req<Entity[]>("GET", `/music${q ? `?${q}` : ""}`);
  }

  /** One line becomes a music idea; with a project, in that project (Music's Projects page). */
  musicQuick(text: string, projectId?: string) {
    return this.req<Entity>("POST", "/music/quick", projectId ? { text, project_id: projectId } : { text });
  }

  quizToday() {
    return this.req<Entity | null>("GET", "/quiz/today");
  }
  /** Make today's quiz from today's chats now (it uses the model, so only when asked). Null when there is nothing to ask. */
  quizBuild() {
    return this.req<Entity | null>("POST", "/quiz/build", {});
  }
  /** Notes waiting for tags and links, and whether they are being read now. */
  notesLinking() {
    return this.req<{ waiting: number; running: boolean }>("GET", "/notes/link");
  }
  notesLinkNow() {
    return this.req<{ waiting: number; running: boolean }>("POST", "/notes/link", {});
  }

  quizAnswer(id: string, index: number, result: "right" | "wrong" | "revealed") {
    return this.req<Entity>("POST", `/quiz/${encodeURIComponent(id)}/answer`, { index, result });
  }

  // ---------- Module 6: Tech (machines, checks and sensors) ----------
  /** The ops board; 404 on hubs without monitors. */
  ops() {
    return this.req<OpsData>("GET", "/ops");
  }

  /** A check that is down: the hub starts (or reopens) a chat where the assistant proposes a fix to approve or cancel. */
  monitorPropose(id: string) {
    return this.req<{ session_id: string; started: boolean }>("POST", `/monitors/${encodeURIComponent(id)}/propose`, {});
  }

  /** Runs the check now; returns the updated monitor. */
  monitorCheck(id: string) {
    return this.req<Entity>("POST", `/monitors/${encodeURIComponent(id)}/check`, {});
  }

  monitorHistory(id: string, hours = 24) {
    return this.req<CheckRow[]>("GET", `/monitors/${encodeURIComponent(id)}/history?hours=${hours}`);
  }

  /** Acknowledges an incident; with a note the hub also writes a journal entry and links it. */
  incidentAck(id: string, note?: string) {
    return this.req<Entity>("POST", `/incidents/${encodeURIComponent(id)}/ack`, note ? { note } : {});
  }

  // ---------- Module 7: life admin ----------
  checklistInstantiate(id: string, title?: string) {
    return this.req<Entity>("POST", `/checklists/${encodeURIComponent(id)}/instantiate`, title ? { title } : {});
  }

  checklistToggle(id: string, index: number) {
    return this.req<Entity>("POST", `/checklists/${encodeURIComponent(id)}/toggle`, { index });
  }

  /** 422 (HubError, `detail` names the employers the draft invented) or 503 `no model`. */
  coverLetter(id: string, body: { job_text?: string; tone?: string }) {
    return this.req<{ note: Entity; backend: string }>("POST", `/applications/${encodeURIComponent(id)}/cover-letter`, body);
  }

  connections() {
    return this.req<Connections>("GET", "/connections");
  }
  /** The hub's own Steam Web API key, set once by whoever runs the hub. */
  setSteamKey(apiKey: string) {
    return this.req<unknown>("PUT", "/connections/steam/key", { api_key: apiKey });
  }
  /** Start Sign in through Steam: Steam's sign-in page, which returns to this hub. */
  steamSignIn(client: "web" | "apple") {
    return this.req<{ url: string }>("POST", "/connections/steam/signin", { hub: this.url(""), client });
  }
  syncSteam() {
    return this.req<{ games: number; created: number; updated: number }>("POST", "/connections/steam/sync", {});
  }
  disconnectSteam() {
    return this.req<unknown>("DELETE", "/connections/steam");
  }
  connectLetterboxd(username: string) {
    return this.req<{ sync: { entries: number; created: number; updated: number } }>("PUT", "/connections/letterboxd", { username });
  }
  syncLetterboxd() {
    return this.req<{ entries: number; created: number; updated: number }>("POST", "/connections/letterboxd/sync", {});
  }
  disconnectLetterboxd() {
    return this.req<unknown>("DELETE", "/connections/letterboxd");
  }
  /** The hub's own Atlassian app (developer.atlassian.com), set once by whoever runs the hub. */
  setAtlassianApp(clientId: string, clientSecret: string) {
    return this.req<unknown>("PUT", "/connections/atlassian/app", { client_id: clientId, client_secret: clientSecret });
  }
  /** Start Sign in with Atlassian: Atlassian's consent page, which returns to this hub. */
  atlassianSignIn(client: "web" | "apple") {
    return this.req<{ url: string }>("POST", "/connections/atlassian/signin", { hub: this.url(""), client });
  }
  atlassianSpaces() {
    return this.req<{ spaces: AtlassianSpace[] }>("GET", "/connections/atlassian/spaces");
  }
  setAtlassianSpaces(keys: string[]) {
    return this.req<{ connection: unknown; sync: ConfluenceSync }>("PUT", "/connections/atlassian/spaces", { keys });
  }
  syncConfluence() {
    return this.req<ConfluenceSync>("POST", "/connections/atlassian/sync", {});
  }
  disconnectAtlassian() {
    return this.req<unknown>("DELETE", "/connections/atlassian");
  }
  /** The hub's own Google app (Google Cloud console, OAuth client for a web application), set once by whoever runs the hub. */
  setGoogleApp(clientId: string, clientSecret: string) {
    return this.req<unknown>("PUT", "/connections/google/app", { client_id: clientId, client_secret: clientSecret });
  }
  /** Start Sign in with Google for one more mailbox: Google's account chooser, which returns to this hub. */
  googleSignIn(client: "web" | "apple") {
    return this.req<{ url: string }>("POST", "/connections/google/signin", { hub: this.url(""), client });
  }
  /** List every linked mailbox (or the one account named by its key) for new mail now; the hub files it in the background. */
  readMailNow(account?: string) {
    return this.req<Record<string, { listed: number; queued: number } | { error: string }>>("POST", "/connections/google/sync", account ? { account } : {});
  }
  /** List every linked mailbox now, from the iCloud Mail panel (the same as readMailNow). */
  icloudReadNow() {
    return this.req<Record<string, { listed: number; queued: number } | { error: string }>>("POST", "/connections/icloud/sync", {});
  }

  /** Link another mail account for the Mail screen; the hub checks it with the server once. */
  linkImap(link: ImapLink) {
    return this.req<ImapConnection>("PUT", "/connections/imap", link);
  }
  /**
   * Switch what an account does: `inbox` (shown in Mail) and `receipts` (read for Receipts and renewals). Switching off
   * the last thing it does removes the account, password and all: the answer then has `removed` and the hub's
   * `message`.
   */
  setAccountFeatures(key: string, body: { inbox?: boolean; receipts?: boolean; read_only?: boolean }) {
    return this.req<{ inbox: boolean; receipts: boolean; read_only?: boolean; removed?: boolean; message?: string }>("PUT", `/connections/accounts/${encodeURIComponent(key)}`, body);
  }
  /**
   * Remove an account whole, of any kind, by its `key` (an InternetAccount's): its calendars stop syncing, its mail
   * leaves the Mail screen, what waited to be read for receipts is dropped, and its password is deleted from the hub.
   * `message` says what was done, and what is left to do at the provider. The one way the app removes an account:
   * done in steps (calendars stopped, then the mailbox unlinked), the second step failed once the first had removed it.
   */
  removeAccount(key: string) {
    return this.req<{ message: string }>("DELETE", `/connections/accounts/${encodeURIComponent(key)}`);
  }

  /** Calendar sync on the hub. */
  calendarSync() {
    return this.req<CalendarSyncView>("GET", "/calendars");
  }
  /** Keep an iCloud address's calendars in step; the password may be left out when Receipts and renewals has it. */
  linkCalendars(email: string, password?: string) {
    return this.req<CalendarSyncView>("PUT", "/calendars/icloud", { email, ...(password ? { password } : {}) });
  }
  chooseCalendars(email: string, choice: { chosen?: string[]; target?: string | null }) {
    return this.req<CalendarSyncView>("PUT", `/calendars/icloud/${encodeURIComponent(email)}`, choice);
  }
  syncCalendarsNow() {
    return this.req<CalendarSyncView & { results: { account: string; error?: string }[] }>("POST", "/calendars/sync", {});
  }
  stopCalendars(email: string) {
    return this.req<CalendarSyncView & { message: string }>("DELETE", `/calendars/icloud/${encodeURIComponent(email)}`);
  }

  /** The machines the hub runs commands on. */
  aiHosts() {
    return this.req<{ hosts: Array<{ name: string; os: string; local: boolean }> }>("GET", "/ai/hosts");
  }
  passwordManagerStatus(provider?: PasswordManagerProvider, host?: string) {
    const q = new URLSearchParams({ ...(provider ? { provider } : {}), ...(host ? { host } : {}) }).toString();
    return this.req<PasswordManagerStatus>("GET", `/connections/password-manager/status${q ? `?${q}` : ""}`);
  }
  linkPasswordManager(provider: PasswordManagerProvider, host: string) {
    return this.req<PasswordManagerView>("PUT", "/connections/password-manager", { provider, host });
  }
  /** LastPass: email, master password and code go to `lpass login` on the hub's host and are not kept. 1Password: a service account token. */
  signInPasswordManager(body: { email?: string; password?: string; code?: string; token?: string; server?: string }) {
    return this.req<PasswordManagerStatus>("POST", "/connections/password-manager/signin", body);
  }
  unlinkPasswordManager() {
    return this.req<PasswordManagerView>("DELETE", "/connections/password-manager");
  }
  passwordManagerItems(q: string) {
    return this.req<{ items: string[] }>("GET", `/connections/password-manager/items?q=${encodeURIComponent(q)}`);
  }
  allowPasswordManagerItems(names: string[]) {
    return this.req<PasswordManagerView>("PUT", "/connections/password-manager/allowed", { names });
  }
  /** Every item except the excluded ones, or only the chosen ones. */
  setPasswordManagerAccess(body: { access?: "all" | "chosen"; excluded?: string[] }) {
    return this.req<PasswordManagerView>("PUT", "/connections/password-manager/access", body);
  }
  /** Hum to MIDI: a WAV recording becomes a music idea at once; its melody, rhythm, key and tempo follow by sync. */
  async hum(wav: Blob, opts: { bpm?: number; title?: string; projectId?: string; fromCapture?: boolean; clientId?: string }): Promise<Entity> {
    const q = new URLSearchParams();
    // One id per take: sent again after a cut-off upload, the hub returns the idea it already made.
    if (opts.clientId) q.set("client_id", opts.clientId);
    if (opts.bpm) q.set("bpm", String(opts.bpm));
    if (opts.title) q.set("title", opts.title);
    if (opts.projectId) q.set("project_id", opts.projectId);
    if (opts.fromCapture) q.set("from", "capture");
    const res = await this.fetchImpl(this.url(`/music/hum?${q}`), { method: "POST", headers: this.headers({ "Content-Type": "audio/wav" }), body: wav });
    if (!res.ok) {
      let msg = `${res.status}`;
      try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* not JSON */ }
      throw new HubError(res.status, msg);
    }
    return (await res.json()) as Entity;
  }
  /** Hear a hummed idea's recording again, at a set tempo or a found one. */
  rehearHum(id: string, body: { bpm?: number }) {
    return this.req<Entity>("POST", `/music/${encodeURIComponent(id)}/rehear`, body);
  }
  /** The idea's notes as a .mid file, snapped to the 1/16 grid or as hummed, with the hub's file name. */
  async musicMidi(id: string, grid: boolean, use?: "melody" | "rhythm" | "both"): Promise<{ blob: Blob; name: string }> {
    const q = new URLSearchParams();
    if (!grid) q.set("grid", "off");
    if (use) q.set("use", use);
    const res = await this.fetchImpl(this.url(`/music/${encodeURIComponent(id)}/midi${q.size ? `?${q}` : ""}`), { headers: this.headers() });
    if (!res.ok) {
      let msg = `${res.status}`;
      try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* not JSON */ }
      throw new HubError(res.status, msg);
    }
    const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "hum.mid";
    return { blob: await res.blob(), name };
  }
  /** The kept recording of a hummed idea. */
  async musicAudio(id: string): Promise<Blob> {
    const res = await this.fetchImpl(this.url(`/music/${encodeURIComponent(id)}/audio`), { headers: this.headers() });
    if (!res.ok) throw new HubError(res.status, `recording ${res.status}`);
    return res.blob();
  }
  /** Bring a past in: upload an export or a file (streamed, no time limit), with or without learning facts from it. */
  async uploadImport(file: Blob, name: string, learn: boolean): Promise<ImportJob> {
    const res = await this.fetchImpl(this.url(`/imports/upload?name=${encodeURIComponent(name)}${learn ? "&learn=1" : ""}`), { method: "POST", headers: this.headers({ "Content-Type": "application/octet-stream" }), body: file });
    if (!res.ok) {
      let msg = `${res.status}`;
      try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* not JSON */ }
      throw new HubError(res.status, msg);
    }
    return (await res.json()) as ImportJob;
  }
  importText(title: string, text: string, learn: boolean) {
    return this.req<ImportJob>("POST", "/imports/text", { title, text, learn });
  }
  importJobs() {
    return this.req<{ jobs: ImportJob[] }>("GET", "/imports/jobs");
  }
  stopImport(id: string) {
    return this.req<ImportJob>("POST", `/imports/jobs/${encodeURIComponent(id)}/stop`);
  }
  /** First-run setup: who the hub belongs to and whether a model is chosen. */
  setup() {
    return this.req<SetupView>("GET", "/setup");
  }
  setupDetect() {
    return this.req<SetupDetect>("GET", "/setup/detect");
  }
  /** Use a model: a local Ollama or OpenAI-compatible server, or a cloud one with its key. Applied at once. */
  setupAi(body: { kind: "ollama" | "openai" | "anthropic"; url?: string; model?: string; key?: string }) {
    return this.req<SetupView>("PUT", "/setup/ai", body);
  }
  removeSetupAi(kind: "ollama" | "openai" | "anthropic") {
    return this.req<SetupView>("DELETE", `/setup/ai/${kind}`);
  }
  pullModel(model: string) {
    return this.req<PullState>("POST", "/setup/ollama/pull", { model });
  }
  pullState() {
    return this.req<{ pull: PullState | null }>("GET", "/setup/ollama/pull");
  }
  /** A one-time code and the links that set up another device in one step (and the address it reaches the hub at). */
  hubUpdate() { return this.req<HubUpdateInfo>("GET", "/hub-update"); }
  checkHubUpdate() { return this.req<HubUpdateInfo>("POST", "/hub-update/check"); }
  startHubUpdate() { return this.req<{ started: true; run: HubUpdateRun }>("POST", "/hub-update"); }
  hubs() { return this.req<HubsList>("GET", "/hubs"); }
  /** The machine owner's people with whether the owner helps each one (404 on hubs before 1.0.6). */
  helpingPeople() { return this.req<{ people: (PersonHub & { help: HelpView | null })[] }>("GET", "/helping/people"); }
  offerHelp(account: string) { return this.req<{ request_id: string }>("POST", `/helping/${encodeURIComponent(account)}`); }
  stopHelping(account: string) { return this.req<{ stopped: boolean }>("DELETE", `/helping/${encodeURIComponent(account)}`); }
  /** This person's helpers, what they did, the passwords saved for them and this person's computers. */
  helpers() { return this.req<HelpersView>("GET", "/helpers"); }
  acceptHelper(id: string) { return this.req<Helper>("POST", `/helpers/${encodeURIComponent(id)}/accept`); }
  stopHelper(id: string) { return this.req<Helper>("POST", `/helpers/${encodeURIComponent(id)}/stop`); }
  saveHelperPassword(item: { title: string; username?: string; password: string; device?: string }) { return this.req<{ title: string; username: string }>("PUT", "/helpers/passwords", item); }
  removeHelperPassword(title: string) { return this.req<{ removed: string }>("DELETE", `/helpers/passwords/${encodeURIComponent(title)}`); }
  sendHomeScan(scan: { network?: string; devices: HomeDevice[] }) { return this.req<HomeScan>("POST", "/helpers/scan", scan); }
  /** Whether this computer lets its helper run things on it (the app's agent). */
  setAgent(a: { on: boolean; os: string; name: string }) { return this.req<HelperComputer>("PUT", "/agent/me", a); }
  /** Work for this computer: waits up to `waitS` seconds for some. */
  agentJobs(waitS: number, signal?: AbortSignal) { return this.req<{ jobs: AgentJob[]; helping: boolean }>("GET", `/agent/jobs?wait=${waitS}`, undefined, signal ?? (typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout((waitS + 20) * 1000) : undefined)); }
  finishAgentJob(id: string, r: { exit_code: number; output: string; host_key?: string }) { return this.req<{ ok: boolean }>("POST", `/agent/jobs/${encodeURIComponent(id)}`, r); }
  addHub(name: string, color?: string) { return this.req<{ request_id: string }>("POST", "/hubs", { name, ...(color ? { color } : {}) }); }
  hubRequest(id: string) { return this.req<HubRequest>("GET", `/hubs/requests/${encodeURIComponent(id)}`); }
  pairHub(account: string) { return this.req<{ request_id: string }>("POST", `/hubs/${encodeURIComponent(account)}/pair`); }
  stopHub(account: string) { return this.req<{ request_id: string }>("POST", `/hubs/${encodeURIComponent(account)}/stop`); }

  link() { return this.req<LinkView>("GET", "/setup/link"); }
  setLink(method: LinkMethod) { return this.req<LinkView>("PUT", "/setup/link", { method }); }
  /** The Tailscale door: 409 with Tailscale's reason in a plain sentence (or `how` when it is not available). */
  setTailscaleDoor(on: boolean) { return this.req<LinkView>("PUT", "/setup/link", { tailscale_door: on }); }

  /**
   * Joining a new device with this one's yes (CONTRACT, Devices): the hub reaches it over Direct link and hands it a
   * pairing link. Up to about 100 seconds; `state: "sent"` when it took the link but had not paired within a minute.
   */
  joinDevice(j: JoinRequest) {
    const signal = typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(110_000) : undefined;
    return this.req<{ device_id: string; name: string } | { name: string; state: "sent" }>("POST", "/devices/join", j, signal);
  }

  pairing(name: string) {
    return this.req<PairingLinks>("POST", "/devices/pairing", { name });
  }
  /** Use the model that fits this machine: chosen, and downloaded when it is not there yet, in one step. */
  setupModelAuto(model?: string) {
    return this.req<{ pull?: PullState | null; ai?: SetupAi; note?: string }>("POST", "/setup/model/auto", model ? { model } : {});
  }
  ownKeyGuide(service: OwnKeyService) {
    return this.req<OwnKeyGuide>("GET", `/connections/guides/${service}`);
  }
  /** The guide's last step: its fields, to the route the hub named (only its own /connections routes). */
  ownKeySave(path: string, body: Record<string, string>) {
    if (!OWN_KEY_SAVE.test(path)) throw new Error("not a setup route");
    return this.req<unknown>("PUT", path, body);
  }
  ownKeyTest(path: string) {
    if (!/^\/connections\/google\/app\/test$/.test(path)) throw new Error("not a check route");
    return this.req<{ ok: boolean; message: string }>("POST", path, {});
  }
  backupStatus() {
    return this.req<BackupStatus>("GET", "/setup/backup");
  }
  /** The recovery key, to save in a password manager. */
  revealRecoveryKey() {
    return this.req<{ recovery_key: string }>("POST", "/setup/backup/reveal", {});
  }
  markRecoverySaved() {
    return this.req<{ recovery_saved: boolean }>("POST", "/setup/backup/saved", {});
  }
  profile() {
    return this.req<{ name: string; pet: string; named: boolean }>("GET", "/profile");
  }
  /** One-door keys: the calendar feed's and sensor boards' (never the hub token). */
  feeds() {
    return this.req<FeedKeysView>("GET", "/feeds");
  }
  /** A new key for one door; the old one stops working. */
  rotateFeed(kind: "calendar" | "sensors") {
    return this.req<FeedKeysView>("POST", `/feeds/${kind}/rotate`, {});
  }
  /** Which modules are on, one setting for every device (Settings, Modules). */
  modules() {
    return this.req<{ modules: ModuleInfo[]; alerts?: AlertInfo[] }>("GET", "/modules");
  }
  /** Switch modules on or off: `{ pet: false }`. */
  setModules(changes: Record<string, boolean>) {
    return this.req<{ modules: ModuleInfo[] }>("PUT", "/modules", changes);
  }
  /** Switch kinds of alert on or off for every device: `{ mail: false }`. */
  setAlerts(changes: Record<string, boolean>) {
    return this.req<{ alerts: AlertInfo[] }>("PUT", "/modules/alerts", changes);
  }
  /** Change the owner's name, the pet's name (empty: no pet), or both. */
  setProfile(name?: string, pet?: string) {
    return this.req<{ name: string; pet: string }>("PUT", "/profile", { ...(name !== undefined ? { name } : {}), ...(pet !== undefined ? { pet } : {}) });
  }
  /** Puts a CLI on the hub's machine where that needs no root (Bitwarden's, from npm). */
  installPasswordManager(provider: PasswordManagerProvider) {
    return this.req<PasswordManagerStatus>("POST", "/connections/password-manager/install", { provider });
  }
  /** The built-in KeePass vault: items without passwords. */
  keepassEntries() {
    return this.req<{ entries: KeePassEntry[] }>("GET", "/connections/password-manager/keepass/entries");
  }
  /** Add or change an item; an empty password is made up by the hub and never shown here. */
  putKeepassEntry(body: { title: string; username?: string; password?: string; url?: string; notes?: string }) {
    return this.req<KeePassEntry>("PUT", "/connections/password-manager/keepass/entries", body);
  }
  removeKeepassEntry(title: string) {
    return this.req<{ removed: string }>("DELETE", `/connections/password-manager/keepass/entries?title=${encodeURIComponent(title)}`);
  }
  /** Use a KeePass file the owner already has (base64) in place of the built-in one. */
  importKeepass(data: string, password: string) {
    return this.req<PasswordManagerView & { items: number }>("POST", "/connections/password-manager/keepass/import", { data, password });
  }
  keepassMaster() {
    return this.req<{ password: string }>("GET", "/connections/password-manager/keepass/master");
  }
  async keepassFile(): Promise<Blob> {
    const res = await this.fetchImpl(this.url("/connections/password-manager/keepass/file"), { headers: this.headers() });
    if (!res.ok) throw new HubError(res.status, `vault file ${res.status}`);
    return res.blob();
  }

  /** Module 5: the game design wiki, read-only. */
  wiki() {
    return this.req<WikiIndex>("GET", "/wiki");
  }
  wikiPage(id: string) {
    return this.req<WikiPage>("GET", `/wiki/page?id=${encodeURIComponent(id)}`);
  }
  wikiSearch(q: string, limit = 30, signal?: AbortSignal) {
    return this.req<{ results: WikiHit[] }>("GET", `/wiki/search?q=${encodeURIComponent(q)}&limit=${limit}`, undefined, signal);
  }

  /** The Mail screen (module mail_inbox): the linked mailboxes' Inbox, sorted into bundles. */
  mailList(signal?: AbortSignal) {
    return this.req<MailList>("GET", "/mail", undefined, signal).then(listAsSent);
  }
  mailMessage(id: string) {
    return this.req<MailMessage>("GET", `/mail/messages/${encodeURIComponent(id)}`);
  }
  mailRefresh() {
    return this.req<MailRefresh>("POST", "/mail/refresh", {});
  }
  /**
   * Show pictures, on a hub without Tor: the hub fetches this one mail's web pictures straight from its sender, who
   * then sees the home's internet address. The answer is the message with them written in.
   */
  mailShowPictures(id: string) {
    return this.req<MailMessage>("POST", `/mail/messages/${encodeURIComponent(id)}/pictures`, {});
  }
  /** Done: the mails move to Archive in their mailbox (a Sweep is many at once). */
  mailDone(ids: string[]) {
    return this.req<MailMoved>("POST", "/mail/done", { ids });
  }
  /** Undo, or Move to Inbox from Done: the mails move back from Archive to the Inbox. */
  mailUndo(ids: string[]) {
    return this.req<MailMoved>("POST", "/mail/undo", { ids });
  }
  /** Snooze a mail until a time: on the hub only, with a task titled with its subject. */
  mailSnooze(id: string, until: string) {
    return this.req<{ ok: true; until: string }>("POST", `/mail/messages/${encodeURIComponent(id)}/snooze`, { until });
  }
  /** Back to the Inbox now; its task is deleted. */
  mailUnsnooze(id: string) {
    return this.req<{ ok: true }>("POST", `/mail/messages/${encodeURIComponent(id)}/unsnooze`, {});
  }
  /** Read or unread: on the hub, and in the mailbox (only its read flag). */
  /** Several messages read or unread with one request (a thread's unread mails, a selection): at most 500. */
  mailSeenMany(ids: string[], seen: boolean) {
    return this.req<{ ok: number; seen: boolean; synced: number }>("POST", "/mail/seen", { ids, seen });
  }
  mailSeen(id: string, seen: boolean) {
    return this.req<{ ok: true; seen: boolean; synced: boolean }>("POST", `/mail/messages/${encodeURIComponent(id)}/seen`, { seen });
  }
  /** A draft: a preview of what the hub would save, or saved to the mailbox's Drafts folder (never sent). */
  mailDraft(body: MailDraftRequest) {
    return this.req<MailDraft>("POST", "/mail/drafts", body);
  }
  /** A reply's greeting and sign-off, suggested by the hub's local model (or the plain ones), to edit or drop. */
  mailGreeting(id: string) {
    return this.req<MailGreeting>("POST", `/mail/messages/${encodeURIComponent(id)}/greeting`, {});
  }
  /**
   * Delete (trash), Spam (junk), Not spam or Move to Inbox (inbox), or Move to one of the owner's folders (its key).
   * `undo`: this move takes back one just made (the screen's Undo), so the hub puts mail going back to the Inbox
   * back as it was: snoozed again, done again, with its note. Without it a move to the Inbox is a plain move.
   */
  mailMove(ids: string[], to: MoveTarget, undo = false) {
    return this.req<MailMovedTo>("POST", "/mail/move", { ids, to, ...(undo ? { undo: true } : {}) });
  }
  /** An open mail's attachments now, with its pictures' previews (read from the mailbox by the hub, kept nowhere). */
  mailAttachments(id: string) {
    return this.req<{ attachments: MailAttachment[] }>("GET", `/mail/messages/${encodeURIComponent(id)}/attachments`);
  }
  /** One attachment, as a file to save. */
  async mailAttachment(id: string, part: string): Promise<Blob> {
    const res = await this.fetchImpl(this.url(`/mail/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(part)}`), { headers: this.headers() });
    if (!res.ok) {
      let msg = `${res.status}`;
      try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* not JSON */ }
      throw new HubError(res.status, msg);
    }
    return res.blob();
  }
  /** The ways a mail offers to unsubscribe, read from it now; then one of them (`direct`: the owner accepted no Tor). */
  mailUnsubscribeOptions(id: string) {
    return this.req<UnsubscribeOptions>("GET", `/mail/messages/${encodeURIComponent(id)}/unsubscribe`);
  }
  mailUnsubscribe(id: string, how: "one_click" | "mailto", direct = false) {
    return this.req<{ ok: boolean; via?: "tor" | "direct"; draft?: boolean }>("POST", `/mail/messages/${encodeURIComponent(id)}/unsubscribe`, { how, ...(direct ? { direct: true } : {}) });
  }
  /** "Something important missing?": a folding note on a mail; every note; clearing them. Kept on the hub only. */
  mailFolding(id: string, note: { lines: string[]; no_fold: boolean }) {
    return this.req<FoldNote>("POST", `/mail/messages/${encodeURIComponent(id)}/folding`, note);
  }
  mailFoldNotes() {
    return this.req<{ notes: { id: string; subject: string; from: string; note: FoldNote }[] }>("GET", "/mail/folding-notes");
  }
  mailClearFoldNotes() {
    return this.req<{ cleared: number }>("DELETE", "/mail/folding-notes");
  }
  /** Triage on or off (off erases every kept triage). */
  mailTriage(on: boolean) {
    return this.req<{ triage: boolean }>("PUT", "/mail/settings/triage", { on });
  }
  /**
   * Sort the mail that waits, now: the hub's model runs because the owner asked. The answer comes at once (it does not
   * wait for the run) and says how sorting stands; the list's `triage_state` follows it.
   */
  mailTriageNow() {
    return this.req<TriageAnswer>("POST", "/mail/triage", {});
  }
  /**
   * Block or unblock a sender: an address, or @domain. The block's answer says what moved to Spam and where it is now,
   * so the block can be undone (unblock, then move those back). The hub refuses to block the owner's own address, a
   * mail provider's whole domain and an ending many sites share, with a sentence to show as it is.
   */
  mailBlock(sender: string) {
    return this.req<MailBlocked>("POST", "/mail/settings/blocked", { sender });
  }
  mailUnblock(sender: string) {
    return this.req<{ blocked: string[] }>("POST", "/mail/settings/unblock", { sender });
  }
  /** Every kept mail with each word of `q` (whole texts, Inbox and folders), or all mail with one person (`with`). */
  mailSearch(q: string, withPerson = "") {
    const p = new URLSearchParams();
    if (q) p.set("q", q);
    if (withPerson) p.set("with", withPerson);
    return this.req<{ hits: SearchHit[] }>("GET", `/mail/search?${p}`);
  }
  /** One of the mailbox's other folders: its kept mail, newest first. */
  mailFolder(key: string) {
    return this.req<{ messages: FolderMail[] }>("GET", `/mail/folders/${encodeURIComponent(key)}`);
  }
  /** The owner's own bundles: add, change, delete. */
  mailBundleAdd(b: Omit<CustomBundle, "id">) {
    return this.req<CustomBundle>("POST", "/mail/settings/custom-bundles", b);
  }
  mailBundleUpdate(b: CustomBundle) {
    return this.req<CustomBundle>("PUT", `/mail/settings/custom-bundles/${encodeURIComponent(b.id)}`, { name: b.name, color: b.color, addresses: b.addresses, domains: b.domains, words: b.words, body_words: b.body_words ?? [], to: b.to ?? [] });
  }
  mailBundleDelete(id: string) {
    return this.req<{ ok: true }>("DELETE", `/mail/settings/custom-bundles/${encodeURIComponent(id)}`);
  }
  /** New-mail notifications: `people`, `detail`, or one bundle's switch (`bundle` with `on`). */
  mailNotify(body: Partial<Pick<MailNotify, "people" | "detail">> & { bundle?: string; on?: boolean }) {
    return this.req<MailNotify>("PUT", "/mail/settings/notify", body);
  }
  /** When a bundle's mail shows in the Inbox. */
  mailBundleDelivery(bundle: string, d: BundleDelivery) {
    return this.req<Record<string, BundleDelivery>>("PUT", `/mail/settings/bundles/${encodeURIComponent(bundle)}`, d);
  }
  /** The owner's snooze times (what "Tomorrow" and the rest mean). */
  mailSnoozeTimes(times: Partial<SnoozeTimes>) {
    return this.req<SnoozeTimes>("PUT", "/mail/settings/snooze", times);
  }
  /**
   * Pin or unpin a mail: kept on the hub, and as the mail app's flag in the mailbox. `pending`: the mailbox had not
   * answered within a few seconds; the pin holds on the hub and the flag follows, so this is a success like any other.
   */
  mailPin(id: string, pinned: boolean) {
    return this.req<{ ok: true; pinned: boolean; synced?: number; pending?: boolean }>("POST", `/mail/messages/${encodeURIComponent(id)}/pin`, { pinned });
  }

  gamePick(body: { players: string[]; hours?: number; coop?: boolean; exclude?: string[] }) {
    return this.req<GamePick>("POST", "/games/pick", body);
  }

  gamePlayed(id: string) {
    return this.req<Entity>("POST", `/games/${encodeURIComponent(id)}/played`, {});
  }

  /** Stateless calculators; the response is read by the tolerant readers in lib/calc. */
  calc(kind: "split" | "payoff" | "unit" | "takehome", body: unknown) {
    return this.req<unknown>("POST", `/calc/${kind}`, body);
  }

  /** How long chats and host command output are kept; 0 is forever. `choices` are the offered numbers of days. */
  retention() {
    return this.req<{ chat_keep_days: number; command_output_keep_days: number; choices: number[] }>("GET", "/settings/retention");
  }
  setRetention(v: { chat_keep_days?: number; command_output_keep_days?: number }) {
    return this.req<{ chat_keep_days: number; command_output_keep_days: number }>("PUT", "/settings/retention", v);
  }
  /** The machines the assistant and sensors may reach, and the hub machine's SSH config names to pick from. */
  machines() {
    return this.req<{ machines: HubMachine[]; ssh_config: string[] }>("GET", "/machines");
  }
  setMachines(machines: HubMachine[]) {
    return this.req<{ machines: HubMachine[] }>("PUT", "/machines", { machines });
  }
  /** Add machine with a password typed once, or a password manager item: the hub puts its own key there and checks it. */
  setupMachine(v: { address: string; user: string; password?: string; secret?: string; name?: string }) {
    return this.req<{ machine: HubMachine; created: boolean }>("POST", "/machines/setup", v);
  }
  /** The hub's public SSH key, for this computer's app to add. */
  hubKey() {
    return this.req<{ public_key: string }>("GET", "/machines/hub-key");
  }
  /** The computer this app runs on reports its readings (the output of HOST_SCRIPTS for its OS). */
  reportComputer(v: { name: string; output: string }) {
    return this.req<{ name: string; read_by_hub: boolean; kept: number }>("PUT", "/devices/me/computer", v);
  }
  /** After this app put the hub's key on its computer: the hub checks it signs in, trusting only these host keys. */
  computerAccess(v: { name: string; user: string; os: "windows" | "macos" | "linux"; host_keys: string[]; addresses?: string[] }) {
    return this.req<{ machine: HubMachine; created: boolean }>("POST", "/devices/me/computer/access", v);
  }

  /** The state's meals tax at an approximate position (rounded to about a kilometre before it leaves the browser). */
  mealsTax(lat: number, lon: number) {
    const r = (n: number) => Math.round(n * 100) / 100;
    return this.req<{ state: string; name: string; pct: number; note: string }>("POST", "/calc/meals-tax", { lat: r(lat), lon: r(lon) });
  }

  /** What every renewal with a cost and a repeat costs together, a month and a year. */
  renewalTotals() {
    return this.req<RenewalTotals>("GET", "/finance/renewals");
  }

  subscriptions() {
    return this.req<unknown>("GET", "/finance/subscriptions");
  }

  push(device_id: string, patches: Patch[]) {
    return this.req<{ applied: Array<{ id: string; seq: number }>; rejected: Array<{ id: string; reason: string }>; seq: number }>(
      "POST",
      "/sync/push",
      { device_id, patches },
    );
  }

  entity(id: string) {
    return this.req<Entity>("GET", `/entities/${encodeURIComponent(id)}`);
  }

  /**
   * `id` is the capture's own id: sent again after a lost reply, the hub answers with the capture it already has.
   * `signal` ends the wait early (Save keeps the capture on the device instead).
   */
  capture(text: string, source: string, auto: boolean, id?: string, signal?: AbortSignal) {
    return this.req<{ capture: Entity; suggested_kind: string; created?: Entity[] }>("POST", "/capture", { text, source, auto, ...(id ? { id } : {}) }, signal);
  }

  /** Ask the hub to load the start every chat shares into the model's cache, so the first reply does not wait for it. */
  warmAssistant() {
    return this.req<{ started?: boolean }>("POST", "/ai/warm", {});
  }

  /** Have the assistant file one capture now; answers with the capture when it is done. */
  fileCapture(id: string) {
    return this.req<Entity>("POST", `/capture/${encodeURIComponent(id)}/file`, {});
  }

  convert(id: string, kind: string, fields?: Record<string, unknown>) {
    return this.req<Entity>("POST", `/capture/${encodeURIComponent(id)}/convert`, { kind, fields });
  }

  snooze(id: string, until: string, reason?: string) {
    return this.req<unknown>("POST", `/reminders/${encodeURIComponent(id)}/snooze`, { until, reason });
  }

  ack(id: string) {
    return this.req<unknown>("POST", `/reminders/${encodeURIComponent(id)}/ack`, {});
  }

  search(q: string, kinds?: string[]) {
    const k = kinds?.length ? `&kinds=${kinds.join(",")}` : "";
    return this.req<{ hits: Array<{ id: string; kind: string; title: string; snippet: string; score: number }>; chats?: ChatHit[] }>(
      "GET",
      `/search?q=${encodeURIComponent(q)}${k}&limit=50`,
    );
  }

  dashboard() {
    return this.req<{
      now: Entity | null;
      next: Entity[];
      reminders_today: Entity[];
      logs_7d: Record<string, Array<{ at: string; value: number | string }>>;
      captures_unprocessed: number;
      projects_active: Entity[];
    }>("GET", "/dashboard");
  }

  // ---------- the general dashboard ----------
  /** Every tile with its series, in one read. */
  dashboardBoard() {
    return this.req<Board>("GET", "/dashboard/board");
  }

  /** Metrics that have data, for the add picker. */
  async dashboardMetrics(): Promise<MetricInfo[]> {
    return (await this.req<{ metrics: MetricInfo[] }>("GET", "/dashboard/metrics")).metrics ?? [];
  }

  dashboardSeries(metric: string, days: number) {
    return this.req<Series>("GET", `/dashboard/series?metric=${encodeURIComponent(metric)}&days=${days}`);
  }

  /** The tiles, one setting for every device. PUT replaces the whole board in order. */
  dashboardPrefs() {
    return this.req<DashboardPrefs>("GET", "/prefs/dashboard");
  }
  setDashboardPrefs(tiles: Tile[]) {
    return this.req<DashboardPrefs>("PUT", "/prefs/dashboard", { tiles });
  }

  aiMemory() {
    return this.req<{ facts: Entity[]; rules: Entity[] }>("GET", "/ai/memory");
  }

  notesGraph() {
    return this.req<NotesGraph>("GET", "/notes/graph");
  }

  notesRelated(id: string) {
    return this.req<{ links: Related[]; backlinks: Related[]; similar: Related[] }>("GET", `/notes/${encodeURIComponent(id)}/related`);
  }

  notesSuggest(id: string, ai: boolean) {
    return this.req<{ id: string; suggested_tags: string[]; links: string[]; ai_used: boolean }>("POST", `/notes/${encodeURIComponent(id)}/suggest?ai=${ai ? "true" : "false"}`, {});
  }

  notesAccept(id: string, tags?: string[]) {
    return this.req<Entity>("POST", `/notes/${encodeURIComponent(id)}/accept`, tags ? { tags } : {});
  }

  chat(body: unknown) {
    return this.req<{ reply: string; model: string; backend: string; redactions: number; rules_applied: string[]; ledger_id?: string; procedure_id?: string }>(
      "POST",
      "/ai/chat",
      body,
    );
  }

  /** Chats kept on the hub: the same list on every device. */
  aiSessions(limit = 100) {
    return this.req<{ sessions: AiSessionItem[] }>("GET", `/ai/sessions?limit=${limit}`);
  }

  aiSession(id: string) {
    return this.req<AiSession>("GET", `/ai/sessions/${encodeURIComponent(id)}`);
  }

  renameAiSession(id: string, title: string) {
    return this.req<AiSession>("PATCH", `/ai/sessions/${encodeURIComponent(id)}`, { title });
  }

  deleteAiSession(id: string) {
    return this.req<{ ok: true }>("DELETE", `/ai/sessions/${encodeURIComponent(id)}`);
  }

  /** Erase every chat on the hub (images, command output, ledgers included). */
  /** The work space switch. Turning it off erases every work item on every device. */
  workSpace() {
    return this.req<{ enabled: boolean; events: number; tasks: number }>("GET", "/space/work");
  }
  setWorkSpace(enabled: boolean) {
    return this.req<{ enabled: boolean; erased: number }>("PUT", "/space/work", enabled ? { enabled } : { enabled, confirm: "erase work" });
  }

  /** Shapes and tap notes, one setting for every device. */
  feel() {
    return this.req<FeelView>("GET", "/prefs/feel");
  }
  setFeel(patch: Partial<Feel>) {
    return this.req<FeelView>("PUT", "/prefs/feel", patch);
  }
  /** A calendar's color chosen in Theme, Calendar colors; null goes back to the calendar's own color. */
  setCalendarColor(key: string, color: string | null) {
    return this.req<FeelView>("PUT", "/prefs/feel/calendar-color", { key, color });
  }

  /** Add an image shape: the raw PNG or WebP as the body. 413 when too big, 415 for another type, 422 when full. */
  async uploadFeelImage(blob: Blob, name: string): Promise<FeelView> {
    const res = await this.fetchImpl(this.url(`/prefs/feel/images?name=${encodeURIComponent(name)}`), {
      method: "POST",
      headers: this.headers({ "Content-Type": blob.type || "image/png" }),
      body: blob,
    });
    if (!res.ok) {
      let msg = `image ${res.status}`;
      try {
        msg = (await res.json()).error ?? msg;
      } catch {
        /* no body */
      }
      throw new HubError(res.status, msg);
    }
    return (await res.json()) as FeelView;
  }

  /** An image shape's bytes, as a blob (the endpoint needs the bearer header, so no plain <img src>). */
  async feelImage(id: string): Promise<Blob> {
    const res = await this.fetchImpl(this.url(`/prefs/feel/images/${encodeURIComponent(id)}`), { headers: this.headers() });
    if (!res.ok) throw new HubError(res.status, `image ${res.status}`);
    return res.blob();
  }

  deleteFeelImage(id: string) {
    return this.req<FeelView>("DELETE", `/prefs/feel/images/${encodeURIComponent(id)}`);
  }

  /** Every item of one kind as CSV; `filter` narrows by field (e.g. { type: "weight" } for logs). */
  async exportCsv(kind: string, filter?: Record<string, string>): Promise<Blob> {
    const q = filter && Object.keys(filter).length ? `?${new URLSearchParams(filter).toString()}` : "";
    const res = await this.fetchImpl(this.url(`/export/csv/${encodeURIComponent(kind)}${q}`), { headers: this.headers() });
    if (!res.ok) throw new HubError(res.status, `export ${res.status}`);
    return res.blob();
  }

  /** Every note as markdown files in a .tar.gz. */
  async exportNotes(): Promise<Blob> {
    const res = await this.fetchImpl(this.url("/vault/export"), { headers: this.headers() });
    if (!res.ok) throw new HubError(res.status, `export ${res.status}`);
    return res.blob();
  }

  wipeAiSessions() {
    return this.req<{ ok: true; sessions: number; images: number }>("DELETE", "/ai/sessions", { confirm: "wipe all chats" });
  }

  cancelAction(id: string) {
    return this.req<{ id: string; status: string }>("POST", `/ai/actions/${encodeURIComponent(id)}/cancel`, {});
  }

  /** What an item links to, what links to it, and people by name (GET /entities/:id/related). */
  async related(id: string) { return (await this.req<{ items: RelatedItem[] }>("GET", `/entities/${encodeURIComponent(id)}/related`)).items; }

  // ---- images (the shared image service, through the hub) ----
  imageCapabilities() { return this.req<ImageCapabilities>("GET", "/images/capabilities"); }
  imagePlan(body: ImageRequest) { return this.req<ImagePlan>("POST", "/images/plan", body); }
  async imageSubmit(body: ImageRequest) { return (await this.req<{ jobs: ImageJob[] }>("POST", "/images/jobs", body)).jobs; }
  async imageJobs(limit = 20) { return (await this.req<{ jobs: ImageJob[] }>("GET", `/images/jobs?limit=${limit}`)).jobs; }
  imageJob(id: string) { return this.req<ImageJob>("GET", `/images/jobs/${encodeURIComponent(id)}`); }
  /** File a picture in the gallery's Saved bin (raw bytes, 25 MB at most). */
  async uploadImage(file: Blob, source: "uploaded" | "downloaded" = "uploaded", name = "") {
    const q = new URLSearchParams({ source, ...(name ? { name } : {}) });
    const res = await this.fetchImpl(this.url(`/images/library?${q}`), { method: "POST", headers: this.headers({ "Content-Type": "application/octet-stream" }), body: file });
    if (!res.ok) { let m = `${res.status}`; try { m = (await res.json()).error ?? m; } catch { /* no body */ } throw new HubError(res.status, m); }
    return res.json() as Promise<Entity>;
  }
  imageCancel(id: string) { return this.req<unknown>("POST", `/images/jobs/${encodeURIComponent(id)}/cancel`, {}); }

  // ---- layout sketches ----
  async layouts() { return (await this.req<{ layouts: LayoutSummary[] }>("GET", "/layouts")).layouts; }
  layout(id: string) { return this.req<Layout>("GET", `/layouts/${encodeURIComponent(id)}`); }
  createLayout(body: { title: string; platform: LayoutPlatform; screen?: string; picture_id: string; note?: string; pieces?: LayoutPiece[] }) { return this.req<Layout>("POST", "/layouts", body); }
  saveLayout(id: string, patch: Partial<Pick<Layout, "title" | "platform" | "screen" | "note" | "pieces" | "status" | "after_id">>) { return this.req<Layout>("PUT", `/layouts/${encodeURIComponent(id)}`, patch); }
  deleteLayout(id: string) { return this.req<{ ok: true }>("DELETE", `/layouts/${encodeURIComponent(id)}`); }
  /** Store a picture for a sketch (raw PNG, JPEG or WebP, 20 MB at most). */
  async uploadLayoutPicture(file: Blob): Promise<{ picture_id: string; width: number; height: number }> {
    const res = await this.fetchImpl(this.url("/layouts/pictures"), { method: "POST", headers: this.headers({ "Content-Type": file.type || "application/octet-stream" }), body: file });
    if (!res.ok) { let m = `${res.status}`; try { m = (await res.json()).error ?? m; } catch { /* no body */ } throw new HubError(res.status, m); }
    return res.json() as Promise<{ picture_id: string; width: number; height: number }>;
  }
  /** A sketch's picture as a blob (the endpoint needs the bearer header, so no plain <img src>). */
  async layoutPicture(id: string): Promise<Blob> {
    const res = await this.fetchImpl(this.url(`/layouts/pictures/${encodeURIComponent(id)}`), { headers: this.headers() });
    if (!res.ok) throw new HubError(res.status, `picture ${res.status}`);
    return res.blob();
  }

  /** An image stored with a chat, as a blob (the endpoint needs the bearer header, so no plain <img src>). */
  async aiImage(id: string): Promise<Blob> {
    const res = await this.fetchImpl(this.url(`/ai/images/${encodeURIComponent(id)}`), { headers: this.headers() });
    if (!res.ok) throw new HubError(res.status, `image ${res.status}`);
    return res.blob();
  }

  /** A Steam game's header picture, through the hub (which fetches it from Steam once), never from Steam's CDN. */
  async gameArt(appid: string): Promise<Blob> {
    const res = await this.fetchImpl(this.url(`/games/art/${encodeURIComponent(appid)}`), { headers: this.headers() });
    if (!res.ok) throw new HubError(res.status, `game art ${res.status}`);
    return res.blob();
  }

  /** Raw fetch of an SSE endpoint with the bearer header. Caller reads the body. */
  async sse(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<Response> {
    const res = await this.fetchImpl(this.url(path), {
      method: init.method ?? "GET",
      headers: this.headers({ Accept: "text/event-stream", ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}) }),
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: init.signal,
    });
    if (!res.ok || !res.body) throw new HubError(res.status, `sse ${res.status}`);
    return res;
  }
}

export interface AiCapabilities { cloud: boolean; tools: boolean; model: string | null; images?: boolean; web?: boolean; hosts?: boolean; voice_model?: boolean; synced_sessions?: boolean }
export type PreflightCheck =
  | { destructive: false }
  | { destructive: true; name: string; command: string; backup: string; verify: string; rollback: string; block: string };
export interface PendingAction { id: string; host: string; command: string; purpose: string; risk?: "medium" | "high"; preflight?: { backup: string; verify: string; rollback: string } }
export interface AiSessionItem { session_id: string; title: string; task_type: string; created_at: string; last_at: string; message_count: number; preview: string; working?: boolean }
/** A reply still being worked on for a chat (on any device). */
export interface AiWorking { since: string; status: string | null; tool: string | null }
export interface AiStoredMessage {
  role: "user" | "assistant";
  content: string;
  at?: string;
  images?: string[];
  actions?: { tool: string; ok: boolean; writes: boolean }[];
  approval?: { action_id: string; host: string; command: string; status?: string; exit_code?: number | null };
}
export interface AiSession { session_id: string; title: string; task_type: string; created_at: string; last_at: string; messages: AiStoredMessage[]; summary: string | null; summary_upto: number; pending_action: PendingAction | null; working?: AiWorking | null }

export interface Related {
  id: string;
  title: string;
  path: string;
  why: string;
}

export interface HubStatus {
  version: string;
  started_at: string;
  uptime_s: number;
  db: { bytes: number; seq: number; entities_by_kind: Record<string, number> };
  devices: Array<{ id: string; name: string; platform: string; last_seen: string }>;
  backups: { latest_file: string | null; latest_at: string | null; count: number };
  ai: { backends_configured: string[]; calls_24h: number; last_call_at: string | null; last_backend: string | null; avg_latency_ms_24h: number | null };
  /** `due_next` is the next reminder itself (a task with `remind_at`), as the contract says, not a time. */
  reminders: { due_next: { id: string; fields: Record<string, unknown> } | null; fired_24h: number };
  captures_unprocessed: number;
  creative?: { projects_active: number; procedures_open: number; music_ideas: number; quiz_streak_days: number };
  ops?: { monitors: number; down: number; incidents_open: number };
}

/** One local day of the proof run (`GET /metrics/proof`, contract section "Proof metrics"). */
export interface ProofDay {
  day: string;
  captures_created: number;
  captures_auto_sorted: number;
  tasks_done: number;
  reminders_fired: number;
  reminders_acked: number;
  reminders_snoozed: number;
  logs_created: number;
  notes_edited: number;
  ai_calls: number;
  health_logs?: number;
  blocks_scheduled?: number;
  blocks_completed?: number;
  incidents_opened?: number;
  /** A task was provably in next or doing at 09:00 local; null when the hub's history cannot say. */
  now_at_0900: boolean | null;
  /** Tasks in next or doing at the end of the day: the fallback when now_at_0900 is null. */
  next_or_doing_eod: number;
}

export interface ProofRun {
  days: number;
  from: string;
  to: string;
  rows: ProofDay[];
  totals: Partial<Record<keyof ProofDay, number>> & { days_with_now_at_0900?: number; days_now_unknown?: number };
  friction: {
    captures_stale?: Array<{ id: string; text: string; created_at: string; age_h: number }>;
    reminders_snoozed_3plus?: Array<{ id: string; title: string; snoozes: number }>;
    tasks_parked_7d?: Array<{ id: string; title: string; parked_since: string; days: number }>;
  };
}

export interface NotesGraph {
  nodes: Array<{ id: string; title: string; path: string; tags: string[]; folder: string }>;
  edges: Array<{ from: string; to: string }>;
}

export type SeriesPoint = { at: string; value: number };

export interface HealthSummary {
  /** `unit`: the newest weight log's, every value converted to it (an older hub sends none: lb). */
  weight: { latest: number | null; unit?: "kg" | "lb"; at: string | null; delta_7d: number | null; delta_30d: number | null; series: SeriesPoint[] };
  bp: { latest: string | null; at: string | null };
  caffeine_today: number;
  meds_today: string[];
  meds_expected: string[];
  mood: { series_7d: SeriesPoint[] };
  sleep: { series_7d: SeriesPoint[]; last?: SeriesPoint | null };
  /** Daily totals from Apple Health; absent on an older hub. */
  steps?: { today: number | null; latest: SeriesPoint | null; series_14d: SeriesPoint[] };
  activity_hours_7d: number;
  next_injection: { name: string; at: string } | null;
}

export interface PetSummary {
  pet: string;
  events_30d: Entity[];
  next_due: Entity[];
  custody: { with_me_now: boolean | null; next_handoff: string | null };
  /** Calendar plans about the pet in the next 60 days; `start` is a date for an all-day plan. */
  plans?: { id: string; title: string; start: string; all_day: boolean }[];
}

/** One sensor from GET /sensors: the config fields flattened, plus the hub's state and a 24 h series. */
export interface SensorRow {
  id: string;
  name: string;
  unit: string;
  location?: string;
  min?: number;
  max?: number;
  alert?: boolean;
  stale_minutes?: number;
  last_at?: string;
  last_value?: number;
  state?: "ok" | "low" | "high" | "stale";
  series_24h: SeriesPoint[];
}

export interface FoodPick {
  pick: Entity | null;
  why: string;
  runner_up: Entity | null;
  constraints_used: string[];
}

export interface GamePick {
  pick: Entity | null;
  why: string;
  runner_up: Entity | null;
  considered?: number;
}

export interface SseEvent {
  event: string;
  data: string;
}

/** Read an SSE body stream and invoke onEvent per event block. Resolves when the stream ends. */
export async function readSse(res: Response, onEvent: (ev: SseEvent) => void): Promise<void> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const emit = (block: string) => {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue;
      const i = line.indexOf(":");
      const field = i < 0 ? line : line.slice(0, i);
      const value = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    if (data.length) onEvent({ event, data: data.join("\n") });
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (block.trim()) emit(block);
    }
  }
  if (buf.trim()) emit(buf);
}

/** `lines`: on a person, the lines of a mentioning note (a diary day) that name them. */
export type RelatedItem = { id: string; kind: string; title: string; why: string; at: string; lines?: string[] };

/** A planner day or today from the hub, with its preference and info rules folded into `commitments`. */
function withPreferences<T extends { commitments: Commitment[]; preferences?: Commitment[] }>(d: T): T {
  const extra = (d.preferences ?? []).filter((p) => !d.commitments.some((c) => c.rule_id === p.rule_id && c.start === p.start));
  const { preferences: _p, ...rest } = d;
  return { ...(rest as T), commitments: [...d.commitments, ...extra].sort((a, b) => a.start.localeCompare(b.start)) };
}

/** An assistant chat that matched a search (GET /search `chats`). */
export interface ChatHit { session_id: string; title: string; snippet: string; role: "user" | "assistant" | null; at: string | null; last_at: string }

/** GET /finance/renewals. */
export interface RenewalTotals {
  monthly_total: number;
  yearly_total: number;
  count: number;
  by_category: { category: string; count: number; monthly: number; yearly: number }[];
  left_out: { id: string; title: string; reason: string }[];
}
