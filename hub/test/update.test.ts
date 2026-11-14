import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeHub } from "./helpers.js";
import { launchUpdate } from "../src/update.js";
import { runTool, TOOLS, type ToolContext, type ApiCall } from "../src/ai/tools.js";

// Updating the hub from the app or the assistant (hub/src/update.ts, deploy/update.sh).

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../deploy/update.sh");
const SCRIPT_PS1 = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../deploy/windows/update.ps1");
/** The updater the hub starts here: update.sh on Linux and macOS, deploy/windows/update.ps1 on Windows. */
const UPDATER = process.platform === "win32" ? "deploy/windows/update.ps1" : "deploy/update.sh";
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.org", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.org" } }).trim();

/** An "origin" with one commit and a clone of it as the installed app (with deploy/update.sh in it). */
function installed(shallow = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ea-update-"));
  const origin = path.join(root, "origin");
  fs.mkdirSync(path.join(origin, "deploy", "windows"), { recursive: true });
  git(root, "init", "-q", "-b", "main", origin);
  fs.copyFileSync(SCRIPT, path.join(origin, "deploy/update.sh"));
  fs.copyFileSync(SCRIPT_PS1, path.join(origin, "deploy/windows/update.ps1"));
  fs.writeFileSync(path.join(origin, "a.txt"), "one\n");
  git(origin, "add", "-A"); git(origin, "commit", "-q", "-m", "First version");
  const app = path.join(root, "app");
  // deploy/install.sh clones with --depth 1: only the newest commit, no history.
  if (shallow) git(root, "clone", "-q", "--depth", "1", `file://${origin}`, app);
  else git(root, "clone", "-q", origin, app);
  const commit = (msg: string, file = "a.txt", text = `${msg}\n`) => { fs.writeFileSync(path.join(origin, file), text); git(origin, "add", "-A"); git(origin, "commit", "-q", "-m", msg); return git(origin, "rev-parse", "HEAD"); };
  return { root, origin, app, commit };
}

function toolCtx(t: ReturnType<typeof makeHub>, lastUser: string): { ctx: ToolContext; api: ApiCall } {
  const api: ApiCall = async (method, p, body) => {
    const r = await t.api(p, { method, ...(body !== undefined ? { json: body } : {}) });
    return { status: r.status, data: await r.json() };
  };
  return { api, ctx: { sessionId: "s", lastUser, topic: "", store: t.hub.store, cfg: t.hub.cfg, hosts: null } as ToolContext };
}

