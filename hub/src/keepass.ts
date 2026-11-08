import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import type * as KdbxWeb from "kdbxweb";
import { argon2d, argon2id } from "hash-wasm";

/**
 * The built-in vault, for owners who have no password manager: a KeePass file (KDBX 4, Argon2id) in the hub's data
 * folder, read and written with kdbxweb. Any KeePass app (KeePassXC, KeePassDX, Strongbox, KeePassium) opens the same
 * file with the same master password, so nothing is locked in. The hub keeps the master password with its other
 * connection secrets, because it reads an item only when an approved command names it, with nobody there to type it.
 */

const requireCjs = createRequire(import.meta.url);

/**
 * kdbxweb parses the vault's XML with xmldom, through a DOMParser on the global object when there is one. Its own
 * fallback passes xmldom an option that xmldom 0.9 (the release with the 2026 injection fixes) no longer takes, so
 * the hub puts a strict xmldom 0.9 parser there: an XML error stops the read, as kdbxweb expects.
 */
{
  const g = globalThis as Record<string, unknown>;
  const xmldom = requireCjs("@xmldom/xmldom") as { DOMParser: new (o: { onError: (level: string, msg: string) => void }) => { parseFromString(x: string, t: string): unknown }; XMLSerializer: new () => unknown };
  if (!g.DOMParser) {
    g.DOMParser = class StrictDomParser {
      parseFromString(xml: string, type: string) {
        return new xmldom.DOMParser({ onError: (level, msg) => { if (level !== "warning") throw new Error(msg); } }).parseFromString(xml, type);
      }
    };
  }
  if (!g.XMLSerializer) g.XMLSerializer = xmldom.XMLSerializer;
}

/** kdbxweb ships one UMD file; loaded with require so its exports arrive whole under ESM. */
const kdbxweb = requireCjs("kdbxweb") as typeof KdbxWeb;
// eslint-disable-next-line @typescript-eslint/no-namespace
declare namespace kdbxweb { type Kdbx = KdbxWeb.Kdbx; type KdbxEntry = KdbxWeb.KdbxEntry; type KdbxGroup = KdbxWeb.KdbxGroup; type KdbxEntryField = KdbxWeb.KdbxEntryField }

kdbxweb.CryptoEngine.setArgon2Impl(async (password, salt, memory, iterations, length, parallelism, type) => {
  const run = type === kdbxweb.CryptoEngine.Argon2TypeArgon2id ? argon2id : argon2d;
  const out = await run({ password: new Uint8Array(password), salt: new Uint8Array(salt), memorySize: memory, iterations, parallelism, hashLength: length, outputType: "binary" });
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
});

export const KEEPASS_FILE = "passwords.kdbx";
/** 64 MiB and 3 passes, as KeePassXC makes a new file: a fraction of a second to open, slow to guess. */
const KDF_MEMORY = 64 * 1024 * 1024;
const KDF_ROUNDS = 3;

export interface VaultEntry { title: string; username: string; url: string; notes: string; fields: string[] }

export function keepassPath(dataDir: string): string {
  return path.join(dataDir, KEEPASS_FILE);
}

/** A long random password from letters, digits and a few symbols that every shell and site accepts. */
export function generatePassword(length = 24): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_.!@#%+=";
  const bytes = randomBytes(length * 2);
  let out = "";
  for (let i = 0; out.length < length && i < bytes.length; i++) if (bytes[i] < 256 - (256 % chars.length)) out += chars[bytes[i] % chars.length];
  return out.length === length ? out : generatePassword(length);
}

const creds = (master: string) => new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(master));
const text = (v: kdbxweb.KdbxEntryField | undefined) => (v === undefined ? "" : typeof v === "string" ? v : v.getText());
const STANDARD = new Set(["Title", "UserName", "Password", "URL", "Notes"]);

function entries(db: kdbxweb.Kdbx): kdbxweb.KdbxEntry[] {
  const out: kdbxweb.KdbxEntry[] = [];
  const recycle = db.meta.recycleBinUuid?.id;
  const walk = (g: kdbxweb.KdbxGroup) => {
    if (recycle && g.uuid.id === recycle) return;
    out.push(...g.entries);
    g.groups.forEach(walk);
  };
  db.groups.forEach(walk);
  return out;
}

