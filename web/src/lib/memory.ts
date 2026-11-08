/**
 * Module 2 helpers: snippet parameters, pre-flight blocks in replies, host detection and the
 * host summary the hub derives (also used by the mock hub and as the offline fallback).
 */
import type { Entity } from "@everythingapp/shared";

export type SnippetParam = { name: string; default?: string; description?: string };
export type SnippetF = { title: string; os: "linux" | "windows" | "macos" | "any"; language: string; body: string; params?: SnippetParam[]; tags?: string[]; host?: string; source_session?: string; last_used?: string };
export type JournalF = { host: string; at: string; what: string; command?: string; risk: "low" | "medium" | "high"; rollback?: string; outcome?: "planned" | "done" | "failed" | "reverted"; session_id?: string; runbook_id?: string };
export type RunbookCommand = { label: string; host: string; user: string; command: string };
export type RunbookF = { host: string; title: string; body?: string; commands?: RunbookCommand[]; last_verified?: string };
export type LedgerF = { session_id: string; topic: string; tried?: Array<{ at: string; what: string; result: string }>; ruled_out?: string[]; confirmed?: string[]; open?: boolean };
export type HostSummary = { host: string; runbooks: number; journal_entries: number; last_change: string | null; snippets: number };
export type SessionClose = { runbook_id?: string; journal_id?: string; journal_ids?: string[]; snippet_ids: string[]; resume_card_written: boolean; summary: string };

const PARAM_RE = /\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/g;

/** Parameter names in a snippet body, in order of first appearance, each once. */
export function paramNames(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(PARAM_RE)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

export type SnippetSegment = { text: string; param?: string };

/** The body split into plain text and `{{name}}` parameter segments, for highlighting. */
export function snippetSegments(body: string): SnippetSegment[] {
  const out: SnippetSegment[] = [];
  let last = 0;
  for (const m of body.matchAll(PARAM_RE)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ text: body.slice(last, i) });
    out.push({ text: m[0], param: m[1] });
    last = i + m[0].length;
  }
  if (last < body.length) out.push({ text: body.slice(last) });
  return out;
}

/**
 * The render form's rows: every declared param plus any `{{name}}` in the body that is not
 * declared, prefilled with the declared default or an empty string.
 */
export function renderDefaults(snippet: Pick<SnippetF, "body" | "params">): Array<{ name: string; value: string; description?: string }> {
  const declared = snippet.params ?? [];
  const names = [...declared.map((p) => p.name)];
  for (const n of paramNames(snippet.body)) if (!names.includes(n)) names.push(n);
  return names.map((name) => {
    const p = declared.find((d) => d.name === name);
    return { name, value: p?.default ?? "", description: p?.description };
  });
}

/** Local stand-in for POST /snippets/:id/render. Throws with the missing names when a value is empty. */
export function renderSnippet(snippet: Pick<SnippetF, "body" | "params">, values: Record<string, string>): string {
  const missing: string[] = [];
  const text = snippet.body.replace(PARAM_RE, (whole, name: string) => {
    const v = values[name] ?? snippet.params?.find((p) => p.name === name)?.default;
    if (v === undefined || v === "") {
      missing.push(name);
      return whole;
    }
    return v;
  });
  if (missing.length) throw new Error(`missing ${[...new Set(missing)].join(", ")}`);
  return text;
}

export type ReplySegment = { preflight: boolean; text: string };

/**
 * Splits an assistant reply so that every block starting with a "Pre-flight" line (through the
 * next blank line) can be shown as a callout.
 */
export function splitPreflight(text: string): ReplySegment[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: ReplySegment[] = [];
  let buf: string[] = [];
  let inPre = false;
  const flush = () => {
    if (buf.length && buf.some((l) => l.trim())) out.push({ preflight: inPre, text: buf.join("\n").replace(/^\n+|\n+$/g, "") });
    buf = [];
  };
  for (const line of lines) {
    const starts = /^\s*(?:[*_#>-]+\s*)?\*{0,2}pre-?flight\b/i.test(line);
    if (starts && !inPre) {
      flush();
      inPre = true;
    } else if (inPre && !line.trim()) {
      flush();
      inPre = false;
      continue;
    }
    buf.push(line);
  }
  flush();
  return out;
}

/**
 * The host most mentioned in a conversation, by whole-word match against known host names
 * (so "pve1.local" and "ssh root@pve1" both count for pve1). Ties go to the first mentioned.
 */
export function detectHost(text: string, hosts: string[]): string | null {
  let best: { host: string; count: number; first: number } | null = null;
  for (const host of hosts) {
    if (!host) continue;
    const re = new RegExp(`(?<![\\w-])${host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "gi");
    let count = 0;
    let first = -1;
    for (const m of text.matchAll(re)) {
      count++;
      if (first < 0) first = m.index ?? 0;
    }
    if (!count) continue;
    if (!best || count > best.count || (count === best.count && first < best.first)) best = { host, count, first };
  }
  return best?.host ?? null;
}

/** What GET /hosts returns, derived from runbook, journal and snippet entities plus `host:<name>` facts. */
export function deriveHosts(entities: Entity[]): HostSummary[] {
  const m = new Map<string, HostSummary>();
  const get = (host: string) => {
    const k = host.trim();
    if (!m.has(k)) m.set(k, { host: k, runbooks: 0, journal_entries: 0, last_change: null, snippets: 0 });
    return m.get(k)!;
  };
  for (const e of entities) {
    if (e.deleted_at) continue;
    if (e.kind === "runbook") get(String(e.fields.host)).runbooks++;
    else if (e.kind === "snippet" && e.fields.host) get(String(e.fields.host)).snippets++;
    else if (e.kind === "journal") {
      const h = get(String(e.fields.host));
      h.journal_entries++;
      const at = String(e.fields.at ?? e.created_at);
      if (!h.last_change || at > h.last_change) h.last_change = at;
    } else if (e.kind === "fact" && /^host:/.test(String(e.fields.key ?? ""))) get(String(e.fields.key).slice(5));
  }
  return [...m.values()].filter((h) => h.host).sort((a, b) => a.host.localeCompare(b.host));
}
