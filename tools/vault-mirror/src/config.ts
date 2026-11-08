import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface MirrorConfig {
  hub_url: string;
  token: string;
  vault_dir: string;
  state_file: string;
}

export const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".config", "everythingapp", "mirror.json");
export const DEFAULT_STATE_PATH = path.join(os.homedir(), ".config", "everythingapp", "mirror-state.json");

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Precedence, highest first:
 *   1. environment: EA_HUB_URL, EA_TOKEN, EA_VAULT_DIR, EA_STATE_FILE
 *   2. JSON file at EA_MIRROR_CONFIG or ~/.config/everythingapp/mirror.json
 *      with keys hub_url, token, vault_dir, state_file
 *   3. built-in default for state_file only
 * The token should come from the environment (the launchd wrapper reads it
 * from the macOS Keychain). Putting it in mirror.json works but is discouraged.
 */
export async function loadConfig(explicitPath?: string): Promise<MirrorConfig> {
  const filePath = explicitPath ?? process.env.EA_MIRROR_CONFIG ?? DEFAULT_CONFIG_PATH;
  let fromFile: Partial<MirrorConfig> = {};
  try {
    const raw = await fs.readFile(expandHome(filePath), "utf8");
    fromFile = JSON.parse(raw) as Partial<MirrorConfig>;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw new Error(`cannot read config ${filePath}: ${(err as Error).message}`);
    if (explicitPath) throw new Error(`config file not found: ${explicitPath}`);
  }

  const merged: Partial<MirrorConfig> = {
    hub_url: process.env.EA_HUB_URL ?? fromFile.hub_url,
    token: process.env.EA_TOKEN ?? fromFile.token,
    vault_dir: process.env.EA_VAULT_DIR ?? fromFile.vault_dir,
    state_file: process.env.EA_STATE_FILE ?? fromFile.state_file ?? DEFAULT_STATE_PATH,
  };

  const missing = (["hub_url", "token", "vault_dir"] as const).filter((k) => !merged[k]);
  if (missing.length) {
    throw new Error(
      `missing config: ${missing.join(", ")}. Set EA_${missing[0].toUpperCase()} in the environment ` +
        `or add "${missing[0]}" to ${filePath}`,
    );
  }

  return {
    hub_url: String(merged.hub_url).replace(/\/+$/, ""),
    token: String(merged.token).trim(),
    vault_dir: path.resolve(expandHome(String(merged.vault_dir))),
    state_file: path.resolve(expandHome(String(merged.state_file))),
  };
}
