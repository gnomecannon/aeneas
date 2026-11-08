import { useEffect, useState } from "react";
import { engine } from "../sync/engine";
import { usePoll } from "../lib/usePoll";
import { relative } from "../lib/time";
import { Chart } from "../components/Chart";
import {
  MAX_TILES,
  RANGES,
  addTile,
  dayPoints,
  describeChange,
  describePeriod,
  formatValue,
  moveTile,
  pickerGroups,
  rangeLabel,
  rangeShort,
  readCachedBoard,
  removeTile,
  shortDay,
  tilesOf,
  type Board,
  type BoardTile,
  type ChartKind,
  type MetricInfo,
  type Range,
} from "../lib/dashboard";

const CACHE_KEY = "ea.dashboard.board";
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function readCache(): Board | null {
  try {
    return readCachedBoard(localStorage.getItem(CACHE_KEY));
  } catch {
    return null;
  }
}
function writeCache(b: Board) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(b));
  } catch {
    /* private mode or full: the board still shows */
  }
}

/**
 * The general dashboard: a grid of tiles, each one metric over 7, 30, 90 or 365 days with its newest value and the
 * change against the period before. The tiles are one setting on the hub, so every device shows the same board.
 */
export function Dashboard() {
  const p = usePoll((c) => c.dashboardBoard(), 120_000);
  const [board, setBoard] = useState<Board | null>(readCache);
  const [picking, setPicking] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!p.data) return;
    setBoard(p.data);
    writeCache(p.data);
  }, [p.data]);

  const live = !!p.data;
  const unreachable = !live && !!p.error && !p.unavailable;

  /** Show the change at once, then save the whole board; `fetchAt` is a tile whose series must be read again. */
  const save = async (tiles: BoardTile[], fetchAt?: number) => {
    const next: Board = { tiles, saved: true };
    setBoard(next);
    setErr("");
    const c = engine.client;
    if (!c) {
      setErr("Changes need the hub.");
      return;
    }
    try {
      await c.setDashboardPrefs(tilesOf(tiles));
      let done = next;
      if (fetchAt != null && tiles[fetchAt]) {
        const t = tiles[fetchAt];
        const series = await c.dashboardSeries(t.metric, t.range);
        done = { ...next, tiles: tiles.map((x, i) => (i === fetchAt ? { ...x, series } : x)) };
        setBoard((b) => (b && b.tiles[fetchAt]?.metric === t.metric && b.tiles[fetchAt]?.range === t.range ? { ...b, tiles: b.tiles.map((x, i) => (i === fetchAt ? { ...x, series } : x)) } : b));
      }
      writeCache(done);
    } catch (e) {
      setErr(`Not saved: ${msg(e)}`);
      void p.reload();
    }
  };

  const tiles = board?.tiles ?? [];
  const canEdit = !!engine.client && !unreachable;

  return (
    <div className="dashboard">
      <div className="row between">
        <h1 style={{ margin: 0 }}>Dashboard</h1>
        <span className="muted small">{p.at && live ? `updated ${relative(p.at.toISOString())}` : ""}</span>
        <div className="row">
          <button className="small" onClick={() => void p.reload()} disabled={p.busy}>
            Refresh
          </button>
          <button className="small primary" onClick={() => setPicking((v) => !v)} disabled={!canEdit || tiles.length >= MAX_TILES} aria-expanded={picking}>
            Add tile
          </button>
        </div>
      </div>

      {unreachable && (
        <div className="muted small dash-note" role="status">
          {board ? "The hub is out of reach, so this is the board as this device last saw it. Changes wait until the hub is back." : "The dashboard is drawn by the hub, which is out of reach right now. It fills in when the hub is back."}
        </div>
      )}
      {p.unavailable && <div className="muted small dash-note">The dashboard is not available on this hub yet.</div>}
      {err && <div className="error">{err}</div>}

      {picking && (
        <Picker
          shown={tiles.map((t) => t.metric)}
          onPick={(m) => {
            setPicking(false);
            const next = addTile(tilesOf(tiles), m).map((t, i) => ({ ...t, series: tiles[i]?.series ?? null }));
            void save(next, next.length - 1);
          }}
          onClose={() => setPicking(false)}
        />
      )}

      {board && !tiles.length && !picking && (
        <div className="empty">No tiles yet. Add one to chart weight, sleep, tasks done, a sensor or anything else the hub keeps.</div>
      )}

      <div className="dash-grid">
        {tiles.map((t, i) => (
          <TileCard
            key={`${t.metric}:${i}`}
            tile={t}
            first={i === 0}
            last={i === tiles.length - 1}
            canEdit={canEdit}
            onRange={(range) => {
              const next = tiles.map((x, j) => (j === i ? { ...x, range } : x));
              void save(next, i);
            }}
            onChart={(chart) => void save(tiles.map((x, j) => (j === i ? { ...x, chart } : x)))}
            onMove={(by) => void save(moveTile(tiles, i, by))}
            onRemove={() => void save(removeTile(tiles, i))}
          />
        ))}
      </div>
    </div>
  );
}

