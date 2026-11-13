import fs from "node:fs";
import { createRequire } from "node:module";
import { type Config } from "./config.js";
import { moveChatTables, openChatDb, openDb, type DB } from "./db.js";
import { Bus } from "./bus.js";
import { Store } from "./store.js";
import { Vault } from "./vault.js";
import { Gateway } from "./ai/index.js";
import { KnowledgeMap } from "./notes.js";
import { fillSecrets, hubSecretValues } from "./secrets.js";
import { addSensitivePath, adoptSshHosts } from "./ai/hosts.js";
import { ProfileStore } from "./profile.js";
import { applyAiSettings, readAiSettings, sealAiSettings } from "./setup.js";
import { SecretBox } from "./secretbox.js";
import { DeviceTracker, removeDevice } from "./devices.js";
import { DeviceKeys } from "./devicekeys.js";
import { nowIso } from "@everythingapp/shared";
import type { Entity } from "@everythingapp/shared";
import { installWatchHooks, probeTls, syncWatchReminder, type TlsProbe } from "./watches.js";
import { installPetHooks, syncHandoffs, syncPetReminder } from "./pets.js";
import { installRecordHooks } from "./records.js";
import { installProjectHooks } from "./projects.js";
import { defaultCheckers, installMonitorHooks, mergeBackupMonitors, type Checkers } from "./monitors.js";
import { backupChecker, sshRunner } from "./backups.js";
import { installAdminHooks, syncApplicationReminder } from "./admin.js";
import { linkedTask, migrateRemindersToTasks, syncLinkedTask } from "./reminders.js";
import { requeueParkedMail } from "./mail-filer.js";
import { migrateRunbookTitles } from "./memory.js";
import { migrateCaffeineToCups } from "./health.js";
import { WorkSpace } from "./work.js";
import { WorkKey } from "./workkey.js";
import { listBackups, sealWorkInBackups } from "./backup.js";
import { BackupKey, BackupKeyError } from "./backupkey.js";
import { FeelStore } from "./feel.js";
import { DashboardStore } from "./dashboard.js";
import { LayoutStore } from "./layouts.js";
import { ConnectionStore } from "./imports/connections.js";
import { WikiStore } from "./wiki.js";
import { ModuleStore, type ModuleId } from "./modules.js";
import { FeedKeys } from "./feedkeys.js";
import { runSeeds } from "./seed.js";
import path from "node:path";
import { errCode } from "./logsafe.js";

const require = createRequire(import.meta.url);
export const VERSION: string = (require("../package.json") as { version: string }).version;

/** Everything a route handler needs. Built once per process (or per test). */
export interface Hub {
  cfg: Config;
  db: DB;
  /** chats.sqlite: sessions, ai_calls, ai_actions. Not backed up. */
  chatDb: DB;
  bus: Bus;
  store: Store;
  vault: Vault;
  ai: Gateway;
  map: KnowledgeMap;
  devices: DeviceTracker;
  /** Each device's own key and the one-time pairing codes (devicekeys.ts). */
  deviceKeys: DeviceKeys;
  /** The work space switch (hub-only setting). */
  work: WorkSpace;
  /** Shapes and tap notes, one setting for every device. */
  feel: FeelStore;
  /** Dashboard tiles, one board for every device. */
  dashboard: DashboardStore;
  layouts: LayoutStore;
  /** ISO time this hub object was built; /status reports uptime from it. */
  startedAt: string;
  /** Reads a TLS certificate's expiry for watch probes. Tests replace it so no socket is opened. */
  tlsProbe: TlsProbe;
  /** Monitor checks by type. Tests replace entries so no packet, socket or request leaves the process. */
  checkers: Checkers;
  /** Game design wiki mirror: repo docs and Confluence pages, read-only. */
  wiki: WikiStore;
  /** Linked accounts and sync bookkeeping (Steam, Letterboxd, Apple Health). */
  connections: ConnectionStore;
  /** Seals connections.json and ai.json at rest (secretbox.ts). */
  secretBox: SecretBox;
  profile: ProfileStore;
  /** Which modules are on (modules.ts): one setting for every device. */
  modules: ModuleStore;
  /** One-door keys for the calendar feed and sensor boards (feedkeys.ts). */
  feedKeys: FeedKeys;
  /** The age key every copy of the data leaving hub.sqlite is encrypted to (backupkey.ts). */
  backupKey: BackupKey;
  /** Outbound HTTP for imports (Steam, Letterboxd). Tests replace it so nothing leaves the process. */
  fetch: typeof fetch;
  close(): void;
}

/**
 * The highest change seq this hub has given out, kept beside the database (not in it, and not in its backups). A hub
 * restored from an older copy starts behind it: the counter is moved past it, so a device whose cursor is ahead of
 * the copy still gets every change made from now on instead of skipping them (a cursor past the hub's seq resets,
 * but one in between saw nothing new until the hub caught up, and then missed what was written meanwhile).
 */
