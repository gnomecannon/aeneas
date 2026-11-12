import { execFile } from "node:child_process";

/**
 * Whether the disk holding the hub's data folder is encrypted. The live hub.sqlite stays a normal SQLite file (so
 * Litestream can read it); the machine's own disk encryption is what protects it, so the hub checks and reports it.
 *
 * - macOS: the volume the folder is on (`df`), then `diskutil info -plist` for that volume's FileVault flag
 *   (`Encryption` alone is not enough: Apple chips encrypt every internal volume, but without FileVault the key opens
 *   at boot without a password); `fdesetup isactive` when diskutil gives no answer for the system volume.
 * - Linux: the folder's mount source (`findmnt`); encrypted when that device or any device under it is a `crypt`
 *   device (LUKS, dm-crypt: `lsblk -s`), the file system is ZFS with encryption on (`zfs get`), or eCryptfs; the folder
 *   itself may also be encrypted with fscrypt (`fscrypt status`).
 * - Anything else, or a command that fails or takes too long: `null` with the reason.
 * Every command has a short time limit.
 */

export interface DiskCrypt { encrypted: boolean | null; detail: string }

/** Runs a command and gives its exit code and output; tests replace it. */
export type CmdRunner = (cmd: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>;

const TIMEOUT_MS = 3000;

export const execRunner: CmdRunner = (cmd, args, timeoutMs) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
    // -1: stopped at the time limit; 127: no such command; else the exit code.
    const e = err as (Error & { code?: unknown; killed?: boolean }) | null;
    const code = !e ? 0 : e.killed ? -1 : typeof e.code === "number" ? e.code : e.code === "ENOENT" ? 127 : 1;
    resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
  });
});

/** The value of a top-level boolean key in a plist printed by `diskutil info -plist`, or null. */
function plistBool(xml: string, key: string): boolean | null {
  const m = new RegExp(`<key>${key}</key>\\s*<(true|false)\\s*/>`).exec(xml);
  return m ? m[1] === "true" : null;
}

async function mac(dir: string, run: CmdRunner): Promise<DiskCrypt> {
  const df = await run("df", ["-P", dir], TIMEOUT_MS);
  const mount = df.code === 0 ? df.stdout.trim().split("\n").at(-1)?.split(/\s+/).slice(5).join(" ") : "";
  if (mount) {
    const info = await run("diskutil", ["info", "-plist", mount], TIMEOUT_MS);
    const fv = info.code === 0 ? plistBool(info.stdout, "FileVault") : null;
    if (fv !== null) return { encrypted: fv, detail: fv ? `FileVault is on for ${mount}` : `FileVault is off for ${mount}; turn it on in System Settings, Privacy and Security` };
  }
  if (!mount || mount === "/" || mount === "/System/Volumes/Data") {
    const r = await run("fdesetup", ["isactive"], TIMEOUT_MS);
    const out = r.stdout.trim();
    if (out === "true") return { encrypted: true, detail: "FileVault is on" };
    if (out === "false") return { encrypted: false, detail: "FileVault is off; turn it on in System Settings, Privacy and Security" };
    return { encrypted: null, detail: `could not tell: fdesetup gave no answer${r.code === -1 ? " in time" : ""}` };
  }
  return { encrypted: null, detail: `could not tell whether ${mount} is encrypted (diskutil gave no answer)` };
}

async function linux(dir: string, run: CmdRunner): Promise<DiskCrypt> {
  const fm = await run("findmnt", ["-n", "-o", "SOURCE,FSTYPE,TARGET", "--target", dir], TIMEOUT_MS);
  if (fm.code !== 0 || !fm.stdout.trim()) return { encrypted: null, detail: `could not tell: findmnt gave no answer${fm.code === -1 ? " in time" : ""}` };
  const [rawSource, fstype, ...rest] = fm.stdout.trim().split("\n")[0].trim().split(/\s+/);
  const target = rest.join(" ");
  // btrfs subvolumes read as /dev/sda2[/@home].
  const source = rawSource.replace(/\[.*\]$/, "");
  // fscrypt encrypts a folder rather than the disk: checked first, it answers even on a plain disk.
  const fs = await run("fscrypt", ["status", dir], TIMEOUT_MS);
  if (fs.code === 0 && /is encrypted with fscrypt/i.test(fs.stdout)) return { encrypted: true, detail: `the data folder is encrypted with fscrypt` };
  if (fstype === "ecryptfs") return { encrypted: true, detail: `the data folder is on eCryptfs (${target})` };
  if (fstype === "zfs") {
    const z = await run("zfs", ["get", "-H", "-o", "value", "encryption", source], TIMEOUT_MS);
    const v = z.stdout.trim();
    if (z.code === 0 && v) return v === "off" ? { encrypted: false, detail: `ZFS dataset ${source} is not encrypted` } : { encrypted: true, detail: `ZFS dataset ${source} is encrypted (${v})` };
    return { encrypted: null, detail: `could not tell whether ZFS dataset ${source} is encrypted` };
  }
  if (!source.startsWith("/dev/")) return { encrypted: null, detail: `could not tell: the data folder is on ${fstype || "an unknown file system"} (${source})` };
  const ls = await run("lsblk", ["-s", "-n", "-r", "-o", "NAME,TYPE", source], TIMEOUT_MS);
  if (ls.code !== 0 || !ls.stdout.trim()) return { encrypted: null, detail: `could not tell: lsblk gave no answer for ${source}${ls.code === -1 ? " in time" : ""}` };
  const crypt = ls.stdout.trim().split("\n").map((l) => l.trim().split(/\s+/)).find((p) => p[1] === "crypt");
  if (crypt) return { encrypted: true, detail: `${target} is on the encrypted device ${crypt[0]} (LUKS or dm-crypt)` };
  return { encrypted: false, detail: `${target} is on ${source}, which is not encrypted; use LUKS full-disk encryption on this machine` };
}

/** Whether the disk holding `dir` is encrypted. Never throws. */
export async function diskEncryption(dir: string, run: CmdRunner = execRunner, platform: NodeJS.Platform = process.platform): Promise<DiskCrypt> {
  try {
    if (platform === "darwin") return await mac(dir, run);
    if (platform === "linux") return await linux(dir, run);
    if (platform === "win32") return { encrypted: null, detail: "not checked on Windows: reading BitLocker's state needs an administrator" };
    return { encrypted: null, detail: `not checked on ${platform}` };
  } catch (e) {
    return { encrypted: null, detail: `could not tell: ${(e as Error).message}` };
  }
}

const cache = new Map<string, { at: number; value: DiskCrypt }>();

/** diskEncryption, kept for 10 minutes per folder: a disk is not encrypted or decrypted between two page loads. */
export async function diskEncryptionCached(dir: string, now = Date.now()): Promise<DiskCrypt> {
  const hit = cache.get(dir);
  if (hit && now - hit.at < 10 * 60_000) return hit.value;
  const value = await diskEncryption(dir);
  cache.set(dir, { at: now, value });
  return value;
}
