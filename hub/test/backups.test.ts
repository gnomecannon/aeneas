import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub } from "./helpers.js";
import { backupChecker, backupCommand, backupHours, backupJobNames, backupOutcome, DEFAULT_BACKUP_JOBS, machineOutcome, parseBackupOutput, parseBackupTarget, parseJobOutput, type SshRunner } from "../src/backups.js";
import { mergeBackupMonitors, runCheck } from "../src/monitors.js";
import { loadConfig } from "../src/config.js";

// Sample output in the shapes launchctl, the Windows task script and journalctl print. Times in messages are the
// hub's local time; the tests run in America/New_York (UTC-4 until Nov 1, 2026).
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

const MAC_VERIFY_OLD = `com.example.projectbackup.verify = {
\tstate = not running
\tlast exit code = 0
}
@@log
[2026-10-20T10:00:00Z] Laptop verification starting
[2026-10-20T10:12:00Z] Laptop verification completed
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

/** What the Windows wrapper writes the moment a run starts: "running", and success false until it ends. */
const WIN_STARTED = WIN_OK.replace('"state":  "complete"', '"state":  "running"').replace('"success":  true', '"success":  false')
  .replace('"completedUtc":  "2026-10-29T08:18:05.5161252Z"', '"completedUtc":  null').replace("[2026-10-29T08:18:05Z] Desk-PC backup completed\n", "");

const LINUX_RUNNING = `LoadState=loaded
ActiveState=activating
ExecMainStatus=0
@@log
2026-10-28T05:04:33-0700 nas01 project-backup[221846]: NAS backup completed with one or more source failures.
2026-10-28T23:08:31-0700 nas01 systemd[1]: project-backup.service: Failed with result 'exit-code'.
2026-10-28T23:08:31-0700 nas01 systemd[1]: Failed to start Back up the NAS offsite with Kopia.
2026-10-29T01:32:17-0700 nas01 project-backup[314340]: NAS backup starting at 2026-10-29T08:32:17Z
2026-10-29T01:32:17-0700 nas01 systemd[1]: project-backup.service: Failed with result 'exit-code'.
2026-10-29T09:52:28-0700 nas01 project-backup[333652]: NAS backup starting at 2026-10-29T16:52:28Z
`;

/** One login's output: each job's part after its `@@job` line. */
const jobs = (parts: Record<string, string>) => Object.entries(parts).map(([job, out]) => `@@job ${job}\n${out}`).join("");

test("backups: a machine target reads every job in one login; #job reads one", () => {
  assert.deepEqual(parseBackupTarget("mac:laptop"), { os: "mac", dest: "laptop", jobs: ["backup", "verify"], single: false });
  assert.deepEqual(parseBackupTarget("linux:robin@10.0.0.16"), { os: "linux", dest: "robin@10.0.0.16", jobs: ["backup", "verify", "restore"], single: false });
  assert.deepEqual(parseBackupTarget("linux:robin@10.0.0.16#restore"), { os: "linux", dest: "robin@10.0.0.16", jobs: ["restore"], single: true });
  assert.throws(() => parseBackupTarget("laptop"), /mac:, windows: or linux:/);
  assert.throws(() => parseBackupTarget("mac:laptop#restore"), /only linux/);

  const mac = backupCommand(parseBackupTarget("mac:laptop")).remote;
  assert.match(mac, /^echo @@job backup; launchctl print gui\/\$\(id -u\)\/local\.projectbackup\.snapshot .*backup\.log" 2>\/dev\/null; echo @@job verify; launchctl print gui\/\$\(id -u\)\/local\.projectbackup\.verify .*verify\.log" 2>\/dev\/null$/);
  assert.doesNotMatch(backupCommand(parseBackupTarget("mac:laptop#verify")).remote, /snapshot/);

  const win = backupCommand(parseBackupTarget("windows:desk-pc"));
  assert.equal(win.remote, "powershell -NoProfile -NonInteractive -Command -");
  assert.match(win.stdin!, /'@@job backup'[\s\S]*Project Backup Snapshot[\s\S]*backup-status\.json[\s\S]*Logs\\backup\.log[\s\S]*'@@job verify'[\s\S]*Project Backup Verify[\s\S]*Logs\\verify\.log/);
  assert.equal(win.stdin!.match(/backup-status\.json/g)!.length, 1, "the status file belongs to the backup job only");

  const linux = backupCommand(parseBackupTarget("linux:nas01")).remote;
  assert.equal(linux.match(/^echo @@job \w+|; echo @@job \w+/g)!.length, 3);
  assert.match(linux, /systemctl show project-backup-verify\.service -p LoadState -p ActiveState -p ExecMainStatus/);
  assert.match(linux, /journalctl -u project-backup-restore-test\.service /);
});

test("backups: hours per job from expect; a plain number is the backup's, or the named job's", () => {
  const machine = parseBackupTarget("linux:nas01");
  assert.deepEqual(backupHours(undefined, machine), { backup: 28, verify: 200, restore: 900 });
  assert.deepEqual(backupHours("30", machine), { backup: 30, verify: 200, restore: 900 });
  assert.deepEqual(backupHours("30, verify=150,restore = 1000", machine), { backup: 30, verify: 150, restore: 1000 });
  assert.deepEqual(backupHours("200", parseBackupTarget("linux:nas01#verify")), { backup: 28, verify: 200, restore: 900 });
  assert.deepEqual(backupHours("soon,verify=0,restore=-5", machine), { backup: 28, verify: 200, restore: 900 }, "anything else keeps the default");
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
  assert.match(backupCommand(parseBackupTarget("linux:nas01#restore"), names).remote, /^echo @@job restore; systemctl show nas-project-backup-restore-test\.service .*journalctl -u nas-project-backup-restore-test\.service /);
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

test("backups: a Mac run that ended in errors is down with kopia's summary and the exit code, in local time", () => {
  const r = parseJobOutput("mac", "backup", MAC_FAILED);
  assert.equal(r.running, false);
  assert.equal(r.exit, "30");
  assert.equal(r.installed, true);
  const o = backupOutcome("backup", r, 28, NOW);
  assert.equal(o.ok, false);
  assert.match(o.error!, /^backup at Oct 29, 4:00 AM failed: Found 44 fatal error\(s\) while snapshotting .* \(exit 30\); last good backup Oct 28, 4:07 AM \(33 h ago\)/);
  assert.equal(o.detail, "last good backup Oct 28, 4:07 AM (33 h ago)");
  assert.deepEqual({ ...o.state, error: undefined }, { job: "backup", state: "failed", max_hours: 28, last_good: "2026-10-28T08:07:35.000Z", last_run: "2026-10-29T08:00:05.000Z", error: undefined });

  // iCloud offloading names its cause.
  const offloaded = MAC_FAILED.replace("flush error", 'Error when processing "photo-tool/.git/objects/e1/bd3e": read /Users/robin/Projects/photo-tool/.git/objects/e1/bd3e: resource deadlock avoided\n'.repeat(2) + "flush error");
  assert.match(backupOutcome("backup", parseJobOutput("mac", "backup", offloaded), 28, NOW).error!, /Found 44 fatal error\(s\) while snapshotting \S+ \(2 on files iCloud offloaded from this Mac\) \(exit 30\)/);
});

test("backups: Desk-PC's completed status is up; a failed status names the failing sources", () => {
  const ok = backupOutcome("backup", parseJobOutput("windows", "backup", WIN_OK), 28, NOW);
  assert.equal(ok.ok, true);
  assert.equal(ok.detail, "last good backup Oct 29, 4:18 AM (9 h ago)");
  assert.equal(ok.state.state, "ok");
  // Too old.
  const old = backupOutcome("backup", parseJobOutput("windows", "backup", WIN_OK), 28, new Date("2026-10-30T14:00:00Z"));
  assert.equal(old.error, "last good backup Oct 29, 4:18 AM (30 h ago), older than 28 h");
  assert.equal(old.state.state, "stale");

  const failed = WIN_OK.replace('"state":  "complete"', '"state":  "failed"').replace('"success":  true', '"success":  false')
    .replace('"success": true, "exitCode": 0', '"success": false, "exitCode": 1').replace("[2026-10-29T08:18:05Z] Desk-PC backup completed\n", "").replace("@@task Ready 0", "@@task Ready 1");
  const o = backupOutcome("backup", parseJobOutput("windows", "backup", failed), 28, NOW);
  assert.equal(o.ok, false);
  assert.match(o.error!, /^backup at Oct 29, 4:18 AM failed: 1 source failed: D:\\Projects \(exit 1\); last good backup Oct 28, 4:19 AM/);
});

test("backups: a Windows run in progress is not a failure; one stopped before it finished is", () => {
  // A Windows desktop, 2026-11-08 and 11-09: a check during the run read the status the wrapper writes at the start ("running",
  // success false) as a failed run and opened "the backup at 3:15 AM failed: failed" until the run ended.
  const during = WIN_STARTED.replace("@@task Ready 0", "@@task Running 267009");
  const r = parseJobOutput("windows", "backup", during, new Date("2026-10-29T08:17:00Z"));
  assert.equal(r.running, true);
  assert.equal(r.events.filter((e) => e.kind === "fail").length, 0);
  const run = backupOutcome("backup", r, 28, new Date("2026-10-29T08:17:00Z"));
  assert.equal(run.ok, true);
  assert.match(run.detail!, /^running since Oct 29, 4:15 AM; last good backup Oct 28, 4:19 AM/);
  assert.equal(run.state.running, true);

  // The task is no longer running but the status never got its result: a restart stopped it.
  const stopped = backupOutcome("backup", parseJobOutput("windows", "backup", WIN_STARTED, new Date("2026-10-29T08:40:00Z")), 28, new Date("2026-10-29T08:40:00Z"));
  assert.equal(stopped.ok, false);
  assert.match(stopped.error!, /^backup at Oct 29, 4:15 AM failed: stopped before it finished; last good backup Oct 28, 4:19 AM/);
  // Within two minutes of the start the task may not show Running yet: still a run in progress.
  assert.equal(parseJobOutput("windows", "backup", WIN_STARTED, new Date("2026-10-29T08:16:00Z")).running, true);
});

test("backups: the NAS running with no good backup on record is down; its journal times are read", () => {
  const r = parseJobOutput("linux", "backup", LINUX_RUNNING);
  assert.equal(r.running, true);
  assert.deepEqual(r.events.map((e) => [new Date(e.at).toISOString(), e.kind]), [
    ["2026-10-28T12:04:33.000Z", "fail"], ["2026-10-29T06:08:31.000Z", "fail"], ["2026-10-29T08:32:17.000Z", "start"], ["2026-10-29T08:32:17.000Z", "fail"], ["2026-10-29T16:52:28.000Z", "start"],
  ]);
  const o = backupOutcome("backup", r, 28, NOW);
  assert.equal(o.ok, false);
  assert.equal(o.error, "running since Oct 29, 12:52 PM; the backup at Oct 29, 4:32 AM failed: systemd: exit-code; no good backup on record");
  assert.equal(o.detail, "no good backup on record");

  const done = LINUX_RUNNING.replace("ActiveState=activating", "ActiveState=inactive") + "2026-10-29T10:40:00-0700 nas01 project-backup[333652]: NAS backup completed at 2026-10-29T17:40:00Z\n";
  const fine = backupOutcome("backup", parseJobOutput("linux", "backup", done), 28, new Date("2026-10-29T18:00:00Z"));
  assert.equal(fine.ok, true);
  assert.equal(fine.detail, "last good backup Oct 29, 1:40 PM (20 min ago)");
  // The last attempt failing after a good run is down even while that good run is fresh.
  const after = done + "2026-10-29T11:00:00-0700 nas01 systemd[1]: project-backup.service: Failed with result 'timeout'.\n";
  assert.match(backupOutcome("backup", parseJobOutput("linux", "backup", after), 28, new Date("2026-10-29T18:30:00Z")).error!, /^backup at Oct 29, 2:00 PM failed: systemd: timeout; last good backup/);
});

test("backups: the machine is one result: any failing job makes it down and is named; a job the machine lacks is left out", () => {
  const t = parseBackupTarget("mac:laptop");
  const hours = backupHours("28", t);
  const backupOk = MAC_FAILED.replace("\tlast exit code = 30", "\tlast exit code = 0") + "[2026-10-29T08:09:00Z] Laptop backup completed\n";

  // Backup fine, verification 223 hours old: down, and only the verification is named.
  let o = machineOutcome(t, parseBackupOutput(t, jobs({ backup: backupOk, verify: MAC_VERIFY_OLD }), NOW), hours, NOW);
  assert.equal(o.ok, false);
  assert.equal(o.error, "last good verification Oct 20, 6:12 AM (9 days ago), older than 200 h");
  assert.deepEqual(o.jobs.map((j) => [j.job, j.state]), [["backup", "ok"], ["verify", "stale"]]);
  assert.equal(o.detail, "last good backup Oct 29, 4:09 AM (9 h ago); last good verification Oct 20, 6:12 AM (9 days ago)");

  // Both failing: one message, each job in it.
  o = machineOutcome(t, parseBackupOutput(t, jobs({ backup: MAC_FAILED, verify: MAC_VERIFY_OLD }), NOW), hours, NOW);
  assert.match(o.error!, /^Backup at Oct 29, 4:00 AM failed: .*\. Last good verification Oct 20/);

  // No verification job on this Mac: the backup alone decides.
  o = machineOutcome(t, parseBackupOutput(t, jobs({ backup: backupOk, verify: "@@log\n" }), NOW), hours, NOW);
  assert.equal(o.ok, true);
  assert.deepEqual(o.jobs.map((j) => j.job), ["backup"]);

  // No backup job at all is a failure, and so is a job the target names.
  const linux = parseBackupTarget("linux:nas01");
  const none = "LoadState=not-found\nActiveState=inactive\nExecMainStatus=0\n@@log\n";
  o = machineOutcome(linux, parseBackupOutput(linux, jobs({ backup: none, verify: none, restore: none }), NOW), backupHours("", linux), NOW);
  assert.equal(o.ok, false);
  assert.equal(o.error, "no backup job on nas01 (looked for project-backup.service)");
  assert.deepEqual(o.jobs, [{ job: "backup", state: "missing", max_hours: 28, error: "no backup job on nas01 (looked for project-backup.service)" }]);
  const restoreOnly = parseBackupTarget("linux:nas01#restore");
  assert.match(machineOutcome(restoreOnly, parseBackupOutput(restoreOnly, jobs({ restore: none }), NOW), backupHours("900", restoreOnly), NOW).error!, /^no restore test job on nas01 \(looked for project-backup-restore-test\.service\)/);
});

test("backups: one login per check; an unreachable machine skips the check and leaves the state alone", async () => {
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

    reply = { code: 0, stdout: jobs({ backup: MAC_FAILED, verify: MAC_VERIFY_OLD.replace("2026-10-20T10:12:00Z", "2026-10-26T10:12:00Z") }), stderr: "" };
    after = await runCheck(t.hub, m.id, NOW);
    assert.equal(after.fields.state, "down");
    assert.equal(after.fields.last_detail, "last good backup Oct 28, 4:07 AM (33 h ago); last good verification Oct 26, 6:12 AM (3 days ago)");
    assert.deepEqual((after.fields.jobs as { job: string; state: string }[]).map((j) => [j.job, j.state]), [["backup", "failed"], ["verify", "ok"]]);
    assert.equal(t.hub.store.list({ kind: "incident" }).length, 1);

    reply = { code: 0, stdout: jobs({ backup: MAC_FAILED + "[2026-10-29T16:00:00Z] Laptop backup starting\n[2026-10-29T16:09:00Z] Laptop backup completed\n", verify: "" }), stderr: "" };
    after = await runCheck(t.hub, m.id, NOW);
    assert.equal(after.fields.state, "up");
    assert.equal(after.fields.last_error, undefined);
    assert.equal(after.fields.last_detail, "last good backup Oct 29, 12:09 PM (51 min ago)");
    assert.deepEqual(calls.map((c) => c.split(" ")[0]), ["laptop", "laptop", "laptop"], "one login per check, not one per job");
  } finally {
    t.cleanup();
  }
});

test("backups: one-job monitors made before are folded into their machine's monitor once", async () => {
  const t = makeHub();
  try {
    const mk = (name: string, target: string, expect: string, extra: Record<string, unknown> = {}) =>
      t.hub.store.create("monitor", { name, type: "backup", target, expect, interval_s: 900, timeout_s: 90, fails_before_down: 1, enabled: true, ...extra });
    const nas = mk("NAS backup", "linux:robin@10.0.0.16", "28");
    const verify = mk("NAS backup verification", "linux:robin@10.0.0.16#verify", "200", { state: "down" });
    mk("NAS restore test", "linux:robin@10.0.0.16#restore", "1000", { timeout_s: 120 });
    const laptop = mk("Laptop backup", "mac:laptop", "28");
    t.hub.store.create("incident", { monitor_id: verify.id, name: "NAS backup verification", opened_at: NOW.toISOString(), checks_failed: 1 });

    assert.equal(mergeBackupMonitors(t.hub.store), 2);
    const left = t.hub.store.list({ kind: "monitor" });
    assert.deepEqual(left.map((m) => m.fields.name).sort(), ["Laptop backup", "NAS backup"]);
    const merged = t.hub.store.get(nas.id)!;
    assert.equal(merged.fields.expect, "28,restore=1000", "hours that differ from the defaults are kept");
    assert.equal(merged.fields.timeout_s, 120, "the longest timeout, since one login now reads three jobs");
    assert.equal(t.hub.store.get(laptop.id)!.fields.expect, "28");
    // The folded monitor's open incident moves to the machine's monitor (acknowledged or not) instead of coming back as a new alert.
    const moved = t.hub.store.list({ kind: "incident" }).filter((i) => !i.fields.closed_at);
    assert.deepEqual(moved.map((i) => [i.fields.monitor_id, i.fields.name]), [[nas.id, "NAS backup"]]);
    assert.equal(merged.fields.state, "down");
    assert.equal(mergeBackupMonitors(t.hub.store), 0, "nothing left to fold");

    // A verification monitor that is off is not folded into a machine monitor that is on.
    const off = mk("Laptop backup verification", "mac:laptop#verify", "200", { enabled: false });
    assert.equal(mergeBackupMonitors(t.hub.store), 0);
    assert.ok(!t.hub.store.get(off.id)!.deleted_at);

    // Checked as a whole once: a job monitor added again on purpose stays.
    t.hub.store.patchSilent(nas.id, { jobs: [{ job: "backup", state: "ok", max_hours: 28 }] });
    mk("NAS verification, stricter", "linux:robin@10.0.0.16#verify", "100");
    assert.equal(mergeBackupMonitors(t.hub.store), 0);
    assert.equal(t.hub.store.list({ kind: "monitor" }).length, 4);
  } finally {
    t.cleanup();
  }
});

test("backups: a good Windows status counts with its log lines out of view; an empty read says what the machine said", async () => {
  const noLog = WIN_OK.split("@@log")[0] + "@@log\n";
  const o = backupOutcome("backup", parseJobOutput("windows", "backup", noLog), 28, NOW);
  assert.equal(o.ok, true);
  assert.equal(o.detail, "last good backup Oct 29, 4:18 AM (9 h ago)");

  const t = makeHub();
  try {
    let reply = { code: 1, stdout: "", stderr: "journalctl: No journal files were opened due to insufficient permissions.\n" };
    t.hub.checkers.backup = backupChecker((async () => reply) as SshRunner);
    const m = t.hub.store.create("monitor", { name: "NAS backup", type: "backup", target: "linux:nas01", expect: "28", interval_s: 900, timeout_s: 60, fails_before_down: 1, enabled: true });
    const after = await runCheck(t.hub, m.id, NOW);
    assert.equal(after.fields.last_error, "nas01 answered but the read failed (exit 1): journalctl: No journal files were opened due to insufficient permissions.");

    // Never reached (a name typed wrong): a skip, but not for ever: three days after it was made it fails.
    reply = { code: 255, stdout: "", stderr: "ssh: Could not resolve hostname nas-typo: nodename nor servname provided\n" };
    const typo = t.hub.store.create("monitor", { name: "Typo backup", type: "backup", target: "linux:nas-typo", interval_s: 900, timeout_s: 60, fails_before_down: 1, enabled: true });
    const made = Date.parse(t.hub.store.get(typo.id)!.created_at);
    let r = await runCheck(t.hub, typo.id, new Date(made + 3600_000));
    assert.equal(r.fields.state ?? "unknown", "unknown");
    r = await runCheck(t.hub, typo.id, new Date(made + 73 * 3600_000));
    assert.equal(r.fields.state, "down");
    assert.match(String(r.fields.last_error), /nas-typo unreachable: .*nothing checked for 3 days/);
  } finally {
    t.cleanup();
  }
});
