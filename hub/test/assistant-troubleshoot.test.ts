import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeHub } from "./helpers.js";
import { scripted, sse } from "./ai-helpers.js";
import { setBackendOverride } from "../src/ai/backends.js";
import { AFFIRMATION, plainClixml, type Host, type RunResult } from "../src/ai/hosts.js";
import { ASKS_APPROVAL, SAYS_RAN, type ChatOutput } from "../src/ai/index.js";
import { detectDestructive } from "../src/preflight.js";

// From an alert chat about a failed backup on a Windows machine (2026-11-24): eleven messages, six typed approvals for
// commands nothing was holding, two replies that said commands ran when none had, a guessed path the script it had read
// named, and a reply that stopped at "Let me try the Kopia CLI directly:" when its tool calls ran out.

const CLIXML = `#< CLIXML\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><S S="Error">Get-Content : Cannot find path 'C:\\Users\\robin\\.kopia\\config' because it does not exist._x000D__x000A_</S><S S="Error">    + FullyQualifiedErrorId : PathNotFound,Microsoft.PowerShell.Commands.GetContentCommand_x000D__x000A_</S><S S="Error"> 2&gt;&amp;1_x000D__x000A_</S></Objs>`;

test("troubleshoot: PowerShell's CLIXML error stream reads as plain text", () => {
  const plain = plainClixml(`Name : backup\n\n${CLIXML}`);
  assert.equal(plain, "Name : backup\n\nGet-Content : Cannot find path 'C:\\Users\\robin\\.kopia\\config' because it does not exist.\n    + FullyQualifiedErrorId : PathNotFound,Microsoft.PowerShell.Commands.GetContentCommand\n 2>&1");
  assert.equal(plainClixml("no xml here"), "no xml here");
  // A block cut short keeps its text rather than losing it.
  assert.match(plainClixml("#< CLIXML\n<Objs><S S=\"Error\">cut"), /<Objs><S S="Error">cut/);
});

test("troubleshoot: a thumbs up is a yes; a question or another option is not", () => {
  for (const yes of ["👍", "👍🏽", "Approve", "Approved", "Do that", "fix it", "Yes, run it."]) assert.ok(AFFIRMATION.test(yes), yes);
  for (const no of ["?", "I guess exclude", "what does that do?", "yes but check the log first"]) assert.ok(!AFFIRMATION.test(no), no);
});

test("troubleshoot: the reply checks match what went wrong on 2026-11-24 and not ordinary words", () => {
  for (const ask of ["Want me to run it?", "Approve it?", "Waiting for your approval to run those three.", "Approve the read?", "Approve?"]) assert.ok(ASKS_APPROVAL.test(ask), ask);
  for (const ran of ["Ran on desk as robin (read-only, changes nothing):", "I ran the search on the nas.", "Here's what the commands showed, then the one waiting."]) assert.ok(SAYS_RAN.test(ran), ran);
  for (const plain of ["Which one? If the test project is disposable, option 1 is the whole fix.", "The backup ran on Nov 23 without errors.", "Kopia ran out of space last week."]) {
    assert.ok(!ASKS_APPROVAL.test(plain) && !SAYS_RAN.test(plain), plain);
  }
});

test("troubleshoot: deleting a folder recursively first checks whether it is a link", () => {
  const win = detectDestructive('Remove-Item "C:\\Users\\robin\\viewer\\node_modules" -Recurse -Force')!;
  assert.match(win.rule.verify, /LinkType, Target.*cmd \/c rmdir <path>/);
  assert.match(detectDestructive("rm -rf /srv/app/node_modules")!.rule.verify, /symlink, `rm <path>` removes just the link/);
});

function windowsHub() {
  const t = makeHub();
  fs.writeFileSync(path.join(t.dir, "hosts.json"), JSON.stringify([{ name: "desk", ssh: "robin@10.0.0.5", os: "windows" }]));
  return t;
}

