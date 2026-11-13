import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub } from "./helpers.js";
import { runSeed } from "../src/seed.js";
import { detectDestructive, insertPreflight, DESTRUCTIVE } from "../src/preflight.js";
import { hostMemory, hostsIn, parseModelClose, upsertSection, MEMORY_BUDGET } from "../src/memory.js";
import { buildSystemPrompt, loadMemory, turnContext } from "../src/ai/prompt.js";
import { setBackendOverride, type Backend } from "../src/ai/backends.js";
import type { ChatOutput } from "../src/ai/index.js";
import type { CloseResult } from "../src/memory.js";

test("preflight: the table detects every listed command and leaves harmless text alone", () => {
  const hits: Record<string, string> = {
    "rm -rf": "sudo rm -rf /srv/old",
    "zpool destroy": "zpool destroy tank",
    "zfs destroy": "zfs destroy -r tank/scratch",
    mkfs: "mkfs.ext4 /dev/sdb1",
    "dd if=": "dd if=/dev/zero of=/dev/sdb bs=1M",
    fdisk: "fdisk /dev/sdb",
    parted: "parted /dev/sdb mklabel gpt",
    wipefs: "wipefs -a /dev/sdb",
    "DROP TABLE or DATABASE": "drop database hub;",
    "reg delete": 'reg delete "HKLM\\Software\\Foo" /f',
    format: "format D: /fs:ntfs",
    diskpart: "diskpart",
    rendom: "rendom /upload",
    "rsync --delete": "rsync -av --delete src/ dst/",
    "git push --force": "git push --force origin main",
    "terraform destroy": "terraform destroy -auto-approve",
    blkdiscard: "blkdiscard /dev/nvme1n1",
    "docker compose down -v": "docker compose down -v",
    "zfs rollback": "zfs rollback -r tank/data@monday",
    "Remove-Item -Recurse": "Remove-Item C:\\builds -Recurse -Force",
    "git clean": "git clean -fdx",
    sgdisk: "sgdisk -Z /dev/sdb",
    sfdisk: "sfdisk /dev/sdb < table.txt",
    lvremove: "lvremove vg0/old",
  };
  for (const [name, cmd] of Object.entries(hits)) {
    const m = detectDestructive(`Run this:\n\`\`\`\n${cmd}\n\`\`\``);
    assert.ok(m, `${name} not detected`);
    assert.equal(m!.rule.name, name);
    assert.equal(m!.command, cmd);
  }
  assert.equal(DESTRUCTIVE.length, Object.keys(hits).length, "every table row is covered");
  // Every recursive rm, however its options are written, and the other spellings of the new rows.
  for (const [cmd, name] of [["rm -r /srv/old", "rm -rf"], ["rm -r -f /srv/old", "rm -rf"], ["rm --recursive --force /srv/old", "rm -rf"], ["rm -v -R /srv/old", "rm -rf"], ["rm /srv/old -r", "rm -rf"],
    ["docker-compose down --volumes", "docker compose down -v"], ["rd /s /q C:\\builds", "Remove-Item -Recurse"], ["git clean -xdf", "git clean"], ["vgremove vg0", "lvremove"], ["sfdisk -d /dev/sda | sfdisk /dev/sdb", "sfdisk"]]) {
    assert.equal(detectDestructive(cmd)?.rule.name, name, cmd);
  }
  for (const safe of ["fdisk -l", "parted -l", "rm -f one-file.txt", "format the output as JSON", "git push origin main", "rsync -av src/ dst/", "zpool status tank",
    "docker compose down", "git clean -n", "sgdisk -p /dev/sda", "sgdisk --backup=/root/t.gpt /dev/sda", "sfdisk -d /dev/sda", "sfdisk -l", "zfs list -t snapshot", "Get-ChildItem C:\\builds -Recurse"]) {
    assert.equal(detectDestructive(safe), null, `false positive on: ${safe}`);
  }
});

