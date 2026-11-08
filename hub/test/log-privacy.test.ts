import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { errCode, logHost } from "../src/logsafe.js";
import { StoreError } from "../src/store.js";
import { setBackendOverride, type Backend } from "../src/ai/backends.js";
import { makeHub } from "./helpers.js";

/*
 * Logs never hold secrets or personal text (CONTRACT.md, "Privacy rules every module meets"). A log line may hold ids,
 * counts, kinds, durations, status codes and module names. This file checks that two ways: errCode and logHost keep
 * only those, and a heuristic over the source fails when a log call interpolates something that looks risky.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const ROOTS = ["hub/src", "tools/vault-mirror/src"];

/**
 * Log calls a person checked by hand. `contains` is a piece of the call's text, so the entry follows the line when
 * code moves. `pending` marks files other people are rewriting now (Phase 2, docs/05-public-release.md): their risky
 * lines are known, listed here so that a new one is still caught, and may go away without this list being updated.
 */
const ALLOW: { file: string; contains: string; why: string; pending?: true }[] = [
  // checked by hand
  { file: "hub/src/hub.ts", contains: "JSON.stringify(mv.moved)", why: "table names and row counts" },
  { file: "hub/src/hub.ts", contains: "could not keep ${file}", why: "the path of the hub's own seq mark file in its data folder" },
  { file: "hub/src/modules.ts", contains: "${this.file} could not be read (${damaged})", why: "damaged is errCode() output; the file is modules.json in the data folder" },
  { file: "hub/src/modules.ts", contains: "could not save ${this.file}", why: "the path of modules.json in the data folder" },
  { file: "hub/src/note-linker.ts", contains: "f.path ? \"moved to a folder\"", why: "the note's id and counts; f.path is only tested, never printed" },
  { file: "hub/src/sweep.ts", contains: "${out.notes} notes, ${out.links_updated} links updated", why: "counts and a duration" },
  { file: "hub/src/workkey.ts", contains: "key file ${this.file} is not a usable key", why: "the key file's path and its length, never its bytes" },
  { file: "hub/src/ai/index.ts", contains: "[ai] ${backend.name} failed", why: "backend.name is a kind (ollama, openai, anthropic, adapter)" },
  { file: "hub/src/ai/index.ts", contains: "logHost(backend.host) : backend.name", why: "host:port only, or the backend kind" },
  // backups and the installer (checked by hand, 2026-11-05)
  { file: "hub/src/backup.ts", contains: "e instanceof BackupKeyError ? e.message", why: "BackupKeyError text is the hub's own sentence about its key file; anything else is errCode()" },
  { file: "hub/src/hub.ts", contains: "e instanceof BackupKeyError ? e.message", why: "BackupKeyError text is the hub's own sentence about its key file; anything else is errCode()" },
  { file: "hub/src/routes/backup.ts", contains: "console.error(`[backup] ${e.message}`)", why: "only a BackupKeyError reaches it: the hub's own sentence about its key file" },
  { file: "hub/src/backup.ts", contains: "plain work items; left plain until they are sealed", why: "a dated backup file name and a count" },
  { file: "hub/src/backup.ts", contains: "dropped the chat tables of ${name}", why: "a dated backup file name" },
  { file: "hub/src/backup.ts", contains: "chat tables could not be dropped: ${errCode(e)}", why: "a dated backup file name and errCode()" },
  { file: "hub/src/backupkey.ts", contains: "was readable by others; now owner-only", why: "the path of the hub's own key file" },
  { file: "hub/src/backupkey.ts", contains: "made the backup key ${this.file}", why: "the key file's path and the public key, which is not secret" },
  { file: "hub/src/main.ts", contains: "[backup] outbox ${o.dir}", why: "the hub's outbox folder and counts" },
  { file: "hub/src/main.ts", contains: "console.error(`[restore] ${(e as Error).message}`)", why: "printed to the owner's terminal by a restore they ran; the hub's own guidance" },
  { file: "hub/src/main.ts", contains: "integrity ${r.integrity}, ${r.entities} entities", why: "the restore target the owner named, and counts" },
  { file: "hub/src/main.ts", contains: "recipient=${k.recipient()}", why: "the public key and the key file's path, for deploy scripts; the identity is never printed" },
  { file: "hub/src/main.ts", contains: "console.error(`[backup-key] ${(e as Error).message}`)", why: "printed to the owner's terminal by a command they ran; the hub's own key file sentence" },
  { file: "hub/src/main.ts", contains: "[encrypt-backups] ${dir} is the hub's data folder", why: "the folder the owner passed" },
  { file: "hub/src/main.ts", contains: "console.error(`[encrypt-backups] ${(e as Error).message}`)", why: "printed to the owner's terminal by a command they ran" },
  { file: "hub/src/main.ts", contains: "; fix hub.env (or run deploy/install.sh again) and start again.", why: "a config check's own sentence (loadConfig, loadTls): names a setting, never a value" },
  { file: "hub/src/main.ts", contains: "listening on ${how}", why: "host:port only for model servers; the data and vault folders are the hub's own" },
  // being rewritten by others now (their risky lines are in the privacy review report)
  { file: "hub/src/app.ts", contains: "${c.req.method} ${routeOf(c)} ${c.res.status}", why: "the method and the route's pattern, never the path, its query or headers" },
  { file: "hub/src/app.ts", contains: "[app] ${c.req.method} ${routeOf(c)}: ${errCode(err)}", why: "the method, the route's pattern and errCode()" },
  { file: "hub/src/backup.ts", contains: "cannot be read, left as it is: ${errCode(e)}", why: "a dated backup file name and errCode()" },
  // in the same files, checked by hand and safe: backup file names are dates, folders are the hub's own
  { file: "hub/src/backup.ts", contains: "[backup] wrote ${r.file}", why: "a dated backup file name and a count" },
  { file: "hub/src/main.ts", contains: "[backup] wrote ${r.file}", why: "a dated backup file name and the dated names pruned" },
  { file: "hub/src/main.ts", contains: "[purge] ${dir} is the hub's data folder", why: "the folder the owner passed on the command line" },
  { file: "hub/src/main.ts", contains: "backup file(s) in ${dir}", why: "a count and the folder the owner passed" },
  { file: "hub/src/main.ts", contains: "EA_TOKEN is ${cfg.token.length} characters", why: "the token's length, never the token" },
  { file: "hub/src/backup.ts", contains: "could not be sealed: ${errCode(e)}", why: "a dated backup file name and errCode()" },
];

