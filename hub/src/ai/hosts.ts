import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nowIso } from "@everythingapp/shared";
import type { Entity } from "@everythingapp/shared";
import type { Config } from "../config.js";
import type { DB } from "../db.js";
import type { Store } from "../store.js";
import { detectDestructive } from "../preflight.js";

/**
 * Host commands for the assistant (Module 2 made live).
 *
 * The hub runs on its own machine and reaches the other machines with the SSH keys and aliases already in that machine's
 * ~/.ssh/config. Read-only commands run as soon as the model asks. Anything else becomes a pending action:
 * the model shows the owner the exact command, the owner approves it (Run button, or "yes" in the chat), and only
 * then does it run. Every approved change is written to the change journal with its rollback.
 */

export type HostOs = "linux" | "macos" | "windows";
export interface Host { name: string; aliases: string[]; target: string; os: HostOs; local: boolean; via: string }

export interface HostFileEntry { name: string; ssh?: string; os?: HostOs; local?: boolean; aliases?: string[] }

/** Host blocks from an OpenSSH client config. Wildcard patterns are skipped. */
export function parseSshConfig(text: string): { names: string[]; hostName?: string; user?: string }[] {
  const out: { names: string[]; hostName?: string; user?: string }[] = [];
  let cur: { names: string[]; hostName?: string; user?: string } | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = /^(\S+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key === "host") {
      const names = m[2].split(/\s+/).filter((n) => !/[*?!]/.test(n));
      cur = names.length ? { names } : null;
      if (cur) out.push(cur);
    } else if (key === "match") {
      cur = null;
    } else if (cur && key === "hostname") cur.hostName = m[2].trim();
    else if (cur && key === "user") cur.user = m[2].trim();
  }
  return out;
}

/** The SSH config's host blocks as Host entries, keyed by their first name (not machines the hub uses by itself). */
function sshHosts(sshConfigPath: string): Map<string, Host> {
  const hosts = new Map<string, Host>();
  let sshText = "";
  try { sshText = fs.readFileSync(sshConfigPath, "utf8"); } catch { /* no ssh config */ }
  for (const b of parseSshConfig(sshText)) {
    const name = b.names[0].toLowerCase();
    hosts.set(name, { name, aliases: b.names.map((n) => n.toLowerCase()), target: b.names[0], os: "linux", local: false, via: `ssh ${b.names[0]}${b.hostName ? ` (${b.user ? `${b.user}@` : ""}${b.hostName})` : ""}` });
  }
  return hosts;
}

/** The names in the hub machine's SSH config, for the Machines screen to offer (nothing is read from them until added). */
export function sshConfigNames(cfg: Pick<Config, "sshConfigPath">): string[] {
  return [...sshHosts(cfg.sshConfigPath).values()].map((h) => h.target);
}

/** The machines file (`hosts.json`): `[{ name, ssh?, os?, local?, aliases? }]`, or null when there is none. */
export function readMachines(cfg: Pick<Config, "hostsFile">): HostFileEntry[] | null {
  let raw: string;
  try { raw = fs.readFileSync(cfg.hostsFile, "utf8"); } catch { return null; }
  try { const v = JSON.parse(raw) as unknown; return Array.isArray(v) ? (v as HostFileEntry[]).filter((e) => e && typeof e.name === "string" && e.name.trim()) : []; } catch { return []; }
}