test("preflight: the block lands before the fenced code block and is never inserted twice", () => {
  const reply = "Destroy the pool once the data is elsewhere.\n```bash\nzpool destroy tank\n```\nThen recreate it.";
  const once = insertPreflight(reply);
  assert.ok(once.inserted);
  const lines = once.text.split("\n");
  const pf = lines.findIndex((l) => l.startsWith("Pre-flight for `zpool destroy tank` (zpool destroy):"));
  const fence = lines.indexOf("```bash");
  assert.ok(pf >= 0 && fence > pf, once.text);
  assert.ok(lines[pf + 1].startsWith("- Back up:"));
  assert.ok(lines[pf + 2].startsWith("- Verify:"));
  assert.ok(lines[pf + 3].startsWith("- Rollback:"));
  assert.ok(!/[–—!]/.test(once.text), "no dashes or exclamation marks");
  const twice = insertPreflight(once.text);
  assert.equal(twice.inserted, false);
  assert.equal(twice.text, once.text);
  // Outside a fence the block goes right before the line.
  const plain = insertPreflight("First back up.\nrm -rf /srv/old\nDone.");
  assert.match(plain.text, /First back up\.\n\nPre-flight for `rm -rf \/srv\/old` \(rm -rf\):\n- Back up:.*\n- Verify:.*\n- Rollback:.*\n\nrm -rf \/srv\/old\nDone\./);
});

test("preflight: the pipeline inserts the block and records one planned journal entry per command", async () => {
  const t = makeHub();
  try {
    t.hub.store.create("fact", { category: "host", key: "host:storage", value: "TrueNAS box with the tank pool" });
    const req = { session_id: "pf1", task_type: "troubleshoot", messages: [{ role: "user", content: "on storage I want to run zpool destroy tank" }] };
    const out = await (await t.api("/ai/chat", { method: "POST", json: req })).json() as ChatOutput;
    assert.ok(out.rules_applied.includes("preflight:zpool destroy"), out.rules_applied.join(","));
    assert.equal((out.reply.match(/^Pre-flight for /gm) ?? []).length, 1, out.reply);
    const pfAt = out.reply.indexOf("Pre-flight for");
    const cmdAt = out.reply.indexOf("zpool destroy tank");
    assert.ok(pfAt >= 0 && pfAt < cmdAt, "block comes before the command");
    let journal = t.hub.store.list({ kind: "journal" });
    assert.equal(journal.length, 1);
    assert.equal(journal[0].fields.outcome, "planned");
    assert.equal(journal[0].fields.risk, "high");
    assert.equal(journal[0].fields.host, "storage");
    assert.equal(journal[0].fields.session_id, "pf1");
    assert.ok(String(journal[0].fields.command).includes("zpool destroy tank"));
    assert.ok(String(journal[0].fields.what).length <= 120);
    assert.ok(journal[0].fields.rollback);
    // The same command again in the same session updates the row instead of adding one.
    await t.api("/ai/chat", { method: "POST", json: { ...req, messages: [...req.messages, { role: "assistant", content: out.reply }, { role: "user", content: "on storage I want to run zpool destroy tank" }] } });
    journal = t.hub.store.list({ kind: "journal" });
    assert.equal(journal.length, 1);
    // A general session with no known host records "unknown".
    const g = await (await t.api("/ai/chat", { method: "POST", json: { session_id: "pf2", task_type: "general", messages: [{ role: "user", content: "run rm -rf /tmp/build" }] } })).json() as ChatOutput;
    assert.ok(g.reply.includes("Pre-flight for"));
    const unknown = t.hub.store.list({ kind: "journal", where: { session_id: "pf2" } });
    assert.equal(unknown.length, 1);
    assert.equal(unknown[0].fields.host, "unknown");
    // The persisted session carries the block, so a later turn sees it and nothing is inserted again.
    const s = await (await t.api("/ai/sessions/pf2")).json() as { messages: { content: string }[] };
    assert.ok(s.messages[1].content.includes("Pre-flight for"));
  } finally { t.cleanup(); }
});

