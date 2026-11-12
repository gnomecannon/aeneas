import { createPrivateKey, createPublicKey, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { bech32 } from "@scure/base";
import { Decrypter, Encrypter } from "age-encryption";

/**
 * The backup key: one age identity (X25519) that every copy of the hub's data leaving hub.sqlite is encrypted to
 * (nightly backups, the settings archive, gallery pictures and recordings sent to storage, the Litestream replica).
 * The file is the one age-keygen writes, so the owner can also decrypt with the standard `age -d -i <file>`. It lives
 * next to the work key, owner-only, and is in no backup or copy: the owner keeps the identity itself (the recovery
 * key) in their password manager, which is what opens the copies on a new machine.
 *
 * A key file that exists but cannot be read, or holds no usable identity, is an error that changes nothing: a new
 * key there would leave every earlier copy unreadable without anyone noticing (the work key and the sign-ins file
 * taught that). Only a file that is not there at all is made, once, and never written over.
 */

const IDENTITY = /^AGE-SECRET-KEY-1[02-9AC-HJ-NP-Z]{58}$/;
// DER prefix of a PKCS#8 X25519 private key; the 32-byte scalar follows.
const PKCS8_X25519 = Buffer.from("302e020100300506032b656e04220420", "hex");

export class BackupKeyError extends Error {}

/** The age recipient (`age1...`) of an X25519 identity's scalar. Node clamps the scalar as age does. */
function recipientOf(scalar: Uint8Array): string {
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_X25519, scalar]), format: "der", type: "pkcs8" });
  const x = createPublicKey(priv).export({ format: "jwk" }).x;
  if (!x) throw new BackupKeyError("could not work out the public half of the backup key");
  return bech32.encodeFromBytes("age", Buffer.from(x, "base64url"));
}

/** The 32-byte scalar of an `AGE-SECRET-KEY-1...` identity, or null when it is not one. */
function scalarOf(identity: string): Uint8Array | null {
  if (!IDENTITY.test(identity)) return null;
  try {
    const d = bech32.decodeToBytes(identity);
    return d.prefix.toUpperCase() === "AGE-SECRET-KEY-" && d.bytes.length === 32 ? d.bytes : null;
  } catch { return null; }
}

/** The identity of a recovery key as typed or pasted (spaces and line breaks around it are dropped), or null. */
export function parseRecoveryKey(text: string): { identity: string; recipient: string } | null {
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const scalar = scalarOf(t.toUpperCase());
    return scalar ? { identity: t.toUpperCase(), recipient: recipientOf(scalar) } : null;
  }
  return null;
}

/** The file body age-keygen writes: two comment lines, then the identity. */
function keyFileBody(identity: string, recipient: string, at: Date): string {
  return `# created: ${at.toISOString().replace(/\.\d{3}Z$/, "Z")}\n# public key: ${recipient}\n${identity}\n`;
}

/** Make a new identity. */
export function newIdentity(): { identity: string; recipient: string } {
  const scalar = randomBytes(32);
  return { identity: bech32.encodeFromBytes("AGE-SECRET-KEY-", scalar).toUpperCase(), recipient: recipientOf(scalar) };
}

function fsyncDir(dir: string): void {
  try { const fd = fs.openSync(dir, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } } catch { /* not every system syncs a folder */ }
}

