import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeHub, type TestHub } from "./helpers.js";
import { cli, forgetItemNames, quoteFor } from "../src/secrets.js";
import { isReadOnly } from "../src/ai/hosts.js";

/** A fake lpass and op: records each call and answers like the real CLIs. */
function fakeCli() {
  const calls: { host: string; command: string; input: string | null; env: Record<string, string> }[] = [];
  const orig = cli.run;
  cli.run = async (host, command, input, env) => {
    calls.push({ host: host.name, command, input, env });
    if (/command -v lpass/.test(command)) return { code: 0, out: "/usr/bin/lpass" };
    if (/command -v op/.test(command)) return { code: 1, out: "" };
    if (/lpass status/.test(command)) return calls.some((c) => /lpass login/.test(c.command)) ? { code: 0, out: "Logged in as robin@example.com." } : { code: 1, out: "Not logged in." };
    if (/lpass login/.test(command)) return input === "hunter22\n123456\n" ? { code: 0, out: "Success: Logged in as robin@example.com." } : { code: 1, out: "Error: Invalid password." };
    if (/lpass ls/.test(command)) return { code: 0, out: "101|Tech/Router admin\n102|Home NAS\n103|Personal/Recovery Codes\n104|Shared-Family/Netflix\n105|Media/Netflix\n" };
    if (/lpass show --sync=no --password '101'/.test(command)) return { code: 0, out: "p@ss'word\n" };
    if (/lpass show --sync=no --password '105'/.test(command)) return { code: 0, out: "media-pass\n" };
    return { code: 1, out: "unknown" };
  };
  return { calls, restore: () => { cli.run = orig; } };
}

function hosts(t: TestHub) {
  fs.writeFileSync(path.join(t.dir, "hosts.json"), JSON.stringify([{ name: "core", local: true }, { name: "vault-box", ssh: "vault-box", os: "linux" }]));
  t.hub.cfg.hostsFile = path.join(t.dir, "hosts.json");
}

test("password manager: link LastPass, sign in without keeping the password, and allow only chosen items", async () => {
  const t = makeHub();
  const f = fakeCli();
  forgetItemNames();
  try {
    hosts(t);
    let view = (await (await t.api("/connections/password-manager")).json()) as { linked: boolean; host: string };
    assert.deepEqual([view.linked, view.host], [false, "core"]);
    assert.equal((await t.api("/connections/password-manager", { method: "PUT", json: { provider: "1password", host: "vault-box" } })).status, 422, "1Password's token stays on the hub's own machine");
    assert.equal((await t.api("/connections/password-manager", { method: "PUT", json: { provider: "lastpass", host: "core" } })).status, 200);
    let st = (await (await t.api("/connections/password-manager/status")).json()) as { installed: Record<string, boolean>; signed_in: boolean; install_hint: string | null };
    assert.deepEqual([st.installed.lastpass, st.installed["1password"], st.signed_in], [true, false, false]);
    assert.equal((await t.api("/connections/password-manager/signin", { method: "POST", json: { email: "robin@example.com", password: "wrong" } })).status, 422);
    const ok = await t.api("/connections/password-manager/signin", { method: "POST", json: { email: "robin@example.com", password: "hunter22", code: "123456" } });
    assert.equal(ok.status, 200);
    st = (await ok.json()) as typeof st;
    assert.equal(st.signed_in, true);
    const login = f.calls.find((c) => /lpass login/.test(c.command) && c.input === "hunter22\n123456\n")!;
    assert.match(login.command, /lpass login --trust 'robin@example\.com'$/);
    assert.ok(!login.command.includes("hunter22"), "the password goes in on standard input, never the command line");
    assert.ok(!fs.readFileSync(path.join(t.hub.cfg.dataDir, "connections.json"), "utf8").includes("hunter22"), "the master password is not kept");
    const items = (await (await t.api("/connections/password-manager/items?q=r")).json()) as { items: string[] };
    assert.deepEqual(items.items, ["Personal/Recovery Codes", "Shared-Family/Netflix", "Tech/Router admin"], "full names, with their folders");
    // Every item by default, with items and folders left out.
    let acc = (await (await t.api("/connections/password-manager")).json()) as { access: string; excluded: string[] };
    assert.deepEqual([acc.access, acc.excluded], ["all", []]);
    assert.equal((await t.api("/connections/password-manager/access", { method: "PUT", json: { access: "some" } })).status, 422);
    assert.equal((await t.api("/connections/password-manager/access", { method: "PUT", json: { excluded: ["{{x}}"] } })).status, 422);
    acc = (await (await t.api("/connections/password-manager/access", { method: "PUT", json: { excluded: ["Personal/Recovery Codes", "Shared-Family/", "Shared-Family/"] } })).json()) as typeof acc;
    assert.deepEqual([acc.access, acc.excluded], ["all", ["Personal/Recovery Codes", "Shared-Family/"]]);
    assert.equal((await t.api("/connections/password-manager/allowed", { method: "PUT", json: { names: ["{{x}}"] } })).status, 422);
    view = (await (await t.api("/connections/password-manager/allowed", { method: "PUT", json: { names: ["Router admin"] } })).json()) as typeof view & { allowed: string[] };
    assert.deepEqual((view as unknown as { allowed: string[] }).allowed, ["Router admin"]);
    const conns = (await (await t.api("/connections")).json()) as { password_manager: { provider: string; allowed: string[] } };
    assert.deepEqual([conns.password_manager.provider, conns.password_manager.allowed], ["lastpass", ["Router admin"]]);
  } finally { f.restore(); t.cleanup(); }
});

