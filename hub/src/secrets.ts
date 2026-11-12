import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Hub } from "./hub.js";
import { StoreError } from "./store.js";
import { commandArgv, type Host, type HostOs } from "./ai/hosts.js";
import { KeePassVault, generatePassword, keepassPath } from "./keepass.js";
import { readAiSettings } from "./setup.js";
import { feedStdin } from "./child.js";

/**
 * Password manager link. The hub reads secrets through the LastPass CLI (`lpass`) on the hub's own machine or another
 * known host (a Mac whose `lpass` is already signed in), the 1Password CLI (`op`) or the Bitwarden CLI (`bw`, which
 * also signs in to a self-hosted Vaultwarden) on the hub's machine, or its own KeePass file for an owner who has no
 * password manager (keepass.ts), so the assistant can use a password in a command without ever seeing it:
 * - which items it may use is set in Settings, Connections (since 2026-11-05): every item except the items and
 *   folders the owner excluded (the default), or only the items they chose; the assistant learns only names, found
 *   by searching, and never an excluded one. An excluded item is never read, even when a command names it;
 * - a command naming one (`{{secret:Item}}`, `{{secret:Item/username}}`) is never read-only, so it always waits for
 *   approval; the value goes in, quoted, only when it runs, and is cut from the output before anything stores it;
 * - sign-in goes through the CLI: a LastPass master password and code are passed to `lpass login` and never kept;
 *   a 1Password service account token (read-only, limited to the vaults it was given) is kept like the hub's other
 *   connection secrets and handed to `op` in its environment; Bitwarden's master password goes to `bw login` or
 *   `bw unlock` in its environment and only the session key it answers is kept;
 * - the built-in KeePass file's master password is made by the hub (or given with a file the owner already has) and
 *   kept apart from the link, so changing password managers never loses it.
 * Nobody makes the assistant list the vault: item names are searched only from Settings.
 */

export type Provider = "lastpass" | "1password" | "bitwarden" | "keepass";
export const PROVIDERS: Provider[] = ["lastpass", "1password", "bitwarden", "keepass"];
/**
 * `access`: "all" (every item except `excluded`, the default) or "chosen" (only `allowed`). An `excluded` entry is an
 * item's name, its full name with its folder ("Tech/Router"), or a folder ending in "/" ("Shared-Family/").
 */
export interface PasswordManagerConn { provider: Provider; host: string; account?: string; op_token?: string; bw_session?: string; bw_server?: string; allowed: string[]; access?: "all" | "chosen"; excluded?: string[]; linked_at: string }

export const accessOf = (c: PasswordManagerConn): "all" | "chosen" => c.access ?? "all";

/** Whether an item (its full name with folder, and its own name) is one the owner excluded. */
export function isExcluded(c: PasswordManagerConn, full: string, name: string = full.slice(full.lastIndexOf("/") + 1)): boolean {
  const f = full.toLowerCase(), n = name.toLowerCase();
  return (c.excluded ?? []).some((raw) => {
    const e = raw.trim().toLowerCase();
    if (!e) return false;
    if (e.endsWith("/")) return f.startsWith(e);
    return e === f || (!e.includes("/") && e === n);
  });
}

/** One item: its id where the manager has one, its full name with folder, and its own name. Never a value. */
interface VaultItem { id: string; full: string; name: string }
const NAMES: Record<Provider, string> = { lastpass: "LastPass", "1password": "1Password", bitwarden: "Bitwarden", keepass: "the built-in vault" };

/** `{{secret:Item}}` or `{{secret:Item/field}}` in a command. */
export const SECRET_REF = /\{\{\s*secret:([^{}]+?)\s*\}\}/g;
const TIMEOUT_S = 30;
const PATHS = 'PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"';
const LPASS = `${PATHS} LPASS_DISABLE_PINENTRY=1 LPASS_AGENT_TIMEOUT=0 lpass`;
const BW = `${PATHS} bw`;

export const INSTALL_HINT: Record<Provider, Record<string, string>> = {
  lastpass: { linux: "sudo apt install lastpass-cli", macos: "brew install lastpass-cli" },
  "1password": { linux: "1Password CLI: developer.1password.com/docs/cli/get-started (one file, `op`, in ~/.local/bin)", macos: "brew install 1password-cli" },
  bitwarden: { linux: "Install, below, puts the Bitwarden CLI in ~/.local/bin", macos: "Install, below, puts the Bitwarden CLI in ~/.local/bin" },
  keepass: { linux: "", macos: "" },
};