const describe = (e: kdbxweb.KdbxEntry): VaultEntry => ({
  title: text(e.fields.get("Title")), username: text(e.fields.get("UserName")), url: text(e.fields.get("URL")), notes: text(e.fields.get("Notes")),
  fields: [...e.fields.keys()].filter((k) => !STANDARD.has(k)),
});

/** One KeePass file and its master password. Reads are cached until the file changes; writes go one at a time. */
export class KeePassVault {
  private cache: { mtimeMs: number; db: kdbxweb.Kdbx } | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly file: string, private readonly master: () => string) {}

  exists(): boolean {
    return fs.existsSync(this.file);
  }

  /** A new, empty vault. Refuses to replace a file that is there. */
  async create(name = "EverythingApp"): Promise<void> {
    if (this.exists()) throw new Error("a vault file is already there");
    const db = kdbxweb.Kdbx.create(creds(this.master()), name);
    db.setKdf(kdbxweb.Consts.KdfId.Argon2id);
    db.header.kdfParameters!.set("M", kdbxweb.VarDictionary.ValueType.UInt64, kdbxweb.Int64.from(KDF_MEMORY));
    db.header.kdfParameters!.set("I", kdbxweb.VarDictionary.ValueType.UInt64, kdbxweb.Int64.from(KDF_ROUNDS));
    await this.write(db);
  }

  /** Open a KeePass file someone already has, to check its password before it replaces the vault. */
  static async check(data: ArrayBuffer, master: string): Promise<number> {
    const db = await kdbxweb.Kdbx.load(data, creds(master));
    return entries(db).length;
  }

  private async open(): Promise<kdbxweb.Kdbx> {
    const st = fs.statSync(this.file);
    if (this.cache && this.cache.mtimeMs === st.mtimeMs) return this.cache.db;
    const buf = fs.readFileSync(this.file);
    const db = await kdbxweb.Kdbx.load(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, creds(this.master()));
    this.cache = { mtimeMs: st.mtimeMs, db };
    return db;
  }

  private async write(db: kdbxweb.Kdbx): Promise<void> {
    const data = Buffer.from(await db.save());
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.cache = { mtimeMs: fs.statSync(this.file).mtimeMs, db };
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Whether the master password opens the file. */
  async unlocks(): Promise<boolean> {
    try { await this.open(); return true; } catch { return false; }
  }

  async list(): Promise<VaultEntry[]> {
    return entries(await this.open()).map(describe).filter((e) => e.title);
  }

  private find(db: kdbxweb.Kdbx, title: string): kdbxweb.KdbxEntry | undefined {
    const want = title.trim().toLowerCase();
    return entries(db).find((e) => text(e.fields.get("Title")).trim().toLowerCase() === want);
  }

  /** One field of one item: password, username, url, notes, or any other field by its name. */
  async read(title: string, field = "password"): Promise<string | null> {
    const e = this.find(await this.open(), title);
    if (!e) return null;
    const key = ({ password: "Password", username: "UserName", url: "URL", notes: "Notes", title: "Title" } as Record<string, string>)[field.toLowerCase()]
      ?? [...e.fields.keys()].find((k) => k.toLowerCase() === field.toLowerCase());
    return key ? text(e.fields.get(key)) : null;
  }

  /** Add an item, or change the one with that title. A password left out keeps the old one (or a new random one). */
  async put(item: { title: string; username?: string; password?: string; url?: string; notes?: string }): Promise<VaultEntry> {
    return this.serial(async () => {
      const db = await this.open();
      const e = this.find(db, item.title) ?? db.createEntry(db.getDefaultGroup());
      e.fields.set("Title", item.title.trim());
      if (item.username !== undefined) e.fields.set("UserName", item.username);
      if (item.url !== undefined) e.fields.set("URL", item.url);
      if (item.notes !== undefined) e.fields.set("Notes", item.notes);
      if (item.password || !text(e.fields.get("Password"))) e.fields.set("Password", kdbxweb.ProtectedValue.fromString(item.password || generatePassword()));
      e.times.update();
      await this.write(db);
      return describe(e);
    });
  }

  async remove(title: string): Promise<boolean> {
    return this.serial(async () => {
      const db = await this.open();
      const e = this.find(db, title);
      if (!e) return false;
      db.move(e, null);
      await this.write(db);
      return true;
    });
  }

  /** Replace the vault with a KeePass file someone already has (checked first with `KeePassVault.check`). */
  replaceWith(data: Buffer): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.cache = null;
  }
}
