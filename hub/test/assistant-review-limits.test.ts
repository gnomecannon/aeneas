import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
// Each case was a finding of the 2026-11-05 review of the assistant (tools, chat loop, cloud residency); each fails on the code before the fix.
const R = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const { makeHub } = await import(`${R}/test/helpers.ts`);
const { setBackendOverride } = await import(`${R}/src/ai/backends.ts`);
const { estimateTokens } = await import(`${R}/src/ai/history.ts`);

test("L1 tool results inside one turn are not counted: one turn sends far more than num_ctx", async () => {
  const t = makeHub({ ollamaNumCtx: 32768 });
  try {
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push(t.hub.store.create("note", { title: `Long note ${i}`, body: `line ${i} `.repeat(4000), tags: [], path: `Inbox/Long ${i}.md` }).id);
    let round = 0;
    const sizes: number[] = [];
    let callsRun = 0;
    const b: any = {
      name: "ollama", model: "scripted",
      chat: async () => ({ text: "", usage: {} }), stream: async () => ({ text: "done", usage: {} }),
      streamTools: async (msgs: any[], tools: unknown[]) => {
        sizes.push(estimateTokens(msgs.map((m) => m.content).join("")) + estimateTokens(JSON.stringify(tools)));
        callsRun = msgs.filter((m) => m.role === "tool").length;
        if (round++ === 0) return { text: "", usage: {}, tool_calls: ids.map((id) => ({ function: { name: "get_item", arguments: { id } } })) };
        return { text: "Read them.", usage: {} };
      },
    };
    setBackendOverride(b);
    await t.hub.ai.chat({ session_id: "l1", message: "compare my long notes", task_type: "general" } as any);
    assert.ok(Math.max(...sizes) <= t.hub.cfg.ollamaNumCtx, "a request bigger than the model's context");
  } finally { setBackendOverride(null); t.cleanup(); }
});

test("L2 the resume card is written by a chat with every write tool on, and a card line like 'Changed ...' triggers the 'make the tool call now' nudge", async () => {
  const t = makeHub();
  try {
    const p = t.hub.store.create("project", { name: "Fan controller", status: "active", definition_of_done: "fans quiet" });
    t.hub.ai.sessions.save("l2", "general", [{ role: "user", content: "the fans are loud" }, { role: "assistant", content: "Lower the curve." }] as any);
    const seen: any[] = [];
    let offered = 0;
    let round = 0;
    const b: any = {
      name: "ollama", model: "scripted",
      chat: async () => ({ text: "## Where I left off\nChanged the fan curve to 40%.\n## What to do next\nOrder a quieter fan.\n## Open questions\nNone.", usage: {} }), stream: async () => ({ text: "", usage: {} }),
      streamTools: async (msgs: any[], tools: unknown[]) => {
        offered = tools.length; seen.push(msgs[msgs.length - 1]);
        if (round++ === 0) return { text: "## Where I left off\nChanged the fan curve to 40%.\n## What to do next\nAdd a task to order a quieter fan.", usage: {} };
        return { text: "", usage: {}, tool_calls: [{ function: { name: "create_task", arguments: { title: "Order a quieter fan" } } }] };
      },
    };
    setBackendOverride(b);
    await t.hub.ai.resumeCard(p.id, "l2");
    const tasks = t.hub.store.list({ kind: "task" }).map((x: any) => x.fields.title);
    assert.equal(offered, 0, "a summary call gets write tools");
    assert.deepEqual(tasks, [], "writing a card made a task");
    assert.match(String(t.hub.store.get(p.id)!.fields.resume_card), /Where I left off/);
  } finally { setBackendOverride(null); t.cleanup(); }
});
