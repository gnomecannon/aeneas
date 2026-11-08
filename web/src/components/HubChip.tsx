import { hubLabel, useHubIdentity } from "../lib/hubIdentity";

/** Whose hub this device is paired with: a dot in the hub's color and its name ("Jamie's hub"). */
export function HubChip({ compact = false }: { compact?: boolean }) {
  const h = useHubIdentity();
  const label = hubLabel(h);
  if (!label || !h?.color) return null;
  return (
    <span className={`hub-chip${compact ? " compact" : ""}`} title={`Paired with ${label}`} aria-label={`Paired with ${label}`}>
      <span className="hub-chip-dot" style={{ background: h.color }} aria-hidden="true" />
      {!compact && <span>{label}</span>}
    </span>
  );
}