export function writeMachines(cfg: Pick<Config, "hostsFile">, list: HostFileEntry[]): void {
  const tmp = `${cfg.hostsFile}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(list, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, cfg.hostsFile);
}

/**
 * Before 2026-11-06 every Host in the hub machine's ~/.ssh/config was a machine the assistant and the sensors used.
 * Now only machines the person adds are (hosts.json). This runs once per hub (`<data>/hosts-adopted` marks it done):
 * a hub that was already using them (Homelab or Sensors on, with the owner's data) gets its SSH config's hosts added
 * to hosts.json, next to any entries already there, so nothing it read before stops. A new hub adds none. Returns how
 * many were added.
 */
export function adoptSshHosts(cfg: Pick<Config, "sshConfigPath" | "hostsFile" | "dataDir">, inUse: boolean): number {
  const marker = path.join(cfg.dataDir, "hosts-adopted");
  if (fs.existsSync(marker)) return 0;
  let added = 0;
  if (inUse) {
    const have = readMachines(cfg) ?? [];
    const known = new Set(have.flatMap((e) => [e.name, e.ssh ?? "", ...(e.aliases ?? [])].map((n) => n.toLowerCase())));
    const add: HostFileEntry[] = [...sshHosts(cfg.sshConfigPath).values()]
      .filter((h) => !h.aliases.some((a) => known.has(a)))
      .map((h) => ({ name: h.name, ssh: h.target, ...(h.aliases.length > 1 ? { aliases: h.aliases.filter((a) => a !== h.name) } : {}) }));
    if (add.length) { writeMachines(cfg, [...have, ...add]); added = add.length; }
  }
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.writeFileSync(marker, `${new Date().toISOString()} ${inUse ? `added ${added} from the SSH config` : "nothing added (a new hub, or Homelab and Sensors off)"}\n`, { mode: 0o600 });
  return added;
}

/**
 * The machines the assistant may run commands on and the sensors read: the ones in hosts.json, with connection details
 * from the SSH config where an entry names one of its hosts, plus the hub's own machine. A Host in the SSH config that
 * is not in hosts.json is never contacted (a work server or `Host github.com` stays out).
 */
export function loadHosts(cfg: Pick<Config, "sshConfigPath" | "hostsFile">): Host[] {
  const hosts = new Map<string, Host>();
  const ssh = sshHosts(cfg.sshConfigPath);
  for (const e of readMachines(cfg) ?? []) {
    const name = e.name.trim().toLowerCase();
    const prev = ssh.get(name) ?? [...ssh.values()].find((h) => h.aliases.includes(name)) ?? (e.ssh ? ssh.get(e.ssh.toLowerCase()) : undefined);
    const local = e.local === true;
    const target = e.ssh ?? prev?.target ?? e.name;
    const h: Host = {
      name, aliases: [...new Set([name, ...(prev?.aliases ?? []), ...(e.aliases ?? []).map((a) => a.toLowerCase())])],
      target, os: e.os ?? prev?.os ?? "linux", local,
      via: local ? "runs on the hub itself" : `ssh ${target}`,
    };
    if (prev && prev.name !== name) hosts.delete(prev.name);
    hosts.set(name, h);
  }
  // The machine the hub runs on is always reachable without ssh.
  const self = os.hostname().toLowerCase().split(".")[0];
  const existing = hosts.get(self) ?? [...hosts.values()].find((h) => h.aliases.includes(self));
  if (existing) { existing.local = true; existing.via = "runs on the hub itself"; }
  else hosts.set(self, { name: self, aliases: [self], target: self, os: process.platform === "darwin" ? "macos" : "linux", local: true, via: "runs on the hub itself" });
  return [...hosts.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function findHost(hosts: Host[], name: string): Host | null {
  const n = name.trim().toLowerCase().replace(/\.local$/, "");
  return hosts.find((h) => h.name === n || h.aliases.includes(n) || h.aliases.includes(`${n}.local`)) ?? null;
}

// ---------- read-only classification ----------

// Commands that only read. Left out on purpose: printenv (shows secrets in the environment), nc (opens connections),
// and anything that runs other programs (env, xargs, sudo, bash, timeout, watch).
const READ_CMDS = new Set([
  "ls", "cat", "head", "tail", "grep", "egrep", "fgrep", "rg", "wc", "sort", "uniq", "cut", "tr", "awk", "column", "jq", "yq", "diff", "cmp", "tree",
  "stat", "file", "du", "df", "free", "uptime", "uname", "hostname", "whoami", "id", "who", "w", "last", "ps", "pgrep", "lsblk", "blkid", "findmnt",
  "lscpu", "lsusb", "lspci", "lsmod", "dmesg", "sensors", "vmstat", "iostat", "mpstat", "ss", "netstat", "ping", "traceroute", "tracepath", "dig",
  "nslookup", "host", "whois", "arp", "date", "echo", "which", "type", "realpath", "readlink", "basename", "dirname", "md5sum",
  "sha256sum", "sha1sum", "cksum", "getent", "nproc", "locale", "lsof", "nvidia-smi", "sw_vers", "system_profiler", "vm_stat", "top", "mount",
  "timedatectl", "hostnamectl", "ip", "systemctl", "journalctl", "docker", "git", "apt", "apt-cache", "dpkg", "snap", "zpool", "zfs", "tailscale",
  "ollama", "ufw", "smartctl", "find", "sed", "curl", "wget", "openssl", "node", "python3", "python", "pip", "pip3", "npm", "brew", "launchctl",
  "diskutil", "kubectl", "true", "test", "cd", "pwd", "less", "more", "strings", "xxd", "hexdump", "od", "mtr", "iwconfig", "nmcli",
  "resolvectl", "virsh", "pvs", "vgs", "lvs", "mdadm", "hdparm", "fdisk", "parted", "sgdisk", "lshw", "dmidecode", "upower", "acpi",
]);

/** Subcommands that keep a command read-only, for tools that can also change things. */
const READ_SUB: Record<string, RegExp> = {
  systemctl: /^(status|is-active|is-enabled|is-failed|list-units|list-unit-files|list-timers|list-sockets|show|cat|--version|get-default)$/,
  docker: /^(ps|logs|inspect|images|image|stats|version|info|top|port|events|compose|network|volume|system|container)$/,
  git: /^(status|log|diff|show|branch|remote|rev-parse|describe|ls-files|blame|shortlog|tag|config|--version)$/,
  apt: /^(list|show|policy|search|--version)$/,
  "apt-cache": /^(show|policy|search|depends|rdepends|showpkg)$/,
  snap: /^(list|info|version|services|changes)$/,
  zpool: /^(status|list|iostat|get|history|events)$/,
  zfs: /^(list|get)$/,
  tailscale: /^(status|ip|ping|netcheck|version|whois|dns)$/,
  ollama: /^(list|ls|ps|show|--version|-v)$/,
  ufw: /^(status)$/,
  ip: /^(-[a-z0-9]+|addr|address|a|route|r|link|l|neigh|n|rule|maddr|monitor)$/,
  npm: /^(ls|list|view|outdated|-v|--version|config)$/,
  pip: /^(list|show|freeze|--version)$/, pip3: /^(list|show|freeze|--version)$/,
  brew: /^(list|info|outdated|--version|config|doctor|services)$/,
  launchctl: /^(list|print|blame)$/,
  diskutil: /^(list|info|apfs|activity)$/,
  kubectl: /^(get|describe|logs|top|version|cluster-info|api-resources)$/,
  virsh: /^(list|dominfo|domifaddr|domstate|net-list|net-dhcp-leases|pool-list|vol-list|dumpxml|nodeinfo|version|capabilities)$/,
  timedatectl: /^(status|show|list-timezones)?$/,
  hostnamectl: /^(status)?$/,
  nmcli: /^(-t|-f|device|dev|d|connection|con|c|general|g|radio)$/,
  resolvectl: /^(status|query|dns|domain|statistics)$/,
  mdadm: /^(--detail|-D|--examine|-E|--query|-Q)$/,
  fdisk: /^(-l|--list)$/, parted: /^(-l|--list)$/, sgdisk: /^(-p|--print)$/, hdparm: /^(-I|-i)$/,
  node: /^(-v|--version)$/, python3: /^(--version|-V)$/, python: /^(--version|-V)$/,
  openssl: /^(s_client|x509|version|req|verify|crl|ciphers)$/,
  dpkg: /^(-l|--list|-L|--listfiles|-s|--status|-S|--search|-p|--print-avail|--get-selections|--print-architecture|--print-foreign-architectures|-c|--contents|-I|--info|--version|--audit|-C|--verify|-V|-W|--show)$/,
};

/**
 * Disk and package tools that act on every option given, in order (sgdisk -p -Z prints, then wipes): each argument
 * must be one of their reading options or a device. A word that is neither waits for approval.
 */
const STRICT_ARGS: Record<string, { flags: RegExp; other: RegExp }> = {
  sgdisk: { flags: /^(-p|--print)$/, other: /^\/dev\/[\w/.-]+$/ },
  hdparm: { flags: /^(-I|-i)$/, other: /^\/dev\/[\w/.-]+$/ },
  parted: { flags: /^(-l|--list|-m|--machine)$/, other: /^\/dev\/[\w/.-]+$/ },
  fdisk: { flags: /^(-l|--list|-x|--list-details)$/, other: /^\/dev\/[\w/.-]+$/ },
  mdadm: { flags: /^(--detail|-D|--examine|-E|--query|-Q|--scan|-s|--brief|-b|--verbose|-v|--export|-Y)$/, other: /^\/dev\/[\w/.-]+$/ },
  dpkg: { flags: /^(-l|--list|-L|--listfiles|-s|--status|-S|--search|-p|--print-avail|--get-selections|--print-architecture|--print-foreign-architectures|-c|--contents|-I|--info|--version|--audit|-C|--verify|-V|-W|--show|--no-pager)$/, other: /^[^-]/ },
};

/** docker's command groups: the second word that keeps each one read-only (docker compose exec would run anything). */
const DOCKER_READ2: Record<string, RegExp> = {
  compose: /^(ps|logs|config|ls|images|top|version|port)$/,
  network: /^(ls|inspect)$/, volume: /^(ls|inspect)$/, system: /^(df|info|events)$/,
  image: /^(ls|inspect|history)$/, container: /^(ls|ps|inspect|logs|top|port|stats)$/,
};
/** Flags of docker compose that take a value, so the value is not read as the subcommand. */
const DOCKER_VALUE_FLAGS = /^(-f|--file|-p|--project-name|--env-file|--profile|--project-directory|--ansi|--progress)$/;

/** Per-command flags that turn an otherwise read-only command into a change. Tested against " <args joined by spaces>". */
const WRITE_FLAGS: Record<string, RegExp> = {
  find: /\s-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)(\s|$)/,
  curl: /\s(-X|--request|-d|--data[a-z-]*|-F|--form[a-z-]*|-T|--upload-file|-o|-O|--output|--remote-name[a-z-]*|-c|--cookie-jar|-K|--config|-x|--proxy|--preproxy|--resolve|--connect-to|--doh-url|--dns-servers|-D|--dump-header|--trace[a-z-]*|--libcurl|--stderr|--etag-save|--hsts|--alt-svc|--json|-Q|--quote|--output-dir|--create-dirs)(\s|=|$)/,
  wget: /^(?!.*(\s-O\s*-|\s--spider|\s-qO-|\s-qO\s*-))|\s(-e|--execute|--post-data|--post-file|--body-data|--body-file|--method|-i|--input-file|--config|-o|--output-file|-a|--append-output|--save-cookies|--save-headers|-x|--force-directories|-P|--directory-prefix)(\s|=|$)/,
  top: /^(?!.*\s-b)/, journalctl: /--(vacuum|rotate|flush|sync|relinquish|setup-keys|update-catalog|cursor-file)/,
  // less writes its input to a log file (-o, -O, --log-file) and runs an initial command given as +cmd (+!sh).
  less: /\s(\+|-[a-zA-Z]*[oOk]|--(log-file|LOG-FILE|lesskey))/, file: /\s(-[a-zA-Z]*C|--compile)(\s|$)/,
  lshw: /\s-dump(\s|$)/, dmidecode: /\s--dump-bin(\s|=|$)/, kubectl: /--output-directory/,
  // ripgrep runs a program for every file (--pre rm would delete them) or to name the host.
  rg: /\s--(pre|hostname-bin)(\s|=|$)/,
  ping: /\s-[a-zA-Z]*p/, whois: /\s(-[a-zA-Z]*h|--host)(\s|=|$)/,
  npm: /\sconfig\s+(set|delete|edit|fix)\b|--registry/, pip: /\s(-i|--index-url|--extra-index-url|-f|--find-links|--proxy|--trusted-host)(\s|=|$)/,
  pip3: /\s(-i|--index-url|--extra-index-url|-f|--find-links|--proxy|--trusted-host)(\s|=|$)/,
  git: /\s(branch|tag)\s+[^-\s]|\s(branch\s+-[dDmMcCfu]|tag\s+-[dfas])(\s|$)|\sremote\s+(add|remove|rm|set-url|set-head|set-branches|rename|prune|update)|--output(=|\s)|\s-o\s|--ext-diff/,
  ip: /\b(add|del|delete|set|flush|change|replace|append|prepend|restore|save)\b|\s-(b|ba|bat|batc|batch|fo|for|forc|force)(\s|$)/, mount: /\S/, nc: /\S/,
  tailscale: /\b(up|down|set|logout|login|serve|funnel|cert|file|drive|switch|update)\b/,
  zpool: /\bevents\s+-c\b/, openssl: /\s-(out|keyout|outform\s+\S+\s+-out|sess_out|keylogfile|msgfile|writerand|new|newkey|CAcreateserial|CAserial|proxy)(\s|$)/,
  sort: /\s(-o|--output|--compress-program)(\s|=|$)|\s-[a-zA-Z]*o/, tree: /\s-o/, yq: /\s(-i|--inplace)(\s|$)/,
  date: /\s(-s|--set)(\s|=|$)/, hostname: /\s[^-\s]/, arp: /\s(-d|-s|-f|--delete|--set|--file)(\s|$)/,
  smartctl: /\s(-t|--test|-s|--smart|-o|--offlineauto|-S|--saveauto|-X|--abort)(\s|=|$)/,
  dmesg: /\s(-c|-C|--clear|--read-clear|-n|--console-level|-D|--console-off|-E|--console-on)(\s|=|$)/,
  sensors: /\s-s(\s|$)/, ss: /\s(-K|--kill)(\s|$)/,
  "nvidia-smi": /\s(-pm|-pl|-ac|-rac|-acp|-c|-e|-r|-lgc|-rgc|-lmc|-rmc|-am|-caa|--persistence-mode|--power-limit|--applications-clocks|--reset-applications-clocks|--compute-mode|--ecc-config|--gpu-reset|--lock-gpu-clocks|--reset-gpu-clocks|--lock-memory-clocks|--reset-memory-clocks)(\s|=|$)/,
  brew: /\sservices\s+(start|stop|restart|run|kill|cleanup)\b/,
  nmcli: /\b(up|down|delete|add|modify|connect|disconnect|reload|set|on|off|import|export|clone)\b/,
  resolvectl: /\s(dns|domain)\s+\S+\s+\S+|\s(flush-caches|reset-statistics|reset-server-features|revert|llmnr|mdns|dnssec|dnsovertls|default-route)\b/,
  diskutil: /\sapfs\s+(?!list(\s|$))/, iwconfig: /\s\S+\s+\S+/,
  // awk runs programs: system(), a pipe (one |; || is "or"), getline from commands and print > file are all changes.
  awk: /system|getline|(?<!\|)\|(?!\|)|\bclose\s*\(|fflush|ENVIRON|\bprintf?\b[^;}]*>|\s(-f|--file|-i|--include|-l|--load|-E|--exec)(\s|=|$)/,
};

/** Commands whose second positional argument is a file they write (uniq in out, xxd in out). */
const WRITES_SECOND_ARG = new Set(["uniq", "xxd"]);

/** Environment prefixes a read may carry; any other (GIT_EXTERNAL_DIFF=..., LD_PRELOAD=...) can run code. */
const SAFE_ENV = /^(LC_[A-Z]+|LANG|LANGUAGE|TZ|COLUMNS|LINES|NO_COLOR|TERM)=/;

/**
 * Files and folders that hold secrets: reading them always waits for approval. The hub's own data folder and key
 * folder are added at start (`addSensitivePath`). Output of every command is also stripped of the hub's secret
 * values (HostActions.hiddenValues), for a read this list misses.
 */
const SENSITIVE = /connections\.json|hub\.env|(^|[\s/'"=])\.env\b|work\.key|passwords\.kdbx|\bai\.json|\.ssh(\/|\b)|\bid_(rsa|dsa|ecdsa|ed25519)|\.netrc|\.pgpass|\.aws\/|\.kube\/config|\/etc\/(shadow|gshadow|sudoers)|\b(shadow|gshadow)\b|\.gnupg|\.config\/everythingapp|\.local\/share\/everythingapp|\/environ\b|keychain|\bsecrets?\b|\btokens?\b|credentials|lpass|lastpass|1password|bitwarden|vaultwarden|\.kdbx\b/i;
const sensitivePaths = new Set<string>();
export function addSensitivePath(p: string): void { if (p && p.length > 3) sensitivePaths.add(p.replace(/\/+$/, "")); }
function touchesSecrets(c: string): boolean {
  if (SENSITIVE.test(c)) return true;
  for (const p of sensitivePaths) if (c.includes(p)) return true;
  return false;
}

/**
 * Each word of a command as the shell will see it: quotes and backslashes taken out (`.s''sh` and `.s\sh` are
 * `.ssh`), and whether it has a wildcard the shell expands (`*`, `?`, `[`, `{a,b}` outside quotes).
 */
export function shellWords(c: string): { text: string; glob: boolean }[] {
  const out: { text: string; glob: boolean }[] = [];
  let cur = "", glob = false, started = false;
  let quote: "'" | '"' | null = null;
  const end = () => { if (started) out.push({ text: cur, glob }); cur = ""; glob = false; started = false; };
  for (let i = 0; i < c.length; i++) {
    const ch = c[i];
    if (quote === "'") { if (ch === "'") quote = null; else cur += ch; continue; }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "\\" && i + 1 < c.length && '"\\$`'.includes(c[i + 1])) cur += c[++i];
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; started = true; continue; }
    if (ch === "\\") { cur += c[++i] ?? ""; started = true; continue; }
    if (/\s/.test(ch) || ch === ";" || ch === "|" || ch === "&") { end(); continue; }
    if ("*?[{".includes(ch)) glob = true;
    cur += ch; started = true;
  }
  end();
  return out;
}

