export const HOUR = 3600_000;

export function isoNow(): string {
  return new Date().toISOString();
}

export function fmtTime(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function fmtDate(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function fmtDateTime(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  if (isToday(iso)) return fmtTime(iso);
  return `${fmtDate(iso)} ${fmtTime(iso)}`;
}

export function isToday(iso: string): boolean {
  const d = new Date(iso);
  const n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

export function startOfDay(d = new Date()): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/** Relative wording, terse: "in 2h", "3d ago", "now". */
export function relative(iso: string, from = new Date()): string {
  const diff = new Date(iso).getTime() - from.getTime();
  const abs = Math.abs(diff);
  const unit = abs < 60_000 ? "now" : abs < HOUR ? `${Math.round(abs / 60_000)}m` : abs < 24 * HOUR ? `${Math.round(abs / HOUR)}h` : `${Math.round(abs / (24 * HOUR))}d`;
  if (unit === "now") return "now";
  return diff > 0 ? `in ${unit}` : `${unit} ago`;
}

/** Seconds as "3d 4h", "2h 5m", "4m 10s" or "40s". */
export function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

/** Bytes as "12.3 MB"; whole numbers under 1 KB. */
export function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** Hours since an ISO time; Infinity when missing or unparseable. */
export function hoursSince(iso: string | null | undefined, from = new Date()): number {
  if (!iso) return Infinity;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return Infinity;
  return (from.getTime() - t) / HOUR;
}

/** datetime-local input value from an ISO string, in local time. */
export function toLocalInput(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fromLocalInput(v: string): string | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return isNaN(d.getTime()) ? undefined : d.toISOString();
}