test("hub update: a copy without git says it cannot update itself and offers nothing", async () => {
  const t = makeHub();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-update-copy-"));
  process.env.EA_UPDATE_APP_DIR = dir;
  try {
    const info = await (await t.api("/hub-update/check", { method: "POST" })).json() as any;
    assert.equal(info.installed_with_git, false);
    assert.equal(info.can_update, false);
    assert.match(info.reason, /not installed with git/);
    const r = await t.api("/hub-update", { method: "POST" });
    assert.equal(r.status, 409);
  } finally { delete process.env.EA_UPDATE_APP_DIR; t.cleanup(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("hub update: check lists what is new, the assistant installs only when asked, and the run is started outside the hub", async () => {
  const t = makeHub();
  const g = installed();
  process.env.EA_UPDATE_APP_DIR = g.app;
  const launched: { script: string; env: Record<string, string> }[] = [];
  const orig = launchUpdate.run;
  launchUpdate.run = async (script, env) => { launched.push({ script, env }); };
  try {
    let info = await (await t.api("/hub-update/check", { method: "POST" })).json() as any;
    assert.equal(info.installed_with_git, true);
    assert.equal(info.behind, 0);
    assert.equal(info.can_update, false, "nothing newer");
    g.commit("Watch speaks louder");
    g.commit("Update the hub from Settings", "b.txt");
    info = await (await t.api("/hub-update/check", { method: "POST" })).json() as any;
    assert.equal(info.behind, 2);
    assert.deepEqual(info.changes.map((c: any) => c.title), ["Update the hub from Settings", "Watch speaks louder"]);
    assert.equal(info.can_update, true);

    const tool = TOOLS.find((x) => x.name === "update_hub")!;
    // Asked what is new: told, nothing started.
    let { api, ctx } = toolCtx(t, "is there a hub update?");
    let out = JSON.parse((await runTool(api, { name: "update_hub", arguments: { action: "install" } }, ctx, [tool])).text);
    assert.match(out.error, /does not ask to update/);
    assert.equal(launched.length, 0);
    // "Update my task" is not about the hub.
    ({ api, ctx } = toolCtx(t, "update my dentist task to Friday"));
    out = JSON.parse((await runTool(api, { name: "update_hub", arguments: { action: "install" } }, ctx, [tool])).text);
    assert.match(out.error, /does not ask to update/);
    // Asked to update: started, with where to report and which branch.
    ({ api, ctx } = toolCtx(t, "Please update the hub"));
    out = JSON.parse((await runTool(api, { name: "update_hub", arguments: { action: "install" } }, ctx, [tool])).text);
    assert.equal(out.status, "started");
    assert.deepEqual(out.whats_new, ["Update the hub from Settings", "Watch speaks louder"]);
    assert.equal(launched.length, 1);
    assert.equal(launched[0].script, path.join(g.app, UPDATER));
    assert.equal(launched[0].env.EA_REF, "main");
    assert.equal(launched[0].env.EA_UPDATE_DIR, path.join(t.hub.cfg.dataDir, "update"));
    // One at a time.
    const again = await t.api("/hub-update", { method: "POST" });
    assert.equal(again.status, 409);
    info = await (await t.api("/hub-update")).json() as any;
    assert.equal(info.running, true);
    assert.equal(info.last_run.state, "starting");
    // Files changed by hand: refused, with why.
    fs.writeFileSync(path.join(t.hub.cfg.dataDir, "update/status.json"), JSON.stringify({ state: "done", message: "Updated.", from: null, to: null, at: new Date().toISOString() }));
    fs.writeFileSync(path.join(g.app, "a.txt"), "my own change\n");
    info = await (await t.api("/hub-update/check", { method: "POST" })).json() as any;
    assert.equal(info.can_update, false);
    assert.match(info.reason, /changed by hand/);
  } finally {
    launchUpdate.run = orig;
    delete process.env.EA_UPDATE_APP_DIR;
    t.cleanup();
    fs.rmSync(g.root, { recursive: true, force: true });
  }
});

/**
 * Runs deploy/update.sh from the clone with stand-ins for npm, the service manager and curl. `npm` and `curl` replace
 * the body of those stand-ins (bash, run in the clone).
 */
function runScript(g: ReturnType<typeof installed>, opts: { npmFails?: boolean; healthFailsAfter?: string; npm?: string; curl?: string } = {}) {
  const home = path.join(g.root, "home");
  const bin = path.join(g.root, "bin");
  fs.mkdirSync(path.join(home, ".config/everythingapp"), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(home, ".config/everythingapp/hub.env"), `EA_DATA_DIR=${path.join(home, "data")}\nEA_PORT=8799\n`);
  const calls = path.join(g.root, "calls.log");
  fs.writeFileSync(calls, "");
  const stub = (name: string, body: string) => { fs.writeFileSync(path.join(bin, name), `#!/bin/bash\necho "${name} $*" >> "${calls}"\n${body}\n`, { mode: 0o755 }); };
  // npm ci fails while the clone is on the version named in FAIL_AT (the new one), when asked to.
  stub("npm", opts.npm ?? (opts.npmFails ? `[ "$1" = ci ] && [ "$(git -C "${g.app}" rev-parse HEAD)" != "$(cat "${g.root}/from")" ] && exit 1; exit 0` : "exit 0"));
  stub("systemctl", "exit 0");
  stub("launchctl", "exit 0");
  // The hub answers, except on the commit named in healthFailsAfter (the new version does not start).
  stub("curl", opts.curl ?? (opts.healthFailsAfter ? `[ "$(git -C "${g.app}" rev-parse HEAD)" = "${opts.healthFailsAfter}" ] && exit 7; exit 0` : "exit 0"));
  stub("sleep", "exit 0");
  fs.writeFileSync(path.join(g.root, "from"), git(g.app, "rev-parse", "HEAD"));
  const script = path.join(g.app, "deploy/update.sh");
  return new Promise<{ status: any; calls: string; log: string }>((resolve) => {
    execFile("/bin/bash", [script], { env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, EA_UPDATE_DIR: path.join(home, "upd") }, timeout: 60_000 }, () => {
      resolve({
        status: JSON.parse(fs.readFileSync(path.join(home, "upd/status.json"), "utf8")),
        calls: fs.readFileSync(calls, "utf8"),
        log: fs.readFileSync(path.join(home, "upd/update.log"), "utf8"),
      });
    });
  });
}

// update.sh is the updater for Linux and macOS hubs (bash, a systemd or launchd service); Windows has its own.
const BASH_UPDATER = process.platform === "win32" ? "update.sh runs on Linux and macOS hubs" : false;

test("update.sh: moves to the new version, installs and restarts; nothing newer says so", { skip: BASH_UPDATER }, async () => {
  const g = installed();
  try {
    let r = await runScript(g);
    assert.equal(r.status.state, "up_to_date");
    const to = g.commit("Second version");
    r = await runScript(g);
    assert.equal(r.status.state, "done", r.log);
    assert.equal(git(g.app, "rev-parse", "HEAD"), to);
    assert.match(r.calls, /npm ci/);
    assert.match(r.calls, /npm --workspace web run build/);
    assert.match(r.calls, process.platform === "darwin" ? /launchctl kickstart -k/ : /systemctl --user restart everythingapp-hub/);
    assert.ok(!fs.existsSync(path.join(g.root, "home/upd/lock")), "the lock is gone");
  } finally { fs.rmSync(g.root, { recursive: true, force: true }); }
});

test("update.sh: goes back to the old version when the new one does not install or does not start, and never overwrites changes", { skip: BASH_UPDATER }, async () => {
  const g = installed();
  try {
    const from = git(g.app, "rev-parse", "HEAD");
    g.commit("Broken packages");
    let r = await runScript(g, { npmFails: true });
    assert.equal(r.status.state, "rolled_back", r.log);
    assert.match(r.status.message, /packages did not install/);
    assert.equal(git(g.app, "rev-parse", "HEAD"), from);

    const bad = g.commit("Does not start");
    r = await runScript(g, { healthFailsAfter: bad });
    assert.equal(r.status.state, "rolled_back", r.log);
    assert.match(r.status.message, /did not start/);
    assert.equal(git(g.app, "rev-parse", "HEAD"), from);

    fs.writeFileSync(path.join(g.app, "a.txt"), "changed by hand\n");
    r = await runScript(g);
    assert.equal(r.status.state, "failed");
    assert.match(r.status.message, /changed by hand/);
    assert.equal(fs.readFileSync(path.join(g.app, "a.txt"), "utf8"), "changed by hand\n");
  } finally { fs.rmSync(g.root, { recursive: true, force: true }); }
});

test("update.sh and the check work on a shallow clone, as the installer makes", { skip: BASH_UPDATER }, async () => {
  const g = installed(true);
  const t = makeHub();
  process.env.EA_UPDATE_APP_DIR = g.app;
  try {
    assert.equal(git(g.app, "rev-parse", "--is-shallow-repository"), "true");
    g.commit("Second version");
    g.commit("Third version", "c.txt");
    const info = await (await t.api("/hub-update/check", { method: "POST" })).json() as any;
    assert.equal(info.behind, 2, JSON.stringify(info));
    assert.deepEqual(info.changes.map((c: any) => c.title), ["Third version", "Second version"]);
    assert.equal(info.can_update, true);
    const r = await runScript(g);
    assert.equal(r.status.state, "done", r.log);
    assert.equal(git(g.app, "rev-parse", "HEAD"), git(g.origin, "rev-parse", "HEAD"));
    assert.equal(git(g.app, "rev-parse", "--is-shallow-repository"), "true", "a shallow clone whose history links up is not fetched in full");
  } finally { delete process.env.EA_UPDATE_APP_DIR; t.cleanup(); fs.rmSync(g.root, { recursive: true, force: true }); }
});

test("update.sh: a shallow clone that a fetch with --depth 1 broke is fetched in full once, and the update goes through", { skip: BASH_UPDATER }, async () => {
  const g = installed(true);
  try {
    const from = git(g.app, "rev-parse", "HEAD");
    const second = g.commit("Second version");
    // What deploy/install.ps1 did to an installed hub: the newest commit came without its parents, so git cannot link
    // it to the one the hub runs, and reads it as a rewritten branch. Later fetches do not mend it.
    git(g.app, "fetch", "-q", "--depth", "1", "origin", "main");
    assert.throws(() => git(g.app, "merge-base", "--is-ancestor", from, second));
    g.commit("Third version", "c.txt");
    const r = await runScript(g);
    assert.equal(r.status.state, "done", r.log);
    assert.match(r.log, /does not link up: fetching all of it/);
    assert.equal(git(g.app, "rev-parse", "HEAD"), git(g.origin, "rev-parse", "HEAD"));
    assert.equal(git(g.app, "rev-parse", "--is-shallow-repository"), "false");
  } finally { fs.rmSync(g.root, { recursive: true, force: true }); }
});

test("hub update check: a shallow clone that a fetch with --depth 1 broke is fetched in full once and offers the update", async () => {
  const g = installed(true);
  const t = makeHub();
  process.env.EA_UPDATE_APP_DIR = g.app;
  try {
    const from = git(g.app, "rev-parse", "HEAD");
    const second = g.commit("Second version");
    git(g.app, "fetch", "-q", "--depth", "1", "origin", "main");
    assert.throws(() => git(g.app, "merge-base", "--is-ancestor", from, second));
    g.commit("Third version", "c.txt");
    const info = await (await t.api("/hub-update/check", { method: "POST" })).json() as any;
    assert.equal(info.reason, undefined, JSON.stringify(info));
    assert.equal(info.behind, 2);
    assert.equal(info.can_update, true);
    assert.equal(git(g.app, "rev-parse", "--is-shallow-repository"), "false");
  } finally { delete process.env.EA_UPDATE_APP_DIR; t.cleanup(); fs.rmSync(g.root, { recursive: true, force: true }); }
});

/** The installed version's packages (at the root and in a workspace) and built web app, each file holding `version`. */
const PARTS = ["node_modules/.installed", "node_modules/dep/index.js", "hub/node_modules/own/index.js", "web/dist/index.html"];
function installParts(app: string, version: string) {
  for (const f of PARTS) { fs.mkdirSync(path.dirname(path.join(app, f)), { recursive: true }); fs.writeFileSync(path.join(app, f), version); }
}
const readIn = (app: string, f: string) => fs.readFileSync(path.join(app, f), "utf8").trim();

test("update.sh: npm ci that fails after deleting node_modules goes back to the packages and web app it had without npm, and the hub comes back", { skip: BASH_UPDATER }, async () => {
  const g = installed();
  const app = g.app;
  try {
    const from = git(app, "rev-parse", "HEAD");
    installParts(app, from);
    // The hub answers only with its packages in place.
    const curl = `[ -f "${app}/node_modules/.installed" ] || exit 7; exit 0`;
    g.commit("Packages that do not install");
    // As the real npm ci: node_modules goes first, then the network fails halfway through.
    let r = await runScript(g, { curl, npm: `if [ "$1" = ci ]; then rm -rf "${app}/node_modules" "${app}/hub/node_modules"; mkdir -p "${app}/node_modules/half" "${app}/web/node_modules/half"; exit 1; fi; exit 0` });
    assert.equal(r.status.state, "rolled_back", r.log);
    assert.match(r.status.message, /packages did not install/);
    assert.equal(git(app, "rev-parse", "HEAD"), from);
    for (const f of PARTS) assert.equal(readIn(app, f), from, f);
    assert.ok(!fs.existsSync(path.join(app, "node_modules/half")) && !fs.existsSync(path.join(app, "web/node_modules")), "what the failed install left is gone");
    assert.equal(r.calls.match(/^npm /gm)?.length, 1, "npm ran once, the npm ci that failed: going back needed none");
    assert.match(r.calls, process.platform === "darwin" ? /launchctl kickstart -k/ : /systemctl --user restart everythingapp-hub/);
    assert.ok(!fs.existsSync(path.join(app, ".update-backup")), "the backup is gone");

    // New packages that install, on which the hub does not start: the old ones go back, again without npm.
    g.commit("Does not start");
    const npmInstalls = (build: string) => `if [ "$1" = ci ]; then rm -rf "${app}/node_modules" "${app}/hub/node_modules"; mkdir -p "${app}/node_modules"; git -C "${app}" rev-parse HEAD > "${app}/node_modules/.installed"; fi
if [ "$1" = --workspace ]; then rm -rf "${app}/web/dist"; ${build}; fi
exit 0`;
    r = await runScript(g, { npm: npmInstalls(`mkdir -p "${app}/web/dist"; echo new > "${app}/web/dist/index.html"`), curl: `[ "$(cat "${app}/node_modules/.installed")" = "${from}" ] || exit 7; exit 0` });
    assert.equal(r.status.state, "rolled_back", r.log);
    assert.match(r.status.message, /did not start/);
    assert.equal(git(app, "rev-parse", "HEAD"), from);
    for (const f of PARTS) assert.equal(readIn(app, f), from, f);
    assert.equal(r.calls.match(/^npm /gm)?.length, 2, "npm ci and the build of the new version; none to go back");
    assert.ok(!fs.existsSync(path.join(app, ".update-backup")));

    // The update goes through but its web app does not build: the hub keeps the web app it had, and the backup goes.
    const good = g.commit("Works");
    r = await runScript(g, { curl, npm: npmInstalls("exit 1") });
    assert.equal(r.status.state, "done", r.log);
    assert.equal(git(app, "rev-parse", "HEAD"), good);
    assert.equal(readIn(app, "node_modules/.installed"), good);
    assert.equal(readIn(app, "web/dist/index.html"), from, "the web app it had");
    assert.ok(!fs.existsSync(path.join(app, ".update-backup")));
  } finally { fs.rmSync(g.root, { recursive: true, force: true }); }
});

test("update.sh: a backup a stopped update left is put back while the code is on its commit, and removed when it is not", { skip: BASH_UPDATER }, async () => {
  const g = installed();
  const app = g.app;
  const backup = path.join(app, ".update-backup");
  const leave = (commit: string, whole: boolean, parts: string[]) => {
    fs.mkdirSync(backup, { recursive: true });
    for (const p of parts) { fs.mkdirSync(path.dirname(path.join(backup, p)), { recursive: true }); fs.renameSync(path.join(app, p), path.join(backup, p)); }
    fs.writeFileSync(path.join(backup, ".commit"), `${commit}\n`);
    if (whole) fs.writeFileSync(path.join(backup, ".complete"), "");
  };
  try {
    const from = git(app, "rev-parse", "HEAD");
    installParts(app, from);
    // Stopped while going back: the packages wait in the backup, and half an install is where they were.
    leave(from, true, ["node_modules", "hub/node_modules"]);
    fs.mkdirSync(path.join(app, "node_modules/half"), { recursive: true });
    let r = await runScript(g);
    assert.equal(r.status.state, "up_to_date", r.log);
    for (const f of PARTS) assert.equal(readIn(app, f), from, f);
    assert.ok(!fs.existsSync(path.join(app, "node_modules/half")));
    assert.ok(!fs.existsSync(backup));

    // Stopped while setting aside (no .complete): only the places it emptied are filled; the rest stays as it is.
    leave(from, false, ["hub/node_modules"]);
    r = await runScript(g);
    assert.equal(r.status.state, "up_to_date", r.log);
    for (const f of PARTS) assert.equal(readIn(app, f), from, f);
    assert.ok(!fs.existsSync(backup));

    // The backup of another commit: no use to this code, so it goes and the packages here stay.
    fs.mkdirSync(path.join(backup, "node_modules/old"), { recursive: true });
    fs.writeFileSync(path.join(backup, ".commit"), `${"0".repeat(40)}\n`);
    r = await runScript(g);
    assert.equal(r.status.state, "up_to_date", r.log);
    assert.ok(!fs.existsSync(backup));
    for (const f of PARTS) assert.equal(readIn(app, f), from, f);
  } finally { fs.rmSync(g.root, { recursive: true, force: true }); }
});

test("another person's hub on a shared machine follows the owner's updates and offers none of its own", async () => {
  const t = makeHub();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ea-update-people-"));
  fs.mkdirSync(path.join(root, "etc/aeneas"), { recursive: true });
  fs.writeFileSync(path.join(root, "etc/aeneas/owner"), "someone-else\n");
  fs.writeFileSync(path.join(root, "etc/aeneas/people.json"), JSON.stringify([
    { name: "Sam", user: "someone-else", port: 1, owner: true },
    { name: "Jamie", user: os.userInfo().username, port: 2, owner: false },
  ]));
  process.env.EA_PEOPLE_ROOT = root;
  try {
    const info = await (await t.api("/hub-update/check", { method: "POST" })).json() as any;
    assert.equal(info.follows_owner, "Sam");
    assert.equal(info.can_update, false);
    assert.match(info.reason, /when Sam updates theirs, this one follows/);
    const r = await t.api("/hub-update", { method: "POST" });
    assert.equal(r.status, 409);
  } finally { delete process.env.EA_PEOPLE_ROOT; t.cleanup(); fs.rmSync(root, { recursive: true, force: true }); }
});