/** Files and folders that hold secrets, as a wildcard could reach them (`~` is any home). */
const SECRET_FILES = [
  "~/.ssh/id_rsa", "~/.ssh/id_ed25519", "~/.ssh/id_ecdsa", "~/.ssh/id_dsa", "~/.ssh/authorized_keys", "~/.ssh/known_hosts", "~/.ssh/config",
  "~/.config/everythingapp/hub.env", "~/.config/everythingapp/work.key", "~/.config/everythingapp/secrets.key", "~/.config/everythingapp/backup.key", "~/.local/share/everythingapp/connections.json",
  "~/.local/share/everythingapp/hub.sqlite", "~/.local/share/everythingapp/chats.sqlite", "~/.local/share/everythingapp/ai.json",
  "~/.local/share/everythingapp/passwords.kdbx", "~/.netrc", "~/.pgpass", "~/.aws/credentials", "~/.kube/config", "~/.gnupg/private-keys-v1.d",
  "~/.lpass/session", "~/.local/share/lpass/session", "/etc/shadow", "/etc/gshadow", "/etc/sudoers", "/proc/1/environ", "/proc/self/environ", "~/.env",
];

/** A wildcard word that could name a secret file or a folder holding one (`~/.ss?/id_*`, `~/.config/everything*`). */
function globReachesSecret(raw: string): boolean {
  // Any home is ~: $HOME, ${HOME}, /home/<user> (or /home/*), /Users/<user>, /root.
  const word = raw.replace(/^(\$HOME|\$\{HOME\}|\/home\/[^/]+|\/Users\/[^/]+|\/root)(?=\/|$)/, "~");
  let re = "";
  for (let i = 0; i < word.length; i++) {
    const ch = word[i];
    if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else if (ch === "[") { const j = word.indexOf("]", i + 1); if (j > i) { re += `[${word.slice(i + 1, j).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`; i = j; } else re += "\\["; }
    else if (ch === "{") { const j = word.indexOf("}", i + 1); if (j > i) { re += `(${word.slice(i + 1, j).split(",").map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`; i = j; } else re += "\\{"; }
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  let rx: RegExp;
  try { rx = new RegExp(`^${re}/?$`); } catch { return true; }
  const candidates = new Set<string>();
  for (const f of [...SECRET_FILES, ...[...sensitivePaths].map((p) => `${p}/x`)]) {
    const parts = f.split("/");
    for (let n = 2; n <= parts.length; n++) {
      const p = parts.slice(0, n).join("/");
      candidates.add(p);
      // A word with no leading slash may be relative to the home folder.
      if (p.startsWith("~/")) candidates.add(p.slice(2));
    }
  }
  for (const cand of candidates) if (rx.test(cand)) return true;
  return false;
}

// Trace-Command -Command runs any command, and Find-/Search- cmdlets fetch from any feed given (-Source http://...).
const PS_READ_VERBS = /^(get|test|resolve|measure|select|where|sort|format|out-string|out-host|convertto|convertfrom|compare|group|show|read)-/i;
const WIN_READ_CMDS = new Set(["ipconfig", "hostname", "whoami", "systeminfo", "tasklist", "netstat", "ping", "nslookup", "tracert", "pathping", "dir", "type", "where", "nvidia-smi", "driverquery", "ver", "echo", "findstr", "more", "sort", "arp", "route", "getmac", "query", "qwinsta", "quser", "gpresult", "w32tm", "wsl", "sc", "netsh", "fsutil", "wmic", "chkdsk", "powercfg"]);
const WIN_READ_SUB: Record<string, RegExp> = { route: /^print$/i, sc: /^(query|queryex|qc|qdescription)$/i, netsh: /^(interface|int|wlan|advfirewall|http|winhttp)$/i, wsl: /^(-l|--list|--status|--version|-v)$/i, w32tm: /^\/(query|tz|stripchart)$/i, fsutil: /^(fsinfo|volume|8dot3name)$/i, wmic: /\S/, chkdsk: /^[a-z]:$/i, powercfg: /^(\/l|\/list|\/q|\/query|\/a|\/availablesleepstates|\/getactivescheme|\/batteryreport)$/i };
const WIN_WRITE: RegExp = /\b(set|add|delete|remove|stop|start|restart|reset|config|create|new|install|uninstall|enable|disable|\/f|\/delete|call|export|import|dump|repair)\b|\s\/(o|out|output)\b/i;
/** Windows commands where every argument must be one of these (ipconfig /release, chkdsk /r and arp -d change things). */
const WIN_STRICT: Record<string, RegExp> = {
  ipconfig: /^\/(all|displaydns|allcompartments)$/i,
  chkdsk: /^([a-z]:|\/i|\/c)$/i,
  wsl: /^(-l|--list|-v|--verbose|--status|--version|-q|--quiet|--running|--all|--online|-o)$/i,
  arp: /^(-a|-g|-v|-N|[0-9a-f.:]+)$/i,
};
/** fsutil: the second word that keeps each group reading (fsutil volume dismount does not). */
const WIN_FSUTIL2: Record<string, RegExp> = {
  fsinfo: /^(drives|drivetype|ntfsinfo|refsinfo|sectorinfo|statistics|volumeinfo)$/i,
  volume: /^(diskfree|list|querycluster|allocationreport|filelayout)$/i,
  "8dot3name": /^(query|scan)$/i,
};

/**
 * Split a command line on unquoted |, ||, &&, ; and newlines. `redirect` is true when an unquoted > writes
 * somewhere other than /dev/null or another stream, and `unsafe` when there is a lone & (it starts a background
 * command, so `true & anything` would run anything) or a quote is left open. Quoted text stays inside its segment.
 */
export function lex(cmd: string): { segments: string[]; redirect: boolean; unsafe: boolean } {
  const segments: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  let redirect = false;
  let unsafe = false;
  // Where an output redirect goes: only /dev/null, $null and another stream (2>&1, >&2) keep a command read-only.
  const harmless = (target: string) => /^(\/dev\/null\b|\$null\b|&\s*[0-9-](?![\w./]))/i.test(target);
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) { cur += ch; if (ch === quote) quote = null; else if (ch === "\\" && quote === '"') cur += cmd[++i] ?? ""; continue; }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
    if (ch === "\\") { cur += ch + (cmd[++i] ?? ""); continue; }
    if (ch === "&" && cmd[i + 1] === "&") { i++; segments.push(cur); cur = ""; continue; }
    if (ch === "&") {
      // &> and &>> send both streams to a file.
      if (cmd[i + 1] === ">") {
        const target = cmd.slice(i + 2).replace(/^>/, "").trimStart();
        if (!harmless(target)) redirect = true;
        cur += ch; continue;
      }
      // The & of >&2 belongs to the redirect before it.
      if (cur.endsWith(">")) { cur += ch; continue; }
      unsafe = true; cur += ch; continue;
    }
    if (ch === "|" || ch === ";" || ch === "\n") {
      if (ch === "|" && cmd[i + 1] === "|") i++;
      // >| forces a write.
      if (ch === "|" && cur.endsWith(">")) { redirect = true; cur += ch; continue; }
      segments.push(cur); cur = ""; continue;
    }
    if (ch === ">") {
      const rest = cmd.slice(i + 1).replace(/^>/, "").trimStart();
      const prev = cur.slice(-1);
      // "a -> b" in an argument and "x=>y" are not redirects.
      if (!(harmless(rest) || prev === "-" || prev === "=")) redirect = true;
    }
    // <> opens a file for writing too.
    if (ch === "<" && cmd[i + 1] === ">") redirect = true;
    cur += ch;
  }
  segments.push(cur);
  return { segments: segments.map((x) => x.trim()).filter(Boolean), redirect: redirect || quote !== null, unsafe: unsafe || quote !== null };
}

