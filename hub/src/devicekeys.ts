import { createHash, randomBytes, randomInt } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { StoreError } from "./store.js";
import { errCode } from "./logsafe.js";

/**
 * Each device has its own key, so no link, QR code or screen ever carries a lasting secret, and any one device can be
 * removed without touching the others.
 *
 * - A paired device asks for a pairing code (`newCode`): 8 characters from an alphabet with no look-alike letters,
 *   used once, gone after 10 minutes or a hub restart. Codes live in memory only.
 * - The new device trades the code for its key (`claim`). The key is 32 random bytes; the hub keeps only its SHA-256,
 *   so nothing it stores could sign in.
 * - A device paired before this (holding the hub's main key, EA_TOKEN) trades that for a key of its own.
 * - Removing a device (Settings, Devices, or deleting its `device` entity anywhere) removes its key, and the key of a
 *   Watch the iPhone holds for it: the Watch's key is the iPhone's to keep, so it goes with the iPhone.
 *
 * The hashes live in `<data>/device-keys.json`, not in hub.sqlite: restoring the database from an older copy (a
 * Litestream point in time, a nightly backup) must not unpair every device. A removed key is remembered by its hash,
 * so the hub can tell a removed device (`device_removed`, the device forgets its key) from a key it simply does not
 * know (a lost keys file: the device keeps its key and shows that it cannot sign in). A file that cannot be read is an
 * error that changes nothing: it is never written over as if empty, and the `.bak` copy made before each write is
 * used instead when it reads.
 *
 * The hub's main key stays in hub.env on the hub's machine for its own scripts and the in-process assistant.
 */

export const KEY_PREFIX = "ead1_";
/** Crockford's base32: no I, L, O or U, so a code read aloud or typed from a screen cannot be mistyped into another. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const CODE_LENGTH = 8;
export const CODE_TTL_MS = 10 * 60_000;
/** Codes waiting at once; making another drops the oldest. */
const MAX_CODES = 5;
/** Removed keys remembered, newest kept. */
const MAX_REVOKED = 2000;

export function hashKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/** A code as typed or scanned ("abcd efgh", "ABCD-EFGH", with an O for a 0) in the form it was made. */
export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
}

