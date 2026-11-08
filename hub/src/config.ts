import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { backupJobNames, type BackupJobNames } from "./backups.js";

/** Directory of the hub package (the folder that holds package.json). */
export const HUB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_DIR = path.resolve(HUB_DIR, "..");

export interface Config {
  port: number;
  /** Interface the HTTP server binds. Loopback by default: clients reach the hub through Tailscale Serve. */
  bindHost: string;
  /**
   * EA_TLS_CERT and EA_TLS_KEY, PEM files: with both, the hub's port serves HTTPS (tls.ts), and plain HTTP is answered
   * only for connections from this machine. deploy/install.sh makes a self-signed pair for a hub on a home network.
   */
  tlsCert: string;
  tlsKey: string;
  token: string;
  /** A second token that can only post project activity (`POST /projects/feed`), for a machine running a feed script. */
  feedToken: string;
  /**
   * EA_MAIN_KEY_FROM: who besides the hub's own machine may use the main key (EA_TOKEN), comma separated: tailnet or
   * network addresses (100.64.0.7) and Tailscale login names (someone@example.com, from the header Tailscale Serve
   * adds). Empty (the default): only scripts on the hub's own machine. `*` allows anyone who has it (before 2026-11-06).
   */
  mainKeyFrom: string[];
  /** EA_MAIN_KEY_IN_QUERY=1: the main key may also come in `?token=` (a link or an old sensor board). Off by default. */
  mainKeyInQuery: boolean;
  /**
   * EA_CORS_ORIGINS: browser origins besides the built-in ones (the Windows app and the web app's dev server) that may
   * call the hub from a page, comma separated (https://example.com). The hub's own /app needs none.
   */
  corsOrigins: string[];
  dataDir: string;
  dbPath: string;
  /** Chats, AI call log and host command output: kept out of backups so a wipe leaves no copy. */
  chatDbPath: string;
  /** SOCKS proxy (host:port) every web request of the assistant goes through, e.g. Tor at 127.0.0.1:9050. Empty: direct. */
  torSocks: string;
  /**
   * EA_WEB_WITHOUT_TOR=1: the owner's own choice to let web lookups leave from the home address when Tor is not set
   * up. Off by default: without Tor (EA_TOR_SOCKS) the assistant has no web search and reads no pages.
   */
  webWithoutTor: boolean;
  vaultDir: string;
  backupDir: string;
  /** EA_BACKUP_COPY_DIR: a second folder each nightly backup is copied to (an external drive, a network share). */
  backupCopyDir: string;
  /** The work space key (workkey.ts). Kept out of the data folder so no backup of it carries the key. */
  workKeyFile: string;
  /**
   * The age identity every copy of the data that leaves hub.sqlite is encrypted to (backupkey.ts). Kept next to the
   * work key (EA_BACKUP_KEY_FILE overrides), owner-only, in no backup or copy.
   */
  backupKeyFile: string;
  /** The key that seals connections.json and ai.json at rest (secretbox.ts). Next to the work key, in no backup. */
  secretsKeyFile: string;
  seedDir: string;
  /** The owner's own seed files (facts, monitors, rules...), read after the starter ones. Not in the repo. */
  seedPersonalDir: string;
  /** EA_MODULES: the modules a new hub starts with (`all`, or a comma list of ids); empty: the defaults. */
  modulesPreset: string;
  ollamaUrl: string;
  ollamaModel: string;
  ollamaNumCtx: number;
  /**
   * Ollama keep_alive sent with every chat so the model stays loaded between messages. 5 minutes: the GPU's memory
   * (17 GB of a 24 GB card) is free for games soon after the owner stops, at the cost of a reload on the first message after.
   */
  ollamaKeepAlive: string;
  /** EA_OLLAMA_THINK: empty (model default), true, false, or low|medium|high for gpt-oss. */
  ollamaThink: string;
  /** Second local model server, tried when the first does not answer (EA_OLLAMA_FALLBACK_URL, _MODEL, _THINK). */
  ollamaFallbackUrl: string;
  ollamaFallbackModel: string;
  ollamaFallbackThink: string;
  /** EA_AI_TOOLS=0 turns assistant tools off. */
  aiTools: boolean;
  anthropicApiKey: string;
  anthropicModel: string;
  allowCloudDefault: boolean;
  tz: string;
  adapterUrl: string;
  adapterModel: string;
  /**
   * An OpenAI-compatible model server (EA_OPENAI_URL ending in /v1, EA_OPENAI_MODEL, EA_OPENAI_KEY when it needs one):
   * LM Studio, llama.cpp, vLLM, or a cloud service. Used when there is no Ollama, or after it; it can use the tools.
   */
  /** The owner's name until the setup page sets it (EA_OWNER_NAME; default "the owner"). */
  ownerName: string;
  /**
   * How devices name and color this hub, so several people's hubs on one machine are told apart (EA_HUB_NAME, e.g.
   * "Jamie"; empty: the owner's name from the profile) and EA_HUB_COLOR (`#rrggbb`; empty: none).
   */
  hubName: string;
  hubColor: string;
  /** The address devices use to reach the hub, for pairing links (else the address a request came in on). */
  publicUrl: string;
  openaiUrl: string;
  openaiModel: string;
  openaiKey: string;
  aiFake: boolean;
  aiTimeoutMs: number;
  classifyTimeoutMs: number;
  reminderIntervalMs: number;
  logRequests: boolean;
  /** Planner day window, HH:MM local. Blocks are placed inside it. */
  dayStart: string;
  dayEnd: string;
  /** HH:MM local time the daily digest notify is emitted. */
  digestTime: string;
  /** Hours an activity may run before the hub asks whether it is still on purpose. */
  focusCheckHours: number;
  /** An activity nobody stopped ends itself after this many hours, at its first check-in (0 never). */
  focusMaxHours: number;
  /** Days of sensor readings kept; older rows are purged nightly. */
  readingKeepDays: number;
  /** EA_HOST_SENSORS: read disk, temperature, GPU and pool sensors from the known hosts every 10 minutes (default on). */
  hostSensors: boolean;
  /** Read linked Gmail mailboxes with the local model and file receipts, renewals, orders and vet mail (EA_MAIL_FILER=false turns it off). */
  mailFiler: boolean;
  noteLinker: boolean;
  /**
   * When background model work runs. `ask` (the default): only when the owner asks (Read now, Tag notes, opening the
   * quiz), so the GPU stays free for games on the same machine. `auto`: on its own while no chat runs, for a hub on a
   * machine nobody plays on.
   */
  backgroundAi: "ask" | "auto";
  /** Local times the waiting mail is read when the GPU is free (EA_MAIL_TIMES, default 07:00,12:00,17:00,22:00). */
  mailTimes: string[];
  /** HH:MM local time the recall quiz is built from the day's sessions. */
  quizTime: string;
  /** SearXNG base URL for the assistant's web search (JSON format enabled). Empty turns web search off. */
  searxngUrl: string;
  /** The shared image service (a gateway on the owner's network), and this project's token for it. Empty = image generation off. */
  imageServiceUrl: string;
  imageServiceToken: string;
  /**
   * The image service's workers that a person or the assistant may pick by hand (EA_IMAGE_WORKERS, `id=label` pairs
   * separated by commas, e.g. `gpu-a=Big GPU,gpu-b=Desktop GPU`). Empty (the default): only Auto, the service picks.
   */
  imageWorkers: { id: string; label: string }[];
  /** EA_AI_WEB_FETCH=0 stops the assistant reading web pages directly. */
  webFetch: boolean;
  /** EA_AI_HOSTS=0 turns host commands off. */
  hostActions: boolean;
  /** OpenSSH client config the host list is read from (Host aliases with keys already set up). */
  sshConfigPath: string;
  /** JSON file of extra or corrected hosts: [{ name, ssh?, os?, local? }]. */
  hostsFile: string;
  /** Seconds a host command may run. */
  commandTimeoutS: number;
  /**
   * What the backup monitor reads on each machine (backups.ts): EA_BACKUP_MAC_JOBS (launchd labels),
   * EA_BACKUP_WINDOWS_TASKS (scheduled task names) and EA_BACKUP_LINUX_UNITS (systemd units), each
   * `backup=<name>,verify=<name>` and for Linux also `restore=<name>`; a job left out keeps its default.
   */
  backupJobs: BackupJobNames;
}