/** Words of one segment with quotes removed (good enough to read the command name and its flags). */
function words(seg: string): string[] {
  return (seg.match(/'[^']*'|"(?:\\.|[^"\\])*"|\S+/g) ?? []).map((w) => w.replace(/^(['"])([\s\S]*)\1$/, "$2"));
}

/** The owner's tailnet names (tailXXXX.ts.net), learned from Tailscale at start or set in EA_TAILNET. */
const ownTailnets = new Set<string>();
export function addOwnTailnet(name: string): void {
  const t = name.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  if (/^[a-z0-9-]+\.ts\.net$/.test(t)) ownTailnets.add(t);
}

/** Private, tailnet and local names: places a read may fetch from without asking (nothing leaves the network). */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!h) return false;
  if (h === "localhost" || /\.(localhost|local|lan|home|home\.arpa|internal|intranet)$/.test(h)) return true;
  // Only the owner's own tailnet: a name in someone else's (a Funnel address) is on the internet.
  if (h.endsWith(".ts.net")) return [...ownTailnets].some((t) => h.endsWith(`.${t}`));
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
  }
  if (h.includes(":")) return h === "::1" || /^(fc|fd|fe8|fe9|fea|feb)/.test(h);
  // A bare name (server, nas01) is a machine on this network.
  return !h.includes(".") && /^[a-z0-9-]+$/.test(h);
}

