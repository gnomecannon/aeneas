import { execFile } from "node:child_process";
import type { CheckOutcome, Checker } from "./monitors.js";
import { feedStdin } from "./child.js";

/**
 * The `backup` monitor: reads a machine's ProjectBackup jobs over ssh from the hub's host, all in one login: the
 * backup itself, its verification and, on Linux, the restore test. Target `<os>:<ssh destination>`, e.g.
 * `mac:laptop` or `linux:backup@192.168.1.20`; `#backup`, `#verify` or `#restore` after it reads only that job.
 * `expect` holds the most hours since each job's last good run: a plain number for the backup (or the one job a
 * target names), and `verify=<hours>`, `restore=<hours>` for the others (defaults 28, 200 and 900: a nightly, a
 * weekly and a monthly job). A verification or restore test the machine does not have is left out; the backup job,
 * or a job the target names, being absent is a failure. Nothing runs on the machine except reading: launchd or Task
 * Scheduler state, the Windows wrapper's status file, the job's log or the systemd journal. Kopia's own snapshot
 * list is not used: it skips saving snapshots when nothing changed, so a quiet source looks stale there.
 */

export type BackupOs = "mac" | "windows" | "linux";
export type BackupJob = "backup" | "verify" | "restore";
/** `single`: the target named one job (`#verify`), so only that job is read and it has to be there. */
export interface BackupTarget { os: BackupOs; dest: string; jobs: BackupJob[]; single: boolean }
export interface BackupEvent { at: number; kind: "start" | "ok" | "fail"; detail?: string }
/** One job as read. `installed`: the machine has the job (its launchd job, scheduled task or unit, or a log of it). */
export interface BackupReport { running: boolean; events: BackupEvent[]; exit?: string; failure?: string; installed?: boolean }
/**
 * One job's result, kept on the monitor as `jobs` so the apps show each job on a line of its own: `ok`, `failed`
 * (the latest run failed), `stale` (the last good run is older than `max_hours`), `never` (no good run on record) or
 * `missing` (the job is not on the machine). `running` while a run is in progress.
 */
export interface BackupJobState {
  job: BackupJob;
  state: "ok" | "failed" | "stale" | "never" | "missing";
  running?: boolean;
  last_good?: string;
  last_run?: string;
  max_hours: number;
  error?: string;
}

export const DEFAULT_MAX_HOURS = 28;
/** Hours since the last good run, per job, when `expect` does not say: a nightly backup, a weekly verification, a monthly restore test. */
export const DEFAULT_HOURS: Record<BackupJob, number> = { backup: DEFAULT_MAX_HOURS, verify: 200, restore: 900 };
/** The jobs a ProjectBackup machine has: the restore test runs on Linux only. */
export const JOBS_OF: Record<BackupOs, BackupJob[]> = { mac: ["backup", "verify"], windows: ["backup", "verify"], linux: ["backup", "verify", "restore"] };
const WHAT: Record<BackupJob, string> = { backup: "backup", verify: "verification", restore: "restore test" };
const SSH_UNREACHABLE = 255;
/** A Windows status still "running" while its task is not, this long after the run began: the run was stopped. */
const STOPPED_AFTER_MS = 2 * 60_000;

