import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeHub } from "./helpers.js";
import { refuseToolCall } from "../src/ai/api-guard.js";
import { runTool, TOOLS, type ToolContext } from "../src/ai/tools.js";
import { parseBackupTarget } from "../src/backups.js";

test("tool calls cannot climb out of their path or reach the vault, pairing, setup or the owner's switches", () => {
  for (const p of [
    "/calc/../connections/password-manager/keepass/import", "/calc/%2e%2e/connections", "/calc/%2E%2E%2Fconnections", "/entities/./x", "//evil.example/x", "/x\\..\\y",
    "/connections/password-manager/keepass/master", "/connections/password-manager/keepass/file", "/setup/pair?name=x", "/vault/export",
    // Spelled with percent codes, which the router decodes before it matches (2026-11-05).
    "/setup/pai%72", "/%66eeds", "/vault/expor%74", "/connections/password%2Dmanager/keepass/master",
  ]) assert.notEqual(refuseToolCall("GET", p), null, p);
  assert.notEqual(refuseToolCall("PUT", "/mod%75les"), null);
  for (const [m, p] of [["PUT", "/modules"], ["PUT", "/profile"], ["POST", "/space/work"], ["POST", "/connections/password-manager/signin"], ["DELETE", "/connections/google/a@b.c"], ["POST", "/imports/text"], ["PUT", "/connections/steam/key"]] as const) {
    assert.notEqual(refuseToolCall(m, p), null, `${m} ${p}`);
  }
  for (const [m, p] of [["GET", "/connections"], ["GET", "/connections/password-manager"], ["GET", "/profile"], ["POST", "/connections/steam/sync"], ["POST", "/calc/split"], ["PATCH", "/entities/abc"], ["GET", "/search?q=a/b"]] as const) {
    assert.equal(refuseToolCall(m, p), null, `${m} ${p}`);
  }
});

test("the calculator tool only reaches the calculators; a path in its type is refused before the hub sees it", async () => {
  const t = makeHub();
  try {
    await t.api("/connections/password-manager", { method: "PUT", json: { provider: "keepass" } });
    const file = path.join(t.dir, "passwords.kdbx");
    const before = fs.readFileSync(file);
    const calc = TOOLS.find((x) => x.name === "calculate")!;
    const ctx = { sessionId: "s", lastUser: "", topic: "", store: t.hub.store, cfg: t.hub.cfg, hosts: null } as ToolContext;
    // The same in-process caller the assistant uses.
    let api!: Parameters<typeof runTool>[0];
    t.hub.ai.setApi = ((orig) => (fn: typeof api) => { api = fn; orig.call(t.hub.ai, fn); })(t.hub.ai.setApi);
    const { createApp } = await import("../src/app.js");
    createApp(t.hub);
    const out = await runTool(api, { name: "calculate", arguments: { type: "../connections/password-manager/keepass/import", input: { data: "AAAA", password: "x" } } }, ctx, [calc]);
    assert.equal(out.ok, false);
    assert.match(out.text, /type must be/);
    assert.deepEqual(fs.readFileSync(file), before, "the vault is untouched");
    const direct = await api("POST", "/calc/../connections/password-manager/keepass/import", { data: "AAAA", password: "x" });
    assert.equal(direct.status, 403);
    const fine = await runTool(api, { name: "calculate", arguments: { type: "split", input: { subtotal: 30, people: 3 } } }, ctx, [calc]);
    assert.equal(fine.ok, true);
  } finally { t.cleanup(); }
});

test("a backup monitor's ssh destination can never be an ssh option", () => {
  assert.equal(parseBackupTarget("linux:gnomecannon@10.0.0.16").dest, "gnomecannon@10.0.0.16");
  assert.equal(parseBackupTarget("windows:desk-pc#verify").job, "verify");
  for (const bad of ["linux:-oProxyCommand=touch${IFS}/tmp/x", "mac:-F/tmp/cfg", "linux:host;id", "linux:$(id)"]) assert.throws(() => parseBackupTarget(bad), /backup target/, bad);
});
