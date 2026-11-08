import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub } from "./helpers.js";
import { backupChecker, backupCommand, backupJobNames, backupOutcome, DEFAULT_BACKUP_JOBS, parseBackupOutput, parseBackupTarget, type SshRunner } from "../src/backups.js";
import { runCheck } from "../src/monitors.js";
import { loadConfig } from "../src/config.js";

// Sample output in the shapes launchctl, the Windows task script and journalctl print.
const NOW = new Date("2026-10-29T17:00:00Z");

const MAC_FAILED = `com.example.projectbackup.snapshot = {
\tactive count = 0
\tpath = /Users/robin/Library/LaunchAgents/com.example.projectbackup.snapshot.plist
\tstate = not running
\tlast exit code = 30
\tevent triggers = {
\t\tstate = active
\t}
}
@@log
[2026-10-28T08:00:05Z] Laptop backup starting
[2026-10-28T08:07:35Z] Laptop backup completed
[2026-10-29T08:00:05Z] Laptop backup starting
Error when processing "cache/app-data/history_1.sqlite": unable to get result
Found 44 fatal error(s) while snapshotting robin@laptop:/Users/robin/Projects.
flush error: error flushing manifests
`;

const WIN_OK = `@@task Ready 0
@@status
{
    "state":  "complete",
    "success":  true,
    "startedUtc":  "2026-10-29T08:15:01.4985653Z",
    "completedUtc":  "2026-10-29T08:18:05.5161252Z",
    "missingRequiredProjectMarkers":  [],
    "unavailableSources":  [],
    "sources":  [{ "path": "D:\\\\Projects", "success": true, "exitCode": 0 }],
    "error":  null
}
@@log
[2026-10-29T08:16:36Z] Source starting: C:\\Users\\robin\\Documents
[2026-10-28T08:15:00Z] Desk-PC backup starting
[2026-10-28T08:19:00Z] Desk-PC backup completed
[2026-10-29T08:15:01Z] Desk-PC backup starting
[2026-10-29T08:18:05Z] Desk-PC backup completed
`;

const LINUX_RUNNING = `ActiveState=activating
ExecMainStatus=0
@@log
2026-10-28T05:04:33-0700 nas01 project-backup[221846]: NAS backup completed with one or more source failures.
2026-10-28T23:08:31-0700 nas01 systemd[1]: project-backup.service: Failed with result 'exit-code'.
2026-10-28T23:08:31-0700 nas01 systemd[1]: Failed to start Back up the NAS offsite with Kopia.
2026-10-29T01:32:17-0700 nas01 project-backup[314340]: NAS backup starting at 2026-10-29T08:32:17Z
2026-10-29T01:32:17-0700 nas01 systemd[1]: project-backup.service: Failed with result 'exit-code'.
2026-10-29T09:52:28-0700 nas01 project-backup[333652]: NAS backup starting at 2026-10-29T16:52:28Z
`;

test("backups: targets", () => {
  assert.deepEqual(parseBackupTarget("mac:laptop"), { os: "mac", dest: "laptop", job: "backup" });
  assert.deepEqual(parseBackupTarget("linux:robin@10.0.0.16#restore"), { os: "linux", dest: "robin@10.0.0.16", job: "restore" });
  assert.throws(() => parseBackupTarget("laptop"), /mac:, windows: or linux:/);
  assert.throws(() => parseBackupTarget("mac:laptop#restore"), /only linux/);
  assert.match(backupCommand(parseBackupTarget("mac:laptop#verify")).remote, /projectbackup\.verify .*verify\.log/);
  const win = backupCommand(parseBackupTarget("windows:desk-pc"));
  assert.equal(win.remote, "powershell -NoProfile -NonInteractive -Command -");
  assert.match(win.stdin!, /Project Backup Snapshot[\s\S]*backup-status\.json[\s\S]*backup\.log/);
  assert.match(backupCommand(parseBackupTarget("linux:nas01#verify")).remote, /^systemctl show project-backup-verify\.service /);
});

