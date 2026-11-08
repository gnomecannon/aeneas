import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deviceKey, makeHub, TOKEN } from "./helpers.js";
import { ctxFor } from "./ai-helpers.js";
import { ModuleStore } from "../src/modules.js";
import { setBackendOverride, buildBackends, type AiMessage, type Backend } from "../src/ai/backends.js";
import { TOOLS } from "../src/ai/tools.js";
import { fileCapture } from "../src/capture-filer.js";
import { adoptSshHosts, loadHosts } from "../src/ai/hosts.js";
import { applyRetention, readRetention } from "../src/retention.js";
import { APP_CSP, corsAllowed } from "../src/app.js";
import { loadConfig } from "../src/config.js";

// The seven tenets (CONTRACT.md section 0), 2026-11-06: what a new hub does by default, and that a hub already in use
// keeps doing what it did.

test("tenets: web lookups are off for a new hub, and a hub already in use keeps them as they were", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-mod-"));
  try {
    const fresh = new ModuleStore(path.join(dir, "new.json"), { existing: () => false, preset: "" });
    assert.equal(fresh.on("web"), false, "a new hub asks no search engine anything");
    const oldFile = path.join(dir, "old.json");
    fs.writeFileSync(oldFile, JSON.stringify({ renewals: true, homelab: true }));
    assert.equal(new ModuleStore(oldFile, { existing: () => true, preset: "" }).on("web"), true, "a modules.json from before keeps web on");
    fs.writeFileSync(oldFile, JSON.stringify({ renewals: true, web: false }));
    assert.equal(new ModuleStore(oldFile, { existing: () => true, preset: "" }).on("web"), false, "a choice already made stays");
    const used = new ModuleStore(path.join(dir, "used.json"), { existing: () => true, preset: "" });
    assert.equal(used.on("web"), true, "a hub with the owner's data and no modules.json yet starts with everything on, as before");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("tenets: filing a capture never offers web search or page reads, though a chat does", async () => {
  const t = makeHub({ searxngUrl: "http://127.0.0.1:1", torSocks: "127.0.0.1:9" });
  const offered: string[][] = [];
  const systems: string[] = [];
  const b: Backend = {
    name: "ollama", model: "m",
    chat: async () => ({ text: "{}", usage: {} }),
    stream: async () => ({ text: "", usage: {} }),
    streamTools: async (msgs: AiMessage[], tools: unknown[]) => {
      offered.push((tools as { function?: { name?: string }; name?: string }[]).map((x) => x.function?.name ?? x.name ?? ""));
      systems.push(String(msgs[0]?.content ?? ""));
      return { text: "Saved.", usage: {} };
    },
  } as Backend;
  setBackendOverride(b);
  try {
    await t.api("/ai/chat", { method: "POST", json: { session_id: "c1", task_type: "general", messages: [{ role: "user", content: "what's new in node 26?" }] } });
    assert.ok(offered[0].includes("web_search"), "a chat with Web lookups on can search");
    const cap = t.hub.store.create("capture", { text: "Lunch with Jen at the new ramen place on Elm St", source: "iphone", processed: false });
    await fileCapture(t.hub, cap.id);
    const filing = offered[offered.length - 1];
    assert.ok(filing.length > 0, "filing still has its tools");
    assert.ok(!filing.includes("web_search") && !filing.includes("read_web_page"), filing.join(","));
    assert.ok(!/search the web/i.test(systems[systems.length - 1]), "and no instruction to search");
  } finally { setBackendOverride(null); t.cleanup(); }
});

test("tenets: phone photos never go to a cloud model", async () => {
  const t = makeHub();
  try {
    const tool = TOOLS.find((x) => x.name === "phone_photos")!;
    let asked = 0;
    const ctx = { ...ctxFor(t), cloud: true, askDevicePhotos: async () => { asked++; return [{ b64: "AAAA" }]; } };
    const out = await tool.run(async () => ({ status: 200, data: null }), { count: 2 }, ctx as never) as { error?: string };
    assert.match(out.error ?? "", /never to a cloud model/);
    assert.equal(asked, 0, "the phone is not even asked");
  } finally { t.cleanup(); }
});

test("tenets: only the hub's own browser clients get CORS answers; the web app gets a content security policy", async () => {
  const t = makeHub({ corsOrigins: ["https://dash.example.com"] });
  try {
    const from = async (origin: string) => (await t.app.request("/health", { headers: { origin } })).headers.get("access-control-allow-origin");
    assert.equal(await from("https://evil.example"), null, "another web page cannot read the answer");
    assert.equal(await from("tauri://localhost"), "tauri://localhost");
    assert.equal(await from("http://tauri.localhost"), "http://tauri.localhost");
    assert.equal(await from("http://localhost:5173"), "http://localhost:5173");
    assert.equal(await from("https://dash.example.com"), "https://dash.example.com", "EA_CORS_ORIGINS adds one");
    assert.equal(corsAllowed(undefined), false);
    assert.match(APP_CSP, /connect-src 'self'/);
    assert.match(APP_CSP, /script-src 'self';/);
    assert.match(APP_CSP, /frame-ancestors 'none'/);
  } finally { t.cleanup(); }
});

test("tenets: the main key works from the hub's own machine and named callers only, never in a link", async () => {
  const t = makeHub();
  const as = (headers: Record<string, string>, p = "/dashboard") => t.app.request(p, { headers: { authorization: `Bearer ${TOKEN}`, ...headers } });
  try {
    assert.equal((await as({})).status, 200, "a script on the hub's machine (loopback, nothing forwarded)");
    assert.equal((await as({ "x-forwarded-for": "100.64.0.7" })).status, 403, "through Tailscale Serve from another device");
    assert.equal((await as({ "tailscale-user-login": "someone@example.com" })).status, 403);
    assert.equal((await t.app.request(`/dashboard?token=${TOKEN}`)).status, 401, "never in a link");
    // A device's own key is unaffected, wherever it comes from.
    const key = await deviceKey(t);
    assert.equal((await t.app.request("/dashboard", { headers: { authorization: `Bearer ${key}`, "x-forwarded-for": "100.64.0.9" } })).status, 200);
    // Named callers: an address, or a Tailscale login.
    t.hub.cfg.mainKeyFrom = ["100.64.0.7", "Someone@Example.com"];
    assert.equal((await as({ "x-forwarded-for": "100.64.0.7" })).status, 200);
    assert.equal((await as({ "x-forwarded-for": "100.64.0.8" })).status, 403);
    assert.equal((await as({ "tailscale-user-login": "someone@example.com", "x-forwarded-for": "100.64.0.8" })).status, 200);
    t.hub.cfg.mainKeyFrom = ["*"];
    assert.equal((await as({ "x-forwarded-for": "203.0.113.5" })).status, 200, "* is the behaviour before 2026-11-06");
    t.hub.cfg.mainKeyFrom = [];
    t.hub.cfg.mainKeyInQuery = true;
    assert.equal((await t.app.request(`/dashboard?token=${TOKEN}`)).status, 200, "EA_MAIN_KEY_IN_QUERY=1 allows a link again, on the hub's machine");
    assert.equal((await t.app.request(`/dashboard?token=${TOKEN}`, { headers: { "x-forwarded-for": "100.64.0.7" } })).status, 403, "but still not from elsewhere");
  } finally { t.cleanup(); }
});

test("tenets: machines are only the ones added; a hub already using its SSH hosts keeps them, once", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-hosts-"));
  try {
    const ssh = path.join(dir, "ssh_config");
    fs.writeFileSync(ssh, "Host nas01 nas\n  HostName 192.0.2.10\n  User robin\nHost github.com\n  User git\nHost *\n  ServerAliveInterval 30\n");
    const cfg = { sshConfigPath: ssh, hostsFile: path.join(dir, "hosts.json"), dataDir: dir };
    const self = os.hostname().toLowerCase().split(".")[0];
    assert.deepEqual(loadHosts(cfg).map((h) => h.name), [self], "a new hub reaches no machine from the SSH config");
    // A new hub (or one not using Homelab or Sensors): nothing added, and it is not tried again.
    assert.equal(adoptSshHosts(cfg, false), 0);
    assert.equal(fs.existsSync(cfg.hostsFile), false);
    assert.equal(adoptSshHosts(cfg, true), 0, "done once per hub");
    // A hub already using them: its own entries stay, the SSH hosts are added once.
    fs.rmSync(path.join(dir, "hosts-adopted"));
    fs.writeFileSync(cfg.hostsFile, JSON.stringify([{ name: "desk", ssh: "robin@192.0.2.20", os: "windows" }, { name: "nas", ssh: "nas" }]));
    assert.equal(adoptSshHosts(cfg, true), 1, "github.com only; nas is already listed by its alias");
    const names = loadHosts(cfg).map((h) => h.name);
    for (const n of ["desk", "nas", "github.com"]) assert.ok(names.includes(n), n);
    assert.equal(adoptSshHosts(cfg, true), 0, "never again");
    assert.equal((JSON.parse(fs.readFileSync(cfg.hostsFile, "utf8")) as unknown[]).length, 3);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("tenets: PUT /machines replaces the list, and the assistant sees the change at once", async () => {
  const ssh = path.join(os.tmpdir(), `ea-ssh-${process.pid}-${Date.now()}`);
  fs.writeFileSync(ssh, "Host pve1\n  HostName 192.0.2.30\n");
  const t = makeHub({ sshConfigPath: ssh });
  try {
    const before = await (await t.api("/machines")).json() as { machines: unknown[]; ssh_config: string[] };
    assert.deepEqual(before, { machines: [], ssh_config: ["pve1"] });
    assert.ok(!t.hub.ai.hosts.hosts().some((h) => h.name === "pve1"));
    assert.equal((await t.api("/machines", { method: "PUT", json: { machines: [{ name: "pve1" }, { name: "pve1" }] } })).status, 422, "listed twice");
    assert.equal((await t.api("/machines", { method: "PUT", json: { machines: [{ name: "pve1", ssh: "x; rm -rf /" }] } })).status, 422);
    assert.equal((await t.api("/machines", { method: "PUT", json: { machines: [{ name: "PVE1", os: "linux" }] } })).status, 200);
    assert.ok(t.hub.ai.hosts.hosts().some((h) => h.name === "pve1"));
  } finally { t.cleanup(); fs.rmSync(ssh, { force: true }); }
});

test("tenets: chats and command output are kept forever unless a number of days is set", async () => {
  const t = makeHub();
  try {
    const old = new Date(Date.now() - 200 * 86_400_000).toISOString();
    const recent = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const add = (id: string, at: string) => t.hub.chatDb.prepare("INSERT INTO sessions (session_id, task_type, created_at, last_at, messages) VALUES (?, 'general', ?, ?, '[]')").run(id, at, at);
    add("old", old); add("recent", recent);
    t.hub.chatDb.prepare("INSERT INTO ai_actions (id, session_id, host, command, kind, status, created_at, ran_at, output) VALUES ('a1', 'recent', 'pve1', 'df -h', 'read', 'done', ?, ?, 'Filesystem ...')").run(old, old);
    assert.deepEqual(readRetention(t.hub), { chat_keep_days: 0, command_output_keep_days: 0 });
    assert.deepEqual(applyRetention(t.hub), { chats: 0, outputs: 0 }, "no setting: nothing is deleted");
    assert.equal((t.hub.chatDb.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n, 2);
    assert.equal((await t.api("/settings/retention", { method: "PUT", json: { chat_keep_days: -1 } })).status, 422);
    const set = await (await t.api("/settings/retention", { method: "PUT", json: { chat_keep_days: 90, command_output_keep_days: 30 } })).json();
    assert.deepEqual(set, { chat_keep_days: 90, command_output_keep_days: 30 });
    assert.deepEqual(applyRetention(t.hub), { chats: 1, outputs: 1 });
    assert.deepEqual((t.hub.chatDb.prepare("SELECT session_id FROM sessions").all() as { session_id: string }[]).map((r) => r.session_id), ["recent"]);
    const a = t.hub.chatDb.prepare("SELECT command, status, output FROM ai_actions WHERE id = 'a1'").get() as { command: string; status: string; output: string | null };
    assert.deepEqual(a, { command: "df -h", status: "done", output: null }, "the command and its result stay, its output goes");
    await t.api("/settings/retention", { method: "PUT", json: { chat_keep_days: 0 } });
    assert.equal(readRetention(t.hub).chat_keep_days, 0, "0 is forever again");
  } finally { t.cleanup(); }
});

test("tenets: no model and no place are assumed by default", () => {
  const saved = { m: process.env.EA_OLLAMA_MODEL, tz: process.env.EA_TZ, d: process.env.EA_NO_DOTENV };
  process.env.EA_NO_DOTENV = "1";
  delete process.env.EA_OLLAMA_MODEL;
  delete process.env.EA_TZ;
  try {
    const cfg = loadConfig({ dataDir: os.tmpdir(), ollamaUrl: "http://127.0.0.1:11434", aiFake: false });
    assert.equal(cfg.ollamaModel, "");
    assert.equal(cfg.tz, Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
    assert.equal(buildBackends(cfg).ollama, null, "no local backend until a model is chosen");
    assert.notEqual(buildBackends({ ...cfg, ollamaModel: "qwen3:8b" }).ollama, null);
    assert.deepEqual([cfg.mainKeyFrom, cfg.mainKeyInQuery, cfg.corsOrigins], [[], false, []]);
  } finally {
    if (saved.m !== undefined) process.env.EA_OLLAMA_MODEL = saved.m;
    if (saved.tz !== undefined) process.env.EA_TZ = saved.tz;
    if (saved.d !== undefined) process.env.EA_NO_DOTENV = saved.d; else delete process.env.EA_NO_DOTENV;
  }
});