test("snippets: render fills defaults, sets last_used, and 422 lists the missing names", async () => {
  const t = makeHub();
  try {
    const created = await (await t.api("/entities", { method: "POST", json: { kind: "snippet", fields: {
      title: "Restart unit", os: "linux", language: "bash",
      body: "ssh {{user}}@{{host}} systemctl restart {{unit}} && journalctl -u {{unit}} -n {{lines}}",
      params: [{ name: "host" }, { name: "unit" }, { name: "user", default: "root" }, { name: "lines", default: "50" }],
    } } })).json() as { id: string };
    const missing = await t.api(`/snippets/${created.id}/render`, { method: "POST", json: { params: { host: "core" } } });
    assert.equal(missing.status, 422);
    const err = await missing.json() as { error: string; detail: { missing: string[] } };
    assert.deepEqual(err.detail.missing, ["unit"]);
    assert.equal(t.hub.store.get(created.id)!.fields.last_used, undefined, "a failed render does not touch last_used");

    const ok = await t.api(`/snippets/${created.id}/render`, { method: "POST", json: { params: { host: "core", unit: "hub", lines: 20 } } });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { text: "ssh root@core systemctl restart hub && journalctl -u hub -n 20" });
    assert.ok(t.hub.store.get(created.id)!.fields.last_used);

    assert.equal((await t.api("/snippets/00000000-0000-0000-0000-000000000000/render", { method: "POST", json: {} })).status, 404);
    assert.equal((await t.api(`/snippets/${created.id}/render`, { method: "POST", json: { params: "nope" } })).status, 422, "a non-object params is treated as empty");
  } finally { t.cleanup(); }
});

test("hosts: the summary merges facts, runbooks, journal and snippets per host", async () => {
  const t = makeHub();
  try {
    const s = t.hub.store;
    s.create("fact", { category: "host", key: "host:core", value: "Proxmox node" });
    s.create("fact", { category: "host", key: "host:pve1", value: "Windows gaming PC" });
    s.create("runbook", { host: "core", title: "Runbook: core", body: "## Facts\n\nProxmox node" });
    s.create("journal", { host: "core", at: "2026-10-01T10:00:00.000Z", what: "older", risk: "low" });
    s.create("journal", { host: "core", at: "2026-10-20T10:00:00.000Z", what: "newer", risk: "medium" });
    s.create("journal", { host: "Storage", at: "2026-10-02T10:00:00.000Z", what: "on a host with no fact", risk: "low" });
    s.create("snippet", { title: "x", os: "linux", language: "bash", body: "true", host: "core" });
    const rows = await (await t.api("/hosts")).json() as { host: string; runbooks: number; journal_entries: number; last_change: string | null; snippets: number }[];
    assert.deepEqual(rows, [
      { host: "core", runbooks: 1, journal_entries: 2, last_change: "2026-10-20T10:00:00.000Z", snippets: 1 },
      { host: "pve1", runbooks: 0, journal_entries: 0, last_change: null, snippets: 0 },
      { host: "storage", runbooks: 0, journal_entries: 1, last_change: "2026-10-02T10:00:00.000Z", snippets: 0 },
    ]);
    const core = await (await t.api("/runbooks?host=CORE")).json() as { fields: { host: string } }[];
    assert.equal(core.length, 1);
    assert.equal(core[0].fields.host, "core");
    assert.equal(((await (await t.api("/runbooks")).json()) as unknown[]).length, 1);
    assert.deepEqual(hostsIn("pve1 and then core; corelation is not a host", ["core", "pve1", "unifi"]), ["pve1", "core"]);
  } finally { t.cleanup(); }
});

