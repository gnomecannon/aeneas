import { execFile } from "node:child_process";
import type { CheckOutcome, Checker } from "./monitors.js";
import { feedStdin } from "./child.js";

/**
 * The `backup` monitor: reads a ProjectBackup job's own records over ssh from the hub's host and checks that its
 * latest run succeeded and that the last good run is recent. Target `<os>:<ssh destination>[#job]`, e.g.
 * `mac:laptop`, `windows:desktop#verify`, `linux:backup@192.168.1.20#restore`; `expect` is the most hours since
 * the last good run (default 28). Nothing runs on the machine except reading: launchd or Task Scheduler state,
 * the Windows wrapper's status file, the job's log or the systemd journal. Kopia's own snapshot list is not used: it skips
 * saving snapshots when nothing changed, so a quiet source looks stale there.
 */

export type BackupOs = "mac" | "windows" | "linux";
export type BackupJob = "backup" | "verify" | "restore";
export interface BackupTarget { os: BackupOs; dest: string; job: BackupJob }
export interface BackupEvent { at: number; kind: "start" | "ok" | "fail"; detail?: string }
export interface BackupReport { running: boolean; events: BackupEvent[]; exit?: string; failure?: string }

export const DEFAULT_MAX_HOURS = 28;
const SSH_UNREACHABLE = 255;