/** "ABCD-EFGH": how a code is shown. */
export function showCode(code: string): string {
  return code.length === CODE_LENGTH ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

export interface PairingCode { code: string; expires_at: string; name: string }

interface KeyRow { hash: string; created_at: string; /** The device that holds this key for it (the iPhone, for its Watch). */ parent?: string }
interface KeyFile { v: 1; keys: Record<string, KeyRow>; /** hash to when it was removed */ revoked: Record<string, string> }

/** What a key is: a paired device's, a removed device's, or nothing the hub knows. */
export type KeyLookup = { device: string } | { removed: true } | null;

export class DeviceKeys {
  private codes = new Map<string, { expires: number; name: string; by?: string }>();
  private data: KeyFile | null = null;
  private byHash: Map<string, string> | null = null;
  /** Set when the keys file could not be read: writes are refused so the owner's file is never replaced. */
  private damaged: string | null = null;
  private listeners = new Set<(ids: string[]) => void>();

  /** `file` null keeps keys in memory only (tests and throwaway hubs). */
  constructor(private file: string | null) {}

  private read(file: string): KeyFile {
    const j = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<KeyFile>;
    if (!j || typeof j !== "object" || j.v !== 1 || typeof j.keys !== "object" || !j.keys || typeof j.revoked !== "object" || !j.revoked) throw new Error("not a device keys file");
    return { v: 1, keys: j.keys, revoked: j.revoked };
  }

  private load(): KeyFile {
    if (this.data) return this.data;
    const empty: KeyFile = { v: 1, keys: {}, revoked: {} };
    if (!this.file) return (this.data = empty);
    try {
      return (this.data = this.read(this.file));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return (this.data = empty);
      try {
        this.data = this.read(`${this.file}.bak`);
        console.error(`[devices] device-keys.json could not be read (${errCode(e)}); using the copy kept before the last write`);
        return this.data;
      } catch {
        this.damaged = errCode(e);
        console.error(`[devices] device-keys.json could not be read (${this.damaged}) and has no usable copy: no device key works and none can be made until it is mended or removed`);
        return (this.data = empty);
      }
    }
  }

  private save(d: KeyFile): void {
    if (this.damaged) throw new StoreError(500, "The hub's device keys file cannot be read, so no device can be paired or removed. Nothing was changed. Mend or remove device-keys.json in the hub's data folder and start the hub again.");
    this.data = d;
    this.byHash = null;
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (fs.existsSync(this.file)) fs.copyFileSync(this.file, `${this.file}.bak`);
    try { fs.chmodSync(`${this.file}.bak`, 0o600); } catch { /* no copy yet */ }
    const tmp = `${this.file}.tmp`;
    const fd = fs.openSync(tmp, "w", 0o600);
    try { fs.writeSync(fd, JSON.stringify(d, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, this.file);
  }

  private index(): Map<string, string> {
    if (this.byHash) return this.byHash;
    this.byHash = new Map(Object.entries(this.load().keys).map(([id, r]) => [r.hash, id]));
    return this.byHash;
  }

  /** A new key for a device; any older key of that device stops working. Returned once, never stored. */
  issue(deviceId: string, opts: { parent?: string; now?: Date } = {}): string {
    const key = KEY_PREFIX + randomBytes(32).toString("base64url");
    const d = structuredClone(this.load());
    const old = d.keys[deviceId];
    if (old) d.revoked[old.hash] = (opts.now ?? new Date()).toISOString();
    d.keys[deviceId] = { hash: hashKey(key), created_at: (opts.now ?? new Date()).toISOString(), ...(opts.parent ? { parent: opts.parent } : {}) };
    this.trim(d);
    this.save(d);
    return key;
  }

  /** What a key belongs to. Only keys in this hub's format are looked up. */
  lookup(key: string | undefined | null): KeyLookup {
    if (!key || !key.startsWith(KEY_PREFIX) || key.length > 128) return null;
    const h = hashKey(key);
    const device = this.index().get(h);
    if (device) return { device };
    return this.load().revoked[h] ? { removed: true } : null;
  }

  /** The device a key belongs to, or null. */
  deviceFor(key: string | undefined | null): string | null {
    const r = this.lookup(key);
    return r && "device" in r ? r.device : null;
  }

  /** Remove a device's key and the keys it holds for others (its Watch). Returns every device whose key went. */
  revoke(deviceId: string, now: Date = new Date()): string[] {
    const d = structuredClone(this.load());
    const gone: string[] = [];
    const drop = (id: string) => {
      const r = d.keys[id];
      if (!r) return;
      d.revoked[r.hash] = now.toISOString();
      delete d.keys[id];
      gone.push(id);
      for (const [child, row] of Object.entries(d.keys)) if (row.parent === id) drop(child);
    };
    drop(deviceId);
    if (!gone.length) return [];
    this.trim(d);
    this.save(d);
    for (const f of this.listeners) f(gone);
    return gone;
  }

  /** Called with the devices whose keys were just removed (open live streams are closed). */
  onRevoke(f: (ids: string[]) => void): () => void {
    this.listeners.add(f);
    return () => { this.listeners.delete(f); };
  }

  /** When each device got its key. */
  pairedAt(): Map<string, string> {
    return new Map(Object.entries(this.load().keys).map(([id, r]) => [id, r.created_at]));
  }

  /** The device holding this one's key (an iPhone for its Watch), if any. */
  parentOf(deviceId: string): string | null {
    return this.load().keys[deviceId]?.parent ?? null;
  }

  /** A one-time code for pairing another device, named for what it will be ("iPhone"); `by` is the device that asked. */
  newCode(name: string, now: number = Date.now(), by?: string): PairingCode {
    this.dropExpired(now);
    while (this.codes.size >= MAX_CODES) this.codes.delete(this.codes.keys().next().value as string);
    let code = "";
    do { code = Array.from({ length: CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join(""); } while (this.codes.has(code));
    const expires = now + CODE_TTL_MS;
    this.codes.set(code, { expires, name, ...(by ? { by } : {}) });
    return { code, expires_at: new Date(expires).toISOString(), name };
  }

  /** Use a code: the name it was made for and who made it, or null when it is wrong, used or expired. Works once. */
  claim(raw: string, now: number = Date.now()): { name: string; by?: string } | null {
    this.dropExpired(now);
    const code = normalizeCode(String(raw ?? ""));
    if (code.length !== CODE_LENGTH) return null;
    const c = this.codes.get(code);
    if (!c) return null;
    this.codes.delete(code);
    return { name: c.name, ...(c.by ? { by: c.by } : {}) };
  }

  /** Codes waiting, for tests. */
  waiting(now: number = Date.now()): number {
    this.dropExpired(now);
    return this.codes.size;
  }

  private dropExpired(now: number) {
    for (const [k, v] of this.codes) if (v.expires <= now) this.codes.delete(k);
  }

  private trim(d: KeyFile) {
    const r = Object.entries(d.revoked);
    if (r.length <= MAX_REVOKED) return;
    r.sort((a, b) => b[1].localeCompare(a[1]));
    d.revoked = Object.fromEntries(r.slice(0, MAX_REVOKED));
  }
}