export function parseBackupTarget(target: string): BackupTarget {
  // The destination is a host name or user@host, never something ssh would read as an option (-oProxyCommand=...).
  const m = /^(mac|windows|linux):([A-Za-z0-9_][A-Za-z0-9._@-]*)(?:#(backup|verify|restore))?$/.exec(target.trim());
  if (!m) throw new Error("backup target must be mac:, windows: or linux: then an ssh destination, optionally #verify or #restore");
  const os = m[1] as BackupOs;
  if (m[3] === "restore" && os !== "linux") throw new Error("only linux backups have a restore test");
  return m[3] ? { os, dest: m[2], jobs: [m[3] as BackupJob], single: true } : { os, dest: m[2], jobs: JOBS_OF[os], single: false };
}

/**
 * Hours per job from `expect`: `28`, `verify=150`, or `28,verify=200,restore=900`. A plain number is the backup's,
 * or the one job's a target names; anything else keeps the default.
 */
export function backupHours(expect: string | undefined, t: Pick<BackupTarget, "jobs" | "single">): Record<BackupJob, number> {
  const out = { ...DEFAULT_HOURS };
  for (const part of (expect ?? "").split(",")) {
    const m = /^\s*(?:(backup|verify|restore)\s*=\s*)?(\d+(?:\.\d+)?)\s*$/.exec(part);
    if (!m || !(Number(m[2]) > 0)) continue;
    out[(m[1] as BackupJob | undefined) ?? (t.single ? t.jobs[0] : "backup")] = Number(m[2]);
  }
  return out;
}

/**
 * What each machine calls its ProjectBackup jobs: launchd labels on a Mac, Task Scheduler task names on Windows,
 * systemd units on Linux. Settings EA_BACKUP_MAC_JOBS, EA_BACKUP_WINDOWS_TASKS and EA_BACKUP_LINUX_UNITS
 * (`backup=<name>,verify=<name>[,restore=<name>]`, hub/src/config.ts); a job left out keeps its default.
 */
export interface BackupJobNames {
  mac: { backup: string; verify: string };
  windows: { backup: string; verify: string };
  linux: { backup: string; verify: string; restore: string };
}
export const DEFAULT_BACKUP_JOBS: BackupJobNames = {
  mac: { backup: "local.projectbackup.snapshot", verify: "local.projectbackup.verify" },
  windows: { backup: "Project Backup Snapshot", verify: "Project Backup Verify" },
  linux: { backup: "project-backup.service", verify: "project-backup-verify.service", restore: "project-backup-restore-test.service" },
};
/** Names go into the read command, so only the characters such names use: no quotes, `$`, `;` or spaces where ssh's shell splits. */
const NAME_OK: Record<BackupOs, RegExp> = {
  mac: /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
  windows: /^[A-Za-z0-9][A-Za-z0-9 ._()-]*$/,
  linux: /^[A-Za-z0-9][A-Za-z0-9@._:-]*$/,
};

const SETTING: Record<BackupOs, string> = { mac: "EA_BACKUP_MAC_JOBS", windows: "EA_BACKUP_WINDOWS_TASKS", linux: "EA_BACKUP_LINUX_UNITS" };

/** One setting, `backup=<name>,verify=<name>[,restore=<name>]`, over the defaults. Unknown jobs and unsafe names are skipped. */
function jobNames<T extends Record<string, string>>(os: BackupOs, v: string | undefined, dflt: T): T {
  const out = { ...dflt };
  let skipped = 0;
  for (const part of (v ?? "").split(",")) {
    if (!part.trim()) continue;
    const i = part.indexOf("=");
    const job = i < 0 ? "" : part.slice(0, i).trim();
    const name = i < 0 ? "" : part.slice(i + 1).trim();
    if (!(job in out) || !NAME_OK[os].test(name)) { skipped++; continue; }
    (out as Record<string, string>)[job] = name;
  }
  if (skipped) console.warn(`[backups] ${SETTING[os]}: ${skipped} entries skipped (not job=name with a known job and a plain name)`);
  return out;
}

export function backupJobNames(env: { mac?: string; windows?: string; linux?: string } = {}): BackupJobNames {
  return {
    mac: jobNames("mac", env.mac, DEFAULT_BACKUP_JOBS.mac),
    windows: jobNames("windows", env.windows, DEFAULT_BACKUP_JOBS.windows),
    linux: jobNames("linux", env.linux, DEFAULT_BACKUP_JOBS.linux),
  };
}

const LOGS: Record<"backup" | "verify", string> = { backup: "backup.log", verify: "verify.log" };
const macOrWin = (job: BackupJob): "backup" | "verify" => (job === "verify" ? "verify" : "backup");

/** The name the machine knows a job by: its launchd label, scheduled task or systemd unit. */
export function jobName(os: BackupOs, job: BackupJob, names: BackupJobNames = DEFAULT_BACKUP_JOBS): string {
  return os === "linux" ? names.linux[job] : names[os][macOrWin(job)];
}

/**
 * The read-only command for every job of the target, in one login: ssh arguments after the destination, and a script
 * on stdin for Windows. Each job's output starts with a line `@@job <job>`.
 */
/** Days of journal to read for a job: enough to see its last good run at its limit, 40 at least. */
export const journalDays = (hours: number) => Math.max(40, Math.ceil(hours / 24) + 2);
/** Log lines read per job: a run that logs a line per file it could not read still leaves its start in view. */
const LOG_LINES = 3000;

export function backupCommand(t: BackupTarget, names: BackupJobNames = DEFAULT_BACKUP_JOBS, hours: Record<BackupJob, number> = DEFAULT_HOURS): { remote: string; stdin?: string } {
  if (t.os === "mac") {
    return { remote: t.jobs.map((job) => `echo @@job ${job}; launchctl print gui/$(id -u)/${names.mac[macOrWin(job)]} 2>/dev/null | head -n 80; echo @@log; tail -n ${LOG_LINES} "$HOME/Library/Application Support/ProjectBackup/logs/${LOGS[macOrWin(job)]}" 2>/dev/null`).join("; ") };
  }
  if (t.os === "windows") {
    const stdin = [`$d = Join-Path $env:LOCALAPPDATA 'ProjectBackup'`];
    for (const job of t.jobs) {
      const j = macOrWin(job);
      stdin.push(
        `'@@job ${job}'`,
        `$t = Get-ScheduledTask -TaskName '${names.windows[j]}' -ErrorAction SilentlyContinue`,
        `if ($t) { $i = $t | Get-ScheduledTaskInfo; '@@task ' + $t.State + ' ' + $i.LastTaskResult }`,
        ...(j === "backup" ? [`'@@status'`, `Get-Content -Raw (Join-Path $d 'backup-status.json') -ErrorAction SilentlyContinue`] : []),
        `'@@log'`,
        `Get-Content (Join-Path $d 'Logs\\${LOGS[j]}') -Tail ${LOG_LINES} -ErrorAction SilentlyContinue`,
      );
    }
    stdin.push("");
    return { remote: "powershell -NoProfile -NonInteractive -Command -", stdin: stdin.join("\n") };
  }
  return {
    remote: t.jobs.map((job) => {
      const unit = names.linux[job];
      return `echo @@job ${job}; systemctl show ${unit} -p LoadState -p ActiveState -p ExecMainStatus; echo @@log; journalctl -u ${unit} --since=-${journalDays(hours[job])}d -o short-iso --no-pager | grep -E 'starting at|completed|passed at|Failed with result|Failed to start'`;
    }).join("; "),
  };
}

const when = (s: string): number => {
  // journalctl short-iso writes offsets without a colon (-0400); Date wants -04:00.
  const t = new Date(s.replace(/([+-]\d{2})(\d{2})$/, "$1:$2")).getTime();
  return Number.isFinite(t) ? t : NaN;
};

const section = (out: string, name: string): string => {
  const i = out.indexOf(`@@${name}`);
  if (i < 0) return "";
  const rest = out.slice(i + name.length + 2);
  const j = rest.search(/^@@\w/m);
  return j < 0 ? rest : rest.slice(0, j);
};

/** `[2026-10-29T08:18:05Z] Desktop backup completed`: the line format of the Mac and Windows wrappers. */
function wrapperEvents(log: string, job: BackupJob): BackupEvent[] {
  const word = job === "verify" ? "verification" : "backup";
  const re = new RegExp(`^\\[([^\\]]+)\\] \\S+ ${word} (starting|completed|failed)\\b(.*)$`);
  const out: BackupEvent[] = [];
  let offloaded = 0;
  for (const raw of log.split(/\r?\n/)) {
    const line = raw.trim();
    const m = re.exec(line);
    if (m) {
      offloaded = 0;
      const at = when(m[1]);
      if (Number.isFinite(at)) out.push(m[2] === "starting" ? { at, kind: "start" } : { at, kind: m[2] === "completed" ? "ok" : "fail", detail: m[3].trim() || undefined });
      continue;
    }
    // For a run that ended without a closing line, keep its clearest error: kopia's "Found N fatal error(s)" summary, else the last error line.
    const last = out.at(-1);
    if (last?.kind !== "start") continue;
    // macOS refuses reads of iCloud files that were offloaded and not downloaded with "resource deadlock avoided".
    if (/resource deadlock avoided/.test(line)) offloaded++;
    if (/^Found \d+ fatal error/.test(line)) last.detail = line;
    else if (/\berror\b|failed/i.test(line) && !last.detail?.startsWith("Found ")) last.detail = line;
  }
  const tail = out.at(-1);
  if (tail?.kind === "start" && offloaded) tail.detail = `${tail.detail ?? "kopia errors"} (${offloaded} on files iCloud offloaded from this Mac)`;
  return out;
}

/** Each job's part of the output: from its `@@job <job>` line to the next one. */
function byJob(out: string): Map<BackupJob, string> {
  const marks = [...out.matchAll(/^@@job (backup|verify|restore)[ \t]*\r?$/gm)];
  const parts = new Map<BackupJob, string>();
  marks.forEach((m, i) => parts.set(m[1] as BackupJob, out.slice(m.index! + m[0].length, i + 1 < marks.length ? marks[i + 1].index : out.length)));
  return parts;
}

/** One job's output (its `@@job` part, or the whole output of a one-job read) as a report. */
export function parseJobOutput(os: BackupOs, job: BackupJob, out: string, now: Date = new Date()): BackupReport {
  if (os === "mac") {
    const head = out.split("@@log")[0];
    const state = /^\tstate = (.+)$/m.exec(head)?.[1]?.trim();
    const exit = /^\tlast exit code = (.+)$/m.exec(head)?.[1]?.trim();
    const events = wrapperEvents(section(out, "log"), job);
    return { running: state === "running", events, exit, failure: events.at(-1)?.kind === "start" ? events.at(-1)!.detail : undefined, installed: state !== undefined || events.length > 0 };
  }
  if (os === "windows") {
    const task = /^@@task (\S+) (-?\d+)/m.exec(out);
    const events = wrapperEvents(section(out, "log"), job);
    let running = task?.[1] === "Running";
    let failure: string | undefined;
    const raw = section(out, "status").trim();
    if (raw) {
      try {
        const s = JSON.parse(raw) as { state?: string; success?: boolean; startedUtc?: string; completedUtc?: string; error?: string | null; unavailableSources?: string[]; missingRequiredProjectMarkers?: string[]; sources?: { path: string; success: boolean }[] };
        if (s.state === "running") {
          // The wrapper writes "running" with success false when a run starts, and the result when it ends: a run in
          // progress is not a failure (it opened false incidents). Still "running" while the task is not, and not just
          // begun: the run was stopped before it finished (a restart for updates).
          const began = when(s.startedUtc ?? "");
          if (task && task[1] !== "Running" && Number.isFinite(began) && now.getTime() - began > STOPPED_AFTER_MS) {
            failure = "stopped before it finished";
            events.push({ at: began, kind: "fail", detail: failure });
          } else running = true;
        } else if (s.state === "complete" && s.success === true) {
          // A good run, also when its log lines are out of view.
          const done = when(s.completedUtc ?? "");
          if (Number.isFinite(done)) events.push({ at: done, kind: "ok" });
        } else if (s.state === "failed" || s.success === false) {
          const bad = (s.sources ?? []).filter((x) => !x.success).map((x) => x.path);
          const missing = [...(s.unavailableSources ?? []), ...(s.missingRequiredProjectMarkers ?? [])];
          failure = s.error || (bad.length ? `${bad.length} source${bad.length === 1 ? "" : "s"} failed: ${bad.slice(0, 3).join(", ")}` : missing.length ? `missing: ${missing.slice(0, 3).join(", ")}` : "failed");
          const at = when(s.completedUtc ?? s.startedUtc ?? "");
          if (Number.isFinite(at)) events.push({ at, kind: "fail", detail: failure });
        }
      } catch { /* a half-written file: the log still counts */ }
    }
    return { running, events: events.sort((a, b) => a.at - b.at), exit: task?.[2], failure, installed: !!task || events.length > 0 || !!raw };
  }
  const load = /^LoadState=(\S+)/m.exec(out)?.[1];
  const state = /^ActiveState=(\S+)/m.exec(out)?.[1];
  const exit = /^ExecMainStatus=(\S+)/m.exec(out)?.[1];
  const events: BackupEvent[] = [];
  for (const line of section(out, "log").split("\n")) {
    const m = /^(\S+) \S+ \S+: (.*)$/.exec(line);
    if (!m) continue;
    const logged = when(m[1]);
    const text = m[2];
    const stamped = / at (\d{4}-\d\d-\d\dT[\d:]+Z)$/.exec(text);
    const at = stamped ? when(stamped[1]) : logged;
    if (!Number.isFinite(at)) continue;
    if (/ starting at /.test(text)) events.push({ at, kind: "start" });
    else if (/one or more source failures/.test(text)) events.push({ at, kind: "fail", detail: "one or more sources failed" });
    else if (/ (completed|passed) at /.test(text)) events.push({ at, kind: "ok" });
    else if (/Failed with result '([^']+)'/.test(text)) events.push({ at, kind: "fail", detail: `systemd: ${/Failed with result '([^']+)'/.exec(text)![1]}` });
  }
  // systemd shows any unit name, even one that does not exist: LoadState says which.
  const installed = load !== undefined ? load !== "not-found" : events.length > 0;
  return { running: state === "activating" || state === "active" || state === "deactivating", events: events.sort((a, b) => a.at - b.at), exit, installed };
}

/** Every job of the target, read from one login's output. */
export function parseBackupOutput(t: BackupTarget, out: string, now: Date = new Date()): Map<BackupJob, BackupReport> {
  const parts = byJob(out);
  // A one-job read from before `@@job` lines (and tests that feed a job's own output) is that job's output.
  if (!parts.size && t.jobs.length === 1) parts.set(t.jobs[0], out);
  return new Map(t.jobs.map((job) => [job, parseJobOutput(t.os, job, parts.get(job) ?? "", now)]));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Nov 13, 3:17 AM" in the hub's own time zone (EA_TZ), which is the owner's. */
export const fmt = (ms: number) => {
  const d = new Date(ms);
  const h = d.getHours();
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${h % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};
const ago = (ms: number) => {
  const h = ms / 3600_000;
  return h < 1 ? `${Math.max(1, Math.round(h * 60))} min ago` : h < 48 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} days ago`;
};
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * One job. Ok when the last good run is within `maxHours` and the latest finished attempt is that good run. A run in
 * progress counts as fine while the last good run is still fresh. `detail` says when the last good run was; `state`
 * is the job's line for the apps.
 */
export function backupOutcome(job: BackupJob, r: BackupReport, maxHours: number, now: Date): CheckOutcome & { detail?: string; state: BackupJobState } {
  const what = WHAT[job];
  const lastOk = r.events.filter((e) => e.kind === "ok").at(-1);
  const lastFail = r.events.filter((e) => e.kind === "fail").at(-1);
  const lastStart = r.events.filter((e) => e.kind === "start").at(-1);
  const lastRun = r.events.length ? Math.max(...r.events.map((e) => e.at)) : NaN;
  const fresh = !!lastOk && now.getTime() - lastOk.at <= maxHours * 3600_000;
  const good = lastOk ? `last good ${what} ${fmt(lastOk.at)} (${ago(now.getTime() - lastOk.at)})` : `no good ${what} on record`;
  const base = { job, max_hours: maxHours, ...(r.running ? { running: true } : {}), ...(lastOk ? { last_good: iso(lastOk.at) } : {}), ...(Number.isFinite(lastRun) ? { last_run: iso(lastRun) } : {}) };
  const notFresh = lastOk ? "stale" as const : "never" as const;
  if (r.running) {
    const since = lastStart ? `running since ${fmt(lastStart.at)}` : "running";
    // A retry after a failed run is not a good run yet: it stays down until it finishes well (it flapped up and down).
    const failedBefore = lastFail && (!lastOk || lastFail.at > lastOk.at);
    if (failedBefore) {
      const error = `${since}; the ${what} at ${fmt(lastFail.at)} failed: ${lastFail.detail ?? r.failure ?? "did not finish"}; ${good}`.slice(0, 300);
      return { ok: false, error, detail: good, state: { ...base, state: "failed", error } };
    }
    if (fresh) return { ok: true, detail: `${since}; ${good}`, state: { ...base, state: "ok" } };
    const error = `${since}; ${good}`;
    return { ok: false, error, detail: good, state: { ...base, state: notFresh, error } };
  }
  const failedAfter = (lastFail && (!lastOk || lastFail.at > lastOk.at)) || (lastStart && (!lastOk || lastStart.at > lastOk.at));
  if (failedAfter) {
    const at = lastFail && (!lastStart || lastFail.at >= lastStart.at) ? lastFail.at : lastStart!.at;
    const why = (lastFail && lastFail.at === at ? lastFail.detail : undefined) ?? r.failure ?? lastStart?.detail ?? (r.exit && r.exit !== "0" ? `exit ${r.exit}` : "did not finish");
    const error = `${what} at ${fmt(at)} failed: ${why}${r.exit && r.exit !== "0" && !why.includes(`exit ${r.exit}`) ? ` (exit ${r.exit})` : ""}; ${good}`.slice(0, 300);
    return { ok: false, error, detail: good, state: { ...base, state: "failed", error } };
  }
  if (!fresh) {
    const error = lastOk ? `${good}, older than ${maxHours} h` : good;
    return { ok: false, error, detail: good, state: { ...base, state: notFresh, error } };
  }
  return { ok: true, detail: good, state: { ...base, state: "ok" } };
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The whole machine: ok when every job it has is. One incident and one alert for the machine, whichever job failed.
 * `jobs` keeps each job's line; `detail` joins their good runs. A verification or restore test the machine does not
 * have is left out; a missing backup job, or a missing job the target names, fails.
 */
export function machineOutcome(t: BackupTarget, reports: Map<BackupJob, BackupReport>, hours: Record<BackupJob, number>, now: Date, names: BackupJobNames = DEFAULT_BACKUP_JOBS): CheckOutcome & { detail?: string; jobs: BackupJobState[] } {
  const jobs: BackupJobState[] = [];
  const errors: string[] = [];
  const details: string[] = [];
  for (const job of t.jobs) {
    const r = reports.get(job);
    if (!r || r.installed === false) {
      if (job !== "backup" && !t.single) continue;
      const error = `no ${WHAT[job]} job on ${t.dest} (looked for ${jobName(t.os, job, names)})`;
      jobs.push({ job, state: "missing", max_hours: hours[job], error });
      errors.push(error);
      continue;
    }
    const o = backupOutcome(job, r, hours[job], now);
    jobs.push(o.state);
    if (!o.ok) errors.push(o.error ?? `${WHAT[job]} failed`);
    if (o.detail) details.push(o.detail);
  }
  const detail = details.length ? details.join("; ") : undefined;
  if (errors.length) return { ok: false, error: (errors.length === 1 ? errors[0] : errors.map(capital).join(". ")).slice(0, 300), ...(detail ? { detail } : {}), jobs };
  return { ok: true, ...(detail ? { detail } : {}), jobs };
}

export type SshRunner = (dest: string, remote: string, stdin: string | undefined, timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>;

export const sshRunner: SshRunner = (dest, remote, stdin, timeoutMs) => new Promise((resolve) => {
  const child = execFile("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "LogLevel=ERROR", dest, remote], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
    const code = err ? (typeof err.code === "number" ? err.code : err.killed ? -1 : 1) : 0;
    resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
  });
  feedStdin(child, stdin);
});

/**
 * ssh exits 255 for every error of its own. These say the machine answered and refused the hub (a reinstalled
 * machine's new host key, a key no longer authorized): that is a failure to fix, not a machine away.
 */
const SSH_REFUSED = /permission denied|host key verification failed|remote host identification has changed|too many authentication failures|unable to negotiate|no matching (host key|key exchange|cipher)|account (is )?(locked|expired)/i;

/** The checker: every job of the machine in one login. An unreachable machine is `skip`: a laptop away from home is not a failed backup. */
export function backupChecker(run: SshRunner = sshRunner, names: BackupJobNames = DEFAULT_BACKUP_JOBS): Checker {
  return async ({ target, expect, timeoutMs, now }) => {
    let t: BackupTarget;
    try { t = parseBackupTarget(target); } catch (e) { return { ok: false, error: (e as Error).message }; }
    const hours = backupHours(expect, t);
    const cmd = backupCommand(t, names, hours);
    const r = await run(t.dest, cmd.remote, cmd.stdin, timeoutMs);
    if (r.code === SSH_UNREACHABLE && SSH_REFUSED.test(r.stderr)) return { ok: false, error: `${t.dest} refused the hub's ssh login: ${r.stderr.trim().split("\n").find((l) => SSH_REFUSED.test(l)) ?? ""}`.slice(0, 300) };
    if (r.code === SSH_UNREACHABLE) return { ok: false, skip: true, error: `${t.dest} unreachable: ${r.stderr.trim().split("\n").at(-1) ?? ""}`.slice(0, 300) };
    if (r.code === -1) return { ok: false, skip: true, error: `${t.dest} did not answer within ${Math.round(timeoutMs / 1000)} s` };
    const reports = parseBackupOutput(t, r.stdout, now);
    // The login worked but nothing came back for any job: say what the machine said, not "no backup job".
    if (![...reports.values()].some((x) => x.installed !== false) && (r.code !== 0 || r.stderr.trim())) {
      return { ok: false, error: `${t.dest} answered but the read failed (exit ${r.code})${r.stderr.trim() ? `: ${r.stderr.trim().split("\n").at(-1)}` : ""}`.slice(0, 300) };
    }
    return machineOutcome(t, reports, hours, now, names);
  };
}