test("password manager: a command naming a secret waits for approval, gets the value quoted only when it runs, and never shows it", async () => {
  const t = makeHub();
  const f = fakeCli();
  forgetItemNames();
  try {
    hosts(t);
    t.hub.connections.update((c) => { c.password_manager = { provider: "lastpass", host: "core", allowed: [], excluded: ["Personal/"], linked_at: new Date().toISOString() }; });
    const ran: string[] = [];
    t.hub.ai.hosts.runner = async (_h, command) => { ran.push(command); return { exit_code: 0, output: "auth ok for p@ss'word", timed_out: false, ms: 3 }; };
    const command = "curl -su admin:{{secret:Router admin}} https://10.0.0.1/api/self";
    assert.equal(isReadOnly(command, "linux"), false, "never runs without approval");
    const core = t.hub.ai.hosts.host("core")!;
    const a = t.hub.ai.hosts.propose("s1", core, command, "check the router login", null);
    const out = await t.hub.ai.hosts.approve(a.id);
    assert.deepEqual(ran, [`curl -su admin:'p@ss'\\''word' https://10.0.0.1/api/self`]);
    assert.equal(out.result.output, "auth ok for [secret]");
    assert.equal(out.action.command, command, "the stored command keeps the name");
    assert.equal(out.journal.fields.command, command);
    assert.ok(!String(t.hub.ai.hosts.get(a.id)!.output).includes("p@ss"));
    // An excluded item (its folder is excluded in Settings) is never read, even by name.
    const b = t.hub.ai.hosts.propose("s2", core, "echo {{secret:Recovery Codes}}", "", null);
    await assert.rejects(t.hub.ai.hosts.approve(b.id), /not an item that may be used/);
    assert.equal(t.hub.ai.hosts.get(b.id)!.status, "failed");
    assert.ok(!f.calls.some((c) => /Recovery Codes/.test(c.command)));
    assert.equal(ran.length, 1);
    assert.equal(quoteFor("windows", "it's"), "'it''s'");
    // PowerShell ends a quoted string at curly quotes too: a password with one cannot break out.
    assert.equal(quoteFor("windows", "it\u2019s; Remove-Item x"), "'it\u2019\u2019s; Remove-Item x'");
    assert.equal(quoteFor("windows", "\u2018a\u201Bb\u201A"), "'\u2018\u2018a\u201B\u201Bb\u201A\u201A'");
  } finally { f.restore(); t.cleanup(); }
});