function keepSeqMark(store: Store, file: string): void {
  try {
    const mark = Number((JSON.parse(fs.readFileSync(file, "utf8")) as { seq?: unknown }).seq);
    const at = store.seq();
    if (Number.isFinite(mark) && mark > at) {
      store.raiseSeq(mark);
      console.warn(`[sync] the database is behind the last change this hub gave out (${at} < ${mark}): restored from a copy? Changes continue from ${mark}`);
    }
  } catch { /* no mark yet */ }
  let timer: NodeJS.Timeout | null = null;
  const write = () => {
    timer = null;
    // A short command (seed, a backup) closes the database before the exit hook runs; the mark was kept by then.
    if (!store.db.open) return;
    try { const tmp = `${file}.tmp`; fs.writeFileSync(tmp, JSON.stringify({ seq: store.seq() })); fs.renameSync(tmp, file); }
    catch (e) { console.error(`[sync] could not keep ${file}: ${errCode(e)}`); }
  };
  write();
  store.afterWrite(() => { if (!timer) { timer = setTimeout(write, 200); timer.unref(); } });
  pendingMarks.add(() => { if (timer) { clearTimeout(timer); write(); } });
  if (!exitHooked) { exitHooked = true; process.once("exit", () => { for (const f of pendingMarks) f(); }); }
}
const pendingMarks = new Set<() => void>();
let exitHooked = false;

/** Modules whose items carry a reminder task the hub keeps in step (watches.ts, pets.ts, admin.ts). */
const REMINDER_OWNERS: Partial<Record<ModuleId, { kind: string; sync: (hub: Hub, e: Entity) => void }>> = {
  renewals: { kind: "watch", sync: (hub, e) => { syncWatchReminder(hub.store, e); } },
  // As the pet hook does: a handoff written while Pet was off moves the next one, then each event's reminder.
  pet: { kind: "pet_event", sync: (hub, e) => {
    if (e.fields.type === "custody" && !e.deleted_at && e.fields.with) syncHandoffs(hub, String(e.fields.pet ?? ""));
    syncPetReminder(hub.store, hub.store.get(e.id) ?? e);
  } },
  jobs: { kind: "application", sync: (hub, e) => { syncApplicationReminder(hub.store, e); } },
};