function TileCard({
  tile,
  first,
  last,
  canEdit,
  onRange,
  onChart,
  onMove,
  onRemove,
}: {
  tile: BoardTile;
  first: boolean;
  last: boolean;
  canEdit: boolean;
  onRange: (r: Range) => void;
  onChart: (c: ChartKind) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}) {
  const s = tile.series;
  const title = s?.label ?? tile.metric;
  // A range just switched shows the old series until the new one arrives; say so rather than mislabel it.
  const stale = !!s && s.days !== tile.range;
  const change = s ? describeChange(s) : null;
  const today = s?.to;
  return (
    <article className="card dash-tile" aria-label={title}>
      <div className="dash-head">
        <h2 className="dash-title">{title}</h2>
        <div className="dash-tools">
          <button className="small ghost" onClick={() => onMove(-1)} disabled={!canEdit || first} aria-label={`Move ${title} earlier`} title="Move earlier">
            {"↑"}
          </button>
          <button className="small ghost" onClick={() => onMove(1)} disabled={!canEdit || last} aria-label={`Move ${title} later`} title="Move later">
            {"↓"}
          </button>
          <button className="small ghost" onClick={onRemove} disabled={!canEdit} aria-label={`Remove ${title}`} title="Remove">
            Remove
          </button>
        </div>
      </div>
      {!s ? (
        <div className="muted small">Loading</div>
      ) : (
        <>
          <div className="dash-latest">
            <span className="dash-value">{s.latest ? formatValue(s.latest.value, s.unit) : "No data yet"}</span>
            {s.latest && <span className="muted small">{s.latest.day === today ? "today" : shortDay(s.latest.day)}</span>}
          </div>
          {change && <div className={`dash-change small ${change.direction}`}>{change.text}</div>}
          <div className={stale ? "dash-chart stale" : "dash-chart"} aria-busy={stale}>
            <Chart points={dayPoints(s.points)} kind={tile.chart} unit={s.unit} label={`${title}, ${rangeLabel(s.days)}`} axis={[shortDay(s.from), "today"]} />
          </div>
          <div className="muted small">{[describePeriod(s), rangeLabel(tile.range)].filter(Boolean).join(" over ")}</div>
        </>
      )}
      <div className="dash-foot">
        <div className="seg seg-sm" role="group" aria-label={`Range for ${title}`}>
          {RANGES.map((r) => (
            <button key={r} type="button" className={tile.range === r ? "on" : ""} aria-pressed={tile.range === r} disabled={!canEdit} onClick={() => tile.range !== r && onRange(r)} title={rangeLabel(r)}>
              {rangeShort(r)}
            </button>
          ))}
        </div>
        <div className="seg seg-sm" role="group" aria-label={`Chart for ${title}`}>
          {(["line", "bar"] as const).map((c) => (
            <button key={c} type="button" className={tile.chart === c ? "on" : ""} aria-pressed={tile.chart === c} disabled={!canEdit} onClick={() => tile.chart !== c && onChart(c)}>
              {c === "line" ? "Line" : "Bars"}
            </button>
          ))}
        </div>
      </div>
    </article>
  );
}

/** Every metric that has data, grouped as the hub groups them. One already on the board can be added again (another range). */
function Picker({ shown, onPick, onClose }: { shown: string[]; onPick: (m: MetricInfo) => void; onClose: () => void }) {
  const [metrics, setMetrics] = useState<MetricInfo[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let alive = true;
    engine.client
      ?.dashboardMetrics()
      .then((m) => alive && setMetrics(m))
      .catch((e) => alive && setErr(msg(e)));
    return () => {
      alive = false;
    };
  }, []);
  const groups = metrics ? pickerGroups(metrics, shown) : [];
  return (
    <div className="card dash-picker">
      <div className="row between">
        <strong>Add a tile</strong>
        <button className="small ghost" onClick={onClose}>
          Close
        </button>
      </div>
      {err && <div className="error">{err}</div>}
      {!metrics && !err && <div className="muted small">Loading what has data</div>}
      {metrics && !metrics.length && <div className="muted small">Nothing to chart yet. Log something, finish a task or connect a sensor and it shows up here.</div>}
      {groups.map((g) => (
        <section key={g.group}>
          <h3>{g.group}</h3>
          <div className="dash-pick-list">
            {g.metrics.map((m) => (
              <button key={m.id} type="button" className="dash-pick" onClick={() => onPick(m)}>
                <span>{m.label}</span>
                <span className="muted small">
                  {m.count === 1 ? "1 entry" : `${m.count.toLocaleString("en-US")} entries`}
                  {m.shown ? ", on the board" : ""}
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
