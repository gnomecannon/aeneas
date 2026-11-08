export interface Point {
  at: string;
  value: number;
}

/**
 * Sparkline over the last `days` days (or `hours` hours). Plain SVG, no library. `lines` draws dashed
 * horizontal bounds (a sensor's min and max) and widens the y range to include them.
 */
export function Sparkline({ points, days = 7, hours, lines = [] }: { points: Point[]; days?: number; hours?: number; lines?: number[] }) {
  const w = 300;
  const h = 40;
  const pad = 4;
  const end = Date.now();
  const start = end - (hours != null ? hours * 3600_000 : days * 86400_000);
  const pts = points.filter((p) => new Date(p.at).getTime() >= start && Number.isFinite(p.value)).sort((a, b) => (a.at < b.at ? -1 : 1));
  const label = hours != null ? `${hours}h` : `${days}d`;
  if (!pts.length) return <div className="muted small">no data in {label}</div>;
  const vals = pts.map((p) => p.value);
  const bounds = lines.filter((v) => Number.isFinite(v));
  const min = Math.min(...vals, ...bounds);
  const max = Math.max(...vals, ...bounds);
  const span = max - min || 1;
  const x = (at: string) => pad + ((new Date(at).getTime() - start) / (end - start)) * (w - 2 * pad);
  const y = (v: number) => h - pad - ((v - min) / span) * (h - 2 * pad);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${x(p.at).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const dense = pts.length > 60;
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={`${pts.length} points, min ${Math.min(...vals)}, max ${Math.max(...vals)}`}>
      {bounds.map((v) => (
        <line key={v} className="bound" x1={pad} x2={w - pad} y1={y(v)} y2={y(v)} />
      ))}
      {pts.length > 1 && <path d={d} />}
      {!dense && pts.map((p, i) => <circle key={i} cx={x(p.at)} cy={y(p.value)} r={2} />)}
    </svg>
  );
}
