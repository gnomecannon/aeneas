import { execFile } from "node:child_process";
import os from "node:os";

/**
 * The Tailscale door: a Direct link hub on a computer that runs Tailscale can also answer web browsers on the tailnet,
 * at this computer's Tailscale address with Tailscale's real certificate, while the apps keep using Direct link. A
 * browser cannot use Direct link itself, so without this a browser away from home has no way in. Off until the owner
 * turns it on (Settings, How devices reach the hub); link.ts keeps the choice in link.json.
 *
 * Requests through it come from Tailscale Serve on this machine, which adds its forwarding headers, so the hub counts
 * them as remote callers that need a device key (app.ts `mainKeyAllowed`), as on a hub whose method is Tailscale.
 */

export interface TailscaleSelf { running: boolean; dns: string | null }

/** Runs the `tailscale` command; replaced in tests. Resolves with stdout, or rejects with what Tailscale said. */
export type TailscaleRunner = (args: string[], timeoutMs: number) => Promise<string>;

const run: TailscaleRunner = (args, timeoutMs) => new Promise((resolve, reject) => {
  execFile("tailscale", args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) reject(new Error(`${String(stderr || "").trim() || String(stdout || "").trim() || err.message}`));
    else resolve(String(stdout));
  });
});

let runner: TailscaleRunner = run;
/** Tests only. */
export function setTailscaleRunner(r: TailscaleRunner | null): void { runner = r ?? run; cached = null; }

/** `tailscale status --json` is asked at most every 30 seconds: Settings asks for the link view often. */
let cached: { at: number; self: TailscaleSelf } | null = null;

export async function tailscaleSelf(now = Date.now()): Promise<TailscaleSelf> {
  if (cached && now - cached.at < 30_000) return cached.self;
  let self: TailscaleSelf = { running: false, dns: null };
  try {
    const j = JSON.parse(await runner(["status", "--json"], 5000)) as { BackendState?: string; Self?: { DNSName?: string } };
    const dns = (j.Self?.DNSName ?? "").replace(/\.$/, "").toLowerCase();
    self = { running: j.BackendState === "Running", dns: /^[a-z0-9.-]+$/.test(dns) && dns ? dns : null };
  } catch { /* not installed, or not running */ }
  cached = { at: now, self };
  return self;
}

export interface DoorView { available: boolean; on: boolean; url: string | null; how?: string; error?: string }

const NOT_DIRECT = "Only for a hub on Direct link. A hub on Tailscale already answers browsers at its Tailscale address.";
const NO_TAILSCALE = "Tailscale is not running on this computer. Install it and sign in here, then try again.";

/** What Settings shows: whether the door can be offered here, and its address while it is on. */
export async function doorView(method: string | null, on: boolean, port: number): Promise<DoorView> {
  if (method !== "direct") return { available: false, on: false, url: null, how: NOT_DIRECT };
  const self = await tailscaleSelf();
  if (!self.running || !self.dns) return { available: false, on, url: null, how: NO_TAILSCALE, ...(on ? { error: "The door is on, but Tailscale is not running on this computer, so browsers cannot reach it now." } : {}) };
  return { available: true, on, url: on ? `https://${self.dns}:${port}` : null };
}

/**
 * Opens or closes the door with Tailscale Serve: HTTPS on the hub's port of this computer's Tailscale address, to the
 * hub on this machine. Null when it worked, else a plain sentence (the 409 PUT /setup/link answers with).
 */
export async function setDoor(on: boolean, port: number): Promise<string | null> {
  const self = await tailscaleSelf();
  if (on && (!self.running || !self.dns)) return NO_TAILSCALE;
  try {
    await runner(on ? ["serve", "--bg", `--https=${port}`, `http://127.0.0.1:${port}`] : ["serve", `--https=${port}`, "off"], 15_000);
    return null;
  } catch (e) {
    // Turning off what is not served is not a failure.
    if (!on && /not found|no serve config|nothing to/i.test((e as Error).message)) return null;
    return refusal((e as Error).message);
  }
}

/** What Tailscale said, as a sentence that says what to do. Never more than one line of its output. */
export function refusal(said: string): string {
  const signIn = said.match(/https:\/\/login\.tailscale\.com\/\S+/);
  if (signIn) return `Tailscale Serve is not turned on for your tailnet yet. Open ${signIn[0]} , turn it on, then switch this on again.`;
  if (/operator|access denied|permission denied|not permitted/i.test(said)) {
    return os.platform() === "win32"
      ? "Tailscale did not let the hub serve. Open Tailscale on this PC as an administrator once, then switch this on again."
      : `Tailscale did not let the hub serve. Once, as an admin on this computer, run: sudo tailscale set --operator=${os.userInfo().username} . Then switch this on again.`;
  }
  const line = said.split("\n").map((l) => l.trim()).find(Boolean) ?? "no answer";
  return `Tailscale did not turn it on: ${line.slice(0, 200)}`;
}
