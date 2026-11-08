import { useCallback, useEffect, useMemo, useState } from "react";
import type { Entity } from "@everythingapp/shared";
import { engine } from "../sync/engine";
import type { GamePick } from "../sync/api";
import { useEntities } from "../sync/hooks";
import { createEntity, softDelete, updateEntity } from "../sync/edits";
import { friendsOf, type GameF } from "../lib/admin";
import { relative } from "../lib/time";
import { useEscape } from "../lib/keys";
import { useOwnerName } from "../lib/profile";
import { CsvButton } from "../components/CsvButton";

const HOURS = [2, 4, 6];
// `owned` starts with the owner's own name (filled in where the form opens).
const EMPTY = { name: "", min: "1", max: "4", coop: true, genres: "", owned: [] as string[], hours: "", rating: "", notes: "" };
type Form = typeof EMPTY;

const n = (v: string) => (v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * A Steam game's header picture, from the hub. Loading it from Steam's CDN would tell Steam (and Cloudflare) this
 * device's address and, game by game, the library (docs/privacy-network.md).
 */
function GameArt({ appid }: { appid: string }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let u = "";
    let live = true;
    engine.client?.gameArt(appid).then((b) => { if (!live) return; u = URL.createObjectURL(b); setUrl(u); }, () => undefined);
    return () => { live = false; if (u) URL.revokeObjectURL(u); };
  }, [appid]);
  return url ? <img className="game-art" src={url} alt="" /> : null;
}

function toFields(f: Form): Record<string, unknown> {
  const rating = n(f.rating);
  return {
    name: f.name.trim(),
    min_players: Math.max(1, Math.round(n(f.min) ?? 1)),
    max_players: Math.max(1, Math.round(n(f.max) ?? 4)),
    coop: f.coop,
    genres: f.genres.split(",").map((s) => s.trim()).filter(Boolean),
    owned_by: f.owned,
    session_hours: n(f.hours),
    rating: rating != null && rating >= 1 && rating <= 5 ? Math.round(rating) : null,
    notes: f.notes.trim() || null,
  };
}

function fromGame(g: GameF): Form {
  return {
    name: g.name ?? "",
    min: String(g.min_players ?? 1),
    max: String(g.max_players ?? 4),
    coop: g.coop !== false,
    genres: (g.genres ?? []).join(", "),
    owned: g.owned_by ?? [],
    hours: g.session_hours != null ? String(g.session_hours) : "",
    rating: g.rating != null ? String(g.rating) : "",
    notes: g.notes ?? "",
  };
}

