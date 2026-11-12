import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { backupOverdue, copyBackup } from "../src/backup.js";
import { fileMode } from "./helpers.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ea-backup-copy-"));

test("backups: each one is copied to the second folder, old copies there pruned, the owner's own files left", () => {
  const src = tmp(), copy = tmp();
  const file = path.join(src, "hub-20261106-030000.sqlite.age");
  fs.writeFileSync(file, "age-encrypted");
  const old = path.join(copy, "hub-20260901-030000.sqlite.age");
  fs.writeFileSync(old, "x");
  const longAgo = new Date(Date.now() - 40 * 86400_000);
  fs.utimesSync(old, longAgo, longAgo);
  const mine = path.join(copy, "holiday-photos.zip");
  fs.writeFileSync(mine, "y");
  fs.utimesSync(mine, longAgo, longAgo);
  const r = copyBackup(file, copy);
  assert.equal(r.copied, path.join(copy, "hub-20261106-030000.sqlite.age"));
  assert.equal(fs.readFileSync(r.copied!, "utf8"), "age-encrypted");
  assert.equal(fileMode(r.copied!), 0o600);
  assert.equal(fs.existsSync(old), false, "a copy older than 30 days is pruned");
  assert.equal(fs.existsSync(mine), true, "anything that is not a backup is left alone");
});

test("backups: a second folder that is not there is reported, never made on the hub's own disk", () => {
  const src = tmp();
  const file = path.join(src, "hub-20261106-030000.sqlite.age");
  fs.writeFileSync(file, "z");
  const gone = path.join(src, "not-mounted", "drive");
  const r = copyBackup(file, gone);
  assert.equal(r.copied, null);
  assert.match(r.error ?? "", /not there/);
  assert.equal(fs.existsSync(gone), false);
  assert.deepEqual(copyBackup(file, ""), { copied: null }, "no second folder set: nothing to do");
});

test("backups: a missed night is noticed", () => {
  const dir = tmp();
  assert.equal(backupOverdue(dir), true, "no backup yet");
  const f = path.join(dir, "hub-20261106-030000.sqlite.age");
  fs.writeFileSync(f, "a");
  assert.equal(backupOverdue(dir), false);
  const twoDays = new Date(Date.now() - 48 * 3600_000);
  fs.utimesSync(f, twoDays, twoDays);
  assert.equal(backupOverdue(dir), true);
});
