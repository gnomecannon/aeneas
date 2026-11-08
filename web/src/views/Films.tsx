import { useMemo, useState } from "react";
import type { Entity } from "@everythingapp/shared";
import { useEntities } from "../sync/hooks";
import { createEntity, softDelete, updateEntity } from "../sync/edits";
import { CsvButton } from "../components/CsvButton";

/** Films: from Letterboxd (export and diary feed) or added here. Watched films by default, the watchlist one tap away. */

type Sort = "recent" | "rating" | "rewatched" | "title";
const SORTS: Array<[Sort, string]> = [["recent", "Recent"], ["rating", "Rating"], ["rewatched", "Most watched"], ["title", "A to Z"]];
const watchedOn = (e: Entity) => (Array.isArray(e.fields.watched_on) ? (e.fields.watched_on as string[]) : []);
const SORTERS: Record<Sort, (a: Entity, b: Entity) => number> = {
  recent: (a, b) => String(b.fields.last_watched ?? "").localeCompare(String(a.fields.last_watched ?? "")),
  rating: (a, b) => Number(b.fields.rating ?? 0) - Number(a.fields.rating ?? 0) || String(b.fields.last_watched ?? "").localeCompare(String(a.fields.last_watched ?? "")),
  rewatched: (a, b) => watchedOn(b).length - watchedOn(a).length,
  title: (a, b) => String(a.fields.title).localeCompare(String(b.fields.title)),
};

/** Half stars as text: 3.5 → ★★★½. */
export function stars(r: unknown): string {
  const n = typeof r === "number" ? r : 0;
  return n ? "★".repeat(Math.floor(n)) + (n % 1 ? "½" : "") : "";
}

const fmtDay = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
/** Today as YYYY-MM-DD in local time. */
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function Row({ e }: { e: Entity }) {
  const [open, setOpen] = useState(false);
  const f = e.fields as Record<string, unknown>;
  const days = watchedOn(e);
  return (
    <div className="item">
      <div className="body">
        <div className="row">
          <span className="t grow">
            {String(f.title)}
            {f.year ? <span className="muted"> ({String(f.year)})</span> : null}
          </span>
          {f.liked ? <span aria-label="liked" title="liked">♥</span> : null}
          {f.rating ? <span className="stars" aria-label={`${String(f.rating)} stars`}>{stars(f.rating)}</span> : null}
        </div>
        <div className="meta">
          {f.last_watched ? <span>watched {fmtDay(String(f.last_watched))}</span> : f.watchlist && !f.watched ? <span>on the watchlist</span> : <span>watched</span>}
          {days.length > 1 && <span>{days.length} times</span>}
          {Array.isArray(f.tags) && f.tags.length > 0 && <span>{(f.tags as string[]).join(", ")}</span>}
          <button className="ghost small" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={`${open ? "Less" : "More"} about ${String(f.title)}`}>
            {open ? "less" : "more"}
          </button>
        </div>
        {open && (
          <div className="col" style={{ marginTop: 8 }}>
            {f.review ? <blockquote className="small">{String(f.review)}</blockquote> : null}
            {days.length > 0 && <div className="muted small">Watched: {days.slice().reverse().map(fmtDay).join(", ")}</div>}
            <div className="row">
              <button className="small" onClick={() => void updateEntity(e, { watched_on: [...new Set([...days, today()])].sort(), last_watched: today(), watched: true, watchlist: false })}>
                Watched today
              </button>
              {f.url ? (
                <a className="small" href={String(f.url)} target="_blank" rel="noreferrer">
                  Letterboxd
                </a>
              ) : null}
              <button className="small ghost danger" onClick={() => confirm("Delete this film") && void softDelete(e)}>
                Delete
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function Films({ q = "" }: { q?: string }) {
  const all = useEntities("film");
  const [list, setList] = useState<"watched" | "watchlist">("watched");
  const [sort, setSort] = useState<Sort>("recent");
  const [filter, setFilter] = useState(q);
  const [title, setTitle] = useState("");
  const [year, setYear] = useState("");
  const shown = useMemo(
    () =>
      all
        .filter((e) => (list === "watchlist" ? !!e.fields.watchlist && !e.fields.watched : e.fields.watched !== false))
        .filter((e) => !filter.trim() || `${String(e.fields.title)} ${String(e.fields.year ?? "")}`.toLowerCase().includes(filter.trim().toLowerCase()))
        .sort(SORTERS[sort]),
    [all, list, filter, sort],
  );
  const thisYear = String(new Date().getFullYear());
  const watchedThisYear = all.filter((e) => watchedOn(e).some((d) => d.startsWith(thisYear))).length;

  const add = async () => {
    if (!title.trim()) return;
    const y = Number(year);
    const watched = list === "watched";
    await createEntity("film", { title: title.trim(), ...(Number.isInteger(y) && y > 1870 ? { year: y } : {}), watched, ...(watched ? { watched_on: [today()], last_watched: today() } : { watched_on: [], watchlist: true }), tags: [], source: "manual" });
    setTitle("");
    setYear("");
  };

  return (
    <div className="col films">
      <span className="title-row"><h1 style={{ margin: 0 }}>Films</h1><CsvButton kind="film" /></span>
      <div className="muted small">
        {all.length ? `${all.filter((e) => e.fields.watched !== false).length} watched, ${watchedThisYear} this year.` : <>No films yet. Link Letterboxd in <a href="#/settings/connections">Settings, Connections</a>.</>}
      </div>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <div className="chips" role="group" aria-label="List">
          <button type="button" className={`chip ${list === "watched" ? "on" : ""}`} aria-pressed={list === "watched"} onClick={() => setList("watched")}>
            Watched
          </button>
          <button type="button" className={`chip ${list === "watchlist" ? "on" : ""}`} aria-pressed={list === "watchlist"} onClick={() => setList("watchlist")}>
            Watchlist
          </button>
        </div>
        <div className="chips" role="group" aria-label="Sort">
          {SORTS.map(([k, label]) => (
            <button key={k} type="button" className={`chip ${sort === k ? "on" : ""}`} aria-pressed={sort === k} onClick={() => setSort(k)}>
              {label}
            </button>
          ))}
        </div>
        <input placeholder="Filter" aria-label="Filter films" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 160 }} />
      </div>
      <form
        className="row quick-add"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <input placeholder={list === "watched" ? "Film watched today" : "Film to watch"} aria-label="Film title" value={title} onChange={(e) => setTitle(e.target.value)} style={{ flex: 1 }} />
        <input placeholder="Year" aria-label="Year" inputMode="numeric" value={year} onChange={(e) => setYear(e.target.value)} style={{ width: 80 }} />
        <button type="submit" className="primary" disabled={!title.trim()}>
          Add
        </button>
      </form>
      <div className="list">
        {shown.map((e) => (
          <Row key={e.id} e={e} />
        ))}
      </div>
      {!shown.length && all.length > 0 && <div className="empty">{filter ? "No film matches." : "Nothing here."}</div>}
    </div>
  );
}