test("troubleshoot: a reply that says a command ran when none did is sent back once", async () => {
  const t = windowsHub();
  const b = scripted([
    () => ({ text: "Ran on desk as robin (read-only):\n\nWhat's there: C:\\Users\\robin\\.kopia\\kopia.db and config." }),
    () => ({ calls: [{ name: "run_command", arguments: { host: "desk", command: "Get-ChildItem C:\\Users\\robin\\.kopia", purpose: "list the folder" } }] }),
    () => ({ text: "C:\\Users\\robin\\.kopia does not exist." }),
  ]);
  setBackendOverride(b);
  t.hub.ai.hosts.runner = async (): Promise<RunResult> => ({ exit_code: 1, output: CLIXML, timed_out: false, ms: 5 });
  try {
    const out = (await (await t.api("/ai/chat", { method: "POST", json: { session_id: "k1", task_type: "troubleshoot", message: "Approve" } })).json()) as ChatOutput;
    assert.match(b.seen[1].at(-1)!.content, /no command ran in this reply/);
    assert.equal(out.reply, "C:\\Users\\robin\\.kopia does not exist.");
    // The model read the error as text, not as XML.
    assert.match(b.seen[2].at(-1)!.content, /Get-Content : Cannot find path '[^']+kopia[^']+config' because it does not exist\./);
    assert.doesNotMatch(b.seen[2].at(-1)!.content, /CLIXML|_x000D_/);
  } finally { setBackendOverride(null); t.cleanup(); }
});

test("troubleshoot: asking for a yes that nothing waits for is sent back once, so the read runs", async () => {
  const t = windowsHub();
  const ran: string[] = [];
  t.hub.ai.hosts.runner = async (_h: Host, cmd: string): Promise<RunResult> => { ran.push(cmd); return { exit_code: 0, output: "Execute: powershell.exe", timed_out: false, ms: 5 }; };
  const b = scripted([
    () => ({ text: "Waiting (desk, as robin, read-only): print the task's definition. Approve it?" }),
    () => ({ calls: [{ name: "run_command", arguments: { host: "desk", command: "Get-ScheduledTask -TaskName 'Project Backup Snapshot'", purpose: "read the task" } }] }),
    () => ({ text: "The task runs powershell.exe." }),
  ]);
  setBackendOverride(b);
  try {
    const out = (await (await t.api("/ai/chat", { method: "POST", json: { session_id: "k2", task_type: "troubleshoot", message: "the backup on desk failed" } })).json()) as ChatOutput;
    assert.match(b.seen[1].at(-1)!.content, /nothing waits for approval/);
    assert.deepEqual(ran, ["Get-ScheduledTask -TaskName 'Project Backup Snapshot'"]);
    assert.equal(out.reply, "The task runs powershell.exe.");
    assert.equal(out.pending_action, undefined);
  } finally { setBackendOverride(null); t.cleanup(); }
});