test("password manager: Bitwarden (or Vaultwarden) signs in with the password in its environment and keeps only the session", async () => {
  const t = makeHub();
  const calls: { command: string; env: Record<string, string> }[] = [];
  const orig = cli.run;
  const SESSION = "A".repeat(20) + "b".repeat(30) + "==";
  let state = "unauthenticated";
  cli.run = async (_host, command, _input, env) => {
    calls.push({ command, env });
    if (/command -v/.test(command)) return { code: /command -v bw/.test(command) ? 0 : 1, out: "" };
    if (/bw status/.test(command)) return { code: 0, out: JSON.stringify({ status: env.BW_SESSION === SESSION ? state : state === "unlocked" ? "locked" : state, userEmail: state === "unauthenticated" ? undefined : "jamie@example.com", serverUrl: "https://vault.example.net" }) };
    if (/bw config server/.test(command)) return { code: 0, out: "Saved setting `config`." };
    if (/bw login/.test(command)) {
      if (env.EA_BW_PASSWORD !== "correct horse") return { code: 1, out: "Username or password is incorrect. Try again." };
      if (!/--code '654321'/.test(command)) return { code: 1, out: "Two-step login is required." };
      state = "unlocked";
      return { code: 0, out: `${SESSION}\n` };
    }
    if (/bw sync/.test(command)) return { code: 0, out: "Syncing complete." };
    if (/bw list items --search 'Router admin'/.test(command)) return { code: 0, out: JSON.stringify([{ name: "Router admin 2" }, { name: "Router admin", login: { username: "admin", password: "s3cret!" } }]) };
    if (/bw list items/.test(command)) return { code: 0, out: JSON.stringify([{ name: "Router admin" }, { name: "Bank" }]) };
    return { code: 1, out: "unknown" };
  };
  try {
    hosts(t);
    assert.equal((await t.api("/connections/password-manager", { method: "PUT", json: { provider: "bitwarden", host: "vault-box" } })).status, 422, "the session key stays on the hub's own machine");
    assert.equal((await t.api("/connections/password-manager", { method: "PUT", json: { provider: "bitwarden" } })).status, 200);
    const st = (await (await t.api("/connections/password-manager/status")).json()) as { installed: Record<string, boolean>; signed_in: boolean };
    assert.deepEqual([st.installed.bitwarden, st.installed.keepass, st.signed_in], [true, true, false]);
    assert.equal((await t.api("/connections/password-manager/signin", { method: "POST", json: { email: "jamie@example.com", password: "nope" } })).status, 422);
    const two = await t.api("/connections/password-manager/signin", { method: "POST", json: { email: "jamie@example.com", password: "correct horse", server: "https://vault.example.net/" } });
    assert.match(((await two.json()) as { error: string }).error, /code from your authenticator/);
    const ok = await t.api("/connections/password-manager/signin", { method: "POST", json: { email: "jamie@example.com", password: "correct horse", code: "654321", server: "https://vault.example.net" } });
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { signed_in: boolean }).signed_in, true);
    assert.ok(calls.some((c) => /bw config server 'https:\/\/vault\.example\.net'$/.test(c.command)), "Vaultwarden's address is set before signing in");
    assert.ok(!calls.some((c) => c.command.includes("correct horse")), "the master password is never on a command line");
    const sealed = fs.readFileSync(path.join(t.hub.cfg.dataDir, "connections.json"), "utf8");
    assert.ok(sealed.startsWith("sb1:") && !sealed.includes(SESSION), "sealed on disk");
    const saved = JSON.stringify(t.hub.connections.get());
    assert.ok(!saved.includes("correct horse") && saved.includes(SESSION));
    assert.deepEqual(((await (await t.api("/connections/password-manager/items")).json()) as { items: string[] }).items, ["Bank", "Router admin"]);
    t.hub.connections.update((c) => { c.password_manager!.allowed = ["Router admin"]; });
    const ran: string[] = [];
    t.hub.ai.hosts.runner = async (_h, command) => { ran.push(command); return { exit_code: 0, output: "ok", timed_out: false, ms: 1 }; };
    const a = t.hub.ai.hosts.propose("s1", t.hub.ai.hosts.host("core")!, "login {{secret:Router admin/username}} {{secret:Router admin}}", "", null);
    await t.hub.ai.hosts.approve(a.id);
    assert.deepEqual(ran, ["login 'admin' 's3cret!'"], "the item whose name matches exactly, not one that starts the same");
  } finally { cli.run = orig; t.cleanup(); }
});