/** Providers whose CLI runs with a kept token or key, so only on the hub's own machine. */
const LOCAL_ONLY = new Set<Provider>(["1password", "bitwarden", "keepass"]);

/** Run a command on a host with something written to its standard input (a master password). Nothing is logged. */
export type InputRunner = (host: Host, command: string, input: string | null, env: Record<string, string>, timeoutS: number) => Promise<{ code: number | null; out: string }>;

export const spawnWithInput: InputRunner = (host, command, input, env, timeoutS) => new Promise((resolve) => {
  const { file, args } = commandArgv(host, command);
  const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env, LC_ALL: "C.UTF-8" } });
  let out = "";
  child.stdout.on("data", (b: Buffer) => { out += b.toString("utf8"); });
  child.stderr.on("data", (b: Buffer) => { out += b.toString("utf8"); });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutS * 1000);
  child.on("error", (e) => { clearTimeout(timer); resolve({ code: null, out: e.message }); });
  child.on("close", (code) => { clearTimeout(timer); resolve({ code, out: out.slice(0, 200_000) }); });
  feedStdin(child, input);
});

export const cli = { run: spawnWithInput };

/** A value for the shell the host runs: single-quoted, so nothing in a password is read as code. */
export function quoteFor(os: HostOs, value: string): string {
  // PowerShell also ends a single-quoted string at the curly quotes ‘ ’ ‚ ‛, so each is doubled like ' is.
  return os === "windows" ? `'${value.replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&")}'` : `'${value.replace(/'/g, `'\\''`)}'`;
}

function conn(hub: Hub): PasswordManagerConn | null {
  return hub.connections.get().password_manager ?? null;
}

/** The built-in KeePass file. Its master password lives apart from the link (`connections.keepass`). */
export function keepass(hub: Hub): KeePassVault {
  return new KeePassVault(keepassPath(hub.cfg.dataDir), () => hub.connections.get().keepass?.password ?? "");
}

const bwEnv = (c: PasswordManagerConn | null, extra: Record<string, string> = {}) => ({ BW_NOINTERACTION: "true", ...(c?.bw_session ? { BW_SESSION: c.bw_session } : {}), ...extra });

/** `bw status`: unauthenticated, locked or unlocked, and the account and server. */
async function bwStatus(host: Host, c: PasswordManagerConn | null): Promise<{ status: string; userEmail?: string; serverUrl?: string | null } | null> {
  const r = await cli.run(host, `${BW} status`, null, bwEnv(c), 20);
  try { return JSON.parse(r.out.slice(r.out.indexOf("{"))) as { status: string; userEmail?: string; serverUrl?: string | null }; } catch { return null; }
}

/** A host for a password manager. The CLIs (LastPass, 1Password, Bitwarden) run in a Linux or macOS shell; the
 * built-in vault is a file the hub reads itself, so `anyOs` lets it use a Windows hub's own machine too. */
function hostFor(hub: Hub, name: string, anyOs = false): Host {
  const h = hub.ai.hosts.host(name);
  if (!h) throw new StoreError(404, `no host named ${name}`);
  if (h.os === "windows" && !anyOs) throw new StoreError(422, "the password manager CLI runs on a Linux or macOS host");
  return h;
}

/** The hub's own machine: the host that runs locally, else the first one (Linux or macOS ones only, for the CLIs). */
export function hubHost(hub: Hub, anyOs = false): string {
  const hosts = hub.ai.hosts.hosts().filter((h) => anyOs || h.os !== "windows");
  return (hosts.find((h) => h.local) ?? hosts[0])?.name ?? "";
}

/** What clients see: never a token or a value; which items may be used. */
export function passwordManagerView(hub: Hub) {
  const c = conn(hub);
  return c
    ? { linked: true, provider: c.provider, host: c.host, account: c.account ?? null, access: accessOf(c), allowed: c.allowed, excluded: c.excluded ?? [] }
    : { linked: false, provider: null, host: hubHost(hub) || null, account: null, access: "all" as const, allowed: [] as string[], excluded: [] as string[] };
}

/** Which CLIs the host has, and whether the chosen one is signed in. */
export async function passwordManagerStatus(hub: Hub, provider?: Provider, hostName?: string) {
  const c = conn(hub);
  // A Windows hub has no Linux or macOS machine of its own: only the built-in vault, and no CLI is looked for there.
  const host = hostFor(hub, hostName ?? c?.host ?? (hubHost(hub) || hubHost(hub, true)), true);
  const shell = host.os !== "windows";
  const has = async (bin: string) => shell && (await cli.run(host, `${PATHS} command -v ${bin}`, null, {}, 10)).code === 0;
  const installed: Record<Provider, boolean> = { lastpass: await has("lpass"), "1password": await has("op"), bitwarden: await has("bw"), keepass: true };
  const p = provider ?? c?.provider ?? null;
  let signedIn = false;
  let account: string | null = null;
  if (p === "lastpass" && installed.lastpass) {
    const r = await cli.run(host, `${LPASS} status`, null, {}, 10);
    signedIn = r.code === 0 && /logged in/i.test(r.out);
    account = signedIn ? (/as (\S+@\S+?)\.?\s*$/m.exec(r.out)?.[1] ?? null) : null;
  } else if (p === "1password" && installed["1password"] && c?.op_token) {
    const r = await cli.run(host, `${PATHS} op whoami --format json`, null, { OP_SERVICE_ACCOUNT_TOKEN: c.op_token }, 15);
    signedIn = r.code === 0;
    try { account = signedIn ? String((JSON.parse(r.out) as { url?: string }).url ?? "") || null : null; } catch { account = null; }
  } else if (p === "bitwarden" && installed.bitwarden) {
    const s = await bwStatus(host, c);
    signedIn = s?.status === "unlocked" && !!c?.bw_session;
    account = s?.userEmail ? `${s.userEmail}${s.serverUrl ? ` (${s.serverUrl})` : ""}` : null;
  } else if (p === "keepass") {
    const v = keepass(hub);
    signedIn = v.exists() && !!hub.connections.get().keepass?.password && await v.unlocks();
    account = v.exists() ? v.file : null;
  }
  const os = host.os === "macos" ? "macos" : "linux";
  const hint = p && !installed[p] ? (shell ? INSTALL_HINT[p][os] : `${NAMES[p]} works on a Linux or macOS hub; a Windows hub has the built-in vault`) : null;
  return { host: host.name, provider: p, installed, signed_in: signedIn, account, install_hint: hint };
}

/** Choose the password manager and where its CLI runs. Allowed items stay when only the host changes. */
export async function linkPasswordManager(hub: Hub, provider: Provider, hostName: string) {
  if (!PROVIDERS.includes(provider)) throw new StoreError(422, `provider must be one of ${PROVIDERS.join(", ")}`);
  // The built-in vault lives on the hub's own machine, whatever its system (a Windows hub included).
  const vault = provider === "keepass";
  const host = vault ? hostFor(hub, hubHost(hub, true), true) : hostFor(hub, LOCAL_ONLY.has(provider) ? hubHost(hub) : hostName || hubHost(hub));
  if (LOCAL_ONLY.has(provider) && hostName && hostName !== host.name) throw new StoreError(422, `${NAMES[provider]} runs on the hub's own machine`);
  // The built-in vault is made the first time it is chosen, with a long random master password the hub keeps.
  if (provider === "keepass" && !keepass(hub).exists()) {
    if (!hub.connections.get().keepass?.password) hub.connections.update((c) => { c.keepass = { password: generatePassword(32), created_at: new Date().toISOString() }; });
    await keepass(hub).create();
  }
  hub.connections.update((c) => {
    const prev = c.password_manager?.provider === provider ? c.password_manager : undefined;
    c.password_manager = { provider, host: host.name, allowed: prev?.allowed ?? [], linked_at: new Date().toISOString(),
      ...(prev?.op_token ? { op_token: prev.op_token } : {}), ...(prev?.bw_session ? { bw_session: prev.bw_session } : {}), ...(prev?.bw_server ? { bw_server: prev.bw_server } : {}) };
  });
  return passwordManagerView(hub);
}

