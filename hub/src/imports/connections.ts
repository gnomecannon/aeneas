import fs from "node:fs";
import path from "node:path";
import type { AtlassianConn } from "./confluence.js";
import type { GoogleAccount } from "./gmail.js";
import type { PasswordManagerConn } from "../secrets.js";
import type { SecretBox } from "../secretbox.js";

/**
 * Linked accounts, kept in `<data>/connections.json` (readable by the hub's user only), sealed with the hub's
 * sign-ins key (secretbox.ts) when the store is given one; an older hub's plain file is read and sealed on the next write. The hub's Steam key never
 * leaves the hub: the view says only whether there is one. Atlassian and Google tokens and the hub's app secrets likewise.
 */

/** `api_key` only on a link made before Sign in through Steam; the hub's key now lives in `steam_key`. */
export interface SteamConn { api_key?: string; steam_id: string; persona?: string; profile_url?: string; last_sync?: string; last_error?: string; games?: number }
export interface LetterboxdConn { username?: string; last_sync?: string; last_error?: string; films?: number }
export interface HealthConn { last_import?: string; samples?: number; total?: number }
export interface Connections { steam_key?: string; steam?: SteamConn; letterboxd?: LetterboxdConn; health?: HealthConn; atlassian_app?: { client_id: string; client_secret: string }; atlassian?: AtlassianConn; google_app?: { client_id: string; client_secret: string }; google?: GoogleAccount[]; password_manager?: PasswordManagerConn; keepass?: { password: string; created_at: string } }

export class ConnectionStore {
  constructor(private file: string, private box?: SecretBox) {}

  private parse(raw: string, name: string): Connections {
    return JSON.parse(this.box ? this.box.open(name, raw) : raw) as Connections;
  }

  /** Seal a plain file an older hub wrote (and its kept copy). True when it was rewritten. */
  sealIfPlain(): boolean {
    if (!this.box) return false;
    let raw: string;
    try { raw = fs.readFileSync(this.file, "utf8"); } catch { return false; }
    let bakPlain = false;
    try { bakPlain = !fs.readFileSync(`${this.file}.bak`, "utf8").startsWith("sb1:"); } catch { /* no kept copy */ }
    if (raw.startsWith("sb1:") && !bakPlain) return false;
    this.update(() => {});
    return true;
  }

  /**
   * The sign-ins. No file is none yet; a file that cannot be read (too many open files, a disk error, a damaged
   * write) is an error, never "none": read as empty, the next update wrote back only its own field and every other
   * sign-in was gone, the password vault's master password with them. A damaged file falls back to the copy kept
   * before the last write.
   */
  get(): Connections {
    let raw: string;
    try { raw = fs.readFileSync(this.file, "utf8"); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new Error(`the sign-ins file could not be read (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}); nothing was changed`);
    }
    try { return this.parse(raw, path.basename(this.file)); }
    catch (e) {
      // A sealed file whose key is missing is not damaged: the kept copy would not open either.
      if (/key/.test((e as Error).message) && raw.startsWith("sb1:")) throw e;
      try {
        const kept = this.parse(fs.readFileSync(`${this.file}.bak`, "utf8"), path.basename(this.file));
        console.error("[connections] connections.json is damaged; using the copy from before the last change");
        return kept;
      } catch { throw new Error("the sign-ins file is damaged and has no good copy; nothing was changed"); }
    }
  }

  update(fn: (c: Connections) => void): Connections {
    const c = this.get();
    const before = fs.existsSync(this.file) ? JSON.stringify(c, null, 2) : null;
    fn(c);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const name = path.basename(this.file);
    const text = (t: string) => (this.box ? this.box.seal(name, t) : t);
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, text(JSON.stringify(c, null, 2)), { mode: 0o600 });
    // The copy from before this change, for a file damaged later (sealed too: never a plain copy beside a sealed file).
    if (before !== null) { fs.writeFileSync(`${this.file}.bak`, text(before), { mode: 0o600 }); fs.chmodSync(`${this.file}.bak`, 0o600); }
    fs.renameSync(tmp, this.file);
    return c;
  }

  /** What clients see: every service, connected or not, with no secrets. */
  view() {
    const c = this.get();
    const s = c.steam;
    const hubKey = !!(process.env.EA_STEAM_KEY || c.steam_key || s?.api_key);
    return {
      steam: s?.steam_id
        ? { connected: true, hub_key: hubKey, steam_id: s.steam_id, persona: s.persona ?? null, profile_url: s.profile_url ?? null, last_sync: s.last_sync ?? null, last_error: s.last_error ?? null, games: s.games ?? 0 }
        : { connected: false, hub_key: hubKey },
      letterboxd: c.letterboxd?.username
        ? { connected: true, username: c.letterboxd.username, last_sync: c.letterboxd.last_sync ?? null, last_error: c.letterboxd.last_error ?? null, films: c.letterboxd.films ?? 0 }
        : { connected: false },
      atlassian: c.atlassian?.cloud_id
        ? { connected: true, app: true, site_name: c.atlassian.site_name, site_url: c.atlassian.site_url, spaces: c.atlassian.spaces, last_sync: c.atlassian.last_sync ?? null, last_error: c.atlassian.last_error ?? null, pages: c.atlassian.pages ?? 0 }
        : { connected: false, app: !!((process.env.EA_ATLASSIAN_CLIENT_ID && process.env.EA_ATLASSIAN_CLIENT_SECRET) || c.atlassian_app?.client_id) },
      health: { last_import: c.health?.last_import ?? null, samples: c.health?.samples ?? 0, total: c.health?.total ?? 0 },
      google: {
        app: !!((process.env.EA_GOOGLE_CLIENT_ID && process.env.EA_GOOGLE_CLIENT_SECRET) || c.google_app?.client_id),
        accounts: (c.google ?? []).map((a) => ({ email: a.email, linked_at: a.linked_at, last_sync: a.last_sync ?? null, last_error: a.last_error ?? null })),
      },
    };
  }
}