export function parseBackupTarget(target: string): BackupTarget {
  // The destination is a host name or user@host, never something ssh would read as an option (-oProxyCommand=...).
  const m = /^(mac|windows|linux):([A-Za-z0-9_][A-Za-z0-9._@-]*)(?:#(backup|verify|restore))?$/.exec(target.trim());
  if (!m) throw new Error("backup target must be mac:, windows: or linux: then an ssh destination, optionally #verify or #restore");
  const job = (m[3] ?? "backup") as BackupJob;
  if (job === "restore" && m[1] !== "linux") throw new Error("only linux backups have a restore test");
  return { os: m[1] as BackupOs, dest: m[2], job };
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

/** The read-only command for a job: ssh arguments after the destination, and a script on stdin for Windows. */
export function backupCommand(t: BackupTarget, names: BackupJobNames = DEFAULT_BACKUP_JOBS): { remote: string; stdin?: string } {
  if (t.os === "mac") {
    const job = t.job === "verify" ? "verify" : "backup";
    return { remote: `launchctl print gui/$(id -u)/${names.mac[job]} 2>/dev/null | head -n 80; echo @@log; tail -n 400 "$HOME/Library/Application Support/ProjectBackup/logs/${LOGS[job]}"` };
  }
  if (t.os === "windows") {
    const job = t.job === "verify" ? "verify" : "backup";
    const j = { task: names.windows[job], log: LOGS[job] };
    const stdin = [
      `$d = Join-Path $env:LOCALAPPDATA 'ProjectBackup'`,
      `$t = Get-ScheduledTask -TaskName '${j.task}' -ErrorAction SilentlyContinue`,
      `if ($t) { $i = $t | Get-ScheduledTaskInfo; '@@task ' + $t.State + ' ' + $i.LastTaskResult }`,
      ...(t.job === "backup" ? [`'@@status'`, `Get-Content -Raw (Join-Path $d 'backup-status.json') -ErrorAction SilentlyContinue`] : []),
      `'@@log'`,
      `Get-Content (Join-Path $d 'Logs\\${j.log}') -Tail 400 -ErrorAction SilentlyContinue`,
      "",
    ].join("\n");
    return { remote: "powershell -NoProfile -NonInteractive -Command -", stdin };
  }
  const unit = names.linux[t.job];
  return { remote: `systemctl show ${unit} -p ActiveState -p ExecMainStatus; echo @@log; journalctl -u ${unit} --since=-40d -o short-iso --no-pager | grep -E 'starting at|completed|passed at|Failed with result|Failed to start'` };
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

export function parseBackupOutput(t: BackupTarget, out: string): BackupReport {
  if (t.os === "mac") {
    const head = out.split("@@log")[0];
    const state = /^\tstate = (.+)$/m.exec(head)?.[1]?.trim();
    const exit = /^\tlast exit code = (.+)$/m.exec(head)?.[1]?.trim();
    const events = wrapperEvents(section(out, "log"), t.job);
    return { running: state === "running", events, exit, failure: events.at(-1)?.kind === "start" ? events.at(-1)!.detail : undefined };
  }
  if (t.os === "windows") {
    const task = /^@@task (\S+) (-?\d+)/m.exec(out);
    const events = wrapperEvents(section(out, "log"), t.job);
    let running = task?.[1] === "Running";
    let failure: string | undefined;
    const raw = section(out, "status").trim();
    if (raw) {
      try {
        const s = JSON.parse(raw) as { state?: string; success?: boolean; startedUtc?: string; completedUtc?: string; error?: string | null; unavailableSources?: string[]; missingRequiredProjectMarkers?: string[]; sources?: { path: string; success: boolean }[] };
        if (s.state === "running") running = true;
        const bad = (s.sources ?? []).filter((x) => !x.success).map((x) => x.path);
        const missing = [...(s.unavailableSources ?? []), ...(s.missingRequiredProjectMarkers ?? [])];
        if (s.state === "failed" || s.success === false) {
          failure = s.error || (bad.length ? `${bad.length} source${bad.length === 1 ? "" : "s"} failed: ${bad.slice(0, 3).join(", ")}` : missing.length ? `missing: ${missing.slice(0, 3).join(", ")}` : "failed");
          const at = when(s.completedUtc ?? s.startedUtc ?? "");
          if (Number.isFinite(at)) events.push({ at, kind: "fail", detail: failure });
        }
      } catch { /* a half-written file: the log still counts */ }
    }
    return { running, events: events.sort((a, b) => a.at - b.at), exit: task?.[2], failure };
  }
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
  return { running: state === "activating" || state === "active" || state === "deactivating", events: events.sort((a, b) => a.at - b.at), exit };
}

const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
const ago = (ms: number) => {
  const h = ms / 3600_000;
  return h < 1 ? `${Math.max(1, Math.round(h * 60))} min ago` : h < 48 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} days ago`;
};

/**
 * Ok when the last good run is within `maxHours` and the latest finished attempt is that good run. A run in
 * progress counts as fine while the last good run is still fresh. `detail` says when the last good run was.
 */
export function backupOutcome(t: BackupTarget, r: BackupReport, maxHours: number, now: Date): CheckOutcome & { detail?: string } {
  const what = t.job === "verify" ? "verification" : t.job === "restore" ? "restore test" : "backup";
  const lastOk = r.events.filter((e) => e.kind === "ok").at(-1);
  const lastFail = r.events.filter((e) => e.kind === "fail").at(-1);
  const lastStart = r.events.filter((e) => e.kind === "start").at(-1);
  const fresh = !!lastOk && now.getTime() - lastOk.at <= maxHours * 3600_000;
  const good = lastOk ? `last good ${what} ${fmt(lastOk.at)} (${ago(now.getTime() - lastOk.at)})` : `no good ${what} on record`;
  if (r.running) {
    const since = lastStart ? `running since ${fmt(lastStart.at)}` : "running";
    // A retry after a failed run is not a good run yet: it stays down until it finishes well (it flapped up and down).
    const failedBefore = lastFail && (!lastOk || lastFail.at > lastOk.at);
    if (failedBefore) return { ok: false, error: `${since}; the ${what} at ${fmt(lastFail.at)} failed: ${lastFail.detail ?? r.failure ?? "did not finish"}; ${good}`.slice(0, 300), detail: good };
    return fresh ? { ok: true, detail: `${since}; ${good}` } : { ok: false, error: `${since}; ${good}`, detail: good };
  }
  const failedAfter = (lastFail && (!lastOk || lastFail.at > lastOk.at)) || (lastStart && (!lastOk || lastStart.at > lastOk.at));
  if (failedAfter) {
    const at = lastFail && (!lastStart || lastFail.at >= lastStart.at) ? lastFail.at : lastStart!.at;
    const why = (lastFail && lastFail.at === at ? lastFail.detail : undefined) ?? r.failure ?? lastStart?.detail ?? (r.exit && r.exit !== "0" ? `exit ${r.exit}` : "did not finish");
    return { ok: false, error: `${what} at ${fmt(at)} failed: ${why}${r.exit && r.exit !== "0" && !why.includes(`exit ${r.exit}`) ? ` (exit ${r.exit})` : ""}; ${good}`.slice(0, 300), detail: good };
  }
  if (!fresh) return { ok: false, error: lastOk ? `${good}, older than ${maxHours} h` : good, detail: good };
  return { ok: true, detail: good };
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

/** The checker. An unreachable machine is `skip`: a laptop away from home is not a failed backup. */
export function backupChecker(run: SshRunner = sshRunner, names: BackupJobNames = DEFAULT_BACKUP_JOBS): Checker {
  return async ({ target, expect, timeoutMs, now }) => {
    let t: BackupTarget;
    try { t = parseBackupTarget(target); } catch (e) { return { ok: false, error: (e as Error).message }; }
    const hours = Number((expect ?? "").trim()) > 0 ? Number(expect) : DEFAULT_MAX_HOURS;
    const cmd = backupCommand(t, names);
    const r = await run(t.dest, cmd.remote, cmd.stdin, timeoutMs);
    if (r.code === SSH_UNREACHABLE && SSH_REFUSED.test(r.stderr)) return { ok: false, error: `${t.dest} refused the hub's ssh login: ${r.stderr.trim().split("\n").find((l) => SSH_REFUSED.test(l)) ?? ""}`.slice(0, 300) };
    if (r.code === SSH_UNREACHABLE) return { ok: false, skip: true, error: `${t.dest} unreachable: ${r.stderr.trim().split("\n").at(-1) ?? ""}`.slice(0, 300) };
    if (r.code === -1) return { ok: false, skip: true, error: `${t.dest} did not answer within ${timeoutMs} ms` };
    return backupOutcome(t, parseBackupOutput(t, r.stdout), hours, now);
  };
}
