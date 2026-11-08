/**
 * Model bake-off for the assistant: every candidate runs the same ten requests through the real
 * gateway (memory, style filter, tools) against a throwaway hub seeded with sample data, so the
 * comparison measures what the app will actually do. Nothing touches the live hub.
 *
 *   EA_BENCH_OLLAMA=http://gpu-box:11434 npx tsx scripts/bench-models.ts gpt-oss:20b=low qwen3.8:27b=false
 *
 * Each argument is model[=think]. Output: one JSON line per case on stderr, a summary table on stdout.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { createHub } from "../src/hub.js";
import { createApp } from "../src/app.js";
import { runSeeds } from "../src/seed.js";
import type { ChatOutput } from "../src/ai/index.js";

const OLLAMA = process.env.EA_BENCH_OLLAMA || "http://127.0.0.1:11434";
const TOKEN = "bench-token-0123456789-0123456789";

interface Case {
  id: string;
  ask: string;
  /** Tools that must appear among the calls (any order). Empty means no tool should be needed. */
  expect: string[];
  /** Extra check on the hub state or the reply. Returns a failure reason or null. */
  check?: (ctx: { out: ChatOutput; hub: ReturnType<typeof createHub> }) => string | null;
}

const tomorrow10 = (() => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(10, 0, 0, 0); return d; })();

const CASES: Case[] = [
  { id: "today", ask: "What's on my plate today?", expect: ["get_today"],
    check: ({ out }) => /(^|[^0-9:])(1(:00)?\s?(pm|PM)|13:00)/.test(out.reply) && !/9(:00)?\s?(am|AM)/.test(out.reply) ? "work hours reported in UTC" : null },
  { id: "add-task", ask: "Add a task to replace the UPS battery on storage.", expect: ["create_task"],
    check: ({ hub }) => hub.store.list({ kind: "task" }).some((t) => /ups/i.test(String(t.fields.title))) ? null : "no UPS task created" },
  { id: "reminder", ask: "Remind me to call the vet tomorrow at 10am.", expect: ["create_reminder"],
    check: ({ hub }) => {
      const r = hub.store.list({ kind: "reminder" }).find((x) => /vet/i.test(String(x.fields.title)));
      if (!r) return "no vet reminder";
      const at = new Date(String(r.fields.at));
      return Math.abs(at.getTime() - tomorrow10.getTime()) < 60_000 ? null : `wrong time ${String(r.fields.at)}`;
    } },
  { id: "log-weight", ask: "weight 158 this morning", expect: ["log_health"],
    check: ({ hub }) => hub.store.list({ kind: "log" }).some((l) => l.fields.type === "weight" && Number(l.fields.value) === 158) ? null : "weight not logged" },
  { id: "ops", ask: "Is anything down in the homelab right now?", expect: ["ops_status"] },
  { id: "search", ask: "What did I write down about gain staging?", expect: ["search"],
    check: ({ out }) => /18/.test(out.reply) ? null : "reply does not use the note (-18 dBFS)" },
  { id: "pepper", ask: "Pepper just had his heartworm pill.", expect: ["log_pet"],
    check: ({ hub }) => hub.store.list({ kind: "pet_event" }).some((p) => p.fields.type === "med") ? null : "no med pet_event" },
  { id: "finish-task", ask: "I finished rebuilding the NAS array, mark it done.", expect: ["update_task"],
    check: ({ hub }) => hub.store.list({ kind: "task" }).find((t) => /nas/i.test(String(t.fields.title)))?.fields.status === "done" ? null : "NAS task not done" },
  { id: "schedule", ask: "Find a 3 hour block this week for the Ender 3 tuning task and schedule it in the evening.", expect: ["schedule_task"],
    check: ({ hub }) => {
      const t = hub.store.list({ kind: "task" }).find((x) => /ender/i.test(String(x.fields.title)));
      const b = t?.fields.block as { start?: string } | undefined;
      if (!b?.start) return "not scheduled";
      const h = new Date(b.start).getHours();
      const enders = hub.store.list({ kind: "task" }).filter((x) => /ender/i.test(String(x.fields.title)));
      if (enders.length > 1) return "created a duplicate task";
      return h >= 17 ? null : `scheduled at ${b.start}, not evening`;
    } },
  { id: "plain", ask: "In two sentences, what's the difference between RAID 5 and RAID 6?", expect: [],
    check: ({ out }) => (out.actions ?? []).some((a) => a.writes) ? "changed data nobody asked for" : null },
  { id: "remember", ask: "Remember that my preferred terminal font is JetBrains Mono.", expect: ["remember"],
    check: ({ hub }) => hub.store.list({ kind: "fact" }).some((f) => /jetbrains/i.test(String(f.fields.value))) ? null : "fact not saved" },
  { id: "inventory", ask: "Add 3 ESP32 dev boards to my parts inventory.", expect: ["create_item"],
    check: ({ hub }) => hub.store.list({ kind: "inventory" }).some((i) => /esp32/i.test(String(i.fields.name)) && Number(i.fields.qty) === 3) ? null : "inventory item missing or wrong qty" },
  { id: "host-read", ask: "How much disk space is free on benchhost?", expect: ["run_command"],
    check: ({ out, hub }) => out.pending_action ? "a read-only check was held for approval" : /\d/.test(out.reply) && hub.ai.hosts.pendingFor("bench-host-read") === null ? null : "no numbers in the answer" },
  { id: "host-change", ask: "Restart the cron service on benchhost.", expect: ["run_command"],
    check: ({ out }) => out.pending_action && /restart/i.test(out.pending_action.command) ? null : "the change was not held for approval" },
  ...(process.env.EA_BENCH_SEARXNG ? [{ id: "web", ask: "What is the latest stable Linux kernel version? Look it up.", expect: ["web_search"],
    check: ({ out }: { out: ChatOutput }) => /\b[67]\.\d+/.test(out.reply) ? null : "no version in the answer" } as Case] : []),
];

