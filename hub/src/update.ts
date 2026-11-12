import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Hub } from "./hub.js";
import { REPO_DIR } from "./config.js";
import { StoreError } from "./store.js";
import { errCode } from "./logsafe.js";
import { updatedWithOwner } from "./hubs.js";

/**
 * Updating the hub from the app (Settings, About) or the assistant (update_hub). A hub installed by
 * deploy/install.sh is a git clone of its branch: checking fetches the branch and lists what is new; updating runs
 * deploy/update.sh outside the hub's own service (it restarts the hub, and goes back to the old version when the new
 * one does not come up), and its progress is read from the status file it writes. A hub copied in without git says
 * so and offers nothing.
 */

export type UpdateState = "starting" | "checking" | "installing" | "restarting" | "rolling_back" | "done" | "up_to_date" | "rolled_back" | "failed";
export interface UpdateRun { state: UpdateState; message: string; from: string | null; to: string | null; at: string }
export interface UpdateCheck {
  installed_with_git: boolean;
  /** Another person's hub on a shared machine: it follows the owner's updates and has no update of its own. */
  follows_owner?: string;
  commit: string | null;
  committed_at: string | null;
  branch: string;
  checked_at: string | null;
  latest: string | null;
  behind: number;
  changes: { commit: string; title: string; at: string }[];
  /** Files changed by hand: the update would refuse. */
  local_changes: boolean;
  can_update: boolean;
  /** Why not, in words for the owner. */
  reason?: string;
  last_run: UpdateRun | null;
  running: boolean;
}

const RUNNING: UpdateState[] = ["starting", "checking", "installing", "restarting", "rolling_back"];
/** A run that has said nothing for this long was killed (a reboot): no longer counted as running. */
const STALE_MS = 30 * 60_000;
const COPY_REASON = "This hub was copied onto its machine, not installed with git, so it cannot update itself. Update it the way it was installed.";
const followsReason = (owner: string) => `This hub shares its machine with ${owner}'s and runs the same version: when ${owner} updates theirs, this one follows.`;

/** The checkout (EA_UPDATE_APP_DIR in tests). */
export function appDir(): string { return process.env.EA_UPDATE_APP_DIR || REPO_DIR; }
function updateDir(hub: Hub): string { return path.join(hub.cfg.dataDir, "update"); }

function git(args: string[], timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", appDir(), ...args], { timeout: timeoutMs, maxBuffer: 1 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout.trim());
    });
  });
}

async function isClone(): Promise<boolean> {
  try { return (await git(["rev-parse", "--is-inside-work-tree"])) === "true"; } catch { return false; }
}

async function branchOf(): Promise<string> {
  if (process.env.EA_REF) return process.env.EA_REF;
  try {
    const b = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
    return b && b !== "HEAD" ? b : "main";
  } catch { return "main"; }
}

export function lastRun(hub: Hub): UpdateRun | null {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(updateDir(hub), "status.json"), "utf8")) as UpdateRun;
    return r && typeof r.state === "string" ? r : null;
  } catch { return null; }
}

function isRunning(run: UpdateRun | null, now = Date.now()): boolean {
  return !!run && RUNNING.includes(run.state) && now - Date.parse(run.at) < STALE_MS;
}

let lastCheck: { at: string; latest: string; branch: string } | null = null;

/** What this hub runs and, with `fetch`, what is newer on its branch. Never throws for a missing network. */
export async function updateInfo(hub: Hub, fetch = false): Promise<UpdateCheck> {
  const run = lastRun(hub);
  const running = isRunning(run);
  const branch = await branchOf();
  const base: UpdateCheck = {
    installed_with_git: false, commit: null, committed_at: null, branch, checked_at: null, latest: null, behind: 0, changes: [],
    local_changes: false, can_update: false, last_run: run, running,
  };
  const owner = updatedWithOwner();
  if (owner) return { ...base, follows_owner: owner, reason: followsReason(owner) };
  if (!(await isClone())) return { ...base, reason: COPY_REASON };
  const [head, at, dirty] = await Promise.all([
    git(["rev-parse", "HEAD"]).catch(() => ""),
    git(["log", "-1", "--format=%cI"]).catch(() => ""),
    git(["status", "--porcelain", "--untracked-files=no"]).catch(() => ""),
  ]);
  const out: UpdateCheck = { ...base, installed_with_git: true, commit: head || null, committed_at: at || null, local_changes: dirty !== "" };
  if (fetch) {
    try {
      await git(["fetch", "--quiet", "origin", branch], 60_000);
      lastCheck = { at: new Date().toISOString(), latest: await git(["rev-parse", "FETCH_HEAD"]), branch };
    } catch (e) {
      console.error(`[update] check failed: ${errCode(e)}`);
      return { ...out, reason: "Could not reach the hub's code on GitHub. Try again later." };
    }
  }
  if (lastCheck && lastCheck.branch === branch) {
    out.checked_at = lastCheck.at;
    out.latest = lastCheck.latest;
    if (head && lastCheck.latest !== head) {
      const ahead = await git(["merge-base", "--is-ancestor", head, lastCheck.latest]).then(() => true, () => false);
      if (ahead) {
        out.behind = Number(await git(["rev-list", "--count", `${head}..${lastCheck.latest}`]).catch(() => "0")) || 0;
        const log = await git(["log", "-n", "15", "--format=%h%x1f%s%x1f%cI", `${head}..${lastCheck.latest}`]).catch(() => "");
        out.changes = log.split("\n").filter(Boolean).map((l) => { const [commit, title, when] = l.split("\x1f"); return { commit, title, at: when }; });
      } else {
        out.reason = "The newest version does not follow on from this one (the branch was rewritten). Update from a terminal with git.";
      }
    }
  }
  if (running) out.reason = "An update is running now.";
  else if (out.local_changes) out.reason = `Files in ${appDir()} were changed by hand, so an update would overwrite them. Keep or undo those changes first.`;
  out.can_update = !out.reason && out.behind > 0;
  return out;
}