/** Patterns that mark a log call's code (not its fixed text) as risky. */
const RISKY: { name: string; re: RegExp }[] = [
  { name: "an error's message or stack", re: /\.(message|stack)\b/ },
  { name: "an error object itself", re: /(^|[^\w.$])(e|e2|err|error|lastErr)\s*(\)|,|\?\?|$|\})/ },
  { name: "an entity's fields", re: /\bfields\b/ },
  { name: "text, a title or a body", re: /\b(text|title|titles|body|content|summary|snippet|description|notes?)\b/i },
  { name: "a secret", re: /token|password|passwd|secret|api_?key|\bkey\b|cookie|authorization|bearer|credential/i },
  { name: "a request or its parts", re: /\b(headers?|query|req|request|params|url|href|uri)\b/i },
  { name: "a model's prompt or reply", re: /\b(prompt|reply|replies|messages?|completion|answer)\b/i },
  { name: "mail or a person", re: /\b(email|emails|subject|sender|from|to|recipient|person|people|account)\b/i },
  { name: "command output", re: /\b(stdout|stderr|output)\b|\bout\b(?!\.\w)/ },
  { name: "a file or folder name", re: /\b(path|rel|filename|file|dir|name)\b/ },
  { name: "a dump of an object", re: /JSON\.stringify|util\.inspect|String\(\s*(e|err|error)\s*\)/ },
];