test("close: the fake backend's JSON becomes a runbook section, journal, snippet, a closed ledger and a resume card", async () => {
  const t = makeHub();
  try {
    const s = t.hub.store;
    s.create("fact", { category: "host", key: "host:core", value: "Proxmox node, 10.0.0.2" });
    const project = s.create("project", { name: "Hub hardening", status: "active", definition_of_done: "hub restarts cleanly" });
    const chat = { session_id: "c1", task_type: "troubleshoot", messages: [{ role: "user", content: "hub service will not start on core" }] };
    const first = await (await t.api("/ai/chat", { method: "POST", json: chat })).json() as ChatOutput;
    assert.ok(first.ledger_id);

    const res = await t.api("/ai/sessions/c1/close", { method: "POST", json: { outcome: "fixed", note: "stale pid file", project_id: project.id } });
    assert.equal(res.status, 200);
    const out = await res.json() as CloseResult;
    assert.equal(out.via, "model");
    assert.equal(out.host, "core");
    assert.ok(out.runbook_id);
    assert.ok(out.journal_id);
    assert.equal(out.snippet_ids.length, 1);
    assert.equal(out.resume_card_written, true);
    assert.match(out.summary, /^\d{4}-\d{2}-\d{2}: hub service would not start on core/);

    const rb = s.get(out.runbook_id!)!;
    assert.equal(rb.fields.title, "Fix notes: core");
    assert.ok(String(rb.fields.body).startsWith("## Facts\n\nProxmox node, 10.0.0.2"), "created from the host fact");
    assert.ok(String(rb.fields.body).includes("<!-- session:c1 -->"));
    assert.match(String(rb.fields.body), /## \d{4}-\d{2}-\d{2}: hub service would not start on core\n\nSymptoms:/);
    assert.ok(rb.fields.last_verified);

    const j = s.get(out.journal_id!)!;
    assert.equal(j.fields.host, "core");
    assert.equal(j.fields.outcome, "done");
    assert.equal(j.fields.risk, "medium");
    assert.equal(j.fields.session_id, "c1");
    assert.equal(j.fields.runbook_id, out.runbook_id);
    assert.ok(String(j.fields.command).startsWith("rm /run/hub.pid"));
    assert.ok(j.fields.rollback);

    const snip = s.get(out.snippet_ids[0])!;
    assert.equal(snip.fields.source_session, "c1");
    assert.equal(snip.fields.host, "core");
    assert.deepEqual(snip.fields.params, [{ name: "unit" }, { name: "lines", default: "50" }]);
    const rendered = await (await t.api(`/snippets/${snip.id}/render`, { method: "POST", json: { params: { unit: "hub" } } })).json() as { text: string };
    assert.equal(rendered.text, "systemctl restart hub && journalctl -u hub -n 50");

    assert.equal(s.get(first.ledger_id!)!.fields.open, false);
    assert.equal(((await (await t.api("/ledgers?open=true")).json()) as unknown[]).length, 0);
    assert.equal(((await (await t.api("/ledgers?open=false")).json()) as unknown[]).length, 1);
    assert.ok(String(s.get(project.id)!.fields.resume_card).includes("Where I left off"));

    assert.equal((await t.api("/ai/sessions/nope/close", { method: "POST", json: { outcome: "fixed" } })).status, 404);
    assert.equal((await t.api("/ai/sessions/c1/close", { method: "POST", json: { outcome: "maybe" } })).status, 422);
    assert.equal((await t.api("/ai/sessions/c1/close", { method: "POST", json: { outcome: "fixed", project_id: "00000000-0000-0000-0000-000000000000" } })).status, 404);
  } finally { t.cleanup(); }
});

test("close: a second close replaces the runbook section, the journal entries and the snippets instead of duplicating them", async () => {
  const t = makeHub();
  try {
    const s = t.hub.store;
    s.create("fact", { category: "host", key: "host:core", value: "Proxmox node" });
    await t.api("/ai/chat", { method: "POST", json: { session_id: "c2", task_type: "troubleshoot", messages: [{ role: "user", content: "hub will not start on core, I ran rm -rf /var/lib/hub/cache" }] } });
    assert.equal(s.list({ kind: "journal", where: { session_id: "c2", outcome: "planned" } }).length, 1, "the pre-flight entry from the chat");
    const a = await (await t.api("/ai/sessions/c2/close", { method: "POST", json: { outcome: "parked" } })).json() as CloseResult;
    const b = await (await t.api("/ai/sessions/c2/close", { method: "POST", json: { outcome: "fixed", note: "done after all" } })).json() as CloseResult;
    assert.equal(a.runbook_id, b.runbook_id);
    const body = String(s.get(b.runbook_id!)!.fields.body);
    assert.equal((body.match(/<!-- session:c2 -->/g) ?? []).length, 1);
    assert.equal((body.match(/^## \d{4}-\d{2}-\d{2}: /gm) ?? []).length, 1, body);
    const journal = s.list({ kind: "journal", where: { session_id: "c2" } });
    assert.equal(journal.filter((j) => j.fields.outcome === "planned").length, 1, "the pre-flight row stays");
    assert.equal(journal.filter((j) => j.fields.outcome !== "planned").length, 1, "one close entry, not two");
    assert.equal(journal.find((j) => j.fields.outcome !== "planned")!.fields.outcome, "done", "the outcome follows the latest close");
    assert.equal(s.list({ kind: "snippet", where: { source_session: "c2" } }).length, 1);
    assert.deepEqual(a.snippet_ids, b.snippet_ids, "the snippet is updated in place");
    assert.equal(s.list({ kind: "runbook" }).length, 1);
  } finally { t.cleanup(); }
});

test("close: without a model the rule-based summary uses the last user messages, the ledger and the note", async () => {
  const t = makeHub();
  try {
    const s = t.hub.store;
    s.create("fact", { category: "host", key: "host:core", value: "Proxmox node" });
    const project = s.create("project", { name: "P", status: "active", definition_of_done: "d" });
    const msgs = [{ role: "user", content: "hub service will not start on core" }];
    const first = await (await t.api("/ai/chat", { method: "POST", json: { session_id: "c3", task_type: "troubleshoot", messages: msgs } })).json() as ChatOutput;
    await t.api("/ai/chat", { method: "POST", json: { session_id: "c3", task_type: "troubleshoot", messages: [...msgs, { role: "assistant", content: first.reply }, { role: "user", content: "that didn't work, same error" }] } });
    const ledger = s.get(first.ledger_id!)!;
    s.patch(ledger.id, { confirmed: ["the unit file is present"] });

    const dead: Backend = {
      name: "ollama", model: "dead",
      async chat() { throw new Error("connection refused"); },
      async stream() { throw new Error("connection refused"); },
    };
    setBackendOverride(dead);
    let out: CloseResult;
    try {
      const res = await t.api("/ai/sessions/c3/close", { method: "POST", json: { outcome: "parked", note: "waiting on a reboot window", project_id: project.id } });
      assert.equal(res.status, 200);
      out = await res.json() as CloseResult;
    } finally { setBackendOverride(null); }
    assert.equal(out.via, "rules");
    assert.equal(out.host, "core");
    const body = String(s.get(out.runbook_id!)!.fields.body);
    assert.match(body, /## \d{4}-\d{2}-\d{2}: hub service will not start on core/);
    assert.ok(body.includes("Outcome: parked. waiting on a reboot window"));
    assert.ok(body.includes("Tried:"));
    assert.ok(body.includes("Ruled out:"));
    assert.ok(body.includes("- the unit file is present"));
    assert.ok(body.includes("Last messages:\n- hub service will not start on core\n- that didn't work, same error"));
    const j = s.get(out.journal_id!)!;
    assert.equal(j.fields.outcome, "done");
    assert.equal(j.fields.risk, "low");
    assert.equal(j.fields.what, "Session parked: hub service will not start on core");
    assert.equal(out.snippet_ids.length, 0);
    assert.equal(s.get(ledger.id)!.fields.open, false);
    assert.equal(out.resume_card_written, true);
    const card = String(s.get(project.id)!.fields.resume_card);
    assert.ok(card.includes("Where I left off") && card.includes("What to do next") && card.includes("waiting on a reboot window"));
  } finally { t.cleanup(); }
  // No known host anywhere (the fake reply names core, but nothing knows that name here): journal says unknown, no runbook.
  const u = makeHub();
  try {
    await u.api("/ai/chat", { method: "POST", json: { session_id: "c4", task_type: "general", messages: [{ role: "user", content: "nothing host-like here" }] } });
    setBackendOverride({ name: "ollama", model: "dead", async chat() { throw new Error("down"); }, async stream() { throw new Error("down"); } });
    let none: CloseResult;
    try { none = await (await u.api("/ai/sessions/c4/close", { method: "POST", json: { outcome: "abandoned" } })).json() as CloseResult; } finally { setBackendOverride(null); }
    assert.equal(none.runbook_id, undefined);
    assert.equal(none.host, null);
    assert.equal(u.hub.store.list({ kind: "runbook" }).length, 0);
    assert.equal(u.hub.store.get(none.journal_id!)!.fields.host, "unknown");
    assert.equal(u.hub.store.get(none.journal_id!)!.fields.outcome, "failed");
  } finally { u.cleanup(); }
});

test("close: the model's JSON is parsed defensively and sections are upserted by session marker", () => {
  assert.equal(parseModelClose("not json"), null);
  assert.equal(parseModelClose('{"journal": []}'), null, "no section means no plan");
  const p = parseModelClose('```json\n{"runbook_section": "## 2026-10-23: x", "journal": [{"what": "a", "risk": "wild"}, {"nope": 1}, "str"], "snippets": [{"title": "t", "body": "b", "os": "beos", "params": "x"}, {"title": "u", "body": "c"}, {"title": "v", "body": "d"}]}\n```')!;
  assert.equal(p.runbook_section, "## 2026-10-23: x");
  assert.deepEqual(p.journal, [{ what: "a", risk: "medium" }]);
  assert.equal(p.snippets.length, 2, "at most two snippets");
  assert.deepEqual(p.snippets[0], { title: "t", os: "any", language: "bash", body: "b", params: [] });
  const once = upsertSection("## Facts\n\nbox\n", "s9", "## 2026-10-23: first");
  assert.equal(once, "## Facts\n\nbox\n\n<!-- session:s9 -->\n## 2026-10-23: first\n<!-- /session:s9 -->\n");
  const twice = upsertSection(once + "\n## Later\n\nkept\n", "s9", "## 2026-10-23: second");
  assert.equal(twice, "## Facts\n\nbox\n\n<!-- session:s9 -->\n## 2026-10-23: second\n<!-- /session:s9 -->\n\n## Later\n\nkept\n");
});

test("seed: a runbook per host fact, created once, and a deleted one is not resurrected", async () => {
  const t = makeHub();
  try {
    const s = t.hub.store;
    const r1 = runSeed(s, t.hub.cfg.seedDir);
    const hostFacts = s.list({ kind: "fact" }).filter((f) => String(f.fields.key).startsWith("host:"));
    assert.ok(hostFacts.length >= 5, "the seed has host facts");
    assert.equal(r1.runbooks.created, hostFacts.length);
    assert.equal(r1.runbooks.kept, 0);
    const runbooks = s.list({ kind: "runbook" });
    assert.equal(runbooks.length, hostFacts.length);
    const core = runbooks.find((r) => r.fields.host === "server")!;
    assert.equal(core.fields.title, "Fix notes: server");
    const fact = hostFacts.find((f) => f.fields.key === "host:server")!;
    assert.equal(core.fields.body, `## Facts\n\n${fact.fields.value}\n`);
    const r2 = runSeed(s, t.hub.cfg.seedDir);
    assert.deepEqual(r2.runbooks, { created: 0, kept: hostFacts.length });
    assert.equal(s.list({ kind: "runbook" }).length, hostFacts.length);
    s.patch(core.id, { body: "edited by hand" });
    s.patch(runbooks.find((r) => r.fields.host === "pve1")!.id, { deleted_at: new Date().toISOString() });
    runSeed(s, t.hub.cfg.seedDir);
    assert.equal(s.get(core.id)!.fields.body, "edited by hand");
    assert.equal(s.list({ kind: "runbook" }).length, hostFacts.length - 1, "the deleted runbook stays deleted");
    const status = await (await t.api("/status")).json() as { memory: { runbooks: number; journal_entries: number; snippets: number; open_ledgers: number } };
    assert.deepEqual(status.memory, { runbooks: hostFacts.length - 1, journal_entries: 0, snippets: 4, open_ledgers: 0 });
  } finally { t.cleanup(); }
});

test("prompt: a troubleshoot session gets the runbook head and last three journal entries for the hosts it names, inside the budget", () => {
  const t = makeHub();
  try {
    const s = t.hub.store;
    s.create("fact", { category: "host", key: "host:storage", value: "TrueNAS" });
    s.create("fact", { category: "host", key: "host:core", value: "Proxmox" });
    s.create("runbook", { host: "storage", title: "Runbook: storage", body: "## Facts\n\nTrueNAS, pool tank, scrub on Sundays.\n" + "x".repeat(3000) });
    s.create("runbook", { host: "core", title: "Runbook: core", body: "## Facts\n\nProxmox on core.\n" });
    for (let i = 1; i <= 5; i++) s.create("journal", { host: "storage", at: `2026-10-0${i}T10:00:00.000Z`, what: `change ${i}`, risk: "low", rollback: `undo ${i}` });
    const messages = [{ role: "user" as const, content: "scrub on storage is stuck" }];
    const mem = loadMemory(s, { cloud: false, allowWork: false }, "p1", messages);
    assert.equal(mem.hosts.length, 1);
    assert.equal(mem.hosts[0].host, "storage");
    assert.equal(mem.hosts[0].runbook.length, 1500, "runbook head only");
    assert.deepEqual(mem.hosts[0].journal.map((j) => j.what), ["change 5", "change 4", "change 3"]);
    // Host memory changes as the chat goes, so it rides on the newest message, not in the cached system prompt.
    assert.ok(!buildSystemPrompt(mem, "troubleshoot").includes("Host storage:"));
    const prompt = turnContext(mem, "troubleshoot", new Date());
    assert.ok(prompt.includes("Host storage:"));
    assert.ok(prompt.includes("pool tank, scrub on Sundays"));
    assert.ok(prompt.includes("- 2026-10-05 [low, done] change 5 (rollback: undo 5)"));
    assert.ok(!prompt.includes("change 2"));
    assert.ok(!prompt.includes("Host core:"), "only hosts the conversation names");
    assert.ok(!turnContext(mem, "general", new Date()).includes("Host storage:"), "general sessions do not get runbooks");
    // Status quo for the existing injections.
    assert.ok(buildSystemPrompt(mem, "troubleshoot").includes("Facts about the user"));
    // Budget: many hosts with long runbooks are trimmed, runbooks first, journal kept.
    const hosts: string[] = [];
    for (let i = 0; i < 6; i++) {
      hosts.push(`box${i}`);
      s.create("runbook", { host: `box${i}`, title: `Runbook: box${i}`, body: "y".repeat(2000) });
      s.create("journal", { host: `box${i}`, at: "2026-10-10T10:00:00.000Z", what: `j${i}`, risk: "low" });
    }
    const trimmed = hostMemory(s, hosts);
    const total = trimmed.reduce((n, h) => n + h.runbook.length + JSON.stringify(h.journal).length, 0);
    assert.ok(total <= MEMORY_BUDGET, `total ${total}`);
    assert.ok(trimmed.every((h) => h.journal.length === 1 && h.runbook.length > 0 && h.runbook.length < 1500));
  } finally { t.cleanup(); }
});