/** Flags of curl and wget that take a value, so the value is not taken for an address. */
const URL_VALUE_FLAGS = /^(-H|--header|-A|--user-agent|-u|--user|-m|--max-time|--connect-timeout|-w|--write-out|-e|--referer|-b|--cookie|-r|--range|--retry|--retry-delay|--retry-max-time|--cacert|--capath|--cert|--key|-E|-y|-Y|--speed-time|--speed-limit|--limit-rate|--keepalive-time|--max-redirs|--interface|-t|--tries|-T|--timeout|--wait|--user|--password|--header|-U)$/;

/** curl and wget only read when every address they are given is private (a fetch elsewhere could carry data out). */
function fetchesOnlyPrivate(ws: string[]): boolean {
  const urls = ws.slice(1).filter((w, i, a) => !w.startsWith("-") && !(i > 0 && URL_VALUE_FLAGS.test(a[i - 1])));
  if (!urls.length) return true;
  return urls.every((u) => {
    try { return isPrivateHost(new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(u) ? u : `http://${u}`).hostname); } catch { return false; }
  });
}

/** sed only reads without -i, script files, and the w, W and e commands (e runs a shell command). */
function sedReads(ws: string[]): boolean {
  const args = ws.slice(1);
  if (args.some((w) => /^-[a-zA-Z]*i/.test(w) || /^--(in-place|file|expression=.*[wWe])/.test(w) || w === "-f" || /^-[a-zA-Z]*f$/.test(w))) return false;
  const scripts: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-e" || args[i] === "--expression") scripts.push(args[++i] ?? "");
    else if (args[i].startsWith("--expression=")) scripts.push(args[i].slice(13));
  }
  if (!scripts.length) { const first = args.find((w) => !w.startsWith("-")); if (first !== undefined) scripts.push(first); }
  return scripts.every((sc) => {
    // s and y commands: their flags may hold e or w (s/a/b/e runs the result, s/a/b/w f writes).
    let flagsBad = false;
    const rest = sc.replace(/([sy])(.)((?:\\.|(?!\2).)*)\2((?:\\.|(?!\2).)*)\2([a-zA-Z0-9]*)/g, (_m, cmd: string, _d, _a, _b, flags: string) => {
      if (cmd === "s" && /[ewW]/.test(flags)) flagsBad = true;
      return ";";
    }).replace(/\/(?:\\.|[^/\\])*\//g, " ");
    return !flagsBad && !/[wWe]/.test(rest);
  });
}

/** Public DNS resolvers a lookup may ask by name (dig @1.1.1.1): asking any other outside server hands it the query. */
const PUBLIC_RESOLVERS = new Set(["1.1.1.1", "1.0.0.1", "8.8.8.8", "8.8.4.4", "9.9.9.9", "149.112.112.112", "208.67.222.222", "208.67.220.220"]);

/** The letters of a short option cluster (-sSo of curl), without a value attached after them. */
function shortCluster(w: string): string | null {
  if (!/^-[a-zA-Z]/.test(w)) return null;
  return /^-([a-zA-Z]+)/.exec(w)![1];
}

/** git config only reads with --get/--list (or get/list), or with one name and no value; anything else sets. */
function gitConfigReads(ws: string[]): boolean {
  const at = ws.indexOf("config");
  const args = ws.slice(at + 1);
  if (args.some((w) => /^--(add|unset|unset-all|replace-all|rename-section|remove-section|edit)$/.test(w) || w === "-e")) return false;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    if (/^(-f|--file|--blob|--type|--default|--comment|--value)$/.test(w)) { i++; continue; }
    if (!w.startsWith("-")) positional.push(w);
  }
  if (positional[0] === "get" || positional[0] === "list") return true;
  if (/^(set|unset|rename-section|remove-section|edit)$/.test(positional[0] ?? "")) return false;
  if (args.some((w) => /^(--get|--get-all|--get-regexp|--get-urlmatch|--get-color|--get-colorbool|-l|--list)$/.test(w))) return positional.length <= 3;
  return positional.length <= 1;
}

