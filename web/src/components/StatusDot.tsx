import { useSyncState } from "../sync/hooks";

const LABEL: Record<string, string> = { synced: "synced", syncing: "syncing", offline: "offline", setup: "no hub" };

export function StatusDot({ compact = false }: { compact?: boolean }) {
  const s = useSyncState();
  const label = LABEL[s.status] ?? s.status;
  const full = `Hub ${label}${s.outbox > 0 ? `, ${s.outbox} queued` : ""}${s.lastError ? `, ${s.lastError}` : ""}`;
  return (
    <div className="status" role="status" aria-label={full} title={full}>
      <span className={`dot ${s.status}`} aria-hidden="true" />
      {!compact && <span>{label}</span>}
      {s.outbox > 0 && <span className="badge muted">{s.outbox} queued</span>}
    </div>
  );
}
