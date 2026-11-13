import { startLink } from "./link.js";
import { startGalleryJob } from "./gallery.js";
import { linkCaptureThreads, startFilingJob } from "./capture-filer.js";
import { startMailJob } from "./mail-filer.js";
import { kick as kickImports } from "./imports/bulk.js";
import { startNoteLinker } from "./note-linker.js";
import path from "node:path";
import fs from "node:fs";
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { createHub, VERSION } from "./hub.js";
import { createApp } from "./app.js";
import { startReminderLoop } from "./reminders.js";
import { dropChatTables, encryptPlainBackups, listBackups, PLAIN_BACKUP_FILE, restoreBackup, runBackup, sealWorkInBackups, startNightlyBackup } from "./backup.js";
import { BackupKey, parseRecoveryKey } from "./backupkey.js";
import { fillOutbox } from "./outbox.js";
import { WorkKey } from "./workkey.js";
import { runSeeds } from "./seed.js";
import { runSweep } from "./sweep.js";
import { scheduleDaily } from "./schedule.js";
import { startDigestJob } from "./planner.js";
import { startWatchJob, watchDaily } from "./watches.js";
import { startFocusLoop } from "./focus.js";
import { sensorTick, startReadingPurgeJob } from "./sensors.js";
import { startRetentionJob } from "./retention.js";
import { startHostSensorLoop } from "./hostsensors.js";
import { startQuizJob } from "./quiz.js";
import { startCheckPruneJob, startMonitorLoop } from "./monitors.js";
import { installTailscaleLookup } from "./tsdns.js";
import { addOwnTailnet } from "./ai/hosts.js";
import { resumeHums } from "./hum.js";
import { execFile } from "node:child_process";
import type { createServer as createHttpServer } from "node:http";
import { startImportJob } from "./routes/imports.js";
import { dualServer, isLoopbackHost, loadTls, type TlsFiles } from "./tls.js";
import { errCode, logHost } from "./logsafe.js";

const USAGE = "usage: tsx src/main.ts <serve | seed | backup | restore <backup.age> <new path> | backup-key | encrypt-backups [dir] | sweep | watches | compact | purge-chat-backups [dir] | seal-work-backups [dir]>";

/**
 * The assistant's commands may fetch from this tailnet's names without asking; other *.ts.net names (Funnel addresses
 * anyone can run) count as the internet. The name comes from EA_TAILNET or from Tailscale itself.
 */
