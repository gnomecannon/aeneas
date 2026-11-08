import { chartGeometry, formatNumber, formatValue, type ChartKind, type ChartPoint } from "../lib/dashboard";

/** The numbers beside the chart carry short units (lb, %, C) but not words (steps, tasks): the title says those. */
function scaleLabel(v: number, unit: string): string {
  return /^[a-z]{4,}$/.test(unit) ? formatNumber(v) : formatValue(v, unit);
}

/**
 * A line or bar chart in plain SVG, sized by its container. Used by the Dashboard tiles and the sensor graphs on
 * Ops. `bounds` draws dashed thresholds (a sensor's min and max); `axis` labels the two ends under the chart.
 */
export function Chart({
  points,
  kind,
  unit = "",
  bounds = [],
  height = 96,
  axis,
  label,
}: {
  points: ChartPoint[];
  kind: ChartKind;
  unit?: string;
  bounds?: number[];
  height?: number;
  axis?: [string, string];
  label: string;
}) {
  const w = 320;
  const g = chartGeometry(points, { kind, width: w, height, pad: 6, bounds });
  if (g.empty) return <div className="chart-empty muted small">No readings in this range.</div>;
  const vals = points.map((p) => p.value).filter((v): v is number => v != null);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const summary = `${label}: ${vals.length} ${vals.length === 1 ? "reading" : "readings"}, low ${formatValue(lo, unit)}, high ${formatValue(hi, unit)}`;
  return (
    <figure className="chart">
      <div className="chart-scale muted" aria-hidden="true">
        <span>{scaleLabel(hi, unit)}</span>
        <span>{scaleLabel(kind === "bar" ? Math.min(0, lo) : lo, unit)}</span>
      </div>
      <svg viewBox={`0 0 ${w} ${height}`} role="img" aria-label={summary} className={`chart-svg ${kind}`}>
        {g.bounds.map((b) => (
          <line key={b.value} className="bound" x1={0} x2={w} y1={b.y} y2={b.y} />
        ))}
        {kind === "bar" && <line className="base" x1={0} x2={w} y1={g.baseline} y2={g.baseline} />}
        {g.bars.map((b, i) => (
          <rect key={i} x={b.x} y={b.y} width={b.w} height={b.h} rx={Math.min(2, b.w / 3)}>
            <title>{`${b.label}: ${formatValue(b.value, unit)}`}</title>
          </rect>
        ))}
        {g.path && <path d={g.path} />}
        {g.dots.map((d, i) => (
          <circle key={i} cx={d.cx} cy={d.cy} r={2.4}>
            <title>{`${d.label}: ${formatValue(d.value, unit)}`}</title>
          </circle>
        ))}
      </svg>
      {axis && (
        <figcaption className="chart-axis muted" aria-hidden="true">
          <span>{axis[0]}</span>
          <span>{axis[1]}</span>
        </figcaption>
      )}
    </figure>
  );
}