test("password manager: the built-in KeePass vault is made on first choice, holds items without showing them, and opens in any KeePass app", async () => {
  const t = makeHub();
  try {
    hosts(t);
    const linked = await t.api("/connections/password-manager", { method: "PUT", json: { provider: "keepass" } });
    assert.equal(linked.status, 200);
    const file = path.join(t.hub.cfg.dataDir, "passwords.kdbx");
    assert.ok(fs.existsSync(file));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const st = (await (await t.api("/connections/password-manager/status")).json()) as { signed_in: boolean };
    assert.equal(st.signed_in, true);
    // Add an item with a password, and one with a password made up for it.
    assert.equal((await t.api("/connections/password-manager/keepass/entries", { method: "PUT", json: { title: "NAS admin", username: "root", password: "pa ss'word" } })).status, 200);
    assert.equal((await t.api("/connections/password-manager/keepass/entries", { method: "PUT", json: { title: "{{bad}}" } })).status, 422);
    await t.api("/connections/password-manager/keepass/entries", { method: "PUT", json: { title: "Wi-Fi guest", url: "https://10.0.0.1" } });
    const listed = (await (await t.api("/connections/password-manager/keepass/entries")).json()) as { entries: { title: string; username: string }[] };
    assert.deepEqual(listed.entries.map((e) => e.title).sort(), ["NAS admin", "Wi-Fi guest"]);
    assert.ok(!JSON.stringify(listed).includes("pa ss"), "no password is ever listed");
    const view = (await (await t.api("/connections/password-manager")).json()) as { allowed: string[] };
    assert.deepEqual(view.allowed, ["NAS admin", "Wi-Fi guest"], "items added here are the assistant's to use");
    // An approved command gets the value; the output never shows it.
    const ran: string[] = [];
    t.hub.ai.hosts.runner = async (_h, command) => { ran.push(command); return { exit_code: 0, output: "logged in with pa ss'word", timed_out: false, ms: 1 }; };
    const a = t.hub.ai.hosts.propose("s1", t.hub.ai.hosts.host("core")!, "ssh-login {{secret:NAS admin/username}} {{secret:nas admin}}", "", null);
    const out = await t.hub.ai.hosts.approve(a.id);
    assert.deepEqual(ran, ["ssh-login 'root' 'pa ss'\\''word'"]);
    assert.equal(out.result.output, "logged in with [secret]");
    // The made-up password is long, and the file opens with the master password the hub shows its owner.
    const master = ((await (await t.api("/connections/password-manager/keepass/master")).json()) as { password: string }).password;
    assert.ok(master.length >= 32);
    const { KeePassVault } = await import("../src/keepass.js");
    const copy = new KeePassVault(file, () => master);
    assert.ok(((await copy.read("Wi-Fi guest")) ?? "").length >= 24);
    const dl = await t.api("/connections/password-manager/keepass/file");
    assert.equal(dl.headers.get("content-disposition"), 'attachment; filename="passwords.kdbx"');
    const bytes = Buffer.from(await dl.arrayBuffer());
    assert.equal(await KeePassVault.check(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, master), 2);
    // Switching away and back keeps the vault and its master password.
    await t.api("/connections/password-manager", { method: "DELETE" });
    await t.api("/connections/password-manager", { method: "PUT", json: { provider: "keepass" } });
    assert.equal(((await (await t.api("/connections/password-manager/status")).json()) as { signed_in: boolean }).signed_in, true);
    // A KeePass file the owner already has replaces it, and the old one is kept beside it.
    const theirs = path.join(t.dir, "theirs.kdbx");
    const mine = new KeePassVault(theirs, () => "their master");
    await mine.create("Mine");
    await mine.put({ title: "Old router", password: "x" });
    assert.equal((await t.api("/connections/password-manager/keepass/import", { method: "POST", json: { data: fs.readFileSync(theirs).toString("base64"), password: "wrong" } })).status, 422);
    const imp = await t.api("/connections/password-manager/keepass/import", { method: "POST", json: { data: fs.readFileSync(theirs).toString("base64"), password: "their master" } });
    assert.equal(((await imp.json()) as { items: number }).items, 1);
    assert.ok(fs.readdirSync(t.hub.cfg.dataDir).some((f) => /^passwords\.kdbx\..*\.bak$/.test(f)));
    assert.deepEqual(((await (await t.api("/connections/password-manager/items")).json()) as { items: string[] }).items, ["Old router"]);
    assert.equal((await t.api("/connections/password-manager/keepass/entries?title=Old%20router", { method: "DELETE" })).status, 200);
    assert.deepEqual(((await (await t.api("/connections/password-manager/items")).json()) as { items: string[] }).items, []);
  } finally { t.cleanup(); }
});

