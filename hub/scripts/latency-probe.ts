/**
 * Where reply time goes: sends a few chats to the real model on a throwaway hub (seeded facts and rules, like the live
 * hub) and prints, per message, the wall time and, for each model round, the prompt tokens the model server had to
 * read out of the whole prompt (from Ollama's journal, so it runs on the machine with Ollama only). Reading close to the whole prompt
 * means the cache was missed. Run on the hub machine like the evals:
 *   cd ~/everythingapp/hub && export PATH=$HOME/.local/node/bin:$PATH && set -a && . ~/.config/everythingapp/hub.env && set +a && npx tsx scripts/latency-probe.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadConfig } from "../src/config.js";
import { createHub } from "../src/hub.js";
import { createApp } from "../src/app.js";
import { runSeeds } from "../src/seed.js";

const TOKEN = "latency-probe-token-not-a-secret-0001";

/** A chat message, or "clobber" (an unrelated prompt, as another program using the model server would send), or "warm". */
const STEPS: string[][] = [
  ["clobber"],
  ["A", "what's on today?"],
  ["A", "and tomorrow?"],
  ["clobber"],
  ["warm"],
  ["B", "what's on today?"],
  ["C", "how much is a 20% tip on $84?"],
  ["A", "what about Wednesday?"],
];

async function main() {
  process.env.EA_NO_DOTENV = "1";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-latency-"));
  const cfg = loadConfig({ dataDir: dir, token: TOKEN, aiFake: false, logRequests: false, searxngUrl: "", imageServiceUrl: "", imageServiceToken: "", hostActions: false,
    sshConfigPath: path.join(dir, "no-ssh-config"), hostsFile: path.join(dir, "hosts.json"), vaultDir: path.join(dir, "vault") } as any);
  const hub = createHub(cfg);
  createApp(hub);
  runSeeds(hub.store, cfg);
  const stamp = Date.now();
  try {
    for (const [chat, said] of STEPS) {
      const t0 = Date.now();
      if (chat === "clobber") {
        await hub.ai.route("general", false)[0].chat([{ role: "user", content: "Say hi in one word." }]);
        console.log(JSON.stringify({ step: "clobber", s: +((Date.now() - t0) / 1000).toFixed(1) }));
        continue;
      }
      if (chat === "warm") {
        (hub.ai as unknown as { lastModelUse: number }).lastModelUse = 0; // the probe has just used it
        console.log(JSON.stringify({ step: "warm", ...(await hub.ai.warm()), s: +((Date.now() - t0) / 1000).toFixed(1) }));
        continue;
      }
      const out = await hub.ai.chat({ session_id: `probe-${chat}-${stamp}`, message: said, task_type: "auto" });
      const ms = Date.now() - t0;
      console.log(JSON.stringify({ chat, said, s: +(ms / 1000).toFixed(1), tools: (out.actions ?? []).map((a) => a.tool), rounds: rounds(t0) }));
    }
  } finally {
    hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Each model round since `t0`: tokens read of the whole prompt, and the seconds spent reading it. */
function rounds(t0: number): string[] {
  const log = execFileSync("journalctl", ["-u", "ollama", "--since", `@${Math.ceil(t0 / 1000)}`, "--no-pager", "-o", "cat"], { encoding: "utf8", timeout: 10_000 });
  const whole = new Map<string, number>();
  const out: string[] = [];
  for (const line of log.split("\n")) {
    const task = /task (\d+)/.exec(line)?.[1];
    if (!task) continue;
    const n = /task\.n_tokens = (\d+)/.exec(line);
    if (n) whole.set(task, +n[1]);
    const read = /prompt eval time =\s+([\d.]+) ms \/\s+(\d+) tokens/.exec(line);
    if (read) out.push(`${read[2]}/${whole.get(task) ?? "?"} in ${(+read[1] / 1000).toFixed(1)}s`);
  }
  return out;
}

main().catch((e) => { console.error(e); process.exit(1); });
