import fs from "node:fs";
import path from "node:path";
import type { AiMessage, Backend, BackendSet } from "./ai/backends.js";

/**
 * Who the hub belongs to. The prompts, tool descriptions and the hub's own notes to a model say `{{owner}}` where the
 * owner's name goes and `{{pet}}` where the pet's goes; the hub puts the owner's name in place of `{{owner}}` in
 * everything it sends a model, and the pet's name (or "the pet" when none is named) in place of `{{pet}}` in system
 * messages and tool descriptions only, never in what the owner typed. Set on the setup page or with EA_OWNER_NAME.
 */
/** `contact`: shown on the public privacy page (Google's sign-in screen links to it). */
export interface Profile { name: string; pet: string; contact?: string }

/** Where the owner's name goes in the hub's own words to a model. Never typed by anyone, so it is replaced anywhere. */
export const OWNER = "{{owner}}";
const WRITTEN_AS = /\{\{owner\}\}/g;
/** Where the pet's name goes in the hub's own words to a model. */
export const PET = "{{pet}}";
const PET_WRITTEN_AS = /\{\{pet\}\}/g;
export type Names = () => { owner: string; pet: string };

export class ProfileStore {
  constructor(private file: string, private fallbackName: string) {}

  get(): Profile {
    try {
      const p = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<Profile>;
      const pet = typeof p.pet === "string" ? p.pet.trim() : "";
      const contact = typeof p.contact === "string" && p.contact.trim() ? { contact: p.contact.trim() } : {};
      if (typeof p.name === "string" && p.name.trim()) return { name: p.name.trim(), pet, ...contact };
      return { name: this.fallbackName, pet, ...contact };
    } catch { /* not set up yet */ }
    return { name: this.fallbackName, pet: "" };
  }

  /** Change the name, the pet's name (empty: no pet), or both. */
  set(p: Partial<Profile>): Profile {
    const clean = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, 60) : undefined);
    const prev = this.named() ? this.get() : { name: "", pet: this.get().pet };
    const name = clean(p.name) ?? prev.name;
    const pet = clean(p.pet) ?? prev.pet;
    const contact = clean(p.contact) ?? this.get().contact ?? "";
    if (!name) throw new Error("a name is required");
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const out: Profile = { name, pet, ...(contact ? { contact } : {}) };
    // Beside and renamed, so a crash mid-write never leaves the owner's name half written.
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(out, null, 2), { mode: 0o600 });
    fs.renameSync(`${this.file}.tmp`, this.file);
    return out;
  }

  /** Whether the owner has been named (setup done), rather than the fallback. */
  named(): boolean {
    try { return !!(JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<Profile>).name; } catch { return false; }
  }
}

/** The hub's own words, with the owner's name in place of `{{owner}}`. */
export function named(text: string, owner: string): string {
  return text && text.includes(OWNER) ? text.replace(WRITTEN_AS, owner) : text;
}

/** Text written about `{{owner}}` and `{{pet}}`, about the owner and their pet instead ("the pet" when there is none). */
export function personalize(text: string, owner: string, pet = ""): string {
  if (!text) return text;
  const out = named(text, owner);
  return out.includes(PET) ? out.replace(PET_WRITTEN_AS, pet || "the pet") : out;
}

/**
 * System messages are the hub's own: the owner's and the pet's names go in. Other turns get the owner's name only
 * where the hub wrote `{{owner}}` (its checks, context notes and tool results).
 */
function personalMessages(messages: AiMessage[], names: Names): AiMessage[] {
  const n = names();
  return messages.map((m) => {
    const content = m.role === "system" ? personalize(m.content, n.owner, n.pet) : named(m.content, n.owner);
    return content === m.content ? m : { ...m, content };
  });
}

function personalTools(tools: unknown[], names: Names): unknown[] {
  const n = names();
  const json = JSON.stringify(tools);
  const out = personalize(json, JSON.stringify(n.owner).slice(1, -1), n.pet && JSON.stringify(n.pet).slice(1, -1));
  return out === json ? tools : JSON.parse(out) as unknown[];
}

/** A backend that speaks of the owner by name in its system messages and tool descriptions. */
export function personalBackend(b: Backend, owner: Names): Backend {
  return {
    ...b,
    chat: (messages, opts) => b.chat(personalMessages(messages, owner), opts),
    stream: (messages, onToken, opts) => b.stream(personalMessages(messages, owner), onToken, opts),
    ...(b.streamTools ? { streamTools: (messages: AiMessage[], tools: unknown[], onToken: (t: string) => void, opts?: { signal?: AbortSignal }) => b.streamTools!(personalMessages(messages, owner), personalTools(tools, owner), onToken, opts) } : {}),
    ...(b.warm ? { warm: (messages: AiMessage[], tools: unknown[]) => b.warm!(personalMessages(messages, owner), personalTools(tools, owner)) } : {}),
  };
}

export function personalBackends(set: BackendSet, owner: Names): BackendSet {
  const wrap = (b: Backend | null | undefined) => (b ? personalBackend(b, owner) : (b ?? null));
  return { ollama: wrap(set.ollama), ollamaFallback: wrap(set.ollamaFallback), anthropic: wrap(set.anthropic), adapter: wrap(set.adapter), openai: wrap(set.openai) };
}