/** curl and wget fetch only over http(s) (gopher:// or dict:// to a server on the network can send it commands). */
function webSchemeOnly(ws: string[]): boolean {
  return ws.slice(1).every((w) => w.startsWith("-") || !/^[a-z][a-z0-9+.-]*:\/\//i.test(w) || /^https?:\/\//i.test(w));
}

/** curl short options that write files, send data or change where it connects (-sSo out, -o/tmp/x, -LO, -dX). */
function curlShortWrites(ws: string[]): boolean {
  return ws.slice(1).some((w) => { const k = shortCluster(w); return k !== null && /[oOdFTKxXcDQ]/.test(k); });
}

/**
 * wget reads only when it prints to standard output (-O -, -qO-) or only checks (--spider), and every option is one
 * of a few known reading ones: a log file, a background run, -e commands or an input list all change something.
 */
function wgetReads(ws: string[]): boolean {
  const args = ws.slice(1);
  let toStdout = false;
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    if (w === "--spider") { toStdout = true; continue; }
    if (w.startsWith("--")) {
      if (/^--output-document(=-)?$/.test(w)) { if (w === "--output-document" ? args[++i] === "-" : true) { toStdout = true; continue; } return false; }
      if (/^--(quiet|no-verbose|verbose|server-response|no-check-certificate|https-only|no-cache|inet4-only|inet6-only|content-on-error)$/.test(w)) continue;
      if (/^--(timeout|tries|user-agent|header|max-redirect|dns-timeout|connect-timeout|read-timeout|wait)=/.test(w)) continue;
      if (/^--(timeout|tries|user-agent|header|max-redirect|dns-timeout|connect-timeout|read-timeout|wait)$/.test(w)) { i++; continue; }
      return false;
    }
    const k = shortCluster(w);
    if (k === null) continue;
    // Letters that take a value end the cluster: O (only "-" is allowed), T/t/U/w (the rest of the word or the next word).
    const m = /^([qnvS46]*)([OTtUw]?)(.*)$/.exec(w.slice(1))!;
    if (m[1].length + m[2].length === 0) return false;
    if (!m[2]) { if (m[3]) return false; continue; }
    const value = m[3] || args[++i] || "";
    if (m[2] === "O") { if (value !== "-") return false; toStdout = true; }
  }
  return toStdout;
}

/** Every server a lookup or openssl connects to is on the network, or a lookup goes to a known public resolver. */
function serversPrivate(w0: string, ws: string[]): boolean {
  const args = ws.slice(1);
  const ok = (h: string) => isPrivateHost(h) || PUBLIC_RESOLVERS.has(h);
  if (w0 === "dig") return args.filter((w) => w.startsWith("@")).every((w) => ok(w.slice(1)));
  if (w0 === "nslookup" || w0 === "host") {
    const pos = args.filter((w, i) => !w.startsWith("-") && !(i > 0 && /^-[tWRcN]$/.test(args[i - 1])));
    return pos.length < 2 || ok(pos[1]);
  }
  if (w0 === "openssl" && args[0] === "s_client") {
    const hosts: string[] = [];
    for (let i = 1; i < args.length; i++) {
      if (args[i] === "-connect") hosts.push(args[++i] ?? "");
      else if (!args[i].startsWith("-") && !(i > 1 && /^-(servername|CAfile|cert|key|CApath|verify|starttls|port|host|psk|psk_identity|alpn|sess_in|cipher|ciphersuites|groups|curves|sigalgs|name)$/.test(args[i - 1]))) hosts.push(args[i]);
    }
    return hosts.every((h) => { const host = h.replace(/^\[([^\]]+)\].*$/, "$1").replace(/:\d+$/, ""); return isPrivateHost(host); });
  }
  return true;
}

/** A script block that only compares properties of $_ with plain values, joined by -and / -or. */
const PS_VALUE = String.raw`(?:'[^']*'|"[^"$\x60]*"|\$(?:true|false|null)|-?[\w.:*]+)`;
const PS_TEST = String.raw`(?:-not\s+)?\$_(?:\.\w+)*(?:\s+-(?:eq|ne|gt|ge|lt|le|like|notlike|match|notmatch|contains|notcontains|in|notin|ceq|cne|ilike|clike)\s+${PS_VALUE})?`;
const PS_FILTER_BLOCK = new RegExp(String.raw`\{\s*${PS_TEST}(?:\s+-(?:and|or)\s+${PS_TEST})*\s*\}`, "gi");

/** Characters outside quotes: PowerShell runs ( ) and { } as code even inside the arguments of a reading cmdlet. */
function unquoted(c: string): string {
  let out = "";
  let quote: string | null = null;
  for (const ch of c) {
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    out += ch;
  }
  return out;
}

