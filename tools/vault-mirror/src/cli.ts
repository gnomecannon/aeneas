#!/usr/bin/env tsx
import { watch } from "node:fs";
import { loadConfig } from "./config.ts";
import { HubClient, HubError } from "./hub.ts";
import { loadIgnore } from "./ignore.ts";
import { loadState, saveState } from "./state.ts";
import { syncOnce } from "./sync.ts";

const POLL_MS = 60_000;
const DEBOUNCE_MS = 2_000;

function usage(): never {
  console.error(`usage: vault-mirror <once|watch|dry-run> [--config <path>]

  once      sync both ways one time and exit
  watch     sync now, then every 60 s and 2 s after any local file change
  dry-run   print what once would do, change nothing

config: ~/.config/everythingapp/mirror.json or EA_MIRROR_CONFIG, keys hub_url, token, vault_dir, state_file.
env overrides: EA_HUB_URL, EA_TOKEN, EA_VAULT_DIR, EA_STATE_FILE`);
  process.exit(2);
}

function ts(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const log = (line: string) => console.log(`${ts()} ${line}`);

/**
 * An error for the log file: the hub route and status, or the error's class and system code. Never its message: a
 * hub answer or a file error can carry a note's name or text.
 */
function errCode(err: unknown): string {
  if (err instanceof HubError) return `hub ${err.route} answered ${err.status}`;
  const e = err as { name?: unknown; code?: unknown; cause?: { code?: unknown } } | null;
  const code = typeof e?.code === "string" ? e.code : typeof e?.cause?.code === "string" ? e.cause.code : "";
  return [typeof e?.name === "string" ? e.name : "Error", /^[A-Z][A-Z0-9_]+$/.test(code) ? code : ""].filter(Boolean).join(" ");
}

/** The hub's address without a user, password, path or query. */
function hostOf(u: string): string {
  try { return new URL(u).host; } catch { return "(address)"; }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mode = args[0];
  if (!mode || !["once", "watch", "dry-run"].includes(mode)) usage();
  const cfgIdx = args.indexOf("--config");
  const cfgPath = cfgIdx >= 0 ? args[cfgIdx + 1] : undefined;

  const cfg = await loadConfig(cfgPath);
  const hub = new HubClient(cfg.hub_url, cfg.token);
  const dryRun = mode === "dry-run";
  log(`vault-mirror ${mode}: hub=${hostOf(cfg.hub_url)}`);

  async function pass(): Promise<void> {
    const ignore = await loadIgnore(cfg.vault_dir);
    const state = await loadState(cfg.state_file);
    await syncOnce({ hub, vaultDir: cfg.vault_dir, state, ignore, dryRun, log });
    if (!dryRun) await saveState(cfg.state_file, state);
  }

  if (mode !== "watch") {
    await pass();
    return;
  }

  let running = false;
  let again = false;
  async function guarded(trigger: string): Promise<void> {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        log(`sync (${trigger})`);
        try {
          await pass();
        } catch (err) {
          log(`ERROR ${errCode(err)}`);
        }
      } while (again);
    } finally {
      running = false;
    }
  }

  await guarded("start");
  setInterval(() => void guarded("poll"), POLL_MS);

  let timer: NodeJS.Timeout | undefined;
  try {
    watch(cfg.vault_dir, { recursive: true }, (_event, filename) => {
      const f = filename ? String(filename) : "";
      if (f.startsWith(".obsidian") || f.startsWith(".trash") || f.endsWith(".tmp")) return;
      if (f && !f.endsWith(".md") && !f.endsWith(".mirrorignore")) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void guarded("file change"), DEBOUNCE_MS);
    });
    log(`watching the vault (poll every ${POLL_MS / 1000} s)`);
  } catch (err) {
    log(`fs.watch unavailable (${errCode(err)}); polling only`);
  }
  await new Promise(() => {});
}

main().catch((err) => {
  log(`FATAL ${errCode(err)}`);
  process.exit(1);
});
