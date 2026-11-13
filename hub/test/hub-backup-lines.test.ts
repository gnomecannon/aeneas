import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hubBackupLines, type UnitReader } from "../src/backup.js";

// Ops shows the hub's own backups beside the machines': the nightly copy, a second folder, the copy to storage and
// the live copy, each fine or not, and when.

const NOW = new Date("2026-11-13T19:00:00Z");

function folder(files: [string, string][]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-hub-backup-"));
  for (const [name, at] of files) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, "x");
    fs.utimesSync(p, new Date(at), new Date(at));
  }
  return dir;
}

test("hub backup lines: nightly copies, a second folder and the Linux services, each fine or not", async () => {
  const backups = folder([["hub-20261112-030000.sqlite.age", "2026-11-12T08:00:00Z"], ["hub-20261113-030000.sqlite.age", "2026-11-13T08:00:00Z"]]);
  const copies = folder([["hub-20261111-030000.sqlite.age", "2026-11-11T08:00:00Z"]]);
  const empty = folder([]);
  const units: Record<string, Awaited<ReturnType<UnitReader>>> = {
    "everythingapp-backup.service": { load: "loaded", active: "inactive", result: "success", exitedAt: "2026-11-13T08:30:00.000Z" },
    "everythingapp-litestream.service": { load: "loaded", active: "failed", result: "exit-code", exitedAt: null },
  };
  try {
    const lines = await hubBackupLines({ backupDir: backups, backupCopyDir: copies }, NOW, async (u) => units[u] ?? null);
    assert.deepEqual(lines, [
      { label: "Nightly copy", ok: true, at: "2026-11-13T08:00:00.000Z", text: "2 kept, encrypted" },
      { label: "Second copy", ok: false, at: "2026-11-11T08:00:00.000Z", text: copies },
      { label: "Copy to storage", ok: true, at: "2026-11-13T08:30:00.000Z", text: "" },
      { label: "Live copy", ok: false, text: "not running (failed)" },
    ]);

    // A hub with no backups yet, no second folder and none of the services (a Mac, or a new install).
    assert.deepEqual(await hubBackupLines({ backupDir: empty, backupCopyDir: "" }, NOW, async () => null), [
      { label: "Nightly copy", ok: false, at: null, text: "none made yet" },
    ]);
    // A failed copy to storage says so even when its last run is recent.
    units["everythingapp-backup.service"] = { load: "loaded", active: "failed", result: "exit-code", exitedAt: "2026-11-13T08:30:00.000Z" };
    const failed = await hubBackupLines({ backupDir: backups, backupCopyDir: "" }, NOW, async (u) => units[u] ?? null);
    assert.deepEqual(failed.find((l) => l.label === "Copy to storage"), { label: "Copy to storage", ok: false, at: "2026-11-13T08:30:00.000Z", text: "last run failed (exit-code)" });
  } finally {
    for (const d of [backups, copies, empty]) fs.rmSync(d, { recursive: true, force: true });
  }
});