/** The sanctioned sanitizers: whatever they are given, they return only codes, statuses and host:port. */
const SANITIZED = /\b(errCode|logHost|mailboxLabel)\s*\(/;

interface Call { file: string; line: number; text: string; code: string }

/**
 * Every console.* call (and process.stdout/stderr.write, and vault-mirror's log()) with its whole argument list.
 * `code` is that argument list with the fixed text of string and template literals blanked, so the words a message is
 * written in ("the hub token") never count, only what is interpolated into it.
 */
function logCalls(file: string, src: string): Call[] {
  const out: Call[] = [];
  const start = /\b(?:console\.(?:log|error|warn|info|debug|trace)|process\.(?:stdout|stderr)\.write|(?<![.\w])log|say|Write-Log)\s*\(/g;
  for (let m = start.exec(src); m; m = start.exec(src)) {
    if (/^\s*function\b/.test(src.slice(src.lastIndexOf("\n", m.index) + 1, m.index))) continue;
    let i = m.index + m[0].length;
    let depth = 1;
    let code = "";
    // a small lexer: plain code, '...' and "..." strings, `...` templates with ${...} code inside (nested any depth)
    const stack: ("code" | "tpl")[] = ["code"];
    const braces: number[] = [0];
    while (i < src.length && depth > 0) {
      const ch = src[i];
      const mode = stack[stack.length - 1];
      if (mode === "tpl") {
        if (ch === "\\") { i += 2; continue; }
        if (ch === "`") { stack.pop(); code += "`"; i++; continue; }
        if (ch === "$" && src[i + 1] === "{") { stack.push("code"); braces.push(0); code += "${"; i += 2; continue; }
        i++; continue;
      }
      if (ch === "'" || ch === '"') {
        const q = ch; i++;
        while (i < src.length && src[i] !== q) { if (src[i] === "\\") i++; i++; }
        i++; code += `${q}${q}`; continue;
      }
      if (ch === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
      if (ch === "`") { stack.push("tpl"); code += "`"; i++; continue; }
      if (ch === "{") braces[braces.length - 1]++;
      if (ch === "}") {
        if (braces[braces.length - 1] === 0 && stack.length > 1) { stack.pop(); braces.pop(); code += "}"; i++; continue; }
        braces[braces.length - 1]--;
      }
      if (stack.length === 1) { if (ch === "(") depth++; if (ch === ")") depth--; }
      if (depth > 0) code += ch;
      i++;
    }
    const line = src.slice(0, m.index).split("\n").length;
    out.push({ file, line, text: src.slice(m.index, i), code });
  }
  return out;
}

/** The code of a call with each sanitizer call removed (its argument may be anything: it is reduced to a code). */
function unsanitized(code: string): string {
  let s = code;
  for (let m = SANITIZED.exec(s); m; m = SANITIZED.exec(s)) {
    let i = m.index + m[0].length, depth = 1;
    while (i < s.length && depth > 0) { if (s[i] === "(") depth++; else if (s[i] === ")") depth--; i++; }
    s = `${s.slice(0, m.index)}SAFE${s.slice(i)}`;
  }
  return s;
}

function sources(): { file: string; src: string }[] {
  const out: { file: string; src: string }[] = [];
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
      const rel = `${dir}/${ent.name}`;
      if (ent.isDirectory()) walk(rel);
      else if (/\.(ts|mjs|js)$/.test(ent.name)) out.push({ file: rel, src: fs.readFileSync(path.join(REPO, rel), "utf8") });
    }
  };
  for (const r of ROOTS) walk(r);
  return out;
}

test("log privacy: no log call interpolates a secret, personal text or an error's message", () => {
  const found: string[] = [];
  const used = new Set<number>();
  let calls = 0;
  for (const { file, src } of sources()) {
    for (const c of logCalls(file, src)) {
      calls++;
      const code = unsanitized(c.code);
      const hits = RISKY.filter((r) => r.re.test(code)).map((r) => r.name);
      if (!hits.length) continue;
      const allowed = ALLOW.findIndex((a) => a.file === file && c.text.includes(a.contains));
      if (allowed >= 0) { used.add(allowed); continue; }
      found.push(`${file}:${c.line}: ${hits.join(", ")}\n    ${c.text.replace(/\s+/g, " ").slice(0, 200)}`);
    }
  }
  assert.ok(calls > 50, `the scanner found only ${calls} log calls; it is broken`);
  assert.deepEqual(found, [], `Log lines that may carry a secret or personal text. Log ids, counts, kinds, durations and status codes; wrap an error in errCode(e) and an address in logHost(u) (hub/src/logsafe.ts). If a line is safe, add it to ALLOW with the reason.\n${found.join("\n")}`);
  const stale = ALLOW.filter((a, i) => !a.pending && !used.has(i)).map((a) => `${a.file}: ${a.contains}`);
  assert.deepEqual(stale, [], "allow-list entries that no longer match a log call: remove them");
});

test("log privacy: the scanner sees through templates and catches the usual leaks", () => {
  const flagged = (src: string) => logCalls("x.ts", src).map((c) => RISKY.filter((r) => r.re.test(unsanitized(c.code))).map((r) => r.name));
  assert.deepEqual(flagged("console.log(`[hub] the token is never logged, ${n} devices`);"), [[]], "fixed text never counts");
  assert.ok(flagged("console.error(`[x] ${(e as Error).message}`);")[0].length);
  assert.ok(flagged("console.log(`[notes] \"${String(next.fields.title ?? \"\")}\"`);")[0].length);
  assert.ok(flagged("console.error('[x]', err);")[0].length);
  assert.ok(flagged("console.log(`[mail] ${a.email}: ${r.queued} new`);")[0].length);
  assert.ok(flagged("console.log(\n  `[ai] ${JSON.stringify(body)}`,\n);")[0].length, "a call over several lines");
  assert.ok(flagged("console.log(`a ${`b ${req.headers.authorization}`}`);")[0].length, "a template inside a template");
  assert.deepEqual(flagged("console.error(`[x] ${id}: ${errCode(e)} at ${logHost(cfg.ollamaUrl)}`);"), [[]]);
});

test("log privacy: errCode keeps the kind, code and status of an error and never its text", () => {
  const secret = "sk-ant-api03-SECRETSECRET my therapy notes";
  const upstream = new Error(`ollama 500: {"error":"prompt was ${secret}"}`);
  const a = errCode(upstream);
  assert.match(a, /^Error upstream 500/);
  assert.ok(!a.includes("SECRET") && !a.includes("therapy"), a);
  const store = errCode(new StoreError(502, `Steam answered 503 for ${secret}`));
  assert.match(store, /^StoreError status 502 upstream 503/);
  assert.ok(!store.includes("SECRET"));
  // a JSON.parse failure quotes the text it read: here a settings file holding a key
  let parse: unknown;
  try { JSON.parse(`{"anthropic_key":"${secret}`); } catch (e) { parse = e; }
  assert.ok(String((parse as Error).message).length > 0);
  assert.ok(!errCode(parse).includes("SECRET"), errCode(parse));
  assert.match(errCode(parse), /^SyntaxError/);
  // a file error names the file
  let fileErr: unknown;
  try { fs.readFileSync("/nonexistent/Private/Diagnosis.md"); } catch (e) { fileErr = e; }
  assert.match(errCode(fileErr), /^Error ENOENT/);
  assert.ok(!errCode(fileErr).includes("Diagnosis"));
  // fetch failures carry their reason in cause
  const net = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(`connect ECONNREFUSED ${secret}`), { code: "ECONNREFUSED" }) });
  assert.match(errCode(net), /^TypeError ECONNREFUSED/);
  assert.ok(!errCode(net).includes("SECRET"));
  assert.match(errCode(new Error("x")), / at test\/log-privacy\.test\.ts:\d+$|^Error$/, "where it was thrown, when in the project's own code");
  assert.equal(errCode("a thrown string with a secret"), "string");
  assert.equal(errCode(undefined), "undefined");
});

