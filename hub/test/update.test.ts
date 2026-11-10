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
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.org", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.org" } }).trim();

/** An "origin" with one commit and a clone of it as the installed app (with deploy/update.sh in it). */
function installed() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ea-update-"));
  const origin = path.join(root, "origin");
  fs.mkdirSync(path.join(origin, "deploy"), { recursive: true });
  git(root, "init", "-q", "-b", "main", origin);
  fs.copyFileSync(SCRIPT, path.join(origin, "deploy/update.sh"));
  fs.writeFileSync(path.join(origin, "a.txt"), "one\n");
  git(origin, "add", "-A"); git(origin, "commit", "-q", "-m", "First version");
  const app = path.join(root, "app");
  git(root, "clone", "-q", origin, app);
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
    assert.equal(launched[0].script, path.join(g.app, "deploy/update.sh"));
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

/** Runs deploy/update.sh from the clone with stand-ins for npm, the service manager and curl. */
function runScript(g: ReturnType<typeof installed>, opts: { npmFails?: boolean; healthFailsAfter?: string } = {}) {
  const home = path.join(g.root, "home");
  const bin = path.join(g.root, "bin");
  fs.mkdirSync(path.join(home, ".config/everythingapp"), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(home, ".config/everythingapp/hub.env"), `EA_DATA_DIR=${path.join(home, "data")}\nEA_PORT=8799\n`);
  const calls = path.join(g.root, "calls.log");
  fs.writeFileSync(calls, "");
  const stub = (name: string, body: string) => { fs.writeFileSync(path.join(bin, name), `#!/bin/bash\necho "${name} $*" >> "${calls}"\n${body}\n`, { mode: 0o755 }); };
  // npm ci fails while the clone is on the version named in FAIL_AT (the new one), when asked to.
  stub("npm", opts.npmFails ? `[ "$1" = ci ] && [ "$(git -C "${g.app}" rev-parse HEAD)" != "$(cat "${g.root}/from")" ] && exit 1; exit 0` : "exit 0");
  stub("systemctl", "exit 0");
  stub("launchctl", "exit 0");
  // The hub answers, except on the commit named in healthFailsAfter (the new version does not start).
  stub("curl", opts.healthFailsAfter ? `[ "$(git -C "${g.app}" rev-parse HEAD)" = "${opts.healthFailsAfter}" ] && exit 7; exit 0` : "exit 0");
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

test("update.sh: moves to the new version, installs and restarts; nothing newer says so", async () => {
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

test("update.sh: goes back to the old version when the new one does not install or does not start, and never overwrites changes", async () => {
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
