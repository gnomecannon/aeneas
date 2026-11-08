import { useEffect, useState } from "react";
import { engine } from "./engine";
import type { PreflightCheck } from "./api";

export type PreflightHit = Extract<PreflightCheck, { destructive: true }>;

/**
 * POST /preflight for a command typed by hand. The hub owns the rule table (hub/src/preflight.ts), so the wording matches
 * the assistant's. Null when the text is blank, harmless, or the hub cannot be asked (offline, older hub): no warning then.
 */
export async function checkPreflight(text: string, client: { preflight(text: string): Promise<PreflightCheck> } | null | undefined): Promise<PreflightHit | null> {
  if (!text.trim() || !client) return null;
  try {
    const r = await client.preflight(text);
    return r && r.destructive ? r : null;
  } catch {
    return null;
  }
}

/** The rollback line without its "Rollback: " label, ready for the journal's rollback field. */
export const rollbackText = (hit: PreflightHit) => hit.rollback.replace(/^Rollback:\s*/, "");

/** The check for a field as it is typed, asked a moment after typing stops. */
export function usePreflight(text: string, delayMs = 400): PreflightHit | null {
  const [hit, setHit] = useState<PreflightHit | null>(null);
  useEffect(() => {
    let off = false;
    if (!text.trim()) {
      setHit(null);
      return;
    }
    const t = setTimeout(() => {
      void checkPreflight(text, engine.client).then((r) => !off && setHit(r));
    }, delayMs);
    return () => {
      off = true;
      clearTimeout(t);
    };
  }, [text, delayMs]);
  return hit;
}