/** UNC paths (\\server\share, //server/share) to a server outside the network send it Windows sign-in hashes. */
function uncLeavesNetwork(c: string): boolean {
  for (const m of c.matchAll(/(?:\\\\|\/\/)([^\\/\s'"]+)/g)) {
    const host = m[1].replace(/@.*$/, "");
    if (!isPrivateHost(host)) return true;
  }
  return false;
}

/** True when every part of the command only reads. Anything unknown counts as a change. */
export function isReadOnly(command: string, hostOs: HostOs): boolean {
  const c = command.trim();
  if (!c || c.length > 2000) return false;
  // Command substitution runs code even inside double quotes.
  if (/[`]|\$\(|<\(|>\(/.test(c)) return false;
  // Expansions that run code from a variable's value: ${x@P} (prompt expansion), ${a[x]} and $[x] (arithmetic
  // evaluates a[$(cmd)] held in x) and ${!x}. Only $NAME, ${NAME} and ${#NAME} are kept.
  if (/\$\[/.test(c) || /\$\{(?!#?[A-Za-z_][A-Za-z0-9_]*\})/.test(c)) return false;
  // bash opens a network connection for /dev/tcp/host/port and /dev/udp/host/port, to any host.
  if (/\/dev\/(tcp|udp)\//.test(c)) return false;
  // A command that uses a secret from the password manager always waits for approval (secrets.ts).
  if (/\{\{\s*secret:/i.test(c)) return false;
  if (touchesSecrets(c)) return false;
  // As the shell reads each word: quotes or backslashes splitting a name (.s''sh), or a wildcard that could reach a
  // secret file (cat ~/.ss?/id_ed2551?), wait for approval like the name written out.
  for (const w of shellWords(c)) {
    if (touchesSecrets(w.text)) return false;
    if (w.glob && globReachesSecret(w.text)) return false;
  }
  const { segments, redirect, unsafe } = lex(c);
  if (redirect || unsafe) return false;
  if (hostOs === "windows") {
    // Script blocks and ( ) run code inside any cmdlet's arguments (Where-Object { Remove-Item ... }, Get-Item (rm x)).
    // A plain filter ({ $_.Status -eq 'Running' -and $_.CPU -gt 10 }) only compares, so it is kept.
    if (/[(){}]/.test(unquoted(c.replace(PS_FILTER_BLOCK, " ")))) return false;
    if (uncLeavesNetwork(c)) return false;
    return segments.every((seg) => {
      const ws = words(seg.replace(/^&\s*/, ""));
      const w0 = (ws[0] ?? "").toLowerCase().replace(/\.exe$/, "");
      if (PS_READ_VERBS.test(w0)) return !/-(Path|FilePath|LiteralPath)\s+\S+\s+-Value|-OutFile|-Destination|-Repair/i.test(seg);
      if (!WIN_READ_CMDS.has(w0)) return false;
      const sub = WIN_READ_SUB[w0];
      if (sub && !(ws[1] && sub.test(ws[1]))) return false;
      const strict = WIN_STRICT[w0];
      if (strict && !ws.slice(1).every((w) => strict.test(w))) return false;
      if (w0 === "fsutil" && !(ws[2] && WIN_FSUTIL2[ws[1].toLowerCase()]?.test(ws[2]))) return false;
      if (w0 === "gpresult" && ws.slice(1).some((w) => /^\/(h|x)$/i.test(w))) return false;
      if (w0 === "nvidia-smi" && WRITE_FLAGS["nvidia-smi"].test(` ${ws.slice(1).join(" ")}`)) return false;
      return !WIN_WRITE.test(ws.slice(1).join(" ")) || w0 === "netstat" || w0 === "ping" || w0 === "query" || w0 === "quser";
    });
  }
  return segments.every((seg) => {
    let ws = words(seg);
    // VAR=value before a command: only harmless locale and display settings.
    while (ws.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(ws[0])) {
      if (!SAFE_ENV.test(ws[0])) return false;
      ws = ws.slice(1);
    }
    // git -C <dir> and --no-pager come before the subcommand.
    if (ws[0] === "git") ws = ws.filter((w, i) => w !== "--no-pager" && w !== "-C" && ws[i - 1] !== "-C");
    // Nothing but assignments: it changes the shell's own variables, which a later ${x@P} or $((x)) could run.
    if (!ws.length) return false;
    // A command named by path only counts when it is the system's own copy (./ls could be anything).
    if (ws[0].includes("/") && !/^\/(usr\/)?(local\/)?s?bin\/[^/]+$|^\/opt\/homebrew\/bin\/[^/]+$/.test(ws[0])) return false;
    const w0 = ws[0].replace(/^.*\//, "");
    if (!READ_CMDS.has(w0)) return false;
    const sub = READ_SUB[w0];
    if (sub) {
      const firstArg = ws.slice(1).find((w) => !(w0 === "systemctl" && /^--(user|no-pager|all|full|type=.*|state=.*|plain|no-legend)$/.test(w))) ?? "";
      if (!sub.test(firstArg)) return false;
      if (w0 === "docker" && DOCKER_READ2[firstArg]) {
        const after = ws.slice(ws.indexOf(firstArg) + 1);
        const second = after.find((w, i) => !w.startsWith("-") && !(i > 0 && DOCKER_VALUE_FLAGS.test(after[i - 1])));
        if (!second || !DOCKER_READ2[firstArg].test(second)) return false;
      }
    }
    const wf = WRITE_FLAGS[w0];
    if (wf && wf.test(` ${ws.slice(1).join(" ")}`)) return false;
    const strict = STRICT_ARGS[w0];
    if (strict && !ws.slice(1).every((w) => (w.startsWith("-") ? strict.flags : strict.other).test(w))) return false;
    if (WRITES_SECOND_ARG.has(w0) && ws.slice(1).filter((w) => !w.startsWith("-")).length >= 2) return false;
    if ((w0 === "curl" || w0 === "wget") && !(fetchesOnlyPrivate(ws) && webSchemeOnly(ws))) return false;
    if (w0 === "curl" && curlShortWrites(ws)) return false;
    if (w0 === "wget" && !wgetReads(ws)) return false;
    if (w0 === "git" && ws[1] === "config" && !gitConfigReads(ws)) return false;
    if (!serversPrivate(w0, ws)) return false;
    if (w0 === "sed" && !sedReads(ws)) return false;
    return true;
  });
}

// ---------- running ----------

export interface RunResult { exit_code: number | null; output: string; timed_out: boolean; ms: number }

const OUT_HEAD = 2000;
const OUT_TAIL = 6000;

export function capOutput(text: string): string {
  if (text.length <= OUT_HEAD + OUT_TAIL) return text;
  return `${text.slice(0, OUT_HEAD)}\n... [${text.length - OUT_HEAD - OUT_TAIL} characters cut] ...\n${text.slice(-OUT_TAIL)}`;
}

/** sudo would wait for a password nobody can type; make it fail at once instead. */
function nonInteractive(cmd: string): string { return cmd.replace(/\bsudo\s+(?!-n\b)/g, "sudo -n "); }

export function commandArgv(host: Host, command: string): { file: string; args: string[] } {
  const cmd = nonInteractive(command);
  if (host.local) return { file: "bash", args: ["-lc", cmd] };
  const ssh = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=3", "-o", "StrictHostKeyChecking=accept-new", "-o", "LogLevel=ERROR", host.target];
  if (host.os === "windows") {
    const encoded = Buffer.from(`$ProgressPreference='SilentlyContinue'; ${command}`, "utf16le").toString("base64");
    return { file: "ssh", args: [...ssh, `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`] };
  }
  return { file: "ssh", args: [...ssh, cmd] };
}

export type Runner = (host: Host, command: string, timeoutS: number) => Promise<RunResult>;

/**
 * The environment a command starts with: what a login shell and ssh need, never the hub's own settings (EA_TOKEN,
 * API keys and the rest of hub.env), so no command can print them.
 */
export function commandEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keep = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TERM", "TZ", "TMPDIR", "SSH_AUTH_SOCK", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"];
  const out: NodeJS.ProcessEnv = { LC_ALL: "C.UTF-8" };
  for (const k of keep) if (env[k] !== undefined) out[k] = env[k];
  return out;
}

/** Cut secret values out of command output, longest first. */
export function redactValues(text: string, values: string[]): string {
  let out = text;
  for (const v of [...values].sort((a, b) => b.length - a.length)) if (v.length >= 3) out = out.split(v).join("[secret]");
  return out;
}

export const spawnRunner: Runner = (host, command, timeoutS) => new Promise((resolve) => {
  const { file, args } = commandArgv(host, command);
  const t0 = Date.now();
  let out = "";
  let timedOut = false;
  const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"], env: commandEnv() });
  const take = (b: Buffer) => { out += b.toString("utf8"); if (out.length > 400_000) out = out.slice(0, OUT_HEAD) + out.slice(-OUT_TAIL * 4); };
  child.stdout.on("data", take);
  child.stderr.on("data", take);
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutS * 1000);
  child.on("error", (e) => { clearTimeout(timer); resolve({ exit_code: null, output: `could not start ${file}: ${e.message}`, timed_out: false, ms: Date.now() - t0 }); });
  child.on("close", (code) => { clearTimeout(timer); resolve({ exit_code: code, output: capOutput(out.replace(/\r\n/g, "\n")), timed_out: timedOut, ms: Date.now() - t0 }); });
});

// ---------- pending actions ----------

export interface ActionRow {
  id: string; session_id: string; host: string; command: string; purpose: string; rollback: string | null;
  kind: "read" | "change"; status: "pending" | "running" | "done" | "failed" | "cancelled" | "expired";
  created_at: string; ran_at: string | null; exit_code: number | null; output: string | null; journal_id: string | null;
}

export const ACTION_TTL_MS = 60 * 60 * 1000;
/** A short reply that approves the pending command. */
export const AFFIRMATION = /^\s*(y|yes|yep|yeah|yup|ok|okay|sure|do it|go ahead|go for it|run it|approve[d]?|confirm(ed)?|proceed|go|please do|send it|yes please|yes,? (run|do) it)[\s.!]*$/i;

export class HostActions {
  runner: Runner = spawnRunner;
  /** Puts `{{secret:Item}}` values into an approved command (secrets.ts); unset, such a command cannot run. */
  fillSecrets: ((command: string, host: Host) => Promise<{ command: string; values: string[] }>) | null = null;
  /** The hub's own secret values (its token, API keys, linked accounts' keys): cut out of every command's output. */
  hiddenValues: () => string[] = () => [];
  private cache: { at: number; hosts: Host[] } | null = null;

  constructor(private cfg: Config, private db: DB, private store: Store) {}

  hosts(): Host[] {
    if (!this.cache || Date.now() - this.cache.at > 60_000) this.cache = { at: Date.now(), hosts: loadHosts(this.cfg) };
    return this.cache.hosts;
  }

  host(name: string): Host | null { return findHost(this.hosts(), name); }

  /** The machines list changed (PUT /machines): read it again on the next use. */
  forget(): void { this.cache = null; }

  get(id: string): ActionRow | null {
    return (this.db.prepare("SELECT * FROM ai_actions WHERE id = ?").get(id) as ActionRow | undefined) ?? null;
  }

  /** Changes run for a session that finished without an error, oldest first. */
  /** Journal entries the hub wrote for commands it ran in a chat (the exact command, its outcome and rollback). */
  journalIds(sessionId: string): Set<string> {
    const rows = this.db.prepare("SELECT journal_id FROM ai_actions WHERE session_id = ? AND journal_id IS NOT NULL").all(sessionId) as { journal_id: string }[];
    return new Set(rows.map((r) => r.journal_id));
  }

  doneChanges(sessionId: string): ActionRow[] {
    return this.db.prepare("SELECT * FROM ai_actions WHERE session_id = ? AND kind = 'change' AND status = 'done' ORDER BY created_at").all(sessionId) as ActionRow[];
  }

  /** The newest pending change for a session that has not expired. */
  pendingFor(sessionId: string): ActionRow | null {
    const r = this.db.prepare("SELECT * FROM ai_actions WHERE session_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1").get(sessionId) as ActionRow | undefined;
    if (!r) return null;
    if (Date.now() - Date.parse(r.created_at) > ACTION_TTL_MS) { this.setStatus(r.id, "expired"); return null; }
    return r;
  }

  private insert(row: Omit<ActionRow, "ran_at" | "exit_code" | "output" | "journal_id">): void {
    this.db.prepare("INSERT INTO ai_actions (id, session_id, host, command, purpose, rollback, kind, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(row.id, row.session_id, row.host, row.command, row.purpose, row.rollback, row.kind, row.status, row.created_at);
  }

  private setStatus(id: string, status: ActionRow["status"]): void {
    this.db.prepare("UPDATE ai_actions SET status = ? WHERE id = ?").run(status, id);
  }

  /** Run a read-only command now. Changes must go through propose + approve. */
  async runRead(sessionId: string, host: Host, command: string, purpose: string): Promise<RunResult & { action_id: string }> {
    const id = crypto.randomUUID();
    this.insert({ id, session_id: sessionId, host: host.name, command, purpose, rollback: null, kind: "read", status: "running", created_at: nowIso() });
    const raw = await this.runner(host, command, this.cfg.commandTimeoutS);
    const r = { ...raw, output: redactValues(raw.output, this.hiddenValues()) };
    this.db.prepare("UPDATE ai_actions SET status = ?, ran_at = ?, exit_code = ?, output = ? WHERE id = ?").run(r.exit_code === 0 ? "done" : "failed", nowIso(), r.exit_code, r.output.slice(0, 20_000), id);
    return { ...r, action_id: id };
  }

  /** Record a change the model wants to make. One pending change per session: a new proposal replaces the old one. */
  propose(sessionId: string, host: Host, command: string, purpose: string, rollback: string | null): ActionRow {
    this.db.prepare("UPDATE ai_actions SET status = 'cancelled' WHERE session_id = ? AND status = 'pending'").run(sessionId);
    const id = crypto.randomUUID();
    this.insert({ id, session_id: sessionId, host: host.name, command, purpose, rollback, kind: "change", status: "pending", created_at: nowIso() });
    return this.get(id)!;
  }

  cancel(id: string): ActionRow | null {
    const a = this.get(id);
    if (a && a.status === "pending") this.setStatus(id, "cancelled");
    return this.get(id);
  }

  /** Run an approved change and journal it. Throws when the action is not pending. */
  async approve(id: string): Promise<{ action: ActionRow; result: RunResult; journal: Entity }> {
    const a = this.get(id);
    if (!a) throw new Error("no such action");
    if (a.status !== "pending") throw new Error(`action is ${a.status}, not pending`);
    if (Date.now() - Date.parse(a.created_at) > ACTION_TTL_MS) { this.setStatus(id, "expired"); throw new Error("action expired; ask again"); }
    const host = this.host(a.host);
    if (!host) throw new Error(`host ${a.host} is no longer known`);
    // Secrets go in only now, after approval; the stored command and the journal keep the {{secret:...}} names.
    let filled = { command: a.command, values: [] as string[] };
    if (/\{\{\s*secret:/i.test(a.command)) {
      try {
        if (!this.fillSecrets) throw new Error("the command names a secret but no password manager is linked");
        filled = await this.fillSecrets(a.command, host);
      } catch (e) {
        this.db.prepare("UPDATE ai_actions SET status = 'failed', ran_at = ?, output = ? WHERE id = ?").run(nowIso(), (e as Error).message, id);
        throw e;
      }
    }
    this.setStatus(id, "running");
    const raw = await this.runner(host, filled.command, this.cfg.commandTimeoutS);
    const result = { ...raw, output: redactValues(raw.output, [...filled.values, ...this.hiddenValues()]) };
    const ok = result.exit_code === 0 && !result.timed_out;
    const destructive = detectDestructive(a.command);
    const journal = this.store.create("journal", {
      host: host.name, at: nowIso(), what: a.purpose || a.command.slice(0, 200), command: a.command,
      risk: destructive ? "high" : "medium",
      ...(a.rollback || destructive ? { rollback: a.rollback || destructive!.rule.rollback.replace(/^Rollback:\s*/, "") } : {}),
      outcome: ok ? "done" : "failed", session_id: a.session_id,
    });
    this.db.prepare("UPDATE ai_actions SET status = ?, ran_at = ?, exit_code = ?, output = ?, journal_id = ? WHERE id = ?")
      .run(ok ? "done" : "failed", nowIso(), result.exit_code, result.output.slice(0, 20_000), journal.id, id);
    return { action: this.get(id)!, result, journal };
  }
}
