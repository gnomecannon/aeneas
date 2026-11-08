import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { SecretBox } from "../src/secretbox.js";
import { ConnectionStore } from "../src/imports/connections.js";
import { readAiSettings, sealAiSettings } from "../src/setup.js";
import { makeHub } from "./helpers.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ea-secretbox-"));

test("sign-ins are sealed on disk, open again, and are bound to their file name", () => {
  const dir = tmp();
  const box = new SecretBox(path.join(dir, "keys", "secrets.key"));
  const file = path.join(dir, "connections.json");
  const c = new ConnectionStore(file, box);
  c.update((x) => { x.steam_key = "STEAMKEY-1234567890"; });
  c.update((x) => { x.google_app = { client_id: "cid", client_secret: "GOOGLESECRET-123" }; });
  const raw = fs.readFileSync(file, "utf8");
  assert.ok(raw.startsWith("sb1:"));
  assert.ok(!raw.includes("STEAMKEY") && !raw.includes("GOOGLESECRET"));
  assert.ok(!fs.readFileSync(`${file}.bak`, "utf8").includes("STEAMKEY"), "the kept copy is sealed too");
  assert.equal((fs.statSync(path.join(dir, "keys", "secrets.key")).mode & 0o777), 0o600);
  assert.equal(new ConnectionStore(file, new SecretBox(path.join(dir, "keys", "secrets.key"))).get().steam_key, "STEAMKEY-1234567890");
  assert.throws(() => box.open("ai.json", raw), /does not open/, "a sealed file renamed to another does not open");
});

test("an older hub's plain files are sealed once at start, nothing lost", () => {
  const t = makeHub();
  try {
    const conn = path.join(t.dir, "connections.json");
    fs.writeFileSync(conn, JSON.stringify({ steam_key: "PLAINKEY-1234567890" }));
    fs.writeFileSync(`${conn}.bak`, JSON.stringify({ steam_key: "OLDPLAIN-1234567890" }));
    fs.writeFileSync(path.join(t.dir, "ai.json"), JSON.stringify({ anthropic_key: "sk-ant-PLAIN" }));
    assert.equal(t.hub.connections.sealIfPlain(), true);
    assert.equal(sealAiSettings(t.dir, t.hub.secretBox), true);
    for (const f of [conn, `${conn}.bak`, path.join(t.dir, "ai.json")]) assert.ok(fs.readFileSync(f, "utf8").startsWith("sb1:"), f);
    assert.equal(t.hub.connections.get().steam_key, "PLAINKEY-1234567890");
    assert.equal(readAiSettings(t.dir, t.hub.secretBox).anthropic_key, "sk-ant-PLAIN");
    assert.equal(t.hub.connections.sealIfPlain(), false, "only once");
    assert.equal(sealAiSettings(t.dir, t.hub.secretBox), false);
  } finally { t.cleanup(); }
});

test("a sealed file whose key is gone is refused, never read as empty or overwritten", () => {
  const dir = tmp();
  const keyFile = path.join(dir, "secrets.key");
  const file = path.join(dir, "connections.json");
  new ConnectionStore(file, new SecretBox(keyFile)).update((x) => { x.steam_key = "KEEPME-1234567890"; });
  const before = fs.readFileSync(file, "utf8");
  fs.renameSync(keyFile, `${keyFile}.away`);
  const lost = new ConnectionStore(file, new SecretBox(keyFile));
  assert.throws(() => lost.get(), /key/);
  assert.throws(() => lost.update((x) => { x.steam_key = "NEW"; }), /key/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.equal(fs.existsSync(keyFile), false, "no new key is made for a file sealed with another");
});

test("the installer's model check reads a sealed ai.json the way the hub writes it", () => {
  const dir = tmp();
  const box = new SecretBox(path.join(dir, "secrets.key"));
  box.writeSealed(path.join(dir, "ai.json"), JSON.stringify({ ollama_url: "http://127.0.0.1:11434" }));
  const sh = fs.readFileSync(path.join(import.meta.dirname, "..", "..", "deploy", "install.sh"), "utf8");
  const js = /"\$NODE_BIN" -e '\n([\s\S]*?)' "\$f" "\$k"/.exec(sh)?.[1];
  assert.ok(js, "model_chosen's script found");
  const run = (f: string, k: string) => { try { execFileSync(process.execPath, ["-e", js, f, k]); return 0; } catch (e) { return (e as { status: number }).status; } };
  assert.equal(run(path.join(dir, "ai.json"), path.join(dir, "secrets.key")), 0);
  box.writeSealed(path.join(dir, "ai.json"), JSON.stringify({ ollama_url: "" }));
  assert.equal(run(path.join(dir, "ai.json"), path.join(dir, "secrets.key")), 1);
});