test("backups: each machine's job names are settings; a job left out keeps its default, an unsafe name is refused", () => {
  const names = backupJobNames({
    mac: "backup=com.example.projectbackup.snapshot, verify=com.example.projectbackup.verify",
    windows: "verify=Nightly Verify (kopia)",
    linux: "backup=nas-project-backup.service,restore=nas-project-backup-restore-test.service,restore2=x.service,verify=a;reboot",
  });
  assert.deepEqual(names.mac, { backup: "com.example.projectbackup.snapshot", verify: "com.example.projectbackup.verify" });
  assert.deepEqual(names.windows, { backup: DEFAULT_BACKUP_JOBS.windows.backup, verify: "Nightly Verify (kopia)" });
  assert.deepEqual(names.linux, { backup: "nas-project-backup.service", verify: DEFAULT_BACKUP_JOBS.linux.verify, restore: "nas-project-backup-restore-test.service" });
  assert.match(backupCommand(parseBackupTarget("mac:laptop"), names).remote, /gui\/\$\(id -u\)\/com\.example\.projectbackup\.snapshot .*backup\.log/);
  assert.match(backupCommand(parseBackupTarget("windows:desk-pc#verify"), names).stdin!, /-TaskName 'Nightly Verify \(kopia\)'[\s\S]*verify\.log/);
  assert.match(backupCommand(parseBackupTarget("linux:nas01#restore"), names).remote, /^systemctl show nas-project-backup-restore-test\.service .*journalctl -u nas-project-backup-restore-test\.service /);
  assert.equal(backupJobNames({ windows: "backup=it's" }).windows.backup, DEFAULT_BACKUP_JOBS.windows.backup, "a quote would end the PowerShell string");

  const saved = { ...process.env };
  try {
    process.env.EA_NO_DOTENV = "1";
    process.env.EA_BACKUP_LINUX_UNITS = "backup=nas-project-backup.service";
    process.env.EA_BACKUP_MAC_JOBS = "verify=com.example.projectbackup.verify";
    const cfg = loadConfig({ dataDir: "/nonexistent-ea-test" });
    assert.equal(cfg.backupJobs.linux.backup, "nas-project-backup.service");
    assert.equal(cfg.backupJobs.mac.verify, "com.example.projectbackup.verify");
    assert.equal(cfg.backupJobs.mac.backup, DEFAULT_BACKUP_JOBS.mac.backup);
  } finally {
    for (const k of ["EA_BACKUP_LINUX_UNITS", "EA_BACKUP_MAC_JOBS", "EA_NO_DOTENV"]) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});

test("backups: a Mac run that ended in errors is down with kopia's summary and the exit code", () => {
  const t = parseBackupTarget("mac:laptop");
  const r = parseBackupOutput(t, MAC_FAILED);
  assert.equal(r.running, false);
  assert.equal(r.exit, "30");
  const o = backupOutcome(t, r, 28, NOW);
  assert.equal(o.ok, false);
  assert.match(o.error!, /^backup at 2026-10-29 08:00 UTC failed: Found 44 fatal error\(s\) while snapshotting .* \(exit 30\); last good backup 2026-10-28 08:07 UTC \(33 h ago\)/);
  assert.equal(o.detail, "last good backup 2026-10-28 08:07 UTC (33 h ago)");

  // iCloud offloading names its cause.
  const offloaded = MAC_FAILED.replace("flush error", 'Error when processing "photo-tool/.git/objects/e1/bd3e": read /Users/robin/Projects/photo-tool/.git/objects/e1/bd3e: resource deadlock avoided\n'.repeat(2) + "flush error");
  assert.match(backupOutcome(t, parseBackupOutput(t, offloaded), 28, NOW).error!, /Found 44 fatal error\(s\) while snapshotting \S+ \(2 on files iCloud offloaded from this Mac\) \(exit 30\)/);
});

test("backups: Desk-PC's completed status is up; a failed status names the failing sources", () => {
  const t = parseBackupTarget("windows:desk-pc");
  const ok = backupOutcome(t, parseBackupOutput(t, WIN_OK), 28, NOW);
  assert.deepEqual(ok, { ok: true, detail: "last good backup 2026-10-29 08:18 UTC (9 h ago)" });
  // Too old.
  assert.equal(backupOutcome(t, parseBackupOutput(t, WIN_OK), 28, new Date("2026-10-30T14:00:00Z")).error, "last good backup 2026-10-29 08:18 UTC (30 h ago), older than 28 h");

  const failed = WIN_OK.replace('"state":  "complete"', '"state":  "failed"').replace('"success":  true', '"success":  false')
    .replace('"success": true, "exitCode": 0', '"success": false, "exitCode": 1').replace("[2026-10-29T08:18:05Z] Desk-PC backup completed\n", "").replace("@@task Ready 0", "@@task Ready 1");
  const o = backupOutcome(t, parseBackupOutput(t, failed), 28, NOW);
  assert.equal(o.ok, false);
  assert.match(o.error!, /^backup at 2026-10-29 08:18 UTC failed: 1 source failed: D:\\Projects \(exit 1\); last good backup 2026-10-28 08:19 UTC/);

  const running = WIN_OK.replace('"state":  "complete"', '"state":  "running"').replace("[2026-10-29T08:18:05Z] Desk-PC backup completed\n", "");
  const run = backupOutcome(t, parseBackupOutput(t, running), 28, new Date("2026-10-29T08:17:00Z"));
  assert.equal(run.ok, true);
  assert.match(run.detail!, /^running since 2026-10-29 08:15 UTC; last good backup 2026-10-28 08:19 UTC/);
});

test("backups: the NAS running with no good backup on record is down; its journal times are read", () => {
  const t = parseBackupTarget("linux:robin@10.0.0.16");
  const r = parseBackupOutput(t, LINUX_RUNNING);
  assert.equal(r.running, true);
  assert.deepEqual(r.events.map((e) => [new Date(e.at).toISOString(), e.kind]), [
    ["2026-10-28T12:04:33.000Z", "fail"], ["2026-10-29T06:08:31.000Z", "fail"], ["2026-10-29T08:32:17.000Z", "start"], ["2026-10-29T08:32:17.000Z", "fail"], ["2026-10-29T16:52:28.000Z", "start"],
  ]);
  assert.deepEqual(backupOutcome(t, r, 28, NOW), { ok: false, error: "running since 2026-10-29 16:52 UTC; the backup at 2026-10-29 08:32 UTC failed: systemd: exit-code; no good backup on record", detail: "no good backup on record" });

  const done = LINUX_RUNNING.replace("ActiveState=activating", "ActiveState=inactive") + "2026-10-29T10:40:00-0700 nas01 project-backup[333652]: NAS backup completed at 2026-10-29T17:40:00Z\n";
  assert.deepEqual(backupOutcome(t, parseBackupOutput(t, done), 28, new Date("2026-10-29T18:00:00Z")), { ok: true, detail: "last good backup 2026-10-29 17:40 UTC (20 min ago)" });
  // The last attempt failing after a good run is down even while that good run is fresh.
  const after = done + "2026-10-29T11:00:00-0700 nas01 systemd[1]: project-backup.service: Failed with result 'timeout'.\n";
  assert.match(backupOutcome(t, parseBackupOutput(t, after), 28, new Date("2026-10-29T18:30:00Z")).error!, /^backup at 2026-10-29 18:00 UTC failed: systemd: timeout; last good backup/);
});

test("backups: an unreachable machine skips the check and leaves the state alone", async () => {
  const t = makeHub();
  try {
    let reply = { code: 255, stdout: "", stderr: "ssh: connect to host laptop port 22: Operation timed out\n" };
    const calls: string[] = [];
    const run: SshRunner = async (dest, remote) => { calls.push(`${dest} ${remote.slice(0, 20)}`); return reply; };
    t.hub.checkers.backup = backupChecker(run);
    const m = t.hub.store.create("monitor", { name: "Laptop backup", type: "backup", target: "mac:laptop", expect: "28", interval_s: 900, timeout_s: 60, fails_before_down: 1, enabled: true });

    let after = await runCheck(t.hub, m.id, NOW);
    assert.equal(after.fields.state ?? "unknown", "unknown");
    assert.match(String(after.fields.last_error), /^laptop unreachable: ssh: connect to host laptop/);
    assert.equal((t.hub.db.prepare("SELECT COUNT(*) AS n FROM checks").get() as { n: number }).n, 0);

    reply = { code: 0, stdout: MAC_FAILED, stderr: "" };
    after = await runCheck(t.hub, m.id, NOW);
    assert.equal(after.fields.state, "down");
    assert.equal(after.fields.last_detail, "last good backup 2026-10-28 08:07 UTC (33 h ago)");
    assert.equal(t.hub.store.list({ kind: "incident" }).length, 1);

    reply = { code: 0, stdout: MAC_FAILED + "[2026-10-29T16:00:00Z] Laptop backup starting\n[2026-10-29T16:09:00Z] Laptop backup completed\n", stderr: "" };
    after = await runCheck(t.hub, m.id, NOW);
    assert.equal(after.fields.state, "up");
    assert.equal(after.fields.last_error, undefined);
    assert.equal(after.fields.last_detail, "last good backup 2026-10-29 16:09 UTC (51 min ago)");
    assert.deepEqual(calls.map((c) => c.split(" ")[0]), ["laptop", "laptop", "laptop"]);
  } finally {
    t.cleanup();
  }
});