export function createHub(cfg: Config): Hub {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const db = openDb(cfg.dbPath);
  const chatDb = openChatDb(cfg.chatDbPath);
  const mv = moveChatTables(db, chatDb);
  if (Object.keys(mv.moved).length) console.log(`[db] moved chat tables out of the main database: ${JSON.stringify(mv.moved)}`);
  const bus = new Bus();
  const store = new Store(db, bus, new WorkKey(cfg.workKeyFile));
  const vault = new Vault(cfg.vaultDir, store);
  const secretBox = new SecretBox(cfg.secretsKeyFile);
  // Sign-in files an older hub wrote in plain text are sealed once; a failure leaves them as they are.
  try { if (sealAiSettings(cfg.dataDir, secretBox)) console.log("[secrets] ai.json sealed"); } catch (e) { console.error(`[secrets] ai.json not sealed: ${errCode(e)}`); }
  // A damaged ai.json must not stop the hub: the models from hub.env are used and the file is left for a look.
  try { applyAiSettings(cfg, readAiSettings(cfg.dataDir, secretBox)); } catch (e) { console.error(`[setup] ${errCode(e)}; using the models from hub.env`); }
  const ai = new Gateway(cfg, store, chatDb);
  const map = new KnowledgeMap(store);
  vault.linkDeriver = (id, body, title, related) => map.deriveLinks(id, body, title, related);
  const devices = new DeviceTracker(store);
  const hub: Hub = { cfg, db, chatDb, bus, store, vault, ai, map, devices, deviceKeys: new DeviceKeys(path.join(cfg.dataDir, "device-keys.json")), work: new WorkSpace(path.join(cfg.dataDir, "work-space.json")), feel: new FeelStore(path.join(cfg.dataDir, "feel.json")), dashboard: new DashboardStore(path.join(cfg.dataDir, "dashboard.json")), layouts: new LayoutStore(path.join(cfg.dataDir, "layouts")), startedAt: nowIso(), tlsProbe: (url) => probeTls(url), checkers: { ...defaultCheckers, backup: backupChecker(sshRunner, cfg.backupJobs) }, connections: new ConnectionStore(path.join(cfg.dataDir, "connections.json"), secretBox), secretBox, profile: new ProfileStore(path.join(cfg.dataDir, "profile.json"), cfg.ownerName), wiki: new WikiStore(path.join(cfg.dataDir, "wiki.json")), feedKeys: new FeedKeys(path.join(cfg.dataDir, "feed-keys.json")), backupKey: new BackupKey(cfg.backupKeyFile, path.join(cfg.dataDir, "backup-recovery.json")),modules: new ModuleStore(path.join(cfg.dataDir, "modules.json"), { preset: cfg.modulesPreset, existing: () => store.hasOwnerData() }), fetch: (input, init) => fetch(input, init), close: () => { db.close(); chatDb.close(); } };
  keepSeqMark(store, path.join(cfg.dataDir, "sync-mark.json"));
  try { if (hub.connections.sealIfPlain()) console.log("[secrets] connections.json sealed"); } catch (e) { console.error(`[secrets] connections.json not sealed: ${errCode(e)}`); }
  // Machines are only the ones the person adds (hosts.json); a hub already using its SSH hosts keeps them, once.
  try {
    const n = adoptSshHosts(cfg, store.hasOwnerData() && (hub.modules.on("homelab") || hub.modules.on("sensors")));
    if (n) console.log(`[hosts] ${n} machine(s) from the SSH config kept in the machines list`);
  } catch (e) { console.error(`[hosts] could not keep the SSH config's machines: ${errCode(e)}`); }
  // An approved command that names a password manager item gets its value only when it runs.
  ai.hosts.fillSecrets = (command, host) => fillSecrets(hub, command, host.os);
  // No command shows the hub's own secrets: reads of its folders wait for approval, and its values are cut from output.
  ai.hosts.hiddenValues = () => hubSecretValues(hub);
  for (const p of [cfg.dataDir, path.dirname(cfg.workKeyFile), path.dirname(cfg.backupKeyFile)]) addSensitivePath(path.resolve(p));
  ai.owner = () => hub.profile.get().name;
  ai.pet = () => hub.profile.get().pet;
  ai.moduleOn = hub.modules.check;
  // A module switched on gets its starter content (monitors, snippets, music sheets, food) now, once. The reminders
  // the hub makes for a module's items (a renewal, a vet visit, a job follow-up) are set aside on every device while
  // it is off and made again from the items when it comes back on.
  hub.modules.onChange((on, off) => {
    for (const id of off) {
      const o = REMINDER_OWNERS[id];
      if (!o) continue;
      try {
        let n = 0;
        for (const e of store.list({ kind: o.kind, limit: 1_000_000 })) {
          const t = linkedTask(store, e);
          if (t && t.fields.status !== "done") { syncLinkedTask(store, e, null); n++; }
        }
        if (n) console.log(`[modules] ${id} off: ${n} reminder(s) set aside`);
      } catch (e) { console.error(`[modules] setting aside ${id} reminders failed: ${errCode(e)}`); }
    }
    for (const id of on) {
      const o = REMINDER_OWNERS[id];
      if (!o) continue;
      try { for (const e of store.list({ kind: o.kind, limit: 1_000_000 })) o.sync(hub, e); }
      catch (e) { console.error(`[modules] restoring ${id} reminders failed: ${errCode(e)}`); }
    }
    for (const id of on) {
      const n = requeueParkedMail(hub, id);
      if (n) console.log(`[modules] ${id} on: ${n} parked mail(s) back in the queue`);
    }
    if (!on.length) return;
    try { runSeeds(store, cfg, hub.modules.check, on); } catch (e) { console.error(`[modules] seeding ${on.join(", ")} failed: ${errCode(e)}`); }
  });
  // A device removed anywhere (Settings, Devices, or its entity deleted through sync) loses its key at once, and so
  // does a Watch whose key it held.
  bus.on("change", (e) => {
    if (e.kind !== "device") return;
    const d = store.get(e.id);
    if (!d?.deleted_at) return;
    try { removeDevice(hub, e.id); } catch (err) { console.error(`[devices] removing ${e.id.slice(0, 8)} failed: ${errCode(err)}`); }
  });
  installWatchHooks(hub);
  installMonitorHooks(hub);
  mergeBackupMonitors(store);
  installPetHooks(hub);
  installRecordHooks(hub);
  installProjectHooks(hub);
  installAdminHooks(hub);
  migrateRemindersToTasks(store);
  migrateRunbookTitles(store);
  const cups = migrateCaffeineToCups(store);
  if (cups) console.log(`[health] ${cups} caffeine log(s) in mg now kept in cups`);
  const sealed = store.sealWorkRows();
  if (sealed) console.log(`[work] sealed ${sealed} work items with the work key`);
  const lost = store.unreadableWork();
  if (lost.length) console.error(`[work] ${lost.length} work items were sealed with a key that is gone (${cfg.workKeyFile}); they read as absent until the work space is erased or a device sends them again`);
  if (store.reindexFtsIfOutdated()) console.log("[store] search index rebuilt for more kinds");
  try {
    const b = sealWorkInBackups(cfg.backupDir, store.workKey);
    if (b.length) console.log(`[work] sealed work items in ${b.length} older backups`);
  } catch (e) { console.error(`[work] sealing work items in backups failed: ${errCode(e)}`); }
  // The backup key is made on first start. A key file that cannot be read stops backups (each says why), not the hub.
  try {
    hub.backupKey.load();
    if (hub.backupKey.created && listBackups(cfg.backupDir).some((b) => b.encrypted)) {
      console.warn(`[backup] a new backup key was made while encrypted backups are in ${cfg.backupDir}: those open only with the recovery key saved before`);
    }
  } catch (e) { console.error(`[backup] ${e instanceof BackupKeyError ? e.message : errCode(e)}`); }
  return hub;
}