function GameForm({ value, onChange, friends, idPrefix }: { value: Form; onChange: (v: Form) => void; friends: string[]; idPrefix: string }) {
  const [other, setOther] = useState("");
  const id = (k: string) => `${idPrefix}-${k}`;
  const names = [...new Set([...friends, ...value.owned])];
  const set = (k: keyof Form) => (e: { target: { value: string } }) => onChange({ ...value, [k]: e.target.value });
  return (
    <div className="col">
      <input placeholder="Name" value={value.name} onChange={set("name")} aria-label="Name" />
      <div className="row">
        <div style={{ width: 70 }}>
          <label htmlFor={id("min")}>Min</label>
          <input id={id("min")} type="number" min={1} value={value.min} onChange={set("min")} />
        </div>
        <div style={{ width: 70 }}>
          <label htmlFor={id("max")}>Max</label>
          <input id={id("max")} type="number" min={1} value={value.max} onChange={set("max")} />
        </div>
        <div style={{ width: 80 }}>
          <label htmlFor={id("hours")}>Hours</label>
          <input id={id("hours")} type="number" min={0} step="0.5" value={value.hours} onChange={set("hours")} />
        </div>
        <div style={{ width: 80 }}>
          <label htmlFor={id("rating")}>Rating</label>
          <input id={id("rating")} type="number" min={1} max={5} value={value.rating} onChange={set("rating")} />
        </div>
        <label style={{ color: "inherit", fontSize: 15, alignSelf: "flex-end" }}>
          <input type="checkbox" checked={value.coop} onChange={(e) => onChange({ ...value, coop: e.target.checked })} /> co-op
        </label>
      </div>
      <div>
        <label htmlFor={id("genres")}>Genres, comma separated</label>
        <input id={id("genres")} value={value.genres} onChange={set("genres")} />
      </div>
      <div>
        <label>Owned by</label>
        <div className="chips" role="group" aria-label="Owned by">
          {names.map((p) => {
            const on = value.owned.includes(p);
            return (
              <button key={p} type="button" className={`chip ${on ? "on" : ""}`} aria-pressed={on} onClick={() => onChange({ ...value, owned: on ? value.owned.filter((x) => x !== p) : [...value.owned, p] })}>
                {p}
              </button>
            );
          })}
          <input
            placeholder="Add a name"
            value={other}
            onChange={(e) => setOther(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && other.trim()) {
                e.preventDefault();
                if (!value.owned.includes(other.trim())) onChange({ ...value, owned: [...value.owned, other.trim()] });
                setOther("");
              }
            }}
            aria-label="Add an owner"
            style={{ width: 130, minHeight: 28 }}
          />
        </div>
      </div>
      <textarea rows={2} placeholder="Notes" value={value.notes} onChange={set("notes")} aria-label="Notes" />
    </div>
  );
}

/** One pick at a time for the group. The list underneath is for upkeep only. */
type Sort = "playtime" | "two_weeks" | "recent" | "name";
const SORTS: Array<[Sort, string]> = [["playtime", "Most played"], ["two_weeks", "Last 2 weeks"], ["recent", "Recent"], ["name", "A to Z"]];
const num = (v: unknown) => (typeof v === "number" ? v : 0);
const SORTERS: Record<Sort, (a: Entity, b: Entity) => number> = {
  playtime: (a, b) => num(b.fields.playtime_min) - num(a.fields.playtime_min) || String(a.fields.name).localeCompare(String(b.fields.name)),
  two_weeks: (a, b) => num(b.fields.playtime_2w_min) - num(a.fields.playtime_2w_min) || num(b.fields.playtime_min) - num(a.fields.playtime_min),
  recent: (a, b) => String(b.fields.last_played ?? "").localeCompare(String(a.fields.last_played ?? "")),
  name: (a, b) => String(a.fields.name).localeCompare(String(b.fields.name)),
};
const hoursText = (min: unknown) => {
  const m = num(min);
  return m < 60 ? `${m} min` : `${Math.round(m / 6) / 10} h`;
};

/** Rows drawn at first; the rest on request, so a 700-game library opens fast. */
const PAGE = 100;