test("log privacy: logHost keeps host and port, never a user, password, path or query", () => {
  assert.equal(logHost("http://user:pa55@desk-pc.example.ts.net:11434/v1?key=abc"), "desk-pc.example.ts.net:11434");
  assert.equal(logHost("https://openrouter.ai/api/v1"), "openrouter.ai");
  assert.equal(logHost("not a url with a secret"), "(address)");
  assert.equal(logHost(undefined), "(none)");
});

test("log privacy: a model failure whose answer echoes the prompt is logged without it", async () => {
  const t = makeHub();
  const lines: string[] = [];
  const orig = { error: console.error, log: console.log, warn: console.warn };
  const keep = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  const failing: Backend = {
    name: "ollama", model: "m",
    chat: async () => { throw new Error('ollama 500: {"error":"bad request: my private question about zanzibar"}'); },
    stream: async () => { throw new Error('ollama 500: {"error":"bad request: my private question about zanzibar"}'); },
    streamTools: async () => { throw new Error('ollama 500: {"error":"bad request: my private question about zanzibar"}'); },
  } as Backend;
  setBackendOverride(failing);
  console.error = keep; console.log = keep; console.warn = keep;
  try {
    await t.hub.ai.chat({ session_id: "leak", task_type: "general", message: "my private question about zanzibar" } as any).catch(() => undefined);
  } finally {
    console.error = orig.error; console.log = orig.log; console.warn = orig.warn;
    setBackendOverride(null);
    t.cleanup();
  }
  assert.ok(lines.some((l) => /\[ai\] .*failed: Error upstream 500/.test(l)), `the failure is still logged:\n${lines.join("\n")}`);
  assert.ok(lines.every((l) => !l.includes("zanzibar")), lines.join("\n"));
});
