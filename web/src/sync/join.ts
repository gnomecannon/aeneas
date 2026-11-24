/**
 * Joining with a phone's yes (CONTRACT, Devices): a new computer or tablet shows a QR code with
 * `everythingapp://join?node=&relay=&s=&name=&platform=`, a paired phone scans it and says yes, and the hub reaches
 * the new device over Direct link and hands it a pairing link. The new device's side is in src-tauri/src/join.rs and
 * Setup; this file reads the code on the phone's side and keeps the note the new device shows once it joined.
 */

export type JoinPlatform = "mac" | "ipad" | "windows" | "android";
const PLATFORMS: readonly JoinPlatform[] = ["mac", "ipad", "windows", "android"];

/** The body of `POST /devices/join`, as the QR code carries it. */
export interface JoinRequest { node: string; relay: string; s: string; name: string; platform: JoinPlatform }

/** What kind of device is asking, said plainly on the phone. */
export const JOIN_KIND: Record<JoinPlatform, string> = {
  mac: "A Mac",
  ipad: "An iPad",
  windows: "A Windows computer",
  android: "An Android tablet or phone",
};

/**
 * The fields of a join code, checked as the hub checks them: the device's key as 64 hex characters, an https relay,
 * a secret of 32 bytes (43 characters of base64url), a name and a known kind of device. Null when any is not so.
 */
export function joinFields(p: URLSearchParams): JoinRequest | null {
  const node = (p.get("node") ?? "").trim();
  const relay = (p.get("relay") ?? "").trim();
  const s = (p.get("s") ?? "").trim();
  const name = (p.get("name") ?? "").trim().slice(0, 64);
  const platform = (p.get("platform") ?? "").trim().toLowerCase() as JoinPlatform;
  if (!/^[0-9a-fA-F]{64}$/.test(node)) return null;
  try { if (new URL(relay).protocol !== "https:") return null; } catch { return null; }
  // Exactly 32 bytes: 43 characters, the last of which holds 4 bits of the secret and two zero bits.
  if (!/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(s)) return null;
  if (!name || !PLATFORMS.includes(platform)) return null;
  return { node: node.toLowerCase(), relay, s, name, platform };
}

/**
 * A join code as the Camera hands it to the app (`everythingapp://join?...`), or null. A name may hold a quote: the
 * Apple apps leave one as it is.
 */
export function parseJoinLink(text: string): JoinRequest | null {
  const q = /^\s*everythingapp:\/\/join\?(\S+)\s*$/i.exec(text)?.[1];
  return q ? joinFields(new URLSearchParams(q)) : null;
}

/**
 * The note a device shows once it joined a hub this way ("This device joined Jamie's hub."): someone who joined it
 * to their own hub first would show there, and the name tells the person at once. Kept here because Setup is gone by
 * the time the main window shows it.
 */
let joinedNote: string | null = null;
const listeners = new Set<(note: string | null) => void>();

export function setJoinedNote(note: string | null): void {
  joinedNote = note;
  for (const fn of listeners) fn(note);
}

export function getJoinedNote(): string | null {
  return joinedNote;
}

export function onJoinedNote(fn: (note: string | null) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** "Jamie's hub" from what the hub says about itself, else its key's start, which the person can compare. */
export function joinedHubName(info: { hubName?: string | null; owner?: string | null; named?: boolean }, hubKey: string): string {
  const name = info.hubName?.trim() || (info.named ? info.owner?.trim() : "");
  return name ? `${name}’s hub` : `the hub with key ${hubKey.slice(0, 10)}`;
}