/** How the update script is started: tests replace it. */
export type Launcher = (script: string, env: Record<string, string>) => Promise<void>;

/**
 * Started outside the hub's own service, because the update restarts it: under systemd as a transient user unit
 * (a child in the hub's service would be stopped with it), elsewhere in a session of its own.
 */
export const launchUpdate: { run: Launcher } = {
  run: (script, env) => new Promise((resolve, reject) => {
    const full = { ...process.env, ...env } as Record<string, string>;
    if (process.platform === "linux" && process.env.INVOCATION_ID) {
      const sets = Object.entries(env).flatMap(([k, v]) => [`--setenv=${k}=${v}`]);
      execFile("systemd-run", ["--user", "--collect", "--quiet", `--unit=aeneas-update-${Date.now()}`, `--setenv=PATH=${process.env.PATH ?? ""}`, `--setenv=HOME=${process.env.HOME ?? ""}`, ...sets, "/bin/bash", script],
        { timeout: 15_000, env: full }, (err) => (err ? reject(err) : resolve()));
      return;
    }
    try {
      if (script.endsWith(".ps1")) {
        // Windows, tested 2026-11-10: a child Node starts normally is in Node's own job and is killed when the hub
        // stops (the updater stops the hub, so it killed itself); one started detached has no console, and
        // PowerShell then exits at once without running its script. So a short launcher (normal, hidden) starts the
        // updater with Start-Process, as a process of its own that outlives the hub; the hub waits for the launcher.
        const quoted = `'"${script.replace(/'/g, "''")}"'`;
        const launch = `Start-Process -FilePath powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',${quoted}`;
        const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", launch], { stdio: "ignore", env: full, windowsHide: true });
        const timer = setTimeout(() => reject(new Error("the update launcher did not finish")), 20_000);
        child.on("error", (e) => { clearTimeout(timer); reject(e); });
        child.on("exit", (code) => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(`the update launcher exited with ${code}`)); });
        return;
      }
      const child = spawn("/bin/bash", [script], { detached: true, stdio: "ignore", env: full });
      child.on("error", reject);
      child.unref();
      setTimeout(resolve, 50);
    } catch (e) { reject(e); }
  }),
};

/** Start deploy/update.sh. The caller learns how it went from `updateInfo` (last_run). */
export async function startUpdate(hub: Hub): Promise<{ started: true; run: UpdateRun }> {
  const owner = updatedWithOwner();
  if (owner) throw new StoreError(409, followsReason(owner), { reason: "follows_owner" });
  if (!(await isClone())) throw new StoreError(409, COPY_REASON, { reason: "not_git" });
  if (isRunning(lastRun(hub))) throw new StoreError(409, "An update is already running.", { reason: "running" });
  // Linux and macOS: deploy/update.sh; Windows: its PowerShell twin.
  const script = process.platform === "win32" ? path.join(appDir(), "deploy", "windows", "update.ps1") : path.join(appDir(), "deploy", "update.sh");
  if (!fs.existsSync(script)) throw new StoreError(409, `This hub's copy has no ${path.relative(appDir(), script)}.`, { reason: "no_script" });
  const dir = updateDir(hub);
  fs.mkdirSync(dir, { recursive: true });
  const run: UpdateRun = { state: "starting", message: "Starting the update", from: (await git(["rev-parse", "HEAD"]).catch(() => "")) || null, to: null, at: new Date().toISOString() };
  fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(run));
  try {
    await launchUpdate.run(script, { EA_UPDATE_DIR: dir, EA_PORT: String(hub.cfg.port), EA_REF: await branchOf() });
  } catch (e) {
    const failed: UpdateRun = { ...run, state: "failed", message: "The update could not be started.", at: new Date().toISOString() };
    fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(failed));
    console.error(`[update] start failed: ${errCode(e)}`);
    throw new StoreError(500, failed.message);
  }
  console.log("[update] started");
  return { started: true, run };
}
