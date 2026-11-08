import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * The work space's own key. Work entities are stored sealed with it (AES-256-GCM, the entity id as associated data,
 * so a sealed value cannot be moved to another row). The key file lives apart from the database and is in no backup,
 * so erasing the work space destroys the key and every older copy of hub.sqlite (nightly backups, the Litestream
 * replica) is left holding work data nobody can read.
 */

const PREFIX = "enc1:";
const IV = 12;
const TAG = 16;

export class WorkKey {
  private key: Buffer | null = null;

  /** `file` null keeps the key in memory only (tests and throwaway hubs). */
  constructor(private file: string | null) {}

  static isSealed(raw: string): boolean { return raw.startsWith(PREFIX); }

  /** True when a key file is already on disk (or a memory key was made). */
  exists(): boolean { return this.key !== null || (this.file !== null && fs.existsSync(this.file)); }

  private current(): Buffer {
    if (this.key) return this.key;
    if (this.file) {
      try {
        const k = fs.readFileSync(this.file);
        // All zeros is a key a rotation wiped before it could write the new one, not a key: anyone could read with it.
        if (k.length === 32 && !k.every((b) => b === 0)) return (this.key = k);
        console.error(`[work] key file ${this.file} is not a usable key (${k.length} bytes${k.length === 32 ? ", all zero" : ""}); making a new key`);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
    return this.replace(randomBytes(32));
  }

  /**
   * Write a new key (atomically, owner-only). The new key is written and synced first; only then is the old file
   * overwritten with zeros and replaced, so a full disk or a crash never leaves the hub without its key.
   */
  private replace(k: Buffer): Buffer {
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.new`;
      const fd = fs.openSync(tmp, "w", 0o600);
      try { fs.writeSync(fd, k); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      try {
        const old = fs.openSync(this.file, "r+");
        try { fs.writeSync(old, Buffer.alloc(fs.fstatSync(old).size)); fs.fsyncSync(old); } finally { fs.closeSync(old); }
      } catch { /* no old key */ }
      fs.renameSync(tmp, this.file);
    }
    this.key = k;
    return k;
  }

  /** The key to seal with next, written to disk before anything is sealed with it (`rotate`). */
  private prepare(): Buffer {
    const k = randomBytes(32);
    if (this.file) {
      const fd = fs.openSync(`${this.file}.next`, "w", 0o600);
      try { fs.writeSync(fd, k); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    return k;
  }

  seal(id: string, plain: string): string {
    const iv = randomBytes(IV);
    const c = createCipheriv("aes-256-gcm", this.current(), iv);
    c.setAAD(Buffer.from(id));
    const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return PREFIX + Buffer.concat([iv, c.getAuthTag(), body]).toString("base64");
  }

  /** The plain text, or null when it was sealed with a key that is gone. Unsealed text passes through. */
  open(id: string, raw: string): string | null {
    if (!WorkKey.isSealed(raw)) return raw;
    const b = Buffer.from(raw.slice(PREFIX.length), "base64");
    if (b.length < IV + TAG) return null;
    const tryKey = (key: Buffer): string | null => {
      try {
        const d = createDecipheriv("aes-256-gcm", key, b.subarray(0, IV));
        d.setAAD(Buffer.from(id));
        d.setAuthTag(b.subarray(IV, IV + TAG));
        return Buffer.concat([d.update(b.subarray(IV + TAG)), d.final()]).toString("utf8");
      } catch { return null; }
    };
    const plain = tryKey(this.current());
    if (plain !== null || !this.file) return plain;
    // A rotation stopped halfway (a crash) left some rows sealed with the key it had saved next.
    try { const next = fs.readFileSync(`${this.file}.next`); return next.length === 32 ? tryKey(next) : null; } catch { return null; }
  }

  /**
   * Destroy the key and make a new one. `reseal` gets the old opener and the new sealer and must rewrite every
   * sealed value before it returns; the old key is gone afterwards.
   */
  rotate(reseal: (open: (id: string, raw: string) => string | null, seal: (id: string, plain: string) => string) => void): void {
    const old = new WorkKey(null);
    old.key = this.current();
    const next = new WorkKey(null);
    // Saved before the rows are resealed with it: a write that fails stops the rotation while the old key still works.
    next.key = this.prepare();
    reseal((id, raw) => old.open(id, raw), (id, plain) => next.seal(id, plain));
    this.replace(next.key);
    if (this.file) fs.rmSync(`${this.file}.next`, { force: true });
    old.key.fill(0);
  }
}