export function Games({ q = "" }: { q?: string }) {
  const all = useEntities("game");
  const [chosen, setSort] = useState<Sort | null>(null);
  const [filter, setFilter] = useState(q);
  const [shown, setShown] = useState(PAGE);
  const fromSteam = useMemo(() => all.filter((g) => g.fields.steam_appid), [all]);
  // Most played once Steam is linked, by name before; a tap on a sort chip wins.
  const sort: Sort = chosen ?? (fromSteam.length ? "playtime" : "name");
  const games = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return all.filter((g) => !f || String(g.fields.name).toLowerCase().includes(f)).sort(SORTERS[sort]);
  }, [all, filter, sort]);
  const steamHours = useMemo(() => Math.round(fromSteam.reduce((n, g) => n + num(g.fields.playtime_min), 0) / 60), [fromSteam]);
  const me = useOwnerName();
  const friends = useMemo(() => friendsOf(all, me), [all, me]);
  // The owner plays until someone is picked by hand.
  const [chosenPlayers, setPlayers] = useState<string[] | null>(null);
  const players = chosenPlayers ?? [me];
  const [hours, setHours] = useState<number | null>(null);
  const [coop, setCoop] = useState(false);
  const [pick, setPick] = useState<GamePick | null>(null);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [played, setPlayed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<Form>(() => ({ ...EMPTY, owned: [me] }));
  const [open, setOpen] = useState<string | null>(null);
  const [edit, setEdit] = useState<Form | null>(null);
  useEscape(
    useCallback(() => {
      setOpen(null);
      setAdding(false);
    }, []),
  );

  const ask = async (exclude: string[]) => {
    const c = engine.client;
    if (!c) {
      setErr("Needs the hub.");
      return;
    }
    setBusy(true);
    setErr("");
    setPlayed(null);
    try {
      setPick(await c.gamePick({ players, hours: hours ?? undefined, coop: coop || undefined, exclude }));
      setExcluded(exclude);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const markPlayed = async () => {
    const c = engine.client;
    const p = pick?.pick;
    if (!c || !p) return;
    setBusy(true);
    try {
      await engine.absorb([await c.gamePlayed(p.id)]);
      setPlayed(String(p.fields.name));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    if (!form.name.trim()) return;
    const fields = toFields(form);
    for (const k of Object.keys(fields)) if (fields[k] === null) delete fields[k];
    await createEntity("game", fields);
    setForm({ ...EMPTY, owned: [me] });
    setAdding(false);
  };

  const p = pick?.pick;
  const pf = p ? (p.fields as GameF) : null;
  const ru = pick?.runner_up ? (pick.runner_up.fields as GameF) : null;

  return (
    <div className="games food">
      <span className="title-row"><h1 style={{ margin: 0 }}>Games</h1><CsvButton kind="game" /></span>
      <div className="muted small">
        {fromSteam.length ? `${all.length} games, ${fromSteam.length} from Steam with ${steamHours} hours played.` : <>{all.length} games. Link Steam in <a href="#/settings/connections">Settings, Connections</a> to bring in your library and playtime.</>}
      </div>
      <div className="row" style={{ margin: "8px 0", flexWrap: "wrap" }}>
        <div className="chips" role="group" aria-label="Sort">
          {SORTS.map(([k, label]) => (
            <button key={k} type="button" className={`chip ${sort === k ? "on" : ""}`} aria-pressed={sort === k} onClick={() => setSort(k)}>
              {label}
            </button>
          ))}
        </div>
        <input placeholder="Filter" aria-label="Filter games" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 160 }} />
        {!adding && (
          <button className="small" onClick={() => setAdding(true)}>
            Add by hand
          </button>
        )}
      </div>
        {adding && (
          <form
            className="card col"
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
          >
            <GameForm value={form} onChange={setForm} friends={friends} idPrefix="new" />
            <div className="row">
              <button className="primary" type="submit" disabled={!form.name.trim()}>
                Add
              </button>
              <button type="button" className="ghost" onClick={() => setAdding(false)}>
                Cancel
              </button>
            </div>
          </form>
        )}
        <div className="list">
          {games.slice(0, shown).map((g: Entity) => {
            const f = g.fields as GameF;
            const isOpen = open === g.id;
            return (
              <div key={g.id} className="item">
                <div className="body">
                  <div className="row">
                    {g.fields.steam_appid ? <GameArt appid={String(g.fields.steam_appid)} /> : null}
                    <span className="t grow">{f.name}</span>
                    {g.fields.playtime_min != null && <span className="small">{hoursText(g.fields.playtime_min)}</span>}
                    {f.rating != null && <span className="muted small">{f.rating}/5</span>}
                  </div>
                  <div className="meta">
                    {num(g.fields.playtime_2w_min) > 0 && <span>{hoursText(g.fields.playtime_2w_min)} in the last 2 weeks</span>}
                    {g.fields.source !== "steam" && (
                      <span>
                        {f.min_players ?? 1} to {f.max_players ?? 4}
                        {f.coop !== false ? ", co-op" : ""}
                      </span>
                    )}
                    {f.owned_by && f.owned_by.length > 0 && <span>{f.owned_by.join(", ")}</span>}
                    {f.last_played && <span>played {relative(f.last_played)}</span>}
                    <button
                      className="ghost small"
                      onClick={() => {
                        if (isOpen) setOpen(null);
                        else {
                          setOpen(g.id);
                          setEdit(fromGame(f));
                        }
                      }}
                      aria-expanded={isOpen}
                      aria-label={`${isOpen ? "Close" : "Edit"} ${f.name}`}
                    >
                      {isOpen ? "less" : "edit"}
                    </button>
                  </div>
                  {isOpen && edit && (
                    <div className="col" style={{ marginTop: 8 }}>
                      <GameForm value={edit} onChange={setEdit} friends={friends} idPrefix={`g-${g.id.slice(0, 8)}`} />
                      <div className="row">
                        <button className="small primary" onClick={() => void updateEntity(g, toFields(edit)).then(() => setOpen(null))} disabled={!edit.name.trim()}>
                          Save
                        </button>
                        <button className="small ghost" onClick={() => setOpen(null)}>
                          Cancel
                        </button>
                        <button className="small ghost danger" onClick={() => confirm("Delete this game") && softDelete(g).then(() => setOpen(null))}>
                          Delete
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {games.length > shown && (
          <button type="button" className="ghost" onClick={() => setShown(games.length)}>
            Show all {games.length}
          </button>
        )}
        {!games.length && <div className="empty">{filter ? "No game matches." : "No games yet."}</div>}
      <details style={{ marginTop: 16 }}>
        <summary>Pick a game for a group</summary>
      <div className="card big">
        <div className="chips" role="group" aria-label="Players">
          {friends.map((f) => {
            const on = players.includes(f);
            return (
              <button key={f} type="button" className={`chip ${on ? "on" : ""}`} aria-pressed={on} onClick={() => setPlayers(on ? players.filter((x) => x !== f) : [...players, f])}>
                {f}
              </button>
            );
          })}
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <div className="chips" role="group" aria-label="Hours">
            {HOURS.map((h) => (
              <button key={h} type="button" className={`chip ${hours === h ? "on" : ""}`} aria-pressed={hours === h} onClick={() => setHours(hours === h ? null : h)}>
                {h} h
              </button>
            ))}
          </div>
          <button type="button" className={`chip ${coop ? "on" : ""}`} aria-pressed={coop} onClick={() => setCoop((v) => !v)}>
            co-op
          </button>
          <button className="primary" onClick={() => void ask([])} disabled={busy || !players.length}>
            Pick
          </button>
        </div>
        {err && <div className="error" style={{ marginTop: 8 }}>{err}</div>}
        {pick && !p && (
          <div className="muted" style={{ marginTop: 12 }}>
            {pick.why || "Nothing fits. Change the players or add a game below."}
          </div>
        )}
        {p && pf && (
          <div className="pick" style={{ marginTop: 14 }}>
            {played ? (
              <div>
                <div className="title">{played}</div>
                <div className="ok">Marked played.</div>
              </div>
            ) : (
              <>
                <div className="title">{pf.name}</div>
                <div className="muted small" style={{ marginTop: 4 }}>
                  {pick?.why}
                </div>
                <div className="muted small">
                  {pf.min_players ?? 1} to {pf.max_players ?? 4} players{pf.coop !== false ? ", co-op" : ""}
                  {pf.session_hours ? `, about ${pf.session_hours} h` : ""}
                </div>
                <div className="actions">
                  <button className="primary" onClick={() => void markPlayed()} disabled={busy}>
                    Played
                  </button>
                  <button onClick={() => void ask([...excluded, p.id])} disabled={busy}>
                    Another
                  </button>
                </div>
                {ru && <div className="muted small faint" style={{ marginTop: 8 }}>runner-up: {ru.name}</div>}
              </>
            )}
          </div>
        )}
      </div>

      </details>
    </div>
  );
}