/** Write a file owner-only through a temp file, fsync and rename, so it is the old file or the new one, never half. */
export function writeAtomic(file: string, body: string | Uint8Array, mode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  try {
    const fd = fs.openSync(tmp, "wx", mode);
    try { fs.writeSync(fd, typeof body === "string" ? Buffer.from(body) : body); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
    fsyncDir(path.dirname(file));
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

export class BackupKey {
  private key: { identity: string; recipient: string } | null = null;
  /** True when this process made the key file (first start). */
  created = false;

  /**
   * `file` is the key; `savedFile` (a small settings file in the data folder) records which key the owner said they
   * saved in their password manager, so a new key asks again.
   */
  constructor(readonly file: string, private savedFile: string) {}

  /**
   * The key, made on first use when there is no key file. Throws a BackupKeyError, changing nothing, when the file is
   * there but cannot be read or holds no usable identity.
   */
  load(): { identity: string; recipient: string } {
    if (this.key) return this.key;
    const found = this.read();
    if (found) return (this.key = found);
    return (this.key = this.make());
  }

  /** The key in the file, or null when there is no file. Never makes one (restore uses this). */
  read(): { identity: string; recipient: string } | null {
    let text: string;
    try {
      text = fs.readFileSync(this.file, "utf8");
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      throw new BackupKeyError(`the backup key file ${this.file} cannot be read (${code ?? (e as Error).message}); it was left as it is and nothing is encrypted until it can be read`);
    }
    const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith("AGE-SECRET-KEY-"));
    const scalar = line ? scalarOf(line) : null;
    if (!line || !scalar) throw new BackupKeyError(`the backup key file ${this.file} holds no usable key; it was left as it is. Put back the file, or the recovery key saved in the password manager, and start the hub again`);
    try {
      // Owner-only: a copy put back with cp under a loose umask is closed again. Windows has no such bits (every file
      // reads as 0o666); its user folder's access list keeps the key private there.
      if (process.platform !== "win32" && (fs.statSync(this.file).mode & 0o077) !== 0) { fs.chmodSync(this.file, 0o600); console.warn(`[backup] ${this.file} was readable by others; now owner-only`); }
    } catch { /* read-only file system: the read still counts */ }
    return { identity: line, recipient: recipientOf(scalar) };
  }

  /**
   * A new key, written atomically (temp file, fsync, then a hard link that fails when a file is already there), so
   * two processes starting at once end up with the same key and nothing is ever written over.
   */
  private make(): { identity: string; recipient: string } {
    const k = newIdentity();
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}-${randomBytes(4).toString("hex")}.new`;
    const fd = fs.openSync(tmp, "wx", 0o600);
    try { fs.writeSync(fd, keyFileBody(k.identity, k.recipient, new Date())); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try {
      fs.linkSync(tmp, this.file);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        fs.rmSync(tmp, { force: true });
        const other = this.read();
        if (other) return other;
        throw new BackupKeyError(`the backup key file ${this.file} appeared while a new one was being made and holds no key`);
      }
      // A file system without hard links: rename, which is still atomic; the file was not there a moment ago.
      if (fs.existsSync(this.file)) { fs.rmSync(tmp, { force: true }); const other = this.read(); if (other) return other; }
      fs.renameSync(tmp, this.file);
    }
    fs.rmSync(tmp, { force: true });
    fsyncDir(dir);
    this.created = true;
    console.log(`[backup] made the backup key ${this.file} (public key ${k.recipient}); its recovery key belongs in the password manager (POST /setup/backup/reveal)`);
    return k;
  }

  recipient(): string { return this.load().recipient; }

  /** The recovery key (the identity itself). Only for the owner's reveal and for decrypting. */
  identity(): string { return this.load().identity; }

  /** True when the owner said they saved this key's recovery key. A damaged or missing record counts as not saved. */
  recoverySaved(): boolean {
    try {
      const j = JSON.parse(fs.readFileSync(this.savedFile, "utf8")) as { recipient?: unknown };
      return typeof j.recipient === "string" && j.recipient === this.recipient();
    } catch { return false; }
  }

  markSaved(now: Date = new Date()): void {
    writeAtomic(this.savedFile, JSON.stringify({ recipient: this.recipient(), saved_at: now.toISOString() }) + "\n");
  }
}

// ---- encrypting and decrypting files ----

const AGE_MAGIC = "age-encryption.org/v1\n";

/** True when the file starts like an age file. */
export function isAgeFile(file: string): boolean {
  try {
    const fd = fs.openSync(file, "r");
    try { const b = Buffer.alloc(AGE_MAGIC.length); fs.readSync(fd, b, 0, b.length, 0); return b.toString("latin1") === AGE_MAGIC; } finally { fs.closeSync(fd); }
  } catch { return false; }
}

/** The bytes of `data` encrypted to `recipient`. For small things (the settings archive). */
export async function encryptBytes(data: Uint8Array, recipient: string): Promise<Uint8Array> {
  const e = new Encrypter();
  e.addRecipient(recipient);
  return e.encrypt(data);
}

export async function decryptBytes(data: Uint8Array, identities: string[]): Promise<Uint8Array> {
  const d = new Decrypter();
  for (const i of identities) d.addIdentity(i);
  return d.decrypt(data);
}

/**
 * Stream a transform from `src` into `dst`: written to a temp file next to it (owner-only), synced, then renamed, so
 * `dst` is either whole or not there. age works in 64 KiB chunks, so a file of any size passes through in small
 * pieces. A failure removes the temp file and leaves `dst` as it was.
 */
async function streamTo(src: string, dst: string, transform: (input: ReadableStream<Uint8Array>) => Promise<ReadableStream<Uint8Array>>): Promise<void> {
  const tmp = `${dst}.${process.pid}-${randomBytes(4).toString("hex")}.partial`;
  const rs = fs.createReadStream(src);
  let ws: fs.WriteStream | null = null;
  try {
    const input = Readable.toWeb(rs) as unknown as ReadableStream<Uint8Array>;
    const out = await transform(input);
    ws = fs.createWriteStream(tmp, { flags: "wx", mode: 0o600 });
    await pipeline(Readable.fromWeb(out as import("node:stream/web").ReadableStream<Uint8Array>), ws);
    const fd = fs.openSync(tmp, "r+");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, dst);
    fsyncDir(path.dirname(dst));
  } catch (e) {
    rs.destroy();
    // A failed pipeline closes the temp file later, not at once; Windows will not remove a file still open.
    const w = ws;
    if (w && !w.closed) await new Promise<void>((done) => { w.once("close", () => done()); w.destroy(); });
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/** Encrypt the file `src` to `recipient` as `dst` (atomically). */
export async function encryptFile(src: string, dst: string, recipient: string): Promise<void> {
  const e = new Encrypter();
  e.addRecipient(recipient);
  await streamTo(src, dst, (input) => e.encrypt(input));
}

/**
 * Decrypt the age file `src` into `dst` (atomically) with any of `identities`. Each 64 KiB chunk is checked as it
 * is read, and a file cut short fails at its end, before anything is renamed into place.
 */
export async function decryptFile(src: string, dst: string, identities: string[]): Promise<void> {
  if (!identities.length) throw new BackupKeyError("no key to decrypt with");
  if (!isAgeFile(src)) throw new BackupKeyError(`${path.basename(src)} is not an age encrypted file`);
  const d = new Decrypter();
  for (const i of identities) d.addIdentity(i);
  await streamTo(src, dst, (input) => d.decrypt(input));
}
