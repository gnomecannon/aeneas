import { useSyncState } from "../sync/hooks";
import { engine } from "../sync/engine";
import { go } from "../lib/router";
import { lastSynced, pairAgainText } from "../lib/lastSynced";

/**
 * The hub refused this device's key without saying it was removed, or its address now leads to another hub: only
 * pairing again helps, and the reason used to sit only in the status dot's tooltip. Pair again opens the pairing
 * screen with the hub's address kept (`#/setup?again=1`); nothing here is signed out or emptied.
 */
export function PairAgainBanner() {
  const s = useSyncState();
  const text = pairAgainText(s.pairing, s.status);
  if (!text) return null;
  const last = lastSynced(s.syncedAt);
  return (
    <div className="banner" role="alert">
      <div className="grow col" style={{ gap: 2 }}>
        <strong>{text.title}</strong>
        <span className="small muted">{text.detail}{last ? ` ${last[0].toUpperCase()}${last.slice(1)}.` : ""}</span>
      </div>
      <button type="button" className="primary" onClick={() => go("/setup?again=1")}>Pair again</button>
      <button type="button" onClick={() => void engine.cycle()}>Retry</button>
    </div>
  );
}