/**
 * Sign in through the CLI. LastPass: email, master password and code go to `lpass login` and are not kept.
 * 1Password: a service account token. Bitwarden: email, master password, code and (for Vaultwarden or the EU cloud)
 * the server go to `bw login` (or `bw unlock` when it is only locked); the session key it answers is kept.
 * The built-in vault: the master password of the KeePass file there, when it was not made here.
 */
export async function signInPasswordManager(hub: Hub, body: { email?: string; password?: string; code?: string; token?: string; server?: string }) {
  const c = conn(hub);
  if (!c) throw new StoreError(409, "choose a password manager first");
  // The built-in vault needs no shell, so a Windows hub's own machine serves it.
  const host = hostFor(hub, c.host, c.provider === "keepass");
  if (c.provider === "bitwarden") await bitwardenSignIn(hub, c, host, body);
  else if (c.provider === "keepass") {
    if (!body.password) throw new StoreError(422, "the master password is needed");
    const before = hub.connections.get().keepass;
    hub.connections.update((x) => { x.keepass = { password: body.password!, created_at: before?.created_at ?? new Date().toISOString() }; });
    if (!await keepass(hub).unlocks()) {
      hub.connections.update((x) => { if (before) x.keepass = before; else delete x.keepass; });
      throw new StoreError(422, "that master password does not open the vault");
    }
  } else if (c.provider === "lastpass") {
    const email = (body.email ?? "").trim();
    if (!/^[^\s@]+@[^\s@]+$/.test(email) || !body.password) throw new StoreError(422, "email and master password are needed");
    const input = `${body.password}\n${body.code?.trim() ? `${body.code.trim()}\n` : ""}`;
    const r = await cli.run(host, `${LPASS} login --trust ${quoteFor(host.os, email)}`, input, {}, 60);
    if (r.code !== 0) throw new StoreError(422, /multifactor|two.?factor|out-of-band|code/i.test(r.out) ? "LastPass wants the code from your authenticator: add it and sign in again" : "LastPass did not accept that email and master password");
    hub.connections.update((x) => { if (x.password_manager) x.password_manager.account = email; });
  } else {
    const token = (body.token ?? "").trim();
    if (!/^ops_[A-Za-z0-9_\-.=]{20,}$/.test(token)) throw new StoreError(422, "that is not a 1Password service account token (it starts with ops_)");
    const r = await cli.run(host, `${PATHS} op whoami`, null, { OP_SERVICE_ACCOUNT_TOKEN: token }, 15);
    if (r.code !== 0) throw new StoreError(422, "1Password did not accept that token");
    hub.connections.update((x) => { if (x.password_manager) x.password_manager.op_token = token; });
  }
  return passwordManagerStatus(hub);
}

