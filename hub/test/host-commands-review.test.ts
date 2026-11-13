import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { makeHub, type TestHub } from "./helpers.js";
import { ctxFor, scripted } from "./ai-helpers.js";
import { setBackendOverride } from "../src/ai/backends.js";
import { opsForModel, renderResult, runTool } from "../src/ai/tools.js";
import { isReadOnly, nonInteractive, spawnRunner, type Host, type RunResult } from "../src/ai/hosts.js";
import { fitToolResults } from "../src/ai/history.js";
import { closeSession, hostMemory, runbookForModel } from "../src/memory.js";
import type { ChatOutput } from "../src/ai/index.js";

// Each case was a finding of the 2026-11-13 review of host commands (approval, the read-only check, running, the
// journal); each fails on the code before the fix.

const api = (t: TestHub) => async (method: string, p: string, body?: unknown) => {
  const res = await t.app.request(p, { method, headers: { authorization: `Bearer ${t.hub.cfg.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, data: await res.json().catch(() => null) };
};
const chat = async (t: TestHub, body: Record<string, unknown>) => (await t.api("/ai/chat", { method: "POST", json: body })).json() as Promise<ChatOutput>;

/** A hub whose machines are storage and core (over ssh), with a runner that records what ran instead of running it. */
function withMachines() {
  const t = makeHub();
  fs.writeFileSync(path.join(t.dir, "hosts.json"), JSON.stringify([{ name: "storage", ssh: "robin@10.0.0.16" }, { name: "core", ssh: "core" }]));
  t.hub.ai.hosts.forget();
  const ran: string[] = [];
  t.hub.ai.hosts.runner = async (_h: Host, cmd: string): Promise<RunResult> => { ran.push(cmd); return { exit_code: 0, output: "ok", timed_out: false, ms: 1 }; };
  return { t, ran };
}

test("H1 read-only check: redirects, zsh and bash forms, write options, ip, git, nmcli and secrets wait for approval", () => {
  const linux = [
    // A > after - or = is a redirect all the same.
    "echo x ->~/.bashrc", "echo a=>~/.profile",
    // zsh (a Mac's login shell over ssh): =(cmd) and glob qualifiers run code; so do a bash function and fish's (cmd).
    "cat =(touch /tmp/p)", "ls *(e:'touch /tmp/p':)", "ls /etc/hosts(e:'touch /tmp/p':)", "ls () ( touch /tmp/p ); ls", "echo $~x", "echo (touch /tmp/p)",
    // Shell syntax the check read differently from the shell: a comment hiding a quote, ANSI-C quoting, a
    // here-document, brace expansion, a quoted or line-joined option, a shortened long option.
    "ls # '\ntouch /tmp/p\n# '", "echo $'\\'' ; touch /tmp/p ; echo \\'", "cat <<EOF\nls '\nEOF\ntouch /tmp/p\necho '", "sort {-o,/tmp/p} f",
    "find . -name x {-delete,}", "sort -\"o\" /tmp/p f", "sort -\\\no /tmp/p f", "sort --out=/tmp/p f", "less --log-f=/tmp/p f", "sed --in s/a/b/ f",
    // Write options the checker missed.
    "curl -s -w '%output{>>/home/u/.bashrc}x' http://core/", "curl -s -w @/tmp/fmt http://core/", "curl -s --variable '%GITHUB_TOKEN' http://core/",
    "openssl x509 -in c.pem -out=/tmp/p", "openssl x509 -in c.pem --out /tmp/p", "openssl x509 -engine /tmp/x.so -in c.pem", "docker compose config -o /tmp/p --services",
    "awk 'BEGIN{f=\"sys\" \"tem\"; @f(\"id\")}'", "awk '@load \"x\"; BEGIN{}'", "awk -f/tmp/prog.awk f", "date -us 2020-01-01", "date 0101", "date --se now", "ss -tK dst 1.2.3.4",
    "smartctl -tlong /dev/sda", "smartctl -l scterc,70,70 /dev/sda", "dmesg -rc", "arp -nd 10.0.0.1", "hostname --file=/etc/x", "hostname -F /etc/x", "zpool events -vc",
    "tree -ao /tmp/p /etc", "yq -Pi '.a=1' f.yml", "journalctl --vac=1d",
    // ip: a flag first no longer stands for the object.
    "ip -4 netns exec ns rm -rf /x", "ip -s netns attach n 1", "ip -4 xfrm state deleteall", "ip a d 10.9.9.9/24 dev lo", "ip -n ns route flush all", "ip vrf exec blue sh", "ip -batch /tmp/cmds",
    // Secrets: variables, other tools' logins, the environment, recursive reads of a folder holding keys.
    "echo $GITHUB_TOKEN", "echo ${AWS_SECRET_ACCESS_KEY}", "echo \"$OPENAI_API_KEY\"", "cat ~/client_secret.json", "cat ~/.config/gh/hosts.yml", "cat ~/.docker/config.json",
    "cat ~/.config/rclone/rclone.conf", "cat /etc/wireguard/wg0.conf", "cat /var/lib/tailscale/tailscaled.state", "cat /var/lib/tail*/tailscaled.st*", "cat /etc/ssh/ssh_host_ed25519_key",
    "cat /etc/NetworkManager/system-connections/home.nmconnection", "tail /home/*/.bash_history", "docker inspect web", "docker container inspect web", "docker inspect -f '{{.Config.Env}}' web",
    "docker inspect -f '{{json .}}' web", "docker compose config", "ps eww", "ps auxe", "ps -E", "jq -n env", "jq -n '$ENV.HOME'", "systemctl show nginx", "systemctl show -p Environment nginx",
    "launchctl print system/com.x", "grep -r . ~", "grep -rn PRIVATE /etc", "grep -R key /", "rg -uu token2 /home/u", "diff -r /etc /mnt/old/etc", "cd / && grep -r x etc",
    // git, nmcli: only their listing forms read.
    "git branch --delete x", "git branch -v -d x", "git branch -dr origin/x", "git branch -t new", "git branch --force x main", "git branch evil", "git tag -m m v9",
    "git tag --delete v1", "git tag -a v2", "git remote -v prune origin", "git remote add x http://core/x", "git config --unse core.x",
    "nmcli general hostname evil", "nmcli dev wifi hotspot", "nmcli d w h", "nmcli dev wifi show-password", "nmcli -s connection show home", "nmcli radio wifi off", "nmcli networking off", "nmcli agent secret",
  ];
  for (const c of linux) assert.equal(isReadOnly(c, "linux"), false, c);
  const windows = [
    "netsh wlan disconnect", "netsh interface set interface x disable", "wmic /output:C:\\x.txt process list", "wmic /append:C:\\x.txt os get", "wmic /record:C:\\x.xml os get",
    "netsh wlan show profile name=home key=clear", "Get-ChildItem Env:", "dir env:", "echo $env:GITHUB_TOKEN", "Get-Item Env:AWS_SECRET_ACCESS_KEY",
  ];
  for (const c of windows) assert.equal(isReadOnly(c, "windows"), false, c);
  const linuxReads = [
    "ip -br a", "ip -4 route", "ip -s link", "ip route get 1.1.1.1", "ip -n blue addr", "ip netns", "ip xfrm state list", "ip -j -p addr show dev eth0", "ip neigh",
    "git branch -a", "git branch -vv --contains HEAD", "git branch --list 'feat*'", "git tag -l 'v*'", "git tag -n5", "git remote -v", "git remote show origin", "git remote get-url origin",
    "nmcli", "nmcli device status", "nmcli -t -f NAME connection show", "nmcli c s", "nmcli general hostname", "nmcli dev wifi list", "nmcli radio", "nmcli networking connectivity check",
    "date +%F", "date -u -d yesterday +%s", "date -Iseconds", "hostname -f", "ss -tlnp", "smartctl -a /dev/sda", "smartctl -l error /dev/sda", "dmesg -T --level=err", "arp -an", "sensors -u",
    "ps aux", "ps -eo pid,user,comm", "ps -ef", "docker inspect -f '{{.State.Status}} {{.RestartCount}}' web", "docker compose config --services", "systemctl show -p ActiveState,SubState nginx",
    "grep -rn error /var/log", "grep -rn listen /etc/nginx", "echo $HOME $USER ${PATH} $?", "df -h # disk usage (root)", "ls -la /var/log 2>&1", "du -sh /var/*", "cat <<< x",
    "curl -s -w '%{http_code}' http://core:8787/health", "awk -F: '{print $1}' /etc/passwd", "journalctl -u nginx --since today --no-pager", "grep -c '^$' f", "launchctl list",
    "find /var/log -name '*.{log,gz}'", "git log --format='%h %s (%an)' -5",
  ];
  for (const c of linuxReads) assert.equal(isReadOnly(c, "linux"), true, c);
  const windowsReads = ["netsh interface show interface", "netsh wlan show interfaces", "netsh advfirewall firewall show rule name=all", "wmic os get caption", "echo $env:COMPUTERNAME", "Get-Item Env:PATH"];
  for (const c of windowsReads) assert.equal(isReadOnly(c, "windows"), true, c);
});

test("H2 sudo -n goes only where sudo is the command a segment runs, never into quoted text", () => {
  assert.equal(nonInteractive("sed -i 's/sudo reboot/x/' f"), "sed -i 's/sudo reboot/x/' f");
  assert.equal(nonInteractive('echo "sudo rm x" && sudo apt update'), 'echo "sudo rm x" && sudo -n apt update');
  assert.equal(nonInteractive("sudo -n true; ls | sudo tee /x; FOO=1 sudo ls; if sudo test -f x; then sudo rm x; fi"), "sudo -n true; ls | sudo -n tee /x; FOO=1 sudo -n ls; if sudo -n test -f x; then sudo -n rm x; fi");
  assert.equal(nonInteractive("echo sudo; sudo -u postgres psql"), "echo sudo; sudo -n -u postgres psql");
});

test("H3 the model cannot propose a change and approve it in the same reply", async () => {
  const { t, ran } = withMachines();
  setBackendOverride(scripted([
    () => ({ calls: [{ name: "run_command", arguments: { host: "storage", command: "systemctl restart smbd", purpose: "restart Samba" } }, { name: "approve_command", arguments: {} }] }),
    (msgs) => ({ text: msgs.filter((m) => m.role === "tool").map((m) => m.content).join(" | ") }),
  ]));
  try {
    const out = await chat(t, { session_id: "h3", message: "ok" });
    assert.deepEqual(ran, [], "nothing ran");
    assert.match(out.reply, /proposed in this reply/);
    assert.equal(out.pending_action?.command, "systemctl restart smbd", "it waits for the owner");
    assert.equal(t.hub.ai.hosts.pendingFor("h3")?.command, "systemctl restart smbd");
  } finally { setBackendOverride(null); t.cleanup(); }
});

test("H4 after the Run button approves a change, the same reply cannot propose and run another", async () => {
  const { t, ran } = withMachines();
  setBackendOverride(scripted([
    () => ({ calls: [{ name: "run_command", arguments: { host: "storage", command: "apt-get install -y htop", purpose: "install htop" } }] }),
    () => ({ text: "This installs htop on storage. Approve?" }),
    () => ({ calls: [{ name: "run_command", arguments: { host: "storage", command: "reboot", purpose: "reboot" } }, { name: "approve_command", arguments: {} }] }),
    (msgs) => ({ text: msgs.filter((m) => m.role === "tool").map((m) => m.content).join(" | ") }),
  ]));
  try {
    const first = await chat(t, { session_id: "h4", message: "install htop on storage" });
    const second = await chat(t, { session_id: "h4", approve_action_id: first.pending_action!.id });
    assert.deepEqual(ran, ["apt-get install -y htop"], "only the approved change ran");
    assert.match(second.reply, /a change already ran in this reply/);
    assert.equal(t.hub.ai.hosts.pendingFor("h4"), null, "and nothing new waits");
  } finally { setBackendOverride(null); t.cleanup(); }
});

test("H5 a typed yes runs the change shown before it; a new one proposed after it in the same reply is refused", async () => {
  const { t, ran } = withMachines();
  setBackendOverride(scripted([
    () => ({ calls: [{ name: "run_command", arguments: { host: "storage", command: "systemctl restart smbd", purpose: "restart Samba" } }] }),
    () => ({ text: "This restarts smbd on storage. Approve?" }),
    () => ({ calls: [{ name: "approve_command", arguments: {} }, { name: "run_command", arguments: { host: "storage", command: "reboot", purpose: "reboot" } }] }),
    (msgs) => ({ text: msgs.filter((m) => m.role === "tool").map((m) => m.content).join(" | ") }),
  ]));
  try {
    await chat(t, { session_id: "h5", message: "restart samba on storage" });
    const yes = await chat(t, { session_id: "h5", message: "yes" });
    assert.deepEqual(ran, ["systemctl restart smbd"]);
    assert.match(yes.reply, /a change already ran in this reply/);
    assert.equal(t.hub.ai.hosts.pendingFor("h5"), null);
  } finally { setBackendOverride(null); t.cleanup(); }
});

test("H6 a timed-out command on the hub's own machine stops with what it started, and the call returns", { skip: process.platform === "win32" }, async () => {
  const self: Host = { name: "self", aliases: ["self"], target: "self", os: process.platform === "darwin" ? "macos" : "linux", local: true, via: "test" };
  const left = (pattern: string) => { try { return execFileSync("pgrep", ["-f", pattern], { encoding: "utf8" }).trim(); } catch { return ""; } };
  const t0 = Date.now();
  const r = await spawnRunner(self, "sleep 41.25 | cat", 1);
  assert.equal(r.timed_out, true);
  assert.ok(Date.now() - t0 < 10_000, `returned after ${Date.now() - t0} ms`);
  assert.equal(left("sleep 41.25"), "", "nothing it started is left running");
  // A command that ends while something it started in the background still holds its output returns when it ends.
  const t1 = Date.now();
  const bg = await spawnRunner(self, "sleep 42.5 & echo started", 30);
  try {
    assert.equal(bg.timed_out, false);
    assert.equal(bg.exit_code, 0);
    assert.match(bg.output, /started/);
    assert.ok(Date.now() - t1 < 10_000, `returned after ${Date.now() - t1} ms`);
  } finally { try { execFileSync("pkill", ["-f", "sleep 42.5"]); } catch { /* already gone */ } }
});

test("H7 an approved change gets ten minutes, is journaled before it runs, and a timeout or a restart leaves it interrupted", async () => {
  const { t } = withMachines();
  try {
    const host = t.hub.ai.hosts.host("storage")!;
    let limit = -1;
    let during: unknown[] = [];
    t.hub.ai.hosts.runner = async (_h: Host, _cmd: string, timeoutS: number) => {
      limit = timeoutS;
      during = t.hub.store.list({ kind: "journal" }).map((j) => j.fields.outcome);
      return { exit_code: null, output: "Unpacking...", timed_out: true, ms: 1 };
    };
    const a = t.hub.ai.hosts.propose("h7", host, "apt-get -y full-upgrade", "upgrade storage", null);
    const out = await t.hub.ai.hosts.approve(a.id);
    assert.equal(limit, 600, "ten minutes, not the 60 seconds of a read");
    assert.deepEqual(during, ["running"], "the journal entry exists while the command runs");
    assert.equal(out.action.status, "interrupted");
    assert.equal(out.journal.fields.outcome, "interrupted");
    // A change that restarts the hub: the command never returns to this run of it.
    t.hub.ai.hosts.runner = () => new Promise<RunResult>(() => {});
    const b = t.hub.ai.hosts.propose("h7", host, "systemctl restart everythingapp-hub", "restart the hub", null);
    void t.hub.ai.hosts.approve(b.id);
    const row = t.hub.ai.hosts.get(b.id)!;
    assert.equal(row.status, "running");
    assert.equal(t.hub.store.get(row.journal_id!)!.fields.outcome, "running");
    // The next start marks it interrupted, with its journal entry.
    assert.equal(t.hub.ai.hosts.recoverInterrupted(), 1);
    assert.equal(t.hub.ai.hosts.get(b.id)!.status, "interrupted");
    assert.equal(t.hub.store.get(row.journal_id!)!.fields.outcome, "interrupted");
  } finally { t.cleanup(); }
});

test("H8 closing a session again replaces only what a close wrote, and does not repeat a change already journaled", async () => {
  const { t } = withMachines();
  try {
    const s = t.hub.store;
    s.create("fact", { category: "host", key: "host:core", value: "Proxmox node" });
    t.hub.ai.sessions.save("h8", "troubleshoot", [{ role: "user", content: "hub will not start on core" }] as any);
    // A change the owner made by hand, recorded through the assistant.
    await runTool(api(t), { name: "journal_entry", arguments: { host: "core", what: "Owner swapped the PSU", risk: "low" } }, ctxFor(t, "h8"));
    const first = await closeSession(s, t.hub.ai, "h8", { outcome: "parked", host: "core" });
    const second = await closeSession(s, t.hub.ai, "h8", { outcome: "fixed", host: "core" });
    const live = () => s.list({ kind: "journal", where: { session_id: "h8" } });
    assert.ok(live().some((j) => j.fields.what === "Owner swapped the PSU"), "the journal_entry record stays");
    assert.equal(s.get(first.journal_ids[0])!.deleted_at !== null, true, "the first close's entry is replaced");
    assert.equal(s.get(second.journal_ids[0])!.fields.source, "close");
    // The hub ran the fake model's change itself, written another way (sudo, spacing): the close adds no second entry.
    const a = t.hub.ai.hosts.propose("h8", t.hub.ai.hosts.host("core")!, "sudo rm /run/hub.pid  &&  systemctl restart hub", "clear the pid file", null);
    await t.hub.ai.hosts.approve(a.id);
    const third = await closeSession(s, t.hub.ai, "h8", { outcome: "fixed", host: "core" });
    assert.deepEqual(third.journal_ids, []);
    assert.equal(live().filter((j) => /restart hub/.test(String(j.fields.command ?? ""))).length, 1);
    // The same command run on another machine is another change.
    t.hub.ai.sessions.save("h8b", "troubleshoot", [{ role: "user", content: "hub will not start on core" }] as any);
    const b = t.hub.ai.hosts.propose("h8b", t.hub.ai.hosts.host("storage")!, "rm /run/hub.pid && systemctl restart hub", "on storage", null);
    await t.hub.ai.hosts.approve(b.id);
    assert.equal((await closeSession(s, t.hub.ai, "h8b", { outcome: "fixed", host: "core" })).journal_ids.length, 1);
  } finally { t.cleanup(); }
});

test("H9 ops_status gives each change's outcome, and an approved destructive command gets no pre-flight after it ran", async () => {
  const view = opsForModel({ journal_recent: [{ fields: { host: "core", at: "2026-11-12T10:00:00.000Z", what: "rm old logs", outcome: "planned" } }, { fields: { host: "core", at: "2026-11-12T09:00:00.000Z", what: "restart", outcome: "failed" } }, { fields: { host: "core", at: "2026-11-12T08:00:00.000Z", what: "old" } }] }) as { recent_changes: { outcome: string }[] };
  assert.deepEqual(view.recent_changes.map((c) => c.outcome), ["planned", "failed", "done"]);
  const { t, ran } = withMachines();
  setBackendOverride(scripted([
    () => ({ calls: [{ name: "run_command", arguments: { host: "storage", command: "zfs destroy tank/scratch", purpose: "free the space" } }] }),
    () => ({ text: "This removes the scratch dataset on storage. Approve?" }),
    () => ({ text: "Finished: `zfs destroy tank/scratch` ran on storage." }),
  ]));
  try {
    const first = await chat(t, { session_id: "h9", message: "free up space on storage" });
    assert.equal(first.pending_action?.risk, "high");
    const after = await chat(t, { session_id: "h9", approve_action_id: first.pending_action!.id });
    assert.deepEqual(ran, ["zfs destroy tank/scratch"]);
    assert.ok(!/Pre-flight for/.test(after.reply), after.reply);
    assert.ok(!after.rules_applied.some((r) => r.startsWith("preflight:")));
    assert.equal(t.hub.store.list({ kind: "journal", where: { outcome: "planned" } }).length, 0, "no planned entry for what already ran");
    assert.equal(t.hub.store.list({ kind: "journal", where: { outcome: "done" } }).length, 1);
  } finally { setBackendOverride(null); t.cleanup(); }
});

test("H10 long command output is cut in the middle, so the error at its end reaches the model", async () => {
  const long = `Reading package lists...\n${"Get: http://deb.example/x\n".repeat(900)}E: No space left on device`;
  const text = renderResult({ host: "core", exit_code: 100, output: long }, 9000, true);
  assert.ok(text.length < 9100, `${text.length}`);
  assert.match(text, /^\{"host":"core","exit_code":100/);
  assert.match(text, /No space left on device/);
  // Through the tool, and when the context fitter cuts it further.
  const { t } = withMachines();
  try {
    t.hub.ai.hosts.runner = async () => ({ exit_code: 100, output: long, timed_out: false, ms: 1 });
    const out = await runTool(api(t), { name: "run_command", arguments: { host: "core", command: "cat /var/log/apt/term.log", purpose: "see the upgrade" } }, ctxFor(t, "h10"));
    assert.match(out.text, /No space left on device/);
    const msgs = [{ role: "tool", tool_name: "run_command", content: out.text }, { role: "tool", tool_name: "list_items", content: `${"y".repeat(9000)}TAIL` }];
    fitToolResults(msgs, 0, 2500);
    assert.match(msgs[0].content, /No space left on device/);
    assert.ok(!msgs[1].content.includes("TAIL"), "other results keep their head, as before");
  } finally { t.cleanup(); }
});

test("H11 fix notes reach the model with their Facts and their newest sections", () => {
  const sections = Array.from({ length: 8 }, (_, i) => `<!-- session:s${i} -->\n## 2026-10-0${i + 1}: problem ${i}\n\n${"detail ".repeat(60)}\n<!-- /session:s${i} -->`);
  const body = `## Facts\n\nProxmox node, 10.0.0.2\n\n${sections.join("\n\n")}\n`;
  const out = runbookForModel(body);
  assert.ok(out.length <= 1500, `${out.length}`);
  assert.match(out, /^## Facts\n\nProxmox node, 10\.0\.0\.2/);
  assert.match(out, /problem 7/, "the newest section");
  assert.ok(!out.includes("<!-- session"));
  const t = makeHub();
  try {
    t.hub.store.create("runbook", { host: "core", title: "Fix notes: core", body });
    const mem = hostMemory(t.hub.store, ["core"]);
    assert.match(mem[0].runbook, /problem 7/);
  } finally { t.cleanup(); }
});