function learnOwnTailnet(): void {
  if (process.env.EA_TAILNET) { addOwnTailnet(process.env.EA_TAILNET); return; }
  execFile("tailscale", ["status", "--json"], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
    if (err) { console.error(`[hosts] own tailnet not known (tailscale status: ${errCode(err)}); set EA_TAILNET`); return; }
    try {
      const suffix = (JSON.parse(out) as { MagicDNSSuffix?: string }).MagicDNSSuffix ?? "";
      if (suffix) { addOwnTailnet(suffix); console.log(`[hosts] own tailnet ${suffix}`); }
    } catch { console.error("[hosts] own tailnet not known: tailscale status gave no JSON"); }
  });
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "serve";
  // A name of its own in ps, top and system monitors, instead of "node" (Linux keeps 15 characters of it).
  const title = ({ serve: "aeneas-hub", gate: "aeneas-gate" } as Record<string, string>)[cmd];
  if (title) process.title = title;
  // The model gate in front of the machine's model server, shared by every person's hub on it (hub/src/gate.ts).
  // It reads only its own EA_GATE_* settings, not a hub's.
  if (cmd === "gate") {
    const { runGate } = await import("./gate.js");
    runGate();
    return;
  }
  // Hosts without MagicDNS cannot resolve *.ts.net; retry those lookups via the Tailscale resolver.
  installTailscaleLookup();
  const cfg = loadConfig();

  if (cmd === "seed") {
    const hub = createHub(cfg);
    const r = runSeeds(hub.store, cfg, hub.modules.check);
    console.log(`[seed] facts: ${r.facts.created} created, ${r.facts.kept} kept; rules: ${r.rules.created} created, ${r.rules.kept} kept; plan rules: ${r.plan_rules.created} created, ${r.plan_rules.kept} kept; runbooks: ${r.runbooks.created} created, ${r.runbooks.kept} kept; food options: ${r.food_options.created} created, ${r.food_options.kept} kept; music notes: ${r.music_notes.created} created, ${r.music_notes.kept} kept; snippets: ${r.snippets.created} created, ${r.snippets.kept} kept; monitors: ${r.monitors.created} created, ${r.monitors.kept} kept; checklists: ${r.checklists.created} created, ${r.checklists.kept} kept, ${r.checklists.states_marked} states marked`);
    hub.close();
    return;
  }
  if (cmd === "backup") {
    const hub = createHub(cfg);
    try {
      if (hub.backupKey.recoverySaved()) {
        const c = await encryptPlainBackups(cfg.backupDir, hub.backupKey, hub.store.workKey);
        if (c.converted.length) console.log(`[backup] encrypted ${c.converted.length} older plain backups`);
      }
      const r = await runBackup(hub.db, cfg.backupDir, hub.backupKey);
      console.log(`[backup] wrote ${r.file}${r.pruned.length ? `, pruned ${r.pruned.join(", ")}` : ""}`);
      // Pictures, recordings and settings live beside the database, not in it: the copy to storage
      // (backup-to-storage.sh) sends them from the outbox, encrypted. Only pictures with a live gallery record: chat
      // pictures stay out, as chats do.
      const o = await fillOutbox(cfg.dataDir, hub.backupKey, galleryFiles(hub, path.join(cfg.dataDir, "ai-images")));
      console.log(`[backup] outbox ${o.dir}: ${o.settings} settings files in one archive; gallery ${o.gallery.sealed} new, ${o.gallery.kept} kept, ${o.gallery.removed} removed; recordings ${o.audio.sealed} new, ${o.audio.kept} kept, ${o.audio.removed} removed`);
      // The plain list of picture names an older copy script read.
      fs.rmSync(path.join(cfg.backupDir, "gallery-files.txt"), { force: true });
    } finally { hub.close(); }
    return;
  }
  if (cmd === "restore") {
    // Decrypt a backup to a new path, with the key file and, on a new machine, the recovery key in EA_RECOVERY_KEY.
    const [src, dst] = [process.argv[3], process.argv[4]];
    if (!src || !dst) { console.error("usage: tsx src/main.ts restore <hub-YYYYMMDD-HHMMSS.sqlite.age> <new path>"); process.exit(2); }
    const ids: string[] = [];
    const given = process.env.EA_RECOVERY_KEY;
    delete process.env.EA_RECOVERY_KEY;
    if (given) {
      const k = parseRecoveryKey(given);
      if (!k) { console.error("[restore] EA_RECOVERY_KEY is not a recovery key (one line starting AGE-SECRET-KEY-1)"); process.exit(1); }
      ids.push(k.identity);
    }
    try { const k = new BackupKey(cfg.backupKeyFile, path.join(cfg.dataDir, "backup-recovery.json")).read(); if (k) ids.push(k.identity); }
    catch (e) { console.error(`[restore] ${(e as Error).message}`); }
    if (!ids.length) { console.error(`[restore] no backup key at ${cfg.backupKeyFile}; set EA_RECOVERY_KEY to the recovery key saved in the password manager (read -rs EA_RECOVERY_KEY; export EA_RECOVERY_KEY)`); process.exit(1); }
    try {
      const r = await restoreBackup(path.resolve(src), path.resolve(dst), ids);
      console.log(`[restore] ${path.resolve(dst)}: integrity ${r.integrity}, ${r.entities} entities`);
    } catch (e) { console.error(`[restore] ${(e as Error).message}`); process.exit(1); }
    return;
  }
  if (cmd === "backup-key") {
    // The public half and where the key is, for deploy scripts (the Litestream replica). Never the key itself.
    const k = new BackupKey(cfg.backupKeyFile, path.join(cfg.dataDir, "backup-recovery.json"));
    try { console.log(`recipient=${k.recipient()}\nfile=${cfg.backupKeyFile}`); }
    catch (e) { console.error(`[backup-key] ${(e as Error).message}`); process.exit(1); }
    return;
  }
  if (cmd === "encrypt-backups") {
    // Seal and encrypt plain backups in a folder (the hub's own by default), e.g. older copies brought from storage.
    const dir = process.argv[3] || cfg.backupDir;
    if (path.resolve(dir) === path.resolve(cfg.dataDir) || fs.existsSync(path.join(dir, "chats.sqlite"))) {
      console.error(`[encrypt-backups] ${dir} is the hub's data folder, not a backup folder; nothing was changed`);
      process.exit(1);
    }
    const work = new WorkKey(cfg.workKeyFile);
    if (!work.exists()) { console.error(`[encrypt-backups] no work key at ${cfg.workKeyFile}; start the hub once first`); process.exit(1); }
    const key = new BackupKey(cfg.backupKeyFile, path.join(cfg.dataDir, "backup-recovery.json"));
    try {
      const r = await encryptPlainBackups(dir, key, work);
      console.log(`[encrypt-backups] encrypted ${r.converted.length} backup file(s) in ${dir}${r.skipped.length ? `; left plain: ${r.skipped.join(", ")}` : ""}`);
    } catch (e) { console.error(`[encrypt-backups] ${(e as Error).message}`); process.exit(1); }
    return;
  }
  if (cmd === "sweep") {
    const hub = createHub(cfg);
    runSweep(hub);
    hub.close();
    return;
  }
  if (cmd === "watches") {
    const hub = createHub(cfg);
    await watchDaily(hub);
    hub.close();
    return;
  }
  if (cmd === "compact") {
    const hub = createHub(cfg);
    const r = hub.store.compactChanges();
    hub.db.exec("VACUUM");
    console.log(`[compact] removed ${r.removed} change rows, ${r.remaining} remain`);
    hub.close();
    return;
  }
  if (cmd === "purge-chat-backups") {
    // Backups made before chats moved to chats.sqlite still hold them. This removes the chat tables from every
    // backup file in the folder (the hub's own by default, or the one given) and VACUUMs each so the text is gone.
    const dir = process.argv[3] || cfg.backupDir;
    // Never the live data folder: there it would drop the chat tables from chats.sqlite itself.
    if (path.resolve(dir) === path.resolve(cfg.dataDir) || fs.existsSync(path.join(dir, "chats.sqlite"))) {
      console.error(`[purge] ${dir} is the hub's data folder, not a backup folder; nothing was changed`);
      process.exitCode = 1;
      return;
    }
    // Plain copies only: encrypting one (encryptPlainBackups) drops its chat tables first, so no .age backup has them.
    let files = 0;
    for (const name of fs.readdirSync(dir).filter((n) => PLAIN_BACKUP_FILE.test(n))) {
      // The file keeps its time, which the 30-day pruning goes by.
      if (dropChatTables(path.join(dir, name))) files++;
    }
    console.log(`[purge-chat-backups] removed chat tables from ${files} backup file(s) in ${dir}`);
    return;
  }
  if (cmd === "seal-work-backups") {
    // Seal work items in backup copies made before the work key, e.g. the copies on storage brought here for it.
    const dir = process.argv[3] || cfg.backupDir;
    const key = new WorkKey(cfg.workKeyFile);
    if (!key.exists()) { console.error(`[seal-work-backups] no work key at ${cfg.workKeyFile}; start the hub once first`); process.exit(1); }
    const done = sealWorkInBackups(dir, key);
    console.log(`[seal-work-backups] sealed work items in ${done.length} backup file(s) in ${dir}`);
    return;
  }
  if (cmd !== "serve") {
    console.error(USAGE);
    process.exit(2);
  }

  if (!cfg.token) {
    console.error("[hub] EA_TOKEN is not set. Put a random 32+ character token in hub/.env and start again.");
    process.exit(1);
  }
  // The token is the only key to everything on the hub; a short one can be guessed. deploy/install.sh makes 48.
  if (cfg.token.length < 24) {
    console.error(`[hub] EA_TOKEN is ${cfg.token.length} characters; use at least 24 (openssl rand -hex 24 makes 48) and start again.`);
    process.exit(1);
  }
  // HTTPS when EA_TLS_CERT and EA_TLS_KEY are set (tls.ts); a half-set or unreadable pair stops the start, since the
  // owner expects the network to see only encrypted traffic.
  let tls: TlsFiles | null;
  try { tls = loadTls(cfg); } catch (e) {
    console.error(`[hub] ${(e as Error).message}; fix hub.env (or run deploy/install.sh again) and start again.`);
    process.exit(1);
  }
  if (!tls && !isLoopbackHost(cfg.bindHost)) {
    console.error(`[hub] plain HTTP on ${cfg.bindHost}: anyone on this network can read what passes. deploy/install.sh makes a certificate (EA_TLS_CERT, EA_TLS_KEY) when run again.`);
  }
  const hub = createHub(cfg);
  learnOwnTailnet();
  const resumed = resumeHums(hub);
  if (resumed) console.log(`[hum] ${resumed} hum(s) left listening by the last run heard again`);
  // Commands the last run left running (a change that restarted the hub or rebooted its machine): interrupted.
  const interrupted = hub.ai.hosts.recoverInterrupted();
  if (interrupted) console.log(`[ai] ${interrupted} command(s) the last run left running marked interrupted`);
  const rec = hub.vault.reconcile();
  if (rec.imported || rec.exported) console.log(`[vault] reconciled: ${rec.imported} imported from disk, ${rec.exported} written to disk`);
  const app = createApp(hub);
  const stopReminders = startReminderLoop(hub.store, hub.bus, cfg.reminderIntervalMs);
  const stopBackup = startNightlyBackup(hub.db, cfg.backupDir, hub.backupKey, hub.store.workKey, 3, cfg.backupCopyDir);
  // Plain backups an older hub wrote are encrypted now (their work items were sealed by createHub), not at 03:00, once
  // the recovery key is saved; until then they stay, as the copies that open without it.
  let saved = false;
  try { saved = hub.backupKey.recoverySaved(); } catch { /* the key file is reported elsewhere */ }
  if (saved) {
    encryptPlainBackups(cfg.backupDir, hub.backupKey, hub.store.workKey)
      .then((c) => { if (c.converted.length) console.log(`[backup] encrypted ${c.converted.length} older plain backups`); })
      .catch((e) => console.error(`[backup] encrypting older plain backups failed: ${errCode(e)}`));
  } else if (listBackups(cfg.backupDir).some((b) => !b.encrypted)) console.warn("[backup] older plain backups on this machine stay as they are until the recovery key is saved (Welcome, The key to your backups): until then they are the copies that open without it");
  const stopSweep = scheduleDaily("sweep", 3, 10, () => { runSweep(hub); });
  const stopCompact = scheduleDaily("compact", 3, 45, () => { const r = hub.store.compactChanges(); console.log(`[compact] removed ${r.removed} change rows, ${r.remaining} remain`); });
  const stopWatches = startWatchJob(hub);
  const stopDigest = startDigestJob(hub);
  const stopFocus = startFocusLoop(hub, 60_000, [{ label: "sensors", tick: () => { if (hub.modules.on("sensors")) sensorTick(hub); } }]);
  const stopReadingPurge = startReadingPurgeJob(hub);
  const stopRetention = startRetentionJob(hub);
  const stopHostSensors = startHostSensorLoop(hub);
  const stopQuiz = startQuizJob(hub);
  const stopMonitors = startMonitorLoop(hub);
  const stopCheckPrune = startCheckPruneJob(hub);
  const stopImports = startImportJob(hub);
  const stopMail = startMailJob(hub);
  const stopNotes = startNoteLinker(hub);
  const stopGallery = startGalleryJob(hub);
  const linked = linkCaptureThreads(hub);
  if (linked) console.log(`[filer] ${linked} filed captures now link to their filing chat`);
  const stopFiling = startFilingJob(hub);
  // An import a restart interrupted goes on where it was.
  kickImports(hub);
  const server = serve({
    fetch: app.fetch, port: cfg.port, hostname: cfg.bindHost,
    ...(tls ? { createServer: dualServer(tls) as unknown as typeof createHttpServer } : {}),
  }, (info) => {
    const how = tls ? `https://${cfg.bindHost}:${info.port} (plain HTTP for this machine only; certificate sha256 ${tls.fingerprint})` : `http://${cfg.bindHost}:${info.port}`;
    console.log(`[hub] v${VERSION} listening on ${how} data=${cfg.dataDir} vault=${cfg.vaultDir} ollama=${cfg.ollamaUrl ? logHost(cfg.ollamaUrl) : "off"} cloud=${cfg.anthropicApiKey ? "key set" : "off"} adapter=${cfg.adapterUrl ? logHost(cfg.adapterUrl) : "off"}`);
  });
  // How devices reach the hub (link.ts): the Direct link starts here when it is the method in use.
  const stopLink = await startLink(cfg, app.fetch);
  const shutdown = () => {
    console.log("[hub] shutting down");
    void stopLink();
    stopReminders();
    stopBackup();
    stopSweep();
    stopCompact();
    stopWatches();
    stopDigest();
    stopFocus();
    stopReadingPurge();
    stopRetention();
    stopHostSensors();
    stopQuiz();
    stopMonitors();
    stopCheckPrune();
    stopImports();
    stopMail();
    stopNotes();
    stopGallery();
    stopFiling();
    server.close();
    hub.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(`[hub] fatal: ${errCode(e)}`);
  process.exit(1);
});

/** File names under ai-images of every picture a live gallery record keeps. */
function galleryFiles(hub: ReturnType<typeof createHub>, dir: string): string[] {
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const ids = new Set(hub.store.list({ kind: "image", limit: 1_000_000 }).map((e) => String(e.fields.image_id ?? "")).filter(Boolean));
  return names.filter((n) => ids.has(n.replace(/\.[a-z0-9]+$/i, ""))).sort();
}
