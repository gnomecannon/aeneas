import type { AiMessage, Backend } from "../src/ai/backends.js";
import type { ToolContext } from "../src/ai/tools.js";
import type { TestHub } from "./helpers.js";

export function ctxFor(t: TestHub, sessionId = "s-test", lastUser = ""): ToolContext {
  return { sessionId, lastUser, topic: "test", store: t.hub.store, cfg: t.hub.cfg, hosts: t.hub.ai.hosts };
}

type Step = (msgs: AiMessage[]) => { text?: string; calls?: { name: string; arguments: Record<string, unknown> }[] };

/** A scripted model: each tool round returns the next step; plain chat calls return `chatText`. Records what it was sent. */
export function scripted(steps: Step[], chatText = "plain"): Backend & { seen: AiMessage[][]; chats: AiMessage[][]; toolsOffered: number } {
  let i = 0;
  const b = {
    name: "ollama" as const, model: "scripted", seen: [] as AiMessage[][], chats: [] as AiMessage[][], toolsOffered: 0,
    chat: async (msgs: AiMessage[]) => { b.chats.push(msgs.map((m) => ({ ...m }))); return { text: chatText, usage: {} }; },
    stream: async (_m: AiMessage[], on: (t: string) => void) => { on("plain"); return { text: "plain", usage: {} }; },
    streamTools: async (msgs: AiMessage[], tools: unknown[], on: (t: string) => void) => {
      b.seen.push(msgs.map((m) => ({ ...m }))); b.toolsOffered = tools.length;
      const s = steps[Math.min(i++, steps.length - 1)](msgs);
      if (s.text) on(s.text);
      return { text: s.text ?? "", usage: { prompt_tokens: 10, completion_tokens: 5 }, tool_calls: (s.calls ?? []).map((c) => ({ function: c })) };
    },
  };
  return b;
}

/** Parse an SSE body into [event, data] pairs. */
export function sse(raw: string): { event: string; data: any }[] {
  return raw.split("\n\n").map((block) => {
    const ev = /^event: (.+)$/m.exec(block)?.[1];
    const data = /^data: (.+)$/m.exec(block)?.[1];
    return ev && data ? { event: ev, data: JSON.parse(data) } : null;
  }).filter((x): x is { event: string; data: any } => !!x);
}