function freshHub(model: string, think: string) {
  process.env.EA_NO_DOTENV = "1";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-bench-"));
  fs.writeFileSync(path.join(dir, "hosts.json"), JSON.stringify([{ name: "benchhost", local: true }]));
  const cfg = loadConfig({ dataDir: dir, token: TOKEN, aiFake: false, logRequests: false, ollamaUrl: OLLAMA, ollamaModel: model, ollamaThink: think,
    ollamaKeepAlive: "30m", anthropicApiKey: "", adapterUrl: "", aiTimeoutMs: 240000, ollamaNumCtx: Number(process.env.EA_BENCH_CTX ?? 32768),
    searxngUrl: process.env.EA_BENCH_SEARXNG ?? "", sshConfigPath: path.join(dir, "no-ssh-config"), hostsFile: path.join(dir, "hosts.json") } as any);
  const hub = createHub(cfg);
  createApp(hub); // wires the tools
  runSeeds(hub.store, cfg);
  hub.store.create("task", { title: "Rebuild the NAS array", status: "next", order: 1 });
  hub.store.create("task", { title: "Ender 3 tuning", status: "next", order: 2 });
  hub.store.create("task", { title: "Write the cover letter for the sysadmin role", status: "inbox", order: 3 });
  hub.store.create("note", { title: "Gain staging basics", path: "Music/Gain staging basics.md", body: "Keep tracks peaking around -18 dBFS so plugins see a nominal level. Set the input gain on the interface first, then trim each channel with the pre-gain knob, not the fader. Leave 6 dB of headroom on the master bus before mastering." });
  return { hub, dir };
}

async function main() {
  const specs = process.argv.slice(2).map((a) => { const [model, think = ""] = a.split("="); return { model, think }; });
  if (!specs.length) throw new Error("pass model[=think] arguments");
  const rows: string[] = [];
  for (const { model, think } of specs) {
    // Warm the model so load time is measured once, separately.
    const w0 = Date.now();
    await fetch(`${OLLAMA}/api/chat`, { method: "POST", body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], stream: false, keep_alive: "30m", ...(think ? { think: think === "true" ? true : think === "false" ? false : think } : {}) }) }).then((r) => r.text());
    const loadMs = Date.now() - w0;
    let pass = 0, toolOk = 0, emdash = 0, totalMs = 0, outTok = 0, genMs = 0;
    const fails: string[] = [];
    for (const c of CASES) {
      const { hub, dir } = freshHub(model, think);
      const t0 = Date.now();
      let out: ChatOutput | null = null;
      let firstTok = 0;
      let err = "";
      try {
        out = await hub.ai.chat({ session_id: `bench-${c.id}`, message: c.ask }, () => { if (!firstTok) firstTok = Date.now() - t0; });
      } catch (e) { err = (e as Error).message; }
      const ms = Date.now() - t0;
      totalMs += ms;
      const calls = out?.actions?.map((a) => a.tool) ?? [];
      const toolsRight = c.expect.every((t) => calls.includes(t)) && (c.expect.length > 0 || calls.length === 0);
      const allOk = (out?.actions ?? []).every((a) => a.ok);
      const extra = out && c.check ? c.check({ out, hub }) : null;
      const replyOk = !!out?.reply?.trim();
      const ok = !err && toolsRight && replyOk && !extra;
      if (ok) pass++; else fails.push(c.id);
      if (toolsRight) toolOk++;
      if (out && /—/.test(out.reply)) emdash++;
      const row = hub.chatDb.prepare("SELECT prompt_tokens, completion_tokens, ms FROM ai_calls ORDER BY rowid DESC LIMIT 1").get() as { completion_tokens: number | null; ms: number } | undefined;
      if (row?.completion_tokens) { outTok += row.completion_tokens; genMs += row.ms; }
      console.error(JSON.stringify({ model, think, case: c.id, ok, ms, first_token_ms: firstTok || null, calls, all_calls_ok: allOk, check: extra, error: err || undefined, reply: out?.reply?.slice(0, 300) }));
      hub.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    rows.push(`${model.padEnd(22)} think=${(think || "default").padEnd(7)} pass ${pass}/${CASES.length}  right-tools ${toolOk}/${CASES.length}  avg ${(totalMs / CASES.length / 1000).toFixed(1)}s  ~${genMs ? Math.round(outTok / (genMs / 1000)) : 0} tok/s  load ${(loadMs / 1000).toFixed(1)}s  fails: ${fails.join(",") || "none"}`);
    // Free the GPU for the next candidate.
    await fetch(`${OLLAMA}/api/generate`, { method: "POST", body: JSON.stringify({ model, keep_alive: 0 }) }).then((r) => r.text()).catch(() => "");
  }
  console.log(rows.join("\n"));
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
