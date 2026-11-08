import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * The key that seals the hub's sign-in files at rest: connections.json (Gmail, Atlassian and Steam keys and tokens,
 * the password vault's master password) and ai.json (model keys). AES-256-GCM, with the file's name as associated
 * data so a sealed file cannot be swapped for another. The key lives beside hub.env and the work key, outside the
 * data folder, and is in no backup: a copy of the data folder alone (a stray rsync, a disk image of that folder)
 * holds no usable sign-in. Lost with the machine, it costs only linking the accounts again.
 */

const PREFIX = "sb1:";
const IV = 12;
const TAG = 16;

export class SecretBox {
  private key: Buffer | null = null;

  /** `file` empty keeps the key in memory only (tests and throwaway hubs). */
  constructor(private file: string) {}

  static isSealed(raw: string): boolean { return raw.startsWith(PREFIX); }

  /** The key, made on first use. Never replaced: every sealed file would be lost with the old one. */
  private current(create: boolean): Buffer | null {
    if (this.key) return this.key;
    if (this.file) {
      try {
        const k = fs.readFileSync(this.file);
        if (k.length === 32 && !k.every((b) => b === 0)) return (this.key = k);
        throw new Error(`the sign-ins key ${path.basename(this.file)} is damaged (${k.length} bytes); nothing was changed`);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
    if (!create) return null;
    const k = randomBytes(32);
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.new`;
      const fd = fs.openSync(tmp, "w", 0o600);
      try { fs.writeSync(fd, k); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      // Another start made one at the same moment: keep the first, so nothing is sealed with a key that is gone.
      try { fs.linkSync(tmp, this.file); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
      fs.rmSync(tmp, { force: true });
      this.key = null;
      return this.current(false);
    }
    return (this.key = k);
  }

  /** The key's bytes for hiding from command output, or null when there is none yet. Never makes one. */
  peek(): Buffer | null {
    try { return this.current(false); } catch { return null; }
  }

  seal(name: string, text: string): string {
    const key = this.current(true)!;
    const iv = randomBytes(IV);
    const c = createCipheriv("aes-256-gcm", key, iv);
    c.setAAD(Buffer.from(name));
    const body = Buffer.concat([c.update(text, "utf8"), c.final()]);
    return PREFIX + Buffer.concat([iv, c.getAuthTag(), body]).toString("base64");
  }

  /** Plain text from a file's contents; contents that are not sealed (an older hub's file) come back as they are. */
  open(name: string, raw: string): string {
    if (!SecretBox.isSealed(raw)) return raw;
    const key = this.current(false);
    if (!key) throw new Error(`${name} is sealed and its key (${this.file ? path.basename(this.file) : "in memory"}) is not here; nothing was changed`);
    const buf = Buffer.from(raw.slice(PREFIX.length), "base64");
    if (buf.length < IV + TAG) throw new Error(`${name} is damaged`);
    const d = createDecipheriv("aes-256-gcm", key, buf.subarray(0, IV));
    d.setAAD(Buffer.from(name));
    d.setAuthTag(buf.subarray(IV, IV + TAG));
    try { return Buffer.concat([d.update(buf.subarray(IV + TAG)), d.final()]).toString("utf8"); }
    catch { throw new Error(`${name} does not open with this hub's sign-ins key; nothing was changed`); }
  }

  /** Write `text` sealed to `file` (owner-only, atomically). */
  writeSealed(file: string, text: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, this.seal(path.basename(file), text), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
}
