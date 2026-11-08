import { nowIso } from "@everythingapp/shared";
import type { Entity } from "@everythingapp/shared";
import type { Store } from "../store.js";

/**
 * The owner saying the last step failed. "still" and "same" count only as "still broken", "same error" and the like:
 * alone they marked a fix that worked as ruled out ("That fixed it! Still not sure why it broke.").
 */
export const FAILURE_PHRASES = /\b(didn'?t work|didn’t work|did not work|doesn'?t work|no change|nope|(the )?same (error|thing|problem|issue|result|message)|same as before|still (not|doesn'?t|won'?t|isn'?t|can'?t|broken|failing|fails|the same|happening|getting|seeing|there|no))\b/i;

interface Tried { at: string; what: string; result: string }

/** Find or create the open ledger for a session. */
export function openLedger(store: Store, sessionId: string, topic: string): Entity {
  const existing = store.list({ kind: "ledger", where: { session_id: sessionId } }).find((l) => l.fields.open !== false);
  if (existing) return existing;
  return store.create("ledger", { session_id: sessionId, topic: topic.slice(0, 120) || "untitled", tried: [], ruled_out: [], confirmed: [], open: true });
}

/** If the user's latest message reports failure, close the last pending entry and rule it out. */
/** The owner says it worked: a statement, not a question, and not "still not working" or "didn't fix it". */
export function saysWorked(msg: string): boolean {
  const t = msg.trim();
  return /\b(work(s|ed)( now| again| great| perfectly)?|fixed( it)?|solved( it)?|did (it|the trick)|all good now|that did it)\b/i.test(t)
    && !/\?\s*$/.test(t)
    && !/(\bnot|n't|\bnever|\bstill)[^.!?]{0,20}\b(work|fix|solve)/i.test(t);
}

export function recordFailure(store: Store, ledger: Entity, userText: string): Entity {
  // A message that says it worked is never also a failure ("That fixed it! Still not sure why it broke.").
  if (saysWorked(userText)) return ledger;
  const m = FAILURE_PHRASES.exec(userText);
  if (!m) return ledger;
  const tried: Tried[] = Array.isArray(ledger.fields.tried) ? [...ledger.fields.tried] : [];
  const idx = tried.map((t) => t.result).lastIndexOf("pending");
  if (idx < 0) return ledger;
  tried[idx] = { ...tried[idx], result: m[0].toLowerCase() };
  const ruled = new Set<string>(Array.isArray(ledger.fields.ruled_out) ? ledger.fields.ruled_out : []);
  ruled.add(tried[idx].what);
  return store.patch(ledger.id, { tried, ruled_out: [...ruled] });
}

/** Pull the one or two suggested steps out of a reply: numbered lines first, else the first two sentences. */
export function extractSteps(reply: string): string {
  const numbered = reply.split(/\r?\n/).map((l) => /^\s*(?:\d+[.)]|[-*])\s+(.+)$/.exec(l)?.[1]?.trim()).filter((s): s is string => !!s);
  if (numbered.length) return numbered.slice(0, 2).join("; ");
  const plain = reply.replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim();
  const sentences = plain.match(/[^.!?]+[.!?]+/g) ?? [plain];
  return sentences.slice(0, 2).map((s) => s.trim()).filter(Boolean).join(" ").slice(0, 300);
}

export function appendPending(store: Store, ledger: Entity, reply: string): Entity {
  const what = extractSteps(reply);
  if (!what) return ledger;
  const tried: Tried[] = Array.isArray(ledger.fields.tried) ? [...ledger.fields.tried] : [];
  tried.push({ at: nowIso(), what, result: "pending" });
  return store.patch(ledger.id, { tried });
}
