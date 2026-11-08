import { Hono } from "hono";
import type { Hub } from "../hub.js";
import { StoreError } from "../store.js";
import { listBackups } from "../backup.js";
import { BackupKeyError } from "../backupkey.js";
import { diskEncryptionCached, type DiskCrypt } from "../diskcrypt.js";

/**
 * Backup encryption for the owner (Settings): which key the copies are encrypted to, whether its recovery key was
 * saved, the backups on disk, and whether the hub's own disk is encrypted. The recovery key is shown only on a
 * POST, answered with no-store, and never logged (the request log has the path only). The assistant's tools cannot
 * reach the POSTs (everything under /setup is the owner's).
 */
export function backupRoutes(disk: (dir: string) => Promise<DiskCrypt> = diskEncryptionCached) {
  const r = new Hono<{ Variables: { hub: Hub } }>();

  /** The key, or a 500 that says what is wrong without the file's path (the log has it). */
  const key = (hub: Hub) => {
    try { return hub.backupKey.load(); }
    catch (e) {
      if (!(e instanceof BackupKeyError)) throw e;
      console.error(`[backup] ${e.message}`);
      throw new StoreError(500, "The backup key file cannot be read, so no backup is being made. Nothing was changed. Put back the key file, or the recovery key saved in the password manager, and start the hub again.");
    }
  };

  r.get("/setup/backup", async (c) => {
    const hub = c.get("hub");
    const { recipient } = key(hub);
    const backups = listBackups(hub.cfg.backupDir);
    return c.json({
      // True while every backup on disk is encrypted (a plain one an older hub left is encrypted at the next start or night).
      encrypted: backups.every((b) => b.encrypted),
      recipient,
      recovery_saved: hub.backupKey.recoverySaved(),
      backups,
      disk: await disk(hub.cfg.dataDir),
    });
  });

  r.post("/setup/backup/reveal", (c) => {
    const { identity } = key(c.get("hub"));
    c.header("cache-control", "no-store");
    c.header("pragma", "no-cache");
    return c.json({ recovery_key: identity });
  });

  r.post("/setup/backup/saved", (c) => {
    const hub = c.get("hub");
    key(hub);
    hub.backupKey.markSaved();
    return c.json({ recovery_saved: true });
  });

  return r;
}
