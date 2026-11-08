import { redact, type Entity } from "@everythingapp/shared";
import type { Store } from "../store.js";
import { hostsIn } from "../memory.js";
import type { ActionRow, Host, HostOs } from "./hosts.js";

/**
 * Module 2: snippets as a side effect of getting help. When the owner says a fix worked, the commands that fixed it are
 * kept in Snippets without anyone writing them down: the changes the hub ran for them in this chat, and the shell
 * commands in the assistant's last reply. A command that looks like it holds a secret is never kept.
 */

// saysWorked lives beside the ledger, which needs it too.
export { saysWorked } from "./ledger.js";

const SHELL_LANGS: Record<string, HostOs | "any"> = { bash: "linux", sh: "linux", zsh: "macos", shell: "any", console: "any", powershell: "windows", ps1: "windows", pwsh: "windows" };

/** Shell code blocks in a reply, prompts ("$ ", "PS> ") taken off. Blocks in other languages (yaml, json) are not commands. */
export function codeBlocks(reply: string): { lang: string; body: string }[] {
  const out: { lang: string; body: string }[] = [];
  for (const m of reply.matchAll(/```([a-z0-9]*)[^\n]*\n([\s\S]*?)```/gi)) {
    const lang = m[1].toLowerCase();
    if (lang && !(lang in SHELL_LANGS)) continue;
    const body = m[2].split("\n").map((l) => l.replace(/^\s*(\$|#|PS [^>]*>|PS>)\s+/, "")).join("\n").trim();
    if (body) out.push({ lang: lang || "shell", body });
  }
  return out;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

export interface HarvestInput {
  sessionId: string;
  topic: string;
  previousReply: string;
  /** Changes the hub ran for the owner in this chat. */
  actions: ActionRow[];
  hosts: Host[];
  privateLiterals: string[];
}

/** Save the commands that fixed it. Returns the snippets made (none twice: a command already saved is skipped). */
export function harvestSnippets(store: Store, input: HarvestInput): Entity[] {
  const have = new Set(store.list({ kind: "snippet", limit: 100000 }).map((s) => norm(String(s.fields.body ?? ""))));
  const byName = new Map(input.hosts.map((h) => [h.name, h]));
  const topic = input.topic.replace(/\s+/g, " ").trim().slice(0, 80) || "Fix from a chat";
  const candidates: { title: string; body: string; os: HostOs | "any"; language: string; host?: string; block?: boolean }[] = [];
  for (const a of input.actions) {
    if (a.kind !== "change" || a.status !== "done") continue;
    const os = byName.get(a.host)?.os ?? "any";
    candidates.push({ title: (a.purpose || topic).slice(0, 100), body: a.command, os, language: os === "windows" ? "powershell" : "bash", host: a.host });
  }
  const named = hostsIn(input.previousReply, input.hosts.map((h) => h.name))[0];
  for (const b of codeBlocks(input.previousReply)) {
    const host = named && byName.get(named);
    const os = SHELL_LANGS[b.lang] === "any" && host ? host.os : SHELL_LANGS[b.lang] ?? "any";
    candidates.push({ title: topic, body: b.body, os, language: b.lang === "shell" || b.lang === "console" ? (os === "windows" ? "powershell" : "bash") : b.lang, ...(host ? { host: host.name } : {}), block: true });
  }
  const kept = candidates.filter((c) => {
    const key = norm(c.body);
    if (key.length < 4 || c.body.length > 4000 || have.has(key)) return false;
    // The model saw private values as [REDACTED:...]; a command holding one, or any secret, is not kept.
    if (c.body.includes("[REDACTED") || redact(c.body, input.privateLiterals).count > 0) return false;
    have.add(key);
    return true;
  });
  const blocks = kept.filter((c) => c.block).length;
  let n = 0;
  return kept.map((c) => store.create("snippet", {
    title: c.block && blocks > 1 ? `${c.title} (${++n})` : c.title, os: c.os, language: c.language, body: c.body, params: [], tags: ["from-chat"],
    source_session: input.sessionId, ...(c.host ? { host: c.host } : {}),
  }));
}
