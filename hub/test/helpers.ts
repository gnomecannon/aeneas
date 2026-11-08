import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { createHub, type Hub } from "../src/hub.js";
import { createApp, type App } from "../src/app.js";
import { restoreBackup } from "../src/backup.js";
import { fileURLToPath } from "node:url";

/** Invented seed data for tests (the shipped seed is only starter content; the owner's own lives in their data folder). */
export const SEED_FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "seed");

export const TOKEN = "test-token-0123456789-0123456789";

export interface TestHub { hub: Hub; app: App; dir: string; cleanup(): void; api(path: string, init?: RequestInit & { json?: unknown }): Promise<Response> }

/** A hub on a fresh temp dir with the fake AI backend, request logging off and every module on (`modulesPreset` changes that). */
export function makeHub(overrides: Record<string, unknown> = {}): TestHub {
  process.env.EA_NO_DOTENV = "1";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-hub-test-"));
  const cfg = loadConfig({ dataDir: dir, token: TOKEN, aiFake: true, logRequests: false, ollamaUrl: "", anthropicApiKey: "", adapterUrl: "", searxngUrl: "", sshConfigPath: path.join(dir, "no-ssh-config"), seedDir: SEED_FIXTURES, seedPersonalDir: path.join(dir, "seed"), modulesPreset: "all", ...overrides } as any);
  const hub = createHub(cfg);
  const app = createApp(hub);
  const api = async (p: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> => {
    const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}`, ...((init.headers as Record<string, string>) ?? {}) };
    let body = init.body;
    if (init.json !== undefined) { body = JSON.stringify(init.json); headers["content-type"] = "application/json"; }
    return app.request(p, { ...init, headers, body });
  };
  return { hub, app, dir, api, cleanup: () => { hub.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

/** A paired device's own key (a pairing code claimed), for routes a device calls with `?token=` (feeds, streams). */
export async function deviceKey(t: TestHub, name = "iPhone", platform = "iphone"): Promise<string> {
  const links = (await (await t.api("/devices/pairing", { method: "POST", json: { name } })).json()) as { code: string };
  const r = await t.app.request("/devices/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: links.code, name, platform }) });
  return ((await r.json()) as { key: string }).key;
}

/** A plain copy of an encrypted backup (decrypted with the hub's backup key into the test folder), for reading it. */
export async function plainBackup(t: TestHub, file: string): Promise<string> {
  const out = path.join(t.dir, `plain-${path.basename(file, ".age")}-${Math.random().toString(36).slice(2, 8)}`);
  await restoreBackup(file, out, [t.hub.backupKey.identity()]);
  return out;
}
