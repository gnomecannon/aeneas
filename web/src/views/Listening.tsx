import { useState, type ReactNode } from "react";
import { MUSIC_NONE_HERE, MUSIC_NO_SUBSCRIPTION, MUSIC_PROFILE_ID, musicCountsLine, readMusicProfile, type MusicProfile } from "@everythingapp/shared";
import { useEntities } from "../sync/hooks";
import { fmtDate, fmtTime } from "../lib/time";

/**
 * Music (Library, Media; module apple_music): the owner's Apple Music taste, read on an iPhone, iPad or Mac and synced
 * here as one item (CONTRACT.md, Music). Nothing is read on this device: the web, Windows and Android apps show the
 * profile as the last Apple device left it.
 */

/** When it was read, in words: "today at 9:15 AM", "yesterday at 9:15 AM", "Nov 23 at 9:15 AM". */
export function readWhen(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "at a time it did not say";
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(now) - day(d)) / 86_400_000);
  const when = days === 0 ? "today" : days === 1 ? "yesterday" : fmtDate(iso);
  return `${when} at ${fmtTime(iso)}`;
}

/** The first `shown` lines, and a button for the rest. */
function ShortList({ title, lines, shown = 10, ordered = false }: { title: string; lines: ReactNode[]; shown?: number; ordered?: boolean }) {
  const [all, setAll] = useState(false);
  const List = ordered ? "ol" : "ul";
  const visible = all ? lines : lines.slice(0, shown);
  return (
    <section className="card music-list" aria-label={title}>
      <h3 style={{ marginTop: 0 }}>{title}</h3>
      <List className="music-lines">
        {visible.map((l, i) => <li key={i}>{l}</li>)}
      </List>
      {lines.length > shown && (
        <button type="button" className="small ghost" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show all ${lines.length}`}
        </button>
      )}
    </section>
  );
}

const plays = (n: number) => <span className="muted"> {n} {n === 1 ? "play" : "plays"}</span>;

/** The screen itself, from a profile (or none): what the Music screen draws, and what the tests draw. */
export function MusicTaste({ profile, now }: { profile: MusicProfile | null; now?: Date }) {
  if (!profile) {
    return (
      <div className="col music-taste">
        <h1 style={{ margin: 0 }}>Music</h1>
        <div className="empty">{MUSIC_NONE_HERE}</div>
      </div>
    );
  }
  const p = profile;
  const own = p.playlists.filter((l) => l.own);
  const added = p.playlists.filter((l) => !l.own);
  return (
    <div className="col music-taste">
      <h1 style={{ margin: 0 }}>Music</h1>
      <div className="muted small">From Apple Music on {p.device || "an Apple device"}, {readWhen(p.read_at, now)}.</div>
      <div className="muted small">{musicCountsLine(p)}</div>
      {p.subscription === false && <div className="muted small">{MUSIC_NO_SUBSCRIPTION}</div>}
      <div className="cols">
        {p.top_artists.length > 0 && <ShortList title="Top artists" ordered lines={p.top_artists.map((a) => <>{a.name}{plays(a.plays)}</>)} />}
        {p.top_songs.length > 0 && (
          <ShortList title="Top songs" ordered lines={p.top_songs.map((s) => <>{s.title} <span className="muted">by {s.artist}</span>{plays(s.plays)}</>)} />
        )}
        {p.playlists.length > 0 && (
          <ShortList
            title="Playlists"
            lines={[...own, ...added].map((l) => <>{l.name}<span className="muted"> {l.songs} {l.songs === 1 ? "song" : "songs"}{l.own ? "" : ", from Apple Music"}</span></>)}
          />
        )}
        {p.recent.length > 0 && <ShortList title="Recently played" lines={p.recent.map((s) => <>{s.title} <span className="muted">by {s.artist}</span></>)} />}
        {p.genres.length > 0 && <ShortList title="Genres" lines={p.genres.map((g) => <>{g.name}<span className="muted"> {g.songs} {g.songs === 1 ? "song" : "songs"}</span></>)} />}
      </div>
      {!p.top_artists.length && !p.playlists.length && <div className="empty">Nothing was in Apple Music on {p.device || "that device"}.</div>}
    </div>
  );
}

export function Listening() {
  const rows = useEntities("music_profile");
  return <MusicTaste profile={readMusicProfile(rows.find((e) => e.id === MUSIC_PROFILE_ID)?.fields)} />;
}