test("password manager: two items with one name need the folder, an excluded folder settles it, and the assistant never finds excluded items", async () => {
  const t = makeHub();
  const f = fakeCli();
  forgetItemNames();
  try {
    hosts(t);
    t.hub.connections.update((c) => { c.password_manager = { provider: "lastpass", host: "core", allowed: [], linked_at: new Date().toISOString() }; });
    const core = t.hub.ai.hosts.host("core")!;
    t.hub.ai.hosts.runner = async (_h, command) => ({ exit_code: 0, output: command, timed_out: false, ms: 1 });
    const two = t.hub.ai.hosts.propose("s1", core, "echo {{secret:Netflix}}", "", null);
    await assert.rejects(t.hub.ai.hosts.approve(two.id), /2 items are named "Netflix".*Media\/Netflix.*Shared-Family\/Netflix|2 items are named "Netflix".*Shared-Family\/Netflix.*Media\/Netflix/);
    const full = t.hub.ai.hosts.propose("s1", core, "echo {{secret:Media/Netflix}}", "", null);
    assert.equal((await t.hub.ai.hosts.approve(full.id)).action.status, "done");
    assert.ok(f.calls.some((c) => /lpass show --sync=no --password '105'/.test(c.command)), "read by the item's id, never by a name two items share");
    // Excluding the shared folder leaves one Netflix: the plain name works.
    await t.api("/connections/password-manager/access", { method: "PUT", json: { excluded: ["Shared-Family/"] } });
    const one = t.hub.ai.hosts.propose("s1", core, "echo {{secret:Netflix}}", "", null);
    assert.equal((await t.hub.ai.hosts.approve(one.id)).action.status, "done");
    // The assistant's search leaves excluded items out; Settings sees them.
    const mine = (await (await t.api("/connections/password-manager/items?q=netflix", { headers: { "x-ea-origin": "assistant" } })).json()) as { items: string[] };
    assert.deepEqual(mine.items, ["Media/Netflix"]);
    const settings = (await (await t.api("/connections/password-manager/items?q=netflix")).json()) as { items: string[] };
    assert.deepEqual(settings.items, ["Media/Netflix", "Shared-Family/Netflix"]);
    // Chosen access: only the chosen items, as before.
    await t.api("/connections/password-manager/access", { method: "PUT", json: { access: "chosen" } });
    await t.api("/connections/password-manager/allowed", { method: "PUT", json: { names: ["Router admin"] } });
    const no = t.hub.ai.hosts.propose("s1", core, "echo {{secret:Media/Netflix}}", "", null);
    await assert.rejects(t.hub.ai.hosts.approve(no.id), /not one of the items chosen/);
  } finally { f.restore(); t.cleanup(); }
});
