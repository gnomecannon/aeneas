/**
 * A demo hub: a real hub on its own throwaway folder, filled once with a made-up month in the life of "Alex"
 * (sample-world.ts), every module on except the ones that read the device's own calendar, reminders and contacts. For App Store screenshots and App Review, and for trying the apps without
 * putting anything of your own in them. Nothing of the live hub is read: no hub.env, no data folder, no keys.
 *
 *   cd hub && npx tsx scripts/demo-hub.ts <folder> [port]
 *
 * Seeds <folder> the first time, then runs the hub there on 127.0.0.1:<port> (default 8790) with a random main key
 * kept in <folder>/demo-token, and prints a pairing link. Stop it with Ctrl-C; delete the folder to start over.
 * EA_DEMO_BIND=0.0.0.0 with EA_DEMO_TLS_CERT and EA_DEMO_TLS_KEY serves it on the network over HTTPS.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { createHub } from "../src/hub.js";
import { createApp } from "../src/app.js";
import { runSeeds } from "../src/seed.js";
import { MODULES } from "../src/modules.js";
import { seedWorld } from "./sample-world.js";

const HUB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = process.argv[2] ? path.resolve(process.argv[2]) : "";
const port = Number(process.argv[3] ?? 8790);
if (!dir) { console.error("usage: npx tsx scripts/demo-hub.ts <folder> [port]"); process.exit(2); }
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

const tokenFile = path.join(dir, "demo-token");
if (!fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, randomBytes(24).toString("hex"), { mode: 0o600 });
const token = fs.readFileSync(tokenFile, "utf8").trim();

const ZONE = process.env.EA_TZ || process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
process.env.TZ = ZONE;
const env: Record<string, string> = {
  // The machine's own time zone: an empty TZ is UTC to Node, which put "today at 3 PM" on the wrong day.
  PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TZ: ZONE, EA_TZ: ZONE,
  EA_NO_DOTENV: "1", EA_TOKEN: token, EA_DATA_DIR: dir, EA_VAULT_DIR: path.join(dir, "vault"), EA_BACKUP_DIR: path.join(dir, "backups"),
  EA_WORK_KEY_FILE: path.join(dir, "work.key"), EA_HOSTS_FILE: path.join(dir, "hosts.json"), EA_SSH_CONFIG: path.join(dir, "no-ssh-config"),
  EA_PORT: String(port), EA_BIND_HOST: process.env.EA_DEMO_BIND ?? "127.0.0.1",
  // No model, search or image service of the machine it runs on: the demo shows the apps, not someone's hub.
  EA_OLLAMA_URL: "", EA_SEARXNG_URL: "", EA_IMAGE_SERVICE_URL: "", EA_AI_HOSTS: "0", EA_HOST_SENSORS: "false",
  ...(process.env.EA_DEMO_TLS_CERT ? { EA_TLS_CERT: process.env.EA_DEMO_TLS_CERT, EA_TLS_KEY: process.env.EA_DEMO_TLS_KEY ?? "" } : {}),
  ...(process.env.EA_DEMO_PUBLIC_URL ? { EA_PUBLIC_URL: process.env.EA_DEMO_PUBLIC_URL } : {}),
};

const marker = path.join(dir, ".demo-seeded");
if (!fs.existsSync(marker)) {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const cfg = loadConfig({ dataDir: dir, token, aiFake: false, logRequests: false, searxngUrl: "", imageServiceUrl: "", imageServiceToken: "", hostActions: false,
    sshConfigPath: env.EA_SSH_CONFIG, hostsFile: env.EA_HOSTS_FILE, vaultDir: env.EA_VAULT_DIR } as any);
  const hub = createHub(cfg);
  hub.profile.set({ name: "Alex", pet: "Pepper" });
  // Every module, except the ones that read the device's own calendar, reminders and contacts: a demo shows
  // Alex's month, not the reviewer's own data.
  const OWN_DATA = new Set(["apple_calendar", "apple_reminders", "contacts"]);
  hub.modules.set(Object.fromEntries(MODULES.map((m) => [m.id, !OWN_DATA.has(m.id)])));
  createApp(hub);
  runSeeds(hub.store, cfg);
  seedWorld(hub);
  hub.close();
  fs.writeFileSync(marker, new Date().toISOString());
  console.log(`[demo] seeded ${dir} with Alex's sample month`);
}

const tsx = path.join(HUB_DIR, "..", "node_modules", ".bin", "tsx");
const child = spawn(process.execPath, [tsx, "src/main.ts", "serve"], { cwd: HUB_DIR, env, stdio: ["ignore", "inherit", "inherit"] });
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));
child.on("exit", (code) => process.exit(code ?? 0));

// A pairing link once it answers (the code works once, for 10 minutes; run again for another).
const base = `http://127.0.0.1:${port}`;
const scheme = env.EA_TLS_CERT ? "https" : "http";
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  try {
    const r = await fetch(`${scheme}://127.0.0.1:${port}/devices/pairing`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ name: "Demo device" }) });
    if (!r.ok) continue;
    const j = (await r.json()) as { code?: string; app?: string; web?: string };
    console.log(`[demo] hub on ${base}; pairing code ${j.code ?? "?"} (once, 10 minutes)\n[demo] app link: ${j.app ?? "?"}\n[demo] web link: ${j.web ?? "?"}`);
    break;
  } catch { /* not up yet */ }
}