/** Minimal .env loader: KEY=value lines, # comments, optional surrounding quotes. Does not override existing env. */
export function loadDotEnv(file: string): void {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function bool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined || v === "") return dflt;
  return /^(1|true|yes|on)$/i.test(v);
}

function int(v: string | undefined, dflt: number): number {
  const n = parseInt(v ?? "", 10);
  return Number.isFinite(n) ? n : dflt;
}

function num(v: string | undefined, dflt: number): number {
  const n = parseFloat(v ?? "");
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

function list(v: string | undefined): string[] {
  return (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** The time zone of the machine the hub runs on (no place is assumed); UTC when it cannot be read. */
function systemZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

/** `id=label,id=label` (a label left out is the id); ids the service does not know are refused by it, not here. */
export function imageWorkers(v: string | undefined): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = [];
  for (const part of (v ?? "").split(",")) {
    const [id, ...rest] = part.split("=");
    const clean = id.trim();
    if (!clean || out.some((w) => w.id === clean)) continue;
    out.push({ id: clean, label: rest.join("=").trim() || clean });
  }
  return out;
}

function hhmm(v: string | undefined, dflt: string): string {
  return v && /^([01]\d|2[0-4]):[0-5]\d$/.test(v.trim()) ? v.trim() : dflt;
}

/** Build the config from process.env (after loading .env from the hub dir unless EA_NO_DOTENV is set). */
export function loadConfig(overrides: Partial<Config> = {}): Config {
  if (!bool(process.env.EA_NO_DOTENV, false)) loadDotEnv(path.join(HUB_DIR, ".env"));
  const env = process.env;
  const dataDir = path.resolve(HUB_DIR, env.EA_DATA_DIR || "./data");
  const cfg: Config = {
    port: int(env.EA_PORT, 8787),
    bindHost: env.EA_BIND_HOST || "127.0.0.1",
    tlsCert: env.EA_TLS_CERT?.trim() ? path.resolve(HUB_DIR, env.EA_TLS_CERT.trim()) : "",
    tlsKey: env.EA_TLS_KEY?.trim() ? path.resolve(HUB_DIR, env.EA_TLS_KEY.trim()) : "",
    token: env.EA_TOKEN || "",
    feedToken: env.EA_FEED_TOKEN || "",
    mainKeyFrom: list(env.EA_MAIN_KEY_FROM),
    mainKeyInQuery: bool(env.EA_MAIN_KEY_IN_QUERY, false),
    corsOrigins: list(env.EA_CORS_ORIGINS).map((o) => o.replace(/\/+$/, "")),
    dataDir,
    dbPath: path.join(dataDir, "hub.sqlite"),
    chatDbPath: path.join(dataDir, "chats.sqlite"),
    torSocks: (env.EA_TOR_SOCKS || "").trim(),
    webWithoutTor: bool(env.EA_WEB_WITHOUT_TOR, false),
    vaultDir: env.EA_VAULT_DIR ? path.resolve(HUB_DIR, env.EA_VAULT_DIR) : path.join(dataDir, "vault"),
    backupDir: env.EA_BACKUP_DIR ? path.resolve(HUB_DIR, env.EA_BACKUP_DIR) : path.join(dataDir, "backups"),
    backupCopyDir: env.EA_BACKUP_COPY_DIR ? path.resolve(env.EA_BACKUP_COPY_DIR) : "",
    workKeyFile: env.EA_WORK_KEY_FILE ? path.resolve(HUB_DIR, env.EA_WORK_KEY_FILE) : path.join(dataDir, "work.key"),
    backupKeyFile: "",
    secretsKeyFile: "",
    seedDir: env.EA_SEED_DIR ? path.resolve(HUB_DIR, env.EA_SEED_DIR) : path.join(REPO_DIR, "deploy", "seed"),
    seedPersonalDir: env.EA_SEED_PERSONAL_DIR ? path.resolve(HUB_DIR, env.EA_SEED_PERSONAL_DIR) : path.join(dataDir, "seed"),
    modulesPreset: (env.EA_MODULES || "").trim(),
    ollamaUrl: (env.EA_OLLAMA_URL || "").replace(/\/+$/, ""),
    // No model is assumed: the Welcome page picks one that fits this machine (ai.json), or EA_OLLAMA_MODEL names it.
    ollamaModel: env.EA_OLLAMA_MODEL || "",
    ollamaNumCtx: int(env.EA_OLLAMA_NUM_CTX, 8192),
    ollamaKeepAlive: env.EA_OLLAMA_KEEP_ALIVE || "5m",
    ollamaThink: (env.EA_OLLAMA_THINK || "").trim().toLowerCase(),
    ollamaFallbackUrl: (env.EA_OLLAMA_FALLBACK_URL || "").replace(/\/+$/, ""),
    ollamaFallbackModel: env.EA_OLLAMA_FALLBACK_MODEL || "",
    ollamaFallbackThink: (env.EA_OLLAMA_FALLBACK_THINK || "").trim().toLowerCase(),
    aiTools: env.EA_AI_TOOLS !== "0",
    anthropicApiKey: env.EA_ANTHROPIC_API_KEY || "",
    anthropicModel: env.EA_ANTHROPIC_MODEL || "claude-sonnet-5-5",
    allowCloudDefault: bool(env.EA_ALLOW_CLOUD_DEFAULT, false),
    tz: env.EA_TZ || systemZone(),
    adapterUrl: (env.EA_ADAPTER_URL || "").replace(/\/+$/, ""),
    adapterModel: env.EA_ADAPTER_MODEL || "",
    ownerName: (env.EA_OWNER_NAME || "").trim() || "the owner",
    hubName: (env.EA_HUB_NAME || "").trim().slice(0, 40),
    hubColor: /^#[0-9a-fA-F]{6}$/.test((env.EA_HUB_COLOR || "").trim()) ? (env.EA_HUB_COLOR || "").trim().toLowerCase() : "",
    publicUrl: (env.EA_PUBLIC_URL || "").trim().replace(/\/+$/, ""),
    openaiUrl: (env.EA_OPENAI_URL || "").replace(/\/+$/, ""),
    openaiModel: env.EA_OPENAI_MODEL || "",
    openaiKey: env.EA_OPENAI_KEY || "",
    aiFake: bool(env.EA_AI_FAKE, false),
    aiTimeoutMs: int(env.EA_AI_TIMEOUT_MS, 120000),
    classifyTimeoutMs: int(env.EA_CLASSIFY_TIMEOUT_MS, 4000),
    reminderIntervalMs: int(env.EA_REMINDER_INTERVAL_MS, 30000),
    logRequests: bool(env.EA_LOG_REQUESTS, true),
    dayStart: hhmm(env.EA_DAY_START, "09:00"),
    dayEnd: hhmm(env.EA_DAY_END, "23:00"),
    digestTime: hhmm(env.EA_DIGEST_TIME, "09:00"),
    focusCheckHours: num(env.EA_FOCUS_CHECK_HOURS, 3),
    focusMaxHours: num(env.EA_FOCUS_MAX_HOURS, 12),
    readingKeepDays: int(env.EA_READING_KEEP_DAYS, 365),
    hostSensors: env.EA_HOST_SENSORS !== "false",
    mailFiler: env.EA_MAIL_FILER !== "false",
    noteLinker: env.EA_NOTE_LINKER !== "false",
    backgroundAi: env.EA_BACKGROUND_AI === "auto" ? "auto" : "ask",
    mailTimes: (env.EA_MAIL_TIMES || "07:00,12:00,17:00,22:00").split(",").map((t) => t.trim()).filter((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)),
    quizTime: hhmm(env.EA_QUIZ_TIME, "21:00"),
    searxngUrl: (env.EA_SEARXNG_URL ?? "").replace(/\/+$/, ""),
    imageServiceUrl: (env.EA_IMAGE_SERVICE_URL ?? "").replace(/\/+$/, ""),
    imageServiceToken: env.EA_IMAGE_SERVICE_TOKEN ?? "",
    imageWorkers: imageWorkers(env.EA_IMAGE_WORKERS),
    webFetch: env.EA_AI_WEB_FETCH !== "0",
    hostActions: env.EA_AI_HOSTS !== "0",
    sshConfigPath: env.EA_SSH_CONFIG || path.join(env.HOME || "", ".ssh", "config"),
    hostsFile: env.EA_HOSTS_FILE ? path.resolve(HUB_DIR, env.EA_HOSTS_FILE) : path.join(dataDir, "hosts.json"),
    commandTimeoutS: int(env.EA_COMMAND_TIMEOUT_S, 60),
    backupJobs: backupJobNames({ mac: env.EA_BACKUP_MAC_JOBS, windows: env.EA_BACKUP_WINDOWS_TASKS, linux: env.EA_BACKUP_LINUX_UNITS }),
    ...overrides,
  };
  if (overrides.dataDir && !overrides.dbPath) cfg.dbPath = path.join(cfg.dataDir, "hub.sqlite");
  if (overrides.dataDir && !overrides.chatDbPath) cfg.chatDbPath = path.join(cfg.dataDir, "chats.sqlite");
  // A hub given its own data folder (tests, evals run with hub.env loaded) keeps every file in it, even when
  // the environment names the live hub's vault, backups or work key; otherwise an eval would open the live work key.
  if (overrides.dataDir && !overrides.vaultDir) cfg.vaultDir = path.join(cfg.dataDir, "vault");
  if (overrides.dataDir && !overrides.backupDir) cfg.backupDir = path.join(cfg.dataDir, "backups");
  if (overrides.dataDir && !overrides.backupCopyDir) cfg.backupCopyDir = "";
  if (overrides.dataDir && !overrides.workKeyFile) cfg.workKeyFile = path.join(cfg.dataDir, "work.key");
  // Next to the work key unless named; a hub given its own data folder or work key keeps it there too.
  if (!overrides.backupKeyFile) {
    cfg.backupKeyFile = env.EA_BACKUP_KEY_FILE && !overrides.dataDir && !overrides.workKeyFile
      ? path.resolve(HUB_DIR, env.EA_BACKUP_KEY_FILE)
      : path.join(path.dirname(cfg.workKeyFile), "backup.key");
  }
  if (!overrides.secretsKeyFile) {
    cfg.secretsKeyFile = env.EA_SECRETS_KEY_FILE && !overrides.dataDir && !overrides.workKeyFile
      ? path.resolve(HUB_DIR, env.EA_SECRETS_KEY_FILE)
      : path.join(path.dirname(cfg.workKeyFile), "secrets.key");
  }
  if (overrides.dataDir && !overrides.hostsFile) cfg.hostsFile = path.join(cfg.dataDir, "hosts.json");
  // Date math in shared helpers (nextOccurrence) uses the process timezone.
  process.env.TZ = cfg.tz;
  return cfg;
}
