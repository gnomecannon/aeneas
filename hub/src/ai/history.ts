import type { StoredMessage } from "./sessions.js";

/**
 * Keeping long chats inside the model's context window.
 *
 * Ollama silently drops the oldest tokens when a request is longer than num_ctx, and the oldest token is the
 * system prompt with the owner's rules and facts. So the hub never sends more than fits: recent turns go verbatim,
 * older turns are folded into a rolling summary that rides in the system prompt.
 */

/** Rough token count. qwen-family tokenizers average about 3.5 characters per token on English and code. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/** Tokens kept free for the model's reply, its thinking included. */
export const REPLY_RESERVE = 6000;
/**
 * Tokens kept free inside one turn for what tools return. The window of earlier turns is planned without them, so a
 * full window still leaves tool results this much room before fitToolResults cuts them.
 */
export const TOOL_RESULT_ROOM = 4096;
/**
 * What the context floor allows for the system prompt: the hub's own instructions and tool guide (about 2,000 tokens),
 * then the owner's rules, facts and list names and a long chat's summary.
 */
export const SYSTEM_ALLOWANCE = 4096;
/** What the context floor allows for the conversation itself, the newest turns sent word for word. */
export const HISTORY_ALLOWANCE = 4096;
/** Context sizes are whole multiples of this. */
const CONTEXT_STEP = 8192;

/**
 * The smallest context that holds the system prompt, the tools (`toolTokens`, every tool the hub can offer), a reply,
 * tool results and some history, rounded up to a multiple of 8192. A smaller EA_OLLAMA_NUM_CTX is raised to it: with
 * 8192, the tool list alone filled the context and Ollama dropped the system prompt from every request.
 */
export function contextFloor(toolTokens: number): number {
  const need = toolTokens + SYSTEM_ALLOWANCE + REPLY_RESERVE + TOOL_RESULT_ROOM + HISTORY_ALLOWANCE;
  return Math.ceil(need / CONTEXT_STEP) * CONTEXT_STEP;
}

/**
 * Text cut to at most `max` characters (and the note) by leaving out its middle: a quarter from the start, the rest
 * from the end, where a command's errors are.
 */
export function trimMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max / 4);
  return `${text.slice(0, head)}\n... [${text.length - max} characters cut from the middle] ...\n${text.slice(text.length - (max - head))}`;
}

/** Tools whose results are command output: cut in the middle, so the end (the error) stays. */
const COMMAND_TOOLS = new Set(["run_command", "approve_command"]);

/**
 * Cut the largest tool results until a request fits `limit` tokens (with `fixed` tokens of tool specs on top), so
 * a round of many calls (twelve get_item results) never sends a local model more than its context, which it would
 * silently truncate from the start. Each cut keeps the head (command output its head and end) and says how much was
 * shown. Returns how many were cut.
 */
export function fitToolResults(messages: { role: string; content: string; tool_name?: string }[], fixed: number, limit: number): number {
  const total = () => fixed + messages.reduce((n, m) => n + estimateTokens(m.content ?? ""), 0);
  let cut = 0;
  for (let guard = 0; guard < 100 && total() > limit; guard++) {
    let idx = -1;
    let size = 0;
    messages.forEach((m, i) => { if (m.role === "tool" && (m.content ?? "").length > 1000 && m.content.length > size) { idx = i; size = m.content.length; } });
    if (idx < 0) break;
    const over = Math.ceil((total() - limit) * 3.5);
    const keep = Math.max(800, size - over - 200);
    if (keep >= size) break;
    const m = messages[idx];
    messages[idx] = { ...m, content: COMMAND_TOOLS.has(m.tool_name ?? "")
      ? `${trimMiddle(m.content, keep)}\n[cut to fit the model's context: ${keep} of ${size} characters shown, the middle left out]`
      : `${m.content.slice(0, keep)}\n[cut to fit the model's context: ${keep} of ${size} characters shown]` };
    cut++;
  }
  return cut;
}

/** Vision models spend roughly this many tokens per attached image. */
export const IMAGE_TOKENS = 1200;

export function messageTokens(m: Pick<StoredMessage, "content" | "images">): number {
  return estimateTokens(m.content) + 8 + (m.images?.length ?? 0) * IMAGE_TOKENS;
}

export interface WindowPlan {
  /** Index of the first message sent verbatim. Everything before it must be in the summary. */
  start: number;
  /** True when messages between the stored summary and `start` still need summarizing. */
  needsSummary: boolean;
}

/**
 * When older turns must be summarized, the share of the budget kept word for word. The rest is room for the next
 * turns: a window filled to the whole budget needed another summary on the very next turn, so a long chat waited
 * for a summary on every message.
 */
export const KEEP_AFTER_SUMMARY = 0.5;

type WindowMessage = Pick<StoredMessage, "role" | "content" | "images">;

/** The first message of the newest run that fits `budget` (at least the newest `minKeep`), never an assistant turn. */
function fitStart(messages: WindowMessage[], budget: number, minKeep: number): number {
  let used = 0;
  let start = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const cost = messageTokens(messages[i]);
    const mustKeep = messages.length - i <= minKeep;
    if (!mustKeep && used + cost > budget) break;
    used += cost;
    start = i;
  }
  while (start > 0 && start < messages.length && messages[start].role === "assistant") start++;
  return start;
}

/**
 * Pick the verbatim window: walk back from the newest message until `budget` tokens are used.
 * Always keeps at least the newest `minKeep` messages (the turn being answered must go in whole).
 * A window never starts on an assistant turn, so the model always sees what was asked.
 * When turns past the stored summary no longer fit, only about half the budget stays word for word
 * (KEEP_AFTER_SUMMARY) and the rest goes into the summary, so the next several turns fit without another one.
 */
export function planWindow(messages: WindowMessage[], summaryUpto: number, budget: number, minKeep = 2): WindowPlan {
  const start = fitStart(messages, budget, minKeep);
  if (start <= summaryUpto) return { start: Math.min(start, messages.length), needsSummary: false };
  return { start: fitStart(messages, Math.floor(budget * KEEP_AFTER_SUMMARY), minKeep), needsSummary: true };
}

export const SUMMARY_SYSTEM = [
  "You compress the earlier part of a conversation between {{owner}} and their assistant so the assistant can keep going without it.",
  "Write plain notes, no preamble, under 350 words. Keep: what {{owner}} is trying to do, decisions made, facts they stated,",
  "hosts, paths, commands, versions and error messages that matter, what was tried and failed (never to be suggested again),",
  "what worked, and what is still open. Drop greetings and repetition. Never invent anything.",
].join(" ");

/** The user message for a summary call: the previous summary plus the turns being folded in. */
export function summaryPrompt(previous: string | null, turns: StoredMessage[]): string {
  const text = turns.map((m) => `${m.role === "user" ? "{{owner}}" : "Assistant"}: ${m.content}${m.images?.length ? ` [${m.images.length} image(s)]` : ""}`).join("\n\n");
  return `${previous ? `Summary so far:\n${previous}\n\nAdd these later turns to it:\n` : "Turns to summarize:\n"}${text.slice(-60_000)}`;
}

/** Last-resort summary when no model answers: the user's own lines, newest last, trimmed. */
export function fallbackSummary(previous: string | null, turns: StoredMessage[]): string {
  const lines = turns.filter((m) => m.role === "user").map((m) => `- ${m.content.replace(/\s+/g, " ").slice(0, 200)}`);
  return [previous ?? "", "Earlier requests (summary model unavailable):", ...lines].filter(Boolean).join("\n").slice(-4000);
}
