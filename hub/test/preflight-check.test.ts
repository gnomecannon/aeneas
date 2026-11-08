import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub } from "./helpers.js";
import { detectDestructive, preflightBlock } from "../src/preflight.js";

const post = (json: unknown) => ({ method: "POST", json });

test("preflight check: a destructive journal command gets the assistant's wording", async () => {
  const t = makeHub();
  try {
    const r = await (await t.api("/preflight", post({ text: "$ sudo zfs destroy -r tank/scratch" }))).json() as any;
    assert.equal(r.destructive, true);
    assert.equal(r.name, "zfs destroy");
    assert.equal(r.command, "sudo zfs destroy -r tank/scratch");
    assert.match(r.backup, /^Back up: /);
    assert.match(r.verify, /^Verify: /);
    assert.match(r.rollback, /^Rollback: /);
    // The very block the assistant path inserts for the same text.
    assert.equal(r.block, preflightBlock(detectDestructive("$ sudo zfs destroy -r tank/scratch")!));
    assert.ok(r.block.startsWith("Pre-flight for `sudo zfs destroy -r tank/scratch` (zfs destroy):\n- Back up:"));
    // A pasted multi-line session reports the first destructive line.
    const multi = await (await t.api("/preflight", post({ text: "zpool status tank\ngit push --force origin main\nrm -rf /srv/old" }))).json() as any;
    assert.equal(multi.name, "git push --force");
    assert.equal(multi.command, "git push --force origin main");
    // Nothing is written: the check is read-only.
    assert.equal(t.hub.store.list({ kind: "journal" }).length, 0);
  } finally { t.cleanup(); }
});

test("preflight check: harmless commands and bad bodies", async () => {
  const t = makeHub();
  try {
    for (const text of ["", "zpool status tank", "fdisk -l", "ls -la /srv", "systemctl restart nginx"]) {
      assert.deepEqual(await (await t.api("/preflight", post({ text }))).json(), { destructive: false }, text);
    }
    assert.equal((await t.api("/preflight", post({}))).status, 422);
    assert.equal((await t.api("/preflight", post({ text: "x".repeat(20001) }))).status, 422);
    assert.equal((await t.api("/preflight", { method: "POST", json: { text: "rm -rf /" }, headers: { authorization: "Bearer wrong" } })).status, 401);
  } finally { t.cleanup(); }
});