test("troubleshoot: a later reply sees what earlier commands printed, not only the earlier prose", async () => {
  const t = windowsHub();
  const script = "$Kopia = Join-Path $env:LOCALAPPDATA 'Programs\\KopiaUI\\resources\\server\\kopia.exe'\n$Config = Join-Path $env:APPDATA 'kopia\\repository.config'";
  t.hub.ai.hosts.runner = async (): Promise<RunResult> => ({ exit_code: 0, output: script, timed_out: false, ms: 5 });
  const b = scripted([
    () => ({ calls: [{ name: "run_command", arguments: { host: "desk", command: "Get-Content C:\\backup-now.ps1", purpose: "read the backup script" } }] }),
    () => ({ text: "The script backs up Documents." }),
    () => ({ text: "Its config is %APPDATA%\\kopia\\repository.config." }),
  ]);
  setBackendOverride(b);
  try {
    await t.api("/ai/chat", { method: "POST", json: { session_id: "k3", task_type: "troubleshoot", message: "why did the backup fail" } });
    await t.api("/ai/chat", { method: "POST", json: { session_id: "k3", message: "where is its config?" } });
    const earlier = b.seen[2].find((m) => m.role === "assistant" && m.content.startsWith("The script backs up Documents."))!;
    assert.match(earlier.content, /\[Commands you ran for this reply/);
    assert.match(earlier.content, /On desk: `Get-Content C:\\backup-now\.ps1` \(done, exit 0\)/);
    assert.match(earlier.content, /kopia\\repository\.config/);
  } finally { setBackendOverride(null); t.cleanup(); }
});

test("troubleshoot: a typed yes runs the waiting change like the slide; any other reply sets it aside and says so", async () => {
  const t = windowsHub();
  const ran: string[] = [];
  t.hub.ai.hosts.runner = async (_h: Host, cmd: string): Promise<RunResult> => { ran.push(cmd); return { exit_code: 0, output: "", timed_out: false, ms: 5 }; };
  const propose = (n: number) => () => ({ calls: [{ name: "run_command", arguments: { host: "desk", command: `Set-Content C:\\viewer\\.kopiaignore 'node_modules' # ${n}`, purpose: "skip the junction" } }] });
  const b = scripted([
    propose(1), () => ({ text: "This adds an ignore file." }),
    () => ({ text: "It ran." }),
    propose(2), () => ({ text: "This adds an ignore file." }),
    () => ({ text: "Then I'll leave it." }),
  ]);
  setBackendOverride(b);
  try {
    const first = (await (await t.api("/ai/chat", { method: "POST", json: { session_id: "k4", task_type: "troubleshoot", message: "exclude it" } })).json()) as ChatOutput;
    assert.ok(first.pending_action);
    // 👍 typed back runs it before the model sees the message, as the slide control does.
    await t.api("/ai/chat", { method: "POST", json: { session_id: "k4", message: "👍" } });
    assert.deepEqual(ran, ["Set-Content C:\\viewer\\.kopiaignore 'node_modules' # 1"]);
    assert.equal(t.hub.ai.hosts.get(first.pending_action!.id)?.status, "done");
    assert.match([...b.seen[2]].reverse().find((m) => m.role === "user")!.content, /\[Approved\. The hub ran `Set-Content/);

    const second = (await (await t.api("/ai/chat", { method: "POST", json: { session_id: "k4", message: "do it again" } })).json()) as ChatOutput;
    const waiting = second.pending_action!.id;
    // Another option typed instead: nothing runs, nothing stays waiting, and the model is told.
    const third = (await (await t.api("/ai/chat", { method: "POST", json: { session_id: "k4", message: "actually, delete the junction instead" } })).json()) as ChatOutput;
    assert.equal(ran.length, 1);
    assert.equal(t.hub.ai.hosts.get(waiting)?.status, "cancelled");
    assert.equal(t.hub.ai.hosts.pendingFor("k4"), null);
    assert.equal(third.reply, "Then I'll leave it.");
    const proposal = b.seen.at(-1)!.find((m) => m.role === "assistant" && m.content.includes("[Not run:"))!;
    assert.match(proposal.content, /did not approve `Set-Content C:\\viewer\\\.kopiaignore 'node_modules' # 2` on desk; they replied with something else instead/);
    const stored = t.hub.ai.sessions.get("k4")!.messages.find((m) => m.approval?.action_id === waiting)!;
    assert.equal(stored.approval!.status, "cancelled", "the apps show the card as no longer waiting");
  } finally { setBackendOverride(null); t.cleanup(); }
});

test("troubleshoot: a reply that runs out of tool calls says what it found and the next step, not that it is trying", async () => {
  const t = windowsHub();
  t.hub.ai.hosts.runner = async (): Promise<RunResult> => ({ exit_code: 0, output: "", timed_out: false, ms: 1 });
  const b = scripted([() => ({ calls: [{ name: "run_command", arguments: { host: "desk", command: "Get-ChildItem C:\\", purpose: "look" } }] })]);
  setBackendOverride(b);
  try {
    const raw = await (await t.api("/ai/chat/stream", { method: "POST", json: { session_id: "k5", task_type: "troubleshoot", message: "find kopia" } })).text();
    assert.ok(sse(raw).some((e) => e.event === "done"));
    assert.equal(b.seen.length, 12, "a troubleshooting reply gets 12 rounds of tools");
    assert.match(b.streams.at(-1)?.at(-1)?.content ?? "", /has used all its tool calls.*the exact next command you would run.*Do not say you are running or trying anything now/);
  } finally { setBackendOverride(null); t.cleanup(); }
});

test("troubleshoot: a backup alert tells the assistant where the check reads the job and names the first error", async () => {
  const t = makeHub();
  const b = scripted([() => ({ text: "Looking." })]);
  setBackendOverride(b);
  try {
    fs.writeFileSync(path.join(t.dir, "hosts.json"), JSON.stringify([{ name: "core", local: true }, { name: "desk", ssh: "robin@10.0.0.5", os: "windows" }]));
    const m = t.hub.store.create("monitor", { name: "Desk backup", type: "backup", target: "windows:robin@desk", host: "desk", interval_s: 3600, state: "down",
      last_error: 'backup at Nov 24, 3:19 AM failed: 1 source failed: C:\\Users\\robin\\Documents (exit 1); first error: Error when processing "viewer/node_modules": unknown or unsupported entry type; last good backup Nov 23, 3:21 AM (38 h ago)' });
    const { session_id } = (await (await t.api(`/monitors/${m.id}/propose`, { method: "POST" })).json()) as { session_id: string };
    for (let i = 0; i < 100 && t.hub.ai.working.has(session_id); i++) await new Promise((r) => setTimeout(r, 20));
    const prompt = [...b.seen[0]].reverse().find((m) => m.role === "user")!.content;
    assert.match(prompt, /scheduled task "Project Backup Snapshot"/);
    assert.match(prompt, /%LOCALAPPDATA%\\ProjectBackup\\backup-status\.json/);
    assert.match(prompt, /first error: Error when processing "viewer\/node_modules"/);
    assert.match(prompt, /run the read-only commands you need on desk .*yourself, in this reply\. They run at once without asking/);
    assert.match(prompt, /they approve with one gesture, or reply with something else instead/);
  } finally { setBackendOverride(null); t.cleanup(); }
});

test("troubleshoot: a Windows read the hub cannot confirm goes back once with the reason, and the plain form runs", async () => {
  // An evaluation on 2026-11-25 held the model's first read in every run, for ( ) around a cmdlet, and the reply
  // ended without looking at anything.
  const t = windowsHub();
  const ran: string[] = [];
  t.hub.ai.hosts.runner = async (_h: Host, cmd: string): Promise<RunResult> => { ran.push(cmd); return { exit_code: 0, output: "LastTaskResult : 1", timed_out: false, ms: 5 }; };
  const awkward = `(Get-ScheduledTaskInfo "Project Backup Snapshot" | Select-Object LastTaskResult) | Format-List`;
  const plain = `Get-ScheduledTask -TaskName 'Project Backup Snapshot' | Get-ScheduledTaskInfo | Format-List`;
  const b = scripted([
    () => ({ calls: [{ name: "run_command", arguments: { host: "desk", command: awkward, purpose: "last result" } }] }),
    () => ({ calls: [{ name: "run_command", arguments: { host: "desk", command: plain, purpose: "last result" } }] }),
    () => ({ calls: [{ name: "run_command", arguments: { host: "desk", command: `Get-Content "$env:LOCALAPPDATA\\ProjectBackup\\Logs\\backup.log" -Tail 80`, purpose: "the log" } }] }),
    () => ({ text: "The last run returned 1." }),
  ]);
  setBackendOverride(b);
  try {
    const out = (await (await t.api("/ai/chat", { method: "POST", json: { session_id: "k6", task_type: "troubleshoot", message: "why did the backup fail" } })).json()) as ChatOutput;
    assert.match(b.seen[1].at(-1)!.content, /"status":"not_run".*puts a command in \( \)/);
    assert.match(b.seen[1].at(-1)!.content, /Get-ScheduledTaskInfo \| Format-List/, "with the plain form to use");
    assert.deepEqual(ran, [plain, `Get-Content "$env:LOCALAPPDATA\\ProjectBackup\\Logs\\backup.log" -Tail 80`], "the plain read and the $env: path ran at once; the awkward one never ran");
    assert.equal(out.pending_action, undefined, "nothing waits");

    // The same command sent again waits for approval, as before; a change is never handed back.
    const b2 = scripted([
      () => ({ calls: [{ name: "run_command", arguments: { host: "desk", command: awkward, purpose: "last result" } }] }),
      () => ({ calls: [{ name: "run_command", arguments: { host: "desk", command: awkward, purpose: "last result", lookup: true } }] }),
      () => ({ text: "It waits for you." }),
    ]);
    setBackendOverride(b2);
    const again = (await (await t.api("/ai/chat", { method: "POST", json: { session_id: "k7", task_type: "troubleshoot", message: "check it" } })).json()) as ChatOutput;
    assert.equal(again.pending_action?.command, awkward);
    const b3 = scripted([() => ({ calls: [{ name: "run_command", arguments: { host: "desk", command: `Remove-Item "C:\\viewer\\node_modules" -Recurse -Force`, purpose: "remove it" } }] }), () => ({ text: "It waits." })]);
    setBackendOverride(b3);
    const change = (await (await t.api("/ai/chat", { method: "POST", json: { session_id: "k8", task_type: "troubleshoot", message: "remove it" } })).json()) as ChatOutput;
    assert.match(change.pending_action?.command ?? "", /^Remove-Item/, "held at once");
  } finally { setBackendOverride(null); t.cleanup(); }
});

test("troubleshoot: a command a reply says ran or worked must have run, and with that result", async () => {
  const { unbackedRuns } = await import("../src/ai/index.js");
  const kopia = `& "$env:LOCALAPPDATA\\Programs\\KopiaUI\\resources\\server\\kopia.exe" --config-file "$env:APPDATA\\kopia\\repository.config" policy set documents --exclude "*/node_modules"`;
  const task = "Get-ScheduledTask -TaskName 'Project Backup Snapshot' | Get-ScheduledTaskInfo | Format-List";
  // From the evaluation on 2026-11-25: the kopia command had failed for want of its password.
  const made = '- `policy set documents --exclude "*/node_modules"` (done, exit 0): printed "Policy updated: documents".';
  assert.deepEqual(unbackedRuns(made, [{ command: kopia, exit_code: 1 }]), ['policy set documents --exclude "*/node_modules"']);
  assert.deepEqual(unbackedRuns(made, []), ['policy set documents --exclude "*/node_modules"'], "never ran at all");
  assert.deepEqual(unbackedRuns(made, [{ command: kopia, exit_code: 0 }]), [], "it did run and worked");
  assert.deepEqual(unbackedRuns("- `kopia repository info` printed the repository's config, with no ignore patterns.", [{ command: kopia, exit_code: 1 }]), ["kopia repository info"], "a known program's subcommand counts as a command");
  // Not claims about commands: quoted output, a path, a held command described, a read that ran.
  assert.deepEqual(unbackedRuns('The log showed `Error when processing "viewer/node_modules": unknown or unsupported entry type`.', []), []);
  assert.deepEqual(unbackedRuns("The folder `C:\\Users\\alex\\Documents\\viewer` holds the junction.", []), []);
  assert.deepEqual(unbackedRuns("The waiting command, `Set-Content C:\\viewer\\.kopiaignore 'node_modules'`, would add an ignore file.", []), []);
  assert.deepEqual(unbackedRuns(`\`${task}\` showed result 1.`, [{ command: task, exit_code: 0 }]), []);
});
