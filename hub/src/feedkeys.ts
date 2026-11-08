import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Keys that open one door each, for places that cannot keep the hub token private: a calendar subscription (calendar
 * apps sync the address to iCloud or Google) and sensor boards (the key sits on the board and may travel in plain
 * HTTP on the home network). `calendar` reads `/calendar.ics` only; `sensors` posts readings only. Either can be
 * replaced from Settings, which ends the old one. Kept in `<data>/feed-keys.json` (0600).
 */
export type FeedKind = "calendar" | "sensors";
export const FEED_KINDS: FeedKind[] = ["calendar", "sensors"];

export class FeedKeys {
  constructor(private file: string) {}

  /**
   * No file is no keys yet; a file that cannot be read is an error. Read as empty, the next GET /feeds made a new
   * calendar key and every calendar subscription stopped.
   */
  private read(): Partial<Record<FeedKind, string>> {
    let raw: string;
    try { raw = fs.readFileSync(this.file, "utf8"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return {}; throw new Error(`feed-keys.json could not be read (${(e as NodeJS.ErrnoException).code ?? "error"}); no key was changed`); }
    try { return JSON.parse(raw) as Partial<Record<FeedKind, string>>; }
    catch { throw new Error("feed-keys.json is damaged; no key was changed"); }
  }

  private write(v: Partial<Record<FeedKind, string>>): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(v, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /** The key for a door, made the first time it is asked for. */
  get(kind: FeedKind): string {
    const v = this.read();
    if (v[kind]) return v[kind]!;
    return this.rotate(kind);
  }

  /** A new key; the old one stops working at once. */
  rotate(kind: FeedKind): string {
    const v = this.read();
    v[kind] = crypto.randomBytes(24).toString("base64url");
    this.write(v);
    return v[kind]!;
  }

  /** Whether `given` is the key for this door. Constant time; never makes a key. */
  matches(kind: FeedKind, given: string | undefined): boolean {
    const want = this.read()[kind];
    if (!want || !given) return false;
    const a = Buffer.from(want);
    const b = Buffer.from(given);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  /** Every key, for hiding them in command output. */
  all(): string[] { return Object.values(this.read()).filter((x): x is string => typeof x === "string"); }
}
