import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Each case was a finding of the 2026-11-05 review of the assistant (tools, chat loop, cloud residency); each fails on the code before the fix.
const R = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const { makeHub } = await import(`${R}/test/helpers.ts`);
const { setBackendOverride } = await import(`${R}/src/ai/backends.ts`);
const { estimateTokens } = await import(`${R}/src/ai/history.ts`);
const tick = () => new Promise((r) => setTimeout(r, 5));

function withHosts(t: any, output = "ok") {
  fs.writeFileSync(path.join(t.dir, "hosts.json"), JSON.stringify([{ name: "core", local: true }]));
  t.hub.cfg.hostsFile = path.join(t.dir, "hosts.json");
  t.hub.cfg.hostActions = true;
  t.hub.ai.hosts.runner = async () => ({ exit_code: 0, output, timed_out: false, ms: 5 });
}

test("X1 Cancel tapped while the proposing reply still streams: the stored chat keeps saying the command is waiting", async () => {
  const t = makeHub();
  withHosts(t);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let round = 0;
  let inRound2 = false;
  const b: any = {
    name: "ollama", model: "scripted", chat: async () => ({ text: "", usage: {} }), stream: async () => ({ text: "", usage: {} }),
    streamTools: async () => {
      if (round++ === 0) return { text: "", usage: {}, tool_calls: [{ function: { name: "run_command", arguments: { host: "core", command: "systemctl restart nginx", purpose: "restart nginx", rollback: "none" } } }] };
      inRound2 = true; await gate;
      return { text: "This restarts nginx on core. Approve to run it.", usage: {} };
    },
  };
  setBackendOverride(b);
  try {
    let action: any = null;
    const p = t.hub.ai.chat({ session_id: "x1", message: "restart nginx on core", task_type: "general" } as any, () => {}, (e: any) => { if (e.type === "approval") action = e.action; });
    while (!inRound2) await tick();
    const c = await t.api(`/ai/actions/${action.id}/cancel`, { method: "POST" });
    release();
    await p;
    const s = t.hub.ai.sessions.get("x1")!;
    const last = s.messages[s.messages.length - 1];
    assert.notEqual(last.approval?.status, "pending", "a cancelled command is stored as still waiting");
  } finally { setBackendOverride(null); t.cleanup(); }
});

test("X2 approved command output is not counted when the window is planned", async () => {
  const t = makeHub({ ollamaNumCtx: 16384 });
  withHosts(t, "log line with details\n".repeat(400));
  try {
    const host = t.hub.ai.hosts.host("core");
    const msgs: any[] = [];
    for (let i = 0; i < 12; i++) {
      const a = t.hub.ai.hosts.propose("x2", host, `journalctl -u svc${i} --vacuum-time=1d`, "trim", null);
      await t.hub.ai.hosts.approve(a.id);
      msgs.push({ role: "assistant", content: `Run this ${i}?`, approval: { action_id: a.id, host: "core", command: `journalctl -u svc${i} --vacuum-time=1d`, status: "done" } });
      msgs.push({ role: "user", content: "Yes, run it.", approval: { action_id: a.id, host: "core", command: `journalctl -u svc${i} --vacuum-time=1d`, status: "done", exit_code: 0 } });
    }
    t.hub.ai.sessions.save("x2", "general", msgs);
    let sent = 0;
    const b: any = { name: "ollama", model: "scripted", chat: async () => ({ text: "s", usage: {} }), stream: async () => ({ text: "", usage: {} }),
      streamTools: async (m: any[], tools: unknown[]) => { sent = estimateTokens(m.map((x) => x.content).join("")) + estimateTokens(JSON.stringify(tools)); return { text: "ok", usage: {} }; } };
    setBackendOverride(b);
    await t.hub.ai.chat({ session_id: "x2", message: "what changed?", task_type: "general" } as any);
    assert.ok(sent <= t.hub.cfg.ollamaNumCtx, "the window ignores the command output each approved turn carries");
  } finally { setBackendOverride(null); t.cleanup(); }
});