async function bitwardenSignIn(hub: Hub, c: PasswordManagerConn, host: Host, body: { email?: string; password?: string; code?: string; server?: string }) {
  if (!body.password) throw new StoreError(422, "the master password is needed");
  const server = (body.server ?? "").trim().replace(/\/+$/, "");
  if (server && !/^https:\/\/[^\s'"]+$/.test(server)) throw new StoreError(422, "the server is an https:// address (leave it empty for bitwarden.com)");
  const env = bwEnv(null, { EA_BW_PASSWORD: body.password });
  let s = await bwStatus(host, null);
  if (!s) throw new StoreError(422, "the Bitwarden CLI did not answer");
  const email = (body.email ?? "").trim();
  // Another account or server: sign that one out first (the CLI keeps one).
  if (s.status !== "unauthenticated" && ((email && s.userEmail && email.toLowerCase() !== s.userEmail.toLowerCase()) || (server && s.serverUrl !== server))) {
    await cli.run(host, `${BW} logout`, null, bwEnv(null), 20);
    s = { status: "unauthenticated" };
  }
  let r: { code: number | null; out: string };
  if (s.status === "unauthenticated") {
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new StoreError(422, "email and master password are needed");
    if (server || c.bw_server) await cli.run(host, `${BW} config server ${quoteFor(host.os, server || c.bw_server!)}`, null, bwEnv(null), 20);
    const code = body.code?.trim() ? ` --method 0 --code ${quoteFor(host.os, body.code.trim())}` : "";
    r = await cli.run(host, `${BW} login ${quoteFor(host.os, email)} --passwordenv EA_BW_PASSWORD --raw${code}`, null, env, 90);
  } else {
    r = await cli.run(host, `${BW} unlock --passwordenv EA_BW_PASSWORD --raw`, null, env, 90);
  }
  const session = r.out.trim().split("\n").pop()?.trim() ?? "";
  if (r.code !== 0 || !/^[A-Za-z0-9+/=]{40,}$/.test(session)) {
    throw new StoreError(422, /two.?step|two.?factor|code/i.test(r.out) && !body.code ? "Bitwarden wants the code from your authenticator: add it and sign in again" : "Bitwarden did not accept that email and master password");
  }
  hub.connections.update((x) => { if (x.password_manager) { x.password_manager.bw_session = session; if (server) x.password_manager.bw_server = server; if (email) x.password_manager.account = email; } });
}

/** Put a password manager's CLI on the hub's machine where it can be done without root: Bitwarden's comes from npm. */
export async function installPasswordManager(hub: Hub, provider: Provider) {
  if (provider !== "bitwarden") throw new StoreError(422, `${NAMES[provider]} is installed by hand: ${INSTALL_HINT[provider]?.linux ?? ""}`);
  const host = hostFor(hub, hubHost(hub));
  const npm = path.join(path.dirname(process.execPath), "npm");
  const r = await cli.run(host, `${quoteFor(host.os, npm)} install -g --prefix "$HOME/.local" @bitwarden/cli`, null, { PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ""}` }, 300);
  if (r.code !== 0) throw new StoreError(502, `npm could not install the Bitwarden CLI: ${r.out.trim().split("\n").slice(-2).join(" ").slice(0, 300)}`);
  return passwordManagerStatus(hub, provider);
}

/** Sign out at the CLI (LastPass, Bitwarden) or forget the token (1Password), and unlink. The built-in vault's file and master password stay. */
export async function unlinkPasswordManager(hub: Hub) {
  const c = conn(hub);
  if (c?.provider === "lastpass") { try { await cli.run(hostFor(hub, c.host), `${LPASS} logout --force`, null, {}, 15); } catch { /* host gone */ } }
  if (c?.provider === "bitwarden") { try { await cli.run(hostFor(hub, c.host), `${BW} logout`, null, bwEnv(c), 20); } catch { /* host gone */ } }
  hub.connections.update((x) => { delete x.password_manager; });
  return passwordManagerView(hub);
}

/** Forget the kept list of names (tests; a sign-in to another account). */
export function forgetItemNames() { itemCache = null; }

/** Every item's id and name (LastPass: with its folder). Names only, never a value; kept a minute. */
let itemCache: { key: string; at: number; items: VaultItem[] } | null = null;
async function vaultItems(hub: Hub, c: PasswordManagerConn, q = ""): Promise<VaultItem[]> {
  const key = `${c.provider}:${c.host}:${c.linked_at}`;
  // Only the managers whose list costs a CLI call are kept; the built-in vault is a local file, read each time.
  const cached = c.provider === "lastpass" || c.provider === "1password";
  if (cached && itemCache && itemCache.key === key && Date.now() - itemCache.at < 60_000) return itemCache.items;
  let items: VaultItem[];
  if (c.provider === "keepass") {
    try { items = (await keepass(hub).list()).map((e) => ({ id: e.title, full: e.title, name: e.title })); } catch { throw new StoreError(409, "the vault does not open with its master password"); }
  } else {
    const host = hostFor(hub, c.host);
    if (c.provider === "bitwarden") await cli.run(host, `${BW} sync`, null, bwEnv(c), TIMEOUT_S);
    const r = c.provider === "lastpass"
      ? await cli.run(host, `${LPASS} ls --sync=auto --format=${quoteFor(host.os, "%ai|%aN")}`, null, {}, TIMEOUT_S)
      : c.provider === "bitwarden"
        ? await cli.run(host, `${BW} list items${q.trim() ? ` --search ${quoteFor(host.os, q.trim())}` : ""}`, null, bwEnv(c), TIMEOUT_S)
        : await cli.run(host, `${PATHS} op item list --format json`, null, { OP_SERVICE_ACCOUNT_TOKEN: c.op_token ?? "" }, TIMEOUT_S);
    if (r.code !== 0) throw new StoreError(409, "the password manager is not signed in");
    if (c.provider === "lastpass") {
      items = r.out.split("\n").map((l) => l.trim()).filter(Boolean).flatMap((l) => {
        const bar = l.indexOf("|");
        const id = l.slice(0, bar), full = l.slice(bar + 1).trim();
        if (bar < 1 || !/^\d+$/.test(id) || !full) return [];
        return [{ id, full, name: full.slice(full.lastIndexOf("/") + 1) }];
      });
    } else {
      try { items = (JSON.parse(r.out.slice(r.out.indexOf("["))) as { id?: string; title?: string; name?: string }[]).map((i) => String(i.title ?? i.name ?? "")).filter(Boolean).map((n) => ({ id: n, full: n, name: n })); } catch { items = []; }
    }
  }
  if (cached) itemCache = { key, at: Date.now(), items };
  return items;
}

/**
 * Item names matching `q`: in Settings, to choose or exclude items; for the assistant, to find an item it may use.
 * `forAssistant` leaves out excluded items (and, with "chosen" access, every item not chosen).
 */
export async function searchItems(hub: Hub, q: string, forAssistant = false): Promise<string[]> {
  const c = conn(hub);
  if (!c) throw new StoreError(409, "no password manager is linked");
  const want = q.trim().toLowerCase();
  let items = await vaultItems(hub, c, q);
  if (forAssistant) items = items.filter((i) => accessOf(c) === "all" ? !isExcluded(c, i.full, i.name) : c.allowed.some((a) => a.toLowerCase() === i.name.toLowerCase() || a.toLowerCase() === i.full.toLowerCase()));
  return [...new Set(items.map((i) => i.full))].filter((n) => !want || n.toLowerCase().includes(want)).sort((a, b) => a.localeCompare(b)).slice(0, 40);
}

/** Every item, or only the chosen ones, and the items and folders left out. */
export function setAccess(hub: Hub, body: { access?: unknown; excluded?: unknown }) {
  if (!conn(hub)) throw new StoreError(409, "no password manager is linked");
  if (body.access !== undefined && body.access !== "all" && body.access !== "chosen") throw new StoreError(422, "access is all or chosen");
  if (body.excluded !== undefined && (!Array.isArray(body.excluded) || !body.excluded.every((n) => typeof n === "string" && n.trim() && !/[{}]/.test(n) && n.length <= 200))) throw new StoreError(422, "excluded is a list of item names, or folders ending in /");
  hub.connections.update((x) => {
    const pm = x.password_manager;
    if (!pm) return;
    if (body.access !== undefined) pm.access = body.access as "all" | "chosen";
    if (body.excluded !== undefined) pm.excluded = [...new Set((body.excluded as string[]).map((n) => n.trim()))];
  });
  return passwordManagerView(hub);
}

export function setAllowed(hub: Hub, names: unknown) {
  if (!Array.isArray(names) || !names.every((n) => typeof n === "string" && n.trim() && !/[{}]/.test(n))) throw new StoreError(422, "names is a list of item names");
  if (!conn(hub)) throw new StoreError(409, "no password manager is linked");
  hub.connections.update((x) => { if (x.password_manager) x.password_manager.allowed = [...new Set((names as string[]).map((n) => n.trim()))]; });
  return passwordManagerView(hub);
}

const FIELD = /^(password|username|url|notes)$/i;

/**
 * Which item a reference names, and which field. `Name`, `Folder/Name`, `Name/username`, `Folder/Name/notes`; a
 * last part that is not a field is part of the name. Every item except excluded ones may be used, or only chosen
 * ones; a name two items share must be written with its folder. Returns the name to read by and, for LastPass, the
 * item's id, so the read can never pick another item with the same name.
 */
async function resolveItem(hub: Hub, c: PasswordManagerConn, ref: string): Promise<{ read: string; label: string; field: string }> {
  const slash = ref.lastIndexOf("/");
  const tail = ref.slice(slash + 1).trim();
  const custom = slash > 0 && /^[a-z][\w ]{0,30}$/i.test(tail) && !FIELD.test(tail);
  const [name, field] = slash > 0 && FIELD.test(tail) ? [ref.slice(0, slash).trim(), tail.toLowerCase()] : [ref.trim(), "password"];
  if (accessOf(c) === "chosen") {
    const allowed = c.allowed.find((a) => a.toLowerCase() === name.toLowerCase());
    if (!allowed) throw new Error(`"${name}" is not one of the items chosen in Settings, Connections, Password manager`);
    return { read: allowed, label: allowed, field };
  }
  const items = await vaultItems(hub, c);
  const lower = name.toLowerCase();
  const found = (n: string) => items.filter((i) => i.full.toLowerCase() === n || (!n.includes("/") && i.name.toLowerCase() === n));
  let matches = found(lower);
  let f = field;
  // "Item/Custom field" (a field the item has besides the usual four) when no item is named that way.
  if (!matches.length && custom) { matches = found(ref.slice(0, slash).trim().toLowerCase()); f = tail.toLowerCase(); }
  const usable = matches.filter((i) => !isExcluded(c, i.full, i.name));
  if (!usable.length) throw new Error(`"${name}" is not an item that may be used (it is not in ${NAMES[c.provider]}, or it is excluded in Settings, Connections, Password manager)`);
  if (usable.length > 1) throw new Error(`${usable.length} items are named "${name}": write {{secret:${usable[0].full}}} with the folder (${usable.map((i) => i.full).join(", ")})`);
  return { read: c.provider === "lastpass" ? usable[0].id : usable[0].full, label: usable[0].full, field: f };
}

/** One usable item's field (password by default), read through the CLI. Never logged. */
async function readSecret(hub: Hub, c: PasswordManagerConn, ref: string): Promise<string> {
  const { read: allowed, label, field } = await resolveItem(hub, c, ref);
  if (c.provider === "keepass") {
    const v = await keepass(hub).read(allowed, field).catch(() => { throw new Error("the built-in vault does not open with its master password"); });
    if (v === null) throw new Error(`"${allowed}" is not in the built-in vault, or has no ${field}`);
    if (!v) throw new Error(`"${allowed}" has no ${field}`);
    return v;
  }
  const host = hostFor(hub, c.host);
  if (c.provider === "bitwarden") return bitwardenRead(host, c, allowed, field);
  const q = quoteFor(host.os, allowed);
  const r = c.provider === "lastpass"
    ? await cli.run(host, `${LPASS} show --sync=no ${field === "password" ? "--password" : field === "username" ? "--username" : field === "url" ? "--url" : field === "notes" ? "--notes" : `--field=${quoteFor(host.os, field)}`} ${q}`, null, {}, TIMEOUT_S)
    : await cli.run(host, `${PATHS} op item get ${q} --fields ${quoteFor(host.os, `label=${field}`)} --reveal`, null, { OP_SERVICE_ACCOUNT_TOKEN: c.op_token ?? "" }, TIMEOUT_S);
  if (r.code !== 0) throw new Error(`could not read "${label}" from ${NAMES[c.provider]} (signed out?)`);
  const value = r.out.replace(/\r?\n$/, "");
  if (!value) throw new Error(`"${label}" has no ${field}`);
  // Never more than one line for a password: a list of matching items is not a password.
  if (field === "password" && (/\n/.test(value) || /^Multiple matches found/i.test(value))) throw new Error(`"${label}" did not give one password; write it with its folder`);
  return value;
}

interface BwItem { name?: string; notes?: string | null; login?: { username?: string | null; password?: string | null; uris?: { uri?: string }[] | null } | null; fields?: { name?: string; value?: string | null }[] | null }

/** A Bitwarden item by its exact name (synced once more if it is not found), and one of its fields. */
async function bitwardenRead(host: Host, c: PasswordManagerConn, name: string, field: string): Promise<string> {
  const find = async () => {
    const r = await cli.run(host, `${BW} list items --search ${quoteFor(host.os, name)}`, null, bwEnv(c), TIMEOUT_S);
    if (r.code !== 0) throw new Error(`could not read "${name}" from Bitwarden (locked or signed out? sign in again in Settings)`);
    try { return (JSON.parse(r.out.slice(r.out.indexOf("["))) as BwItem[]).find((i) => (i.name ?? "").toLowerCase() === name.toLowerCase()); } catch { return undefined; }
  };
  let item = await find();
  if (!item) { await cli.run(host, `${BW} sync`, null, bwEnv(c), TIMEOUT_S); item = await find(); }
  if (!item) throw new Error(`"${name}" is not in Bitwarden`);
  const value = field === "password" ? item.login?.password : field === "username" ? item.login?.username : field === "url" ? item.login?.uris?.[0]?.uri
    : field === "notes" ? item.notes : item.fields?.find((f) => (f.name ?? "").toLowerCase() === field)?.value;
  if (!value) throw new Error(`"${name}" has no ${field}`);
  return value;
}

/** Put the named secrets into a command, quoted for the host's shell. Returns the values so the output can be cleaned. */
export async function fillSecrets(hub: Hub, command: string, os: HostOs): Promise<{ command: string; values: string[] }> {
  const c = conn(hub);
  if (!c) throw new Error("the command names a secret but no password manager is linked");
  const refs = [...new Set([...command.matchAll(SECRET_REF)].map((m) => m[1]))];
  const values = new Map<string, string>();
  for (const r of refs) values.set(r, await readSecret(hub, c, r));
  return { command: command.replace(SECRET_REF, (_, r: string) => quoteFor(os, values.get(r)!)), values: [...values.values()] };
}

// ---------- the built-in vault's items, managed from Settings ----------

function keepassLinked(hub: Hub): PasswordManagerConn {
  const c = conn(hub);
  if (c?.provider !== "keepass") throw new StoreError(409, "the built-in vault is not the linked password manager");
  return c;
}

/** Items in the built-in vault: names, usernames and addresses, never a password. */
export async function keepassEntries(hub: Hub) {
  keepassLinked(hub);
  try { return await keepass(hub).list(); } catch { throw new StoreError(409, "the vault does not open with its master password"); }
}

/** Add or change an item. A new item the owner adds here is one the assistant may use; an empty password is made up. */
export async function putKeepassEntry(hub: Hub, body: { title?: unknown; username?: unknown; password?: unknown; url?: unknown; notes?: unknown }) {
  keepassLinked(hub);
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title || /[{}]/.test(title) || title.length > 120) throw new StoreError(422, "an item needs a name (no braces)");
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const entry = await keepass(hub).put({ title, username: str(body.username), password: str(body.password) || undefined, url: str(body.url), notes: str(body.notes) });
  hub.connections.update((x) => { const pm = x.password_manager; if (pm && !pm.allowed.some((a) => a.toLowerCase() === title.toLowerCase())) pm.allowed.push(title); });
  return entry;
}

export async function removeKeepassEntry(hub: Hub, title: string) {
  keepassLinked(hub);
  if (!await keepass(hub).remove(title)) throw new StoreError(404, `no item named ${title}`);
  hub.connections.update((x) => { const pm = x.password_manager; if (pm) pm.allowed = pm.allowed.filter((a) => a.toLowerCase() !== title.toLowerCase()); });
  return { removed: title };
}

/** Use a KeePass file the owner already has in place of the built-in one, after its master password opens it. */
export async function importKeepass(hub: Hub, body: { data?: unknown; password?: unknown }) {
  if (typeof body.data !== "string" || typeof body.password !== "string" || !body.password) throw new StoreError(422, "data (the .kdbx file in base64) and password are needed");
  const bytes = Buffer.from(body.data, "base64");
  if (bytes.length < 100 || bytes.length > 18 * 1024 * 1024) throw new StoreError(422, "that is not a KeePass file");
  let count: number;
  try { count = await KeePassVault.check(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, body.password); } catch { throw new StoreError(422, "that file does not open with that master password (is it a .kdbx file?)"); }
  const v = keepass(hub);
  // The vault that was there is kept beside it, in case it held something.
  if (v.exists()) fs.copyFileSync(v.file, `${v.file}.${new Date().toISOString().slice(0, 19).replace(/:/g, "")}.bak`);
  v.replaceWith(bytes);
  hub.connections.update((x) => { x.keepass = { password: body.password as string, created_at: new Date().toISOString() }; });
  await linkPasswordManager(hub, "keepass", "");
  return { items: count, ...passwordManagerView(hub) };
}


/**
 * Every secret value the hub itself holds: its token and feed token, model and image service keys (hub.env and
 * Settings), linked accounts' keys and tokens (connections.json, the vault's master password included) and the work
 * key. Command output is stripped of them (HostActions.hiddenValues), so a read that reaches one of these files by
 * a path the read-only check did not catch still shows only [secret].
 */
export function hubSecretValues(hub: Hub): string[] {
  const out = new Set<string>();
  const add = (v: unknown) => { if (typeof v === "string" && v.trim().length >= 8) out.add(v.trim()); };
  const c = hub.cfg;
  [c.token, c.feedToken, c.anthropicApiKey, c.openaiKey, c.imageServiceToken].forEach(add);
  // Every secret set in hub.env, not only the ones named above (EA_STEAM_KEY, EA_GOOGLE_CLIENT_SECRET, ...).
  for (const [k, v] of Object.entries(process.env)) if (/^EA_.*(KEY|SECRET|TOKEN|PASSWORD|PASS)$/.test(k)) add(v);
  const walk = (v: unknown, key = ""): void => {
    if (typeof v === "string") { if (/token|secret|key|password|master|refresh|access|credential|session/i.test(key)) add(v); return; }
    if (Array.isArray(v)) { v.forEach((x) => walk(x, key)); return; }
    if (v && typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, k);
  };
  try { walk(hub.connections.get()); } catch { /* none linked */ }
  try { walk(readAiSettings(c.dataDir, hub.secretBox)); } catch { /* no settings */ }
  // The sign-ins key, as the work key below.
  const sk = hub.secretBox.peek();
  if (sk) { const hex = sk.toString("hex"); out.add(hex); out.add(hex.toUpperCase()); out.add(sk.toString("base64")); }
  try { hub.feedKeys.all().forEach(add); } catch { /* none made yet */ }
  try {
    const k = fs.readFileSync(c.workKeyFile);
    // Hex in both cases and the spaced hex of xxd, as well as base64.
    if (k.length === 32) {
      const hex = k.toString("hex");
      out.add(hex); out.add(hex.toUpperCase()); out.add(k.toString("base64"));
      for (let i = 0; i + 4 <= hex.length; i += 32) out.add(hex.slice(i, i + 32).match(/.{4}/g)!.join(" "));
    }
  } catch { /* no work key */ }
  // The backup key's identity (the recovery key), as written and in lower case. Read only: never makes a key.
  try { const b = hub.backupKey.read(); if (b) { out.add(b.identity); out.add(b.identity.toLowerCase()); } } catch { /* unreadable: nothing to hide */ }
  return [...out];
}
